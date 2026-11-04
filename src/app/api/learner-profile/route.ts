import { z } from "zod";

import { authorizeParentRequest, parentOwnsLearner } from "@/lib/parent-api";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const profilePatchSchema = z
  .object({
    dateOfBirth: z.string().date().nullable().optional(),
    educationalLevel: z.string().trim().max(120).optional(),
    interests: z.string().trim().max(4000).optional(),
    learningPreferences: z.string().trim().max(4000).optional(),
    observedStrengths: z.string().trim().max(4000).optional(),
    observedChallenges: z.string().trim().max(4000).optional(),
    motivators: z.string().trim().max(4000).optional(),
    helpfulApproaches: z.string().trim().max(4000).optional(),
    additionalNotes: z.string().trim().max(6000).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const learnerId = new URL(request.url).searchParams.get("learnerId") ?? "";
  if (!uuidPattern.test(learnerId)) {
    return Response.json({ error: "Choose a valid learner." }, { status: 400 });
  }

  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;
  if (!(await parentOwnsLearner(authorization.context, learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Profile access is not configured." }, { status: 503 });

  const [
    learnerResult,
    profileResult,
    sourcesResult,
    assessmentsResult,
    extractionsResult,
    findingsResult,
    observationsResult,
    prioritiesResult,
    summariesResult,
  ] = await Promise.all([
    admin.from("learners").select("id, display_name").eq("id", learnerId).eq("user_id", userId).single(),
    admin.from("learner_profiles").select("*").eq("learner_id", learnerId).eq("user_id", userId).maybeSingle(),
    admin.from("assessment_source_files").select("id, source_label, assessment_date, original_filename, content_type, byte_size, uploaded_at").eq("learner_id", learnerId).eq("user_id", userId).order("uploaded_at", { ascending: false }),
    admin.from("learner_assessments").select("*").eq("learner_id", learnerId).eq("user_id", userId).order("created_at", { ascending: false }),
    admin.from("assessment_extractions").select("id, assessment_id, version, schema_version, extracted_assessment_name, extracted_provider, extracted_subject, extracted_assessment_date, domains, scores, provider_strengths, provider_difficulties, narrative_observations, parent_corrections, review_status, created_at, reviewed_at").eq("learner_id", learnerId).eq("user_id", userId).order("version", { ascending: false }),
    admin.from("assessment_findings").select("*").eq("learner_id", learnerId).eq("user_id", userId).order("created_at", { ascending: true }),
    admin.from("learner_observations").select("*").eq("learner_id", learnerId).eq("user_id", userId).order("observation_date", { ascending: false }),
    admin.from("learner_priorities").select("*").eq("learner_id", learnerId).eq("user_id", userId).order("created_at", { ascending: false }),
    admin.from("learner_academic_summaries").select("*").eq("learner_id", learnerId).eq("user_id", userId).order("version", { ascending: false }),
  ]);

  const firstError = [
    learnerResult,
    profileResult,
    sourcesResult,
    assessmentsResult,
    extractionsResult,
    findingsResult,
    observationsResult,
    prioritiesResult,
    summariesResult,
  ].find((result) => result.error)?.error;
  if (firstError) {
    return Response.json({ error: "The learner profile could not be loaded." }, { status: 500 });
  }

  return Response.json(
    {
      learner: learnerResult.data,
      profile: profileResult.data,
      sources: sourcesResult.data ?? [],
      assessments: (assessmentsResult.data ?? []).map((assessment) => ({
        ...assessment,
        processing_retry_available:
          assessment.processing_status === "processing" &&
          Date.now() - new Date(assessment.updated_at).valueOf() > 15 * 60 * 1000,
      })),
      extractions: extractionsResult.data ?? [],
      findings: findingsResult.data ?? [],
      observations: observationsResult.data ?? [],
      priorities: prioritiesResult.data ?? [],
      summaries: summariesResult.data ?? [],
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}

export async function PATCH(request: Request) {
  const learnerId = new URL(request.url).searchParams.get("learnerId") ?? "";
  if (!uuidPattern.test(learnerId)) {
    return Response.json({ error: "Choose a valid learner." }, { status: 400 });
  }

  const authorization = await authorizeParentRequest(request, { requireSecret: true });
  if (!authorization.context) return authorization.response;
  if (!(await parentOwnsLearner(authorization.context, learnerId))) {
    return Response.json({ error: "Learner not found." }, { status: 404 });
  }

  let parsed: z.infer<typeof profilePatchSchema>;
  try {
    parsed = profilePatchSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Enter valid learner profile details." }, { status: 400 });
  }
  if (Object.keys(parsed).length === 0) {
    return Response.json({ error: "No profile changes were provided." }, { status: 400 });
  }

  const { admin, userId } = authorization.context;
  if (!admin) return Response.json({ error: "Profile access is not configured." }, { status: 503 });
  const profileValues = {
    user_id: userId,
    learner_id: learnerId,
    updated_at: new Date().toISOString(),
    ...(parsed.dateOfBirth !== undefined ? { date_of_birth: parsed.dateOfBirth } : {}),
    ...(parsed.educationalLevel !== undefined ? { educational_level: parsed.educationalLevel } : {}),
    ...(parsed.interests !== undefined ? { interests: parsed.interests } : {}),
    ...(parsed.learningPreferences !== undefined ? { learning_preferences: parsed.learningPreferences } : {}),
    ...(parsed.observedStrengths !== undefined ? { observed_strengths: parsed.observedStrengths } : {}),
    ...(parsed.observedChallenges !== undefined ? { observed_challenges: parsed.observedChallenges } : {}),
    ...(parsed.motivators !== undefined ? { motivators: parsed.motivators } : {}),
    ...(parsed.helpfulApproaches !== undefined ? { helpful_approaches: parsed.helpfulApproaches } : {}),
    ...(parsed.additionalNotes !== undefined ? { additional_notes: parsed.additionalNotes } : {}),
  };
  const { data, error } = await admin
    .from("learner_profiles")
    .upsert(profileValues, { onConflict: "learner_id" })
    .select("*")
    .single();

  if (error) {
    return Response.json({ error: "The learner profile could not be saved." }, { status: 500 });
  }
  return Response.json({ profile: data });
}
