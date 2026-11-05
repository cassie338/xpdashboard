import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const statusArgs = ["supabase", "status", "-o", "json"];
if (process.env.SUPABASE_WORKDIR)
  statusArgs.push("--workdir", process.env.SUPABASE_WORKDIR);
const status = JSON.parse(
  execFileSync("npx", statusArgs, { encoding: "utf8" }),
);
const url = new URL(status.API_URL);
const expectedPort = process.env.SUPABASE_API_PORT ?? "55321";
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.port !== expectedPort
) {
  throw new Error(`Refusing non-local Supabase target: ${url.host}`);
}

const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (!publishableKey || !secretKey)
  throw new Error("Local Supabase keys are unavailable.");

const admin = createClient(url.origin, secretKey, {
  auth: { persistSession: false },
});
const password = `Local-only-${crypto.randomUUID()}-A1!`;
const suffix = crypto.randomUUID();
const emails = [
  `rls-a-${suffix}@example.invalid`,
  `rls-b-${suffix}@example.invalid`,
];

const users = [];
for (const email of emails) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { parent_birthday: "01/02/90" },
  });
  if (error || !data.user)
    throw error ?? new Error(`Failed to create ${email}`);
  users.push(data.user);
}

const clients = [];
for (const email of emails) {
  const client = createClient(url.origin, publishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  clients.push(client);
}

const [clientA, clientB] = clients;
const [userA, userB] = users;
const parentTokens = new Map();

for (const [client, user] of [
  [clientA, userA],
  [clientB, userB],
]) {
  const { data: correctAccess, error: correctAccessError } = await client.rpc(
    "verify_parent_access",
    { p_birthday: "01/02/90" },
  );
  if (correctAccessError || correctAccess !== true)
    throw (
      correctAccessError ?? new Error("Correct parent birthday was rejected.")
    );

  const { data: wrongAccess, error: wrongAccessError } = await client.rpc(
    "verify_parent_access",
    { p_birthday: "01/02/91" },
  );
  if (wrongAccessError || wrongAccess !== false)
    throw (
      wrongAccessError ?? new Error("Incorrect parent birthday was accepted.")
    );

  const { data: authUser, error: authUserError } =
    await admin.auth.admin.getUserById(user.id);
  if (authUserError) throw authUserError;
  if (authUser.user.user_metadata.parent_birthday)
    throw new Error("Parent birthday remained in Auth metadata.");

  const { error: credentialReadError } = await client
    .from("parent_access_credentials")
    .select("access_code_hash");
  if (!credentialReadError)
    throw new Error("Authenticated client read parent credential hashes.");

  const { data: parentToken, error: parentTokenError } = await client.rpc(
    "open_parent_access_session",
    { p_birthday: "01/02/90" },
  );
  if (parentTokenError || typeof parentToken !== "string")
    throw parentTokenError ?? new Error("Parent access session was not opened.");
  parentTokens.set(user.id, parentToken);
  const { data: validSession, error: validSessionError } = await client.rpc(
    "validate_parent_access_session",
    { p_token: parentToken },
  );
  if (validSessionError || validSession !== true)
    throw validSessionError ?? new Error("Parent access session was not valid.");

  const { error: sessionReadError } = await client
    .from("parent_access_sessions")
    .select("token_hash");
  if (!sessionReadError)
    throw new Error("Authenticated client read parent access sessions.");
}

async function createAssessmentSource(client, user) {
  const { data: learner, error: learnerError } = await client
    .from("learners")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (learnerError) throw learnerError;

  const sourceId = crypto.randomUUID();
  const bytes = new TextEncoder().encode("%PDF-1.4\nLocal assessment source\n");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const storagePath = `${user.id}/${learner.id}/${sourceId}/local-report.pdf`;

  const { error: directUploadError } = await client.storage
    .from("assessment-sources")
    .upload(`${user.id}/${learner.id}/${crypto.randomUUID()}/forbidden.pdf`, bytes, {
      contentType: "application/pdf",
    });
  if (!directUploadError)
    throw new Error("Authenticated client directly uploaded an assessment source.");

  const { error: uploadError } = await admin.storage
    .from("assessment-sources")
    .upload(storagePath, bytes, { contentType: "application/pdf" });
  if (uploadError) throw uploadError;

  const assessmentId = crypto.randomUUID();
  const { data: registration, error: registerError } = await client.rpc(
    "register_learner_assessment",
    {
      p_parent_token: parentTokens.get(user.id),
      p_source_id: sourceId,
      p_assessment_id: assessmentId,
      p_learner_id: learner.id,
      p_source_label: "Local assessment",
      p_assessment_date: "2026-10-01",
      p_original_filename: "local-report.pdf",
      p_storage_path: storagePath,
      p_content_type: "application/pdf",
      p_byte_size: bytes.byteLength,
      p_file_sha256: checksum,
    },
  );
  if (
    registerError ||
    registration?.[0]?.source_id !== sourceId ||
    registration?.[0]?.assessment_id !== assessmentId
  )
    throw registerError ?? new Error("Atomic assessment registration failed.");

  const { error: directDownloadError } = await client.storage
    .from("assessment-sources")
    .download(storagePath);
  if (!directDownloadError)
    throw new Error("Authenticated client directly downloaded an assessment source.");

  const { error: directReadError } = await client
    .from("assessment_source_files")
    .select("original_filename");
  if (!directReadError)
    throw new Error("Authenticated client directly read assessment metadata.");
  const { data: listedSources, error: listError } = await client.rpc(
    "list_assessment_sources",
    { p_parent_token: parentTokens.get(user.id), p_learner_id: learner.id },
  );
  if (listError || listedSources?.length !== 1)
    throw listError ?? new Error("Parent could not list assessment sources.");

  const { error: directInsertError } = await client
    .from("assessment_source_files")
    .insert({
      id: crypto.randomUUID(),
      user_id: user.id,
      learner_id: learner.id,
      source_label: "Forbidden direct insert",
      original_filename: "forbidden.pdf",
      storage_path: `${user.id}/${learner.id}/${crypto.randomUUID()}/forbidden.pdf`,
      content_type: "application/pdf",
      byte_size: 10,
      file_sha256: "a".repeat(64),
    });
  if (!directInsertError)
    throw new Error("Authenticated client directly inserted assessment metadata.");

  const { error: updateError } = await client
    .from("assessment_source_files")
    .update({ source_label: "Changed" })
    .eq("id", sourceId);
  if (!updateError)
    throw new Error("Authenticated client updated an assessment source.");
  const { error: deleteError } = await client
    .from("assessment_source_files")
    .delete()
    .eq("id", sourceId);
  if (!deleteError)
    throw new Error("Authenticated client deleted an assessment source.");

  return { sourceId, assessmentId, learnerId: learner.id, storagePath };
}

const sourceA = await createAssessmentSource(clientA, userA);
const sourceB = await createAssessmentSource(clientB, userB);

const protectedProfileTables = [
  "learner_profiles",
  "learner_assessments",
  "assessment_processing_attempts",
  "assessment_extractions",
  "assessment_findings",
  "learner_observations",
  "learner_priorities",
  "learner_academic_summaries",
  "learner_summary_evidence",
];
for (const table of protectedProfileTables) {
  const { error } = await clientA.from(table).select("*").limit(1);
  if (!error) throw new Error(`Authenticated client directly read ${table}.`);
}

const { error: directProcessingError } = await clientA.rpc(
  "begin_assessment_processing",
  {
    p_assessment_id: sourceA.assessmentId,
    p_provider_name: "Forbidden",
    p_model_name: "Forbidden",
  },
);
if (!directProcessingError)
  throw new Error("Authenticated client started assessment processing directly.");

const { data: processingAttemptId, error: processingError } = await admin.rpc(
  "begin_assessment_processing",
  {
    p_assessment_id: sourceA.assessmentId,
    p_provider_name: "Local test provider",
    p_model_name: "local-test-model",
  },
);
if (processingError || typeof processingAttemptId !== "string")
  throw processingError ?? new Error("Service role could not begin assessment processing.");

const validatedExtraction = {
  assessmentName: "Local assessment",
  provider: "Local provider",
  subject: "Reading",
  assessmentDate: "2026-10-01",
  domains: ["Phonics"],
  scores: [],
  providerStrengths: [],
  providerDifficulties: [],
  narrativeObservations: [],
};
const validatedFindings = [
  {
    skillName: "Short vowels",
    domainName: "Phonics",
    testedState: "tested",
    proposedStatus: "developing",
    statusBasis: "multiple_items",
    providerReportedStatus: null,
    confidence: "medium",
    evidenceSummary: "Six of eight items were correct.",
    sourceLocator: "Page 2, Short vowels row",
    originalResult: "6 of 8 correct",
  },
];
const { data: extractionId, error: extractionError } = await admin.rpc(
  "record_assessment_processing_success",
  {
    p_assessment_id: sourceA.assessmentId,
    p_attempt_id: processingAttemptId,
    p_provider_name: "Local test provider",
    p_model_name: "local-test-model",
    p_extraction: validatedExtraction,
    p_findings: validatedFindings,
  },
);
if (extractionError || typeof extractionId !== "string")
  throw extractionError ?? new Error("Validated assessment extraction was not stored.");

const { data: processedAssessment, error: processedAssessmentError } = await admin
  .from("learner_assessments")
  .select("processing_status")
  .eq("id", sourceA.assessmentId)
  .single();
if (processedAssessmentError || processedAssessment.processing_status !== "ready_for_review")
  throw processedAssessmentError ?? new Error("Assessment did not enter parent review.");

const { error: sourceMutationError } = await admin
  .from("assessment_extractions")
  .update({ extracted_subject: "Changed" })
  .eq("id", extractionId);
if (!sourceMutationError)
  throw new Error("Validated provider extraction was mutable.");

const { data: storedFinding, error: storedFindingError } = await admin
  .from("assessment_findings")
  .select("id")
  .eq("assessment_id", sourceA.assessmentId)
  .single();
if (storedFindingError) throw storedFindingError;
const findingReviews = [
  { id: storedFinding.id, correction: "", statusOverride: "" },
];
const { error: directReviewError } = await clientA.rpc("approve_assessment_review", {
  p_assessment_id: sourceA.assessmentId,
  p_extraction_id: extractionId,
  p_reviews: findingReviews,
});
if (!directReviewError)
  throw new Error("Authenticated client approved assessment findings directly.");
const { error: reviewError } = await admin.rpc("approve_assessment_review", {
  p_assessment_id: sourceA.assessmentId,
  p_extraction_id: extractionId,
  p_reviews: findingReviews,
});
if (reviewError) throw reviewError;

const { data: approvedAssessment, error: approvedAssessmentError } = await admin
  .from("learner_assessments")
  .select("processing_status, approved_at")
  .eq("id", sourceA.assessmentId)
  .single();
if (
  approvedAssessmentError ||
  approvedAssessment.processing_status !== "approved" ||
  !approvedAssessment.approved_at
)
  throw approvedAssessmentError ?? new Error("Reviewed assessment was not approved.");

const { data: observation, error: observationError } = await admin
  .from("learner_observations")
  .insert({
    user_id: userA.id,
    learner_id: sourceA.learnerId,
    observation_date: "2026-10-02",
    subject: "Reading",
    observation_text: "The learner used vowel cards without prompting.",
  })
  .select("id")
  .single();
if (observationError) throw observationError;
const summaryPayload = {
  learnerOverview: "The available evidence describes current reading work.",
  strengths: "The learner used a support strategy independently.",
  developingSkills: "Short-vowel reading is developing in the provider report.",
  learningPatterns: "Evidence is limited to one report and one parent observation.",
  areasToInvestigate: "Verify the skill in later provider evidence.",
  teachingRecommendations: "Continue the helpful vowel-card strategy.",
  parentContext: "A parent reported independent use of vowel cards.",
};
const { error: directSummaryError } = await clientA.rpc(
  "record_learner_summary_draft",
  {
    p_user_id: userA.id,
    p_learner_id: sourceA.learnerId,
    p_summary: summaryPayload,
    p_evidence_snapshot: { localTest: true },
    p_provider_name: "Local test provider",
    p_model_name: "local-test-model",
    p_assessment_ids: [sourceA.assessmentId],
    p_observation_ids: [observation.id],
    p_prior_summary_id: null,
  },
);
if (!directSummaryError)
  throw new Error("Authenticated client created a summary draft directly.");
const { data: summaryId, error: summaryError } = await admin.rpc(
  "record_learner_summary_draft",
  {
    p_user_id: userA.id,
    p_learner_id: sourceA.learnerId,
    p_summary: summaryPayload,
    p_evidence_snapshot: { localTest: true },
    p_provider_name: "Local test provider",
    p_model_name: "local-test-model",
    p_assessment_ids: [sourceA.assessmentId],
    p_observation_ids: [observation.id],
    p_prior_summary_id: null,
  },
);
if (summaryError || typeof summaryId !== "string")
  throw summaryError ?? new Error("Summary draft was not recorded.");
const { error: summaryApprovalError } = await admin.rpc("approve_learner_summary", {
  p_user_id: userA.id,
  p_learner_id: sourceA.learnerId,
  p_summary_id: summaryId,
});
if (summaryApprovalError) throw summaryApprovalError;
const { data: approvedSummary, error: approvedSummaryError } = await admin
  .from("learner_academic_summaries")
  .select("status, approved_at")
  .eq("id", summaryId)
  .single();
if (approvedSummaryError || approvedSummary.status !== "approved" || !approvedSummary.approved_at)
  throw approvedSummaryError ?? new Error("Summary draft was not approved.");

const { data: crossSession, error: crossSessionError } = await clientA.rpc(
  "validate_parent_access_session",
  { p_token: parentTokens.get(userB.id) },
);
if (crossSessionError || crossSession !== false)
  throw crossSessionError ?? new Error("Cross-user parent token was accepted.");
const { error: crossSourceRegistrationError } = await clientA.rpc(
  "register_assessment_source",
  {
    p_parent_token: parentTokens.get(userA.id),
    p_id: crypto.randomUUID(),
    p_learner_id: sourceB.learnerId,
    p_source_label: "Forbidden source",
    p_assessment_date: null,
    p_original_filename: "forbidden.pdf",
    p_storage_path: sourceB.storagePath,
    p_content_type: "application/pdf",
    p_byte_size: 10,
    p_file_sha256: "b".repeat(64),
  },
);
if (!crossSourceRegistrationError)
  throw new Error("Cross-user assessment source registration succeeded.");
const { error: crossSourceListError } = await clientA.rpc(
  "list_assessment_sources",
  {
    p_parent_token: parentTokens.get(userA.id),
    p_learner_id: sourceB.learnerId,
  },
);
if (!crossSourceListError)
  throw new Error("Cross-user assessment source listing succeeded.");
const { data: crossDownloadSources, error: crossDownloadError } = await clientA.rpc(
  "get_assessment_source_download",
  {
    p_parent_token: parentTokens.get(userA.id),
    p_source_id: sourceB.sourceId,
  },
);
if (crossDownloadError || crossDownloadSources?.length !== 0)
  throw crossDownloadError ?? new Error("Cross-user assessment download lookup succeeded.");

const { error: expireError } = await admin
  .from("parent_access_sessions")
  .update({ expires_at: "2000-01-01T00:00:00.000Z" })
  .eq("user_id", userB.id);
if (expireError) throw expireError;
const { data: expiredSession, error: expiredSessionError } = await clientB.rpc(
  "validate_parent_access_session",
  { p_token: parentTokens.get(userB.id) },
);
if (expiredSessionError || expiredSession !== false)
  throw expiredSessionError ?? new Error("Expired parent session remained valid.");
const { error: expiredListError } = await clientB.rpc(
  "list_assessment_sources",
  {
    p_parent_token: parentTokens.get(userB.id),
    p_learner_id: sourceB.learnerId,
  },
);
if (!expiredListError)
  throw new Error("Expired parent session listed assessment sources.");

async function createFirstPlan(client, userId, name) {
  const { data: task, error: taskError } = await client
    .from("tasks")
    .insert({
      user_id: userId,
      name,
      category: "Math",
      day: "Monday",
      xp: 15,
    })
    .select("id")
    .single();
  if (taskError) throw taskError;

  const { data: planId, error: planError } = await client.rpc(
    "start_next_week",
    {
      p_source_plan_id: null,
      p_task_ids: [task.id],
      p_week_start: "2030-01-07",
    },
  );
  if (planError) throw planError;

  const { error: quoteError } = await client.rpc(
    "set_weekly_inspirational_quote",
    {
      p_weekly_plan_id: planId,
      p_quote: "Keep going, one thoughtful step at a time.",
    },
  );
  if (quoteError) throw quoteError;

  const { data: copiedTask, error: copiedError } = await client
    .from("tasks")
    .select("id")
    .eq("weekly_plan_id", planId)
    .single();
  if (copiedError) throw copiedError;

  const { error: supportError } = await client.rpc("set_task_support_mode", {
    p_task_id: copiedTask.id,
    p_support_mode: "with_parent",
  });
  if (supportError) throw supportError;
  const { error: moveError } = await client.rpc("move_weekly_task", {
    p_task_id: copiedTask.id,
    p_target_day: "Tuesday",
    p_before_task_id: null,
  });
  if (moveError) throw moveError;
  const { data: movedTask, error: movedTaskError } = await client
    .from("tasks")
    .select("day, position")
    .eq("id", copiedTask.id)
    .single();
  if (movedTaskError) throw movedTaskError;
  if (movedTask.day !== "Tuesday" || movedTask.position !== 0)
    throw new Error("Owned weekly task did not move to the target day.");
  const { error: moveBackError } = await client.rpc("move_weekly_task", {
    p_task_id: copiedTask.id,
    p_target_day: "Monday",
    p_before_task_id: null,
  });
  if (moveBackError) throw moveBackError;
  const { error: struggleError } = await client.rpc("record_parent_struggle", {
    p_task_id: copiedTask.id,
    p_description: "Local RLS observation",
  });
  if (struggleError) throw struggleError;
  const { data: swapRequestId, error: swapError } = await client.rpc(
    "request_task_swap",
    { p_task_id: copiedTask.id, p_requested_name: "Local replacement" },
  );
  if (swapError) throw swapError;
  const { error: rejectSwapError } = await client.rpc("review_task_swap", {
    p_swap_request_id: swapRequestId,
    p_approve: false,
  });
  if (rejectSwapError) throw rejectSwapError;
  const { error: startError } = await client.rpc("start_task", {
    p_task_id: copiedTask.id,
  });
  if (startError) throw startError;
  const { error: helpError } = await client.rpc("request_task_help", {
    p_task_id: copiedTask.id,
  });
  if (helpError) throw helpError;

  const { error: completionError } = await client.rpc(
    "record_task_completion",
    {
      p_task_id: copiedTask.id,
      p_complete: true,
    },
  );
  if (completionError) throw completionError;
  return {
    legacyTaskId: task.id,
    planId,
    copiedTaskId: copiedTask.id,
    swapRequestId,
  };
}

const recordsA = await createFirstPlan(clientA, userA.id, "Auth user A task");
const recordsB = await createFirstPlan(clientB, userB.id, "Auth user B task");

async function assertCannotAccess(
  attacker,
  attackerUser,
  ownerUser,
  ownerRecords,
  attackerRecords,
) {
  for (const table of [
    "learners",
    "dashboard_settings",
    "weekly_plans",
    "tasks",
    "xp_events",
    "task_sessions",
    "help_requests",
    "parent_struggle_observations",
    "task_swap_requests",
  ]) {
    const { data, error } = await attacker
      .from(table)
      .select("*")
      .eq("user_id", ownerUser.id);
    if (error) throw error;
    if (data.length !== 0)
      throw new Error(`${attackerUser.email} read ${ownerUser.email} ${table}`);
  }

  const { data: settingsUpdate, error: settingsError } = await attacker
    .from("dashboard_settings")
    .update({ learner_name: "Forbidden" })
    .eq("user_id", ownerUser.id)
    .select("user_id");
  if (settingsError) throw settingsError;
  if (settingsUpdate.length !== 0)
    throw new Error("Cross-user settings update changed a row.");

  const { data: deletedTasks, error: deleteError } = await attacker
    .from("tasks")
    .delete()
    .eq("id", ownerRecords.legacyTaskId)
    .select("id");
  if (deleteError) throw deleteError;
  if (deletedTasks.length !== 0)
    throw new Error("Cross-user task delete changed a row.");

  const { error: completionError } = await attacker.rpc(
    "record_task_completion",
    {
      p_task_id: ownerRecords.copiedTaskId,
      p_complete: false,
    },
  );
  if (!completionError)
    throw new Error("Cross-user completion RPC unexpectedly succeeded.");

  for (const rpc of ["start_task", "request_task_help"]) {
    const { error } = await attacker.rpc(rpc, {
      p_task_id: ownerRecords.copiedTaskId,
    });
    if (!error)
      throw new Error(`Cross-user ${rpc} RPC unexpectedly succeeded.`);
  }

  const { error: supportError } = await attacker.rpc("set_task_support_mode", {
    p_task_id: ownerRecords.copiedTaskId,
    p_support_mode: "with_parent",
  });
  if (!supportError)
    throw new Error("Cross-user support-mode RPC unexpectedly succeeded.");

  const { error: moveError } = await attacker.rpc("move_weekly_task", {
    p_task_id: ownerRecords.copiedTaskId,
    p_target_day: "Tuesday",
    p_before_task_id: null,
  });
  if (!moveError)
    throw new Error("Cross-user weekly-task move unexpectedly succeeded.");

  const { error: struggleError } = await attacker.rpc(
    "record_parent_struggle",
    {
      p_task_id: ownerRecords.copiedTaskId,
      p_description: "Forbidden observation",
    },
  );
  if (!struggleError)
    throw new Error("Cross-user parent-struggle RPC unexpectedly succeeded.");

  const { error: swapError } = await attacker.rpc("request_task_swap", {
    p_task_id: ownerRecords.copiedTaskId,
    p_requested_name: "Forbidden replacement",
  });
  if (!swapError)
    throw new Error("Cross-user task-swap request unexpectedly succeeded.");

  const { error: swapReviewError } = await attacker.rpc("review_task_swap", {
    p_swap_request_id: ownerRecords.swapRequestId,
    p_approve: true,
  });
  if (!swapReviewError)
    throw new Error("Cross-user task-swap review unexpectedly succeeded.");

  const { error: rewardError } = await attacker.rpc("set_daily_reward", {
    p_weekly_plan_id: ownerRecords.planId,
    p_day: "Monday",
    p_reward: "Forbidden reward",
  });
  if (!rewardError)
    throw new Error("Cross-user daily-reward RPC unexpectedly succeeded.");

  const { error: quoteError } = await attacker.rpc(
    "set_weekly_inspirational_quote",
    {
      p_weekly_plan_id: ownerRecords.planId,
      p_quote: "Forbidden quote",
    },
  );
  if (!quoteError)
    throw new Error("Cross-user weekly quote RPC unexpectedly succeeded.");

  const { error: rolloverError } = await attacker.rpc("start_next_week", {
    p_source_plan_id: ownerRecords.planId,
    p_task_ids: [ownerRecords.copiedTaskId],
    p_week_start: "2030-01-14",
  });
  if (!rolloverError)
    throw new Error("Cross-user rollover RPC unexpectedly succeeded.");

  const { error: copiedSourceError } = await attacker.from("tasks").insert({
    user_id: attackerUser.id,
    weekly_plan_id: attackerRecords.planId,
    copied_from_task_id: ownerRecords.copiedTaskId,
    name: "Forbidden copy",
    category: "Math",
    day: "Tuesday",
    xp: 10,
  });
  if (!copiedSourceError)
    throw new Error("Cross-user copied_from_task_id unexpectedly succeeded.");

  const { error: xpUpdateError } = await attacker
    .from("xp_events")
    .update({ amount: 999 })
    .eq("user_id", ownerUser.id);
  if (!xpUpdateError)
    throw new Error("Cross-user XP update unexpectedly succeeded.");

  const { error: xpDeleteError } = await attacker
    .from("xp_events")
    .delete()
    .eq("user_id", ownerUser.id);
  if (!xpDeleteError)
    throw new Error("Cross-user XP delete unexpectedly succeeded.");
}

await assertCannotAccess(clientA, userA, userB, recordsB, recordsA);
await assertCannotAccess(clientB, userB, userA, recordsA, recordsB);

for (let attempt = 0; attempt < 5; attempt += 1) {
  const { data, error } = await clientA.rpc("verify_parent_access", {
    p_birthday: "01/02/91",
  });
  if (error || data !== false)
    throw error ?? new Error("Incorrect parent birthday bypassed throttling.");
}
const { data: lockedAccess, error: lockedAccessError } = await clientA.rpc(
  "verify_parent_access",
  { p_birthday: "01/02/90" },
);
if (lockedAccessError || lockedAccess !== false)
  throw (
    lockedAccessError ??
    new Error("Parent access was not locked after five failures.")
  );

console.log(
  "real_auth_sessions|PASS|Two local Auth users signed in with separate access tokens.",
);
console.log(
  "parent_access|PASS|Birthdays are hashed, removed from Auth metadata, hidden from clients, verified server-side, and throttled after repeated failures.",
);
console.log(
  "assessment_sources|PASS|Parent sessions, private storage, append-only metadata, and learner ownership are enforced server-side.",
);
console.log(
  "symmetric_cross_user_reads|PASS|Each user saw zero rows belonging to the other across all dashboard, session, help, struggle, swap, and XP records.",
);
console.log(
  "symmetric_cross_user_mutations|PASS|Settings, task, session, help, struggle, swap, support, task move, reward, weekly quote, rollover, task copy, and XP mutation attempts were rejected in both directions.",
);
