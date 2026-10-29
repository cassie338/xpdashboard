import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" }));
const url = new URL(status.API_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55321") {
  throw new Error(`Refusing non-local Supabase target: ${url.host}`);
}

const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
const admin = createClient(url.origin, secretKey, { auth: { persistSession: false } });

async function createUserClients(label) {
  const email = `concurrent-${label}-${crypto.randomUUID()}@example.invalid`;
  const password = `Local-only-${crypto.randomUUID()}-A1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`Unable to create ${label} user.`);

  const clients = [];
  for (let index = 0; index < 2; index += 1) {
    const client = createClient(url.origin, publishableKey, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    clients.push(client);
  }
  return { user: data.user, clients };
}

async function insertLegacyTasks(client, userId, prefix) {
  const { data, error } = await client.from("tasks").insert([
    { user_id: userId, name: `${prefix} Math`, category: "Math", day: "Monday", xp: 25 },
    { user_id: userId, name: `${prefix} Reading`, category: "Reading", day: "Tuesday", xp: 20 },
  ]).select("id");
  if (error) throw error;
  return data.map((task) => task.id).sort();
}

async function createFirstPlan(client, taskIds, weekStart) {
  const { data, error } = await client.rpc("start_next_week", {
    p_source_plan_id: null,
    p_task_ids: taskIds,
    p_week_start: weekStart,
  });
  if (error) throw error;
  return data;
}

async function sourceTaskIds(client, planId) {
  const { data, error } = await client.from("tasks").select("id").eq("weekly_plan_id", planId).order("id");
  if (error) throw error;
  return data.map((task) => task.id);
}

async function accountState(client, userId, sourcePlanId, destinationWeek) {
  const [{ data: plans, error: plansError }, { data: destination, error: destinationError }] = await Promise.all([
    client.from("weekly_plans").select("id, week_start, status").eq("user_id", userId).order("week_start"),
    client.from("weekly_plans").select("id, status").eq("user_id", userId).eq("week_start", destinationWeek).single(),
  ]);
  if (plansError) throw plansError;
  if (destinationError) throw destinationError;
  const { data: copies, error: copiesError } = await client.from("tasks")
    .select("id, copied_from_task_id, user_id")
    .eq("weekly_plan_id", destination.id)
    .order("copied_from_task_id");
  if (copiesError) throw copiesError;
  const source = plans.find((plan) => plan.id === sourcePlanId);
  return { plans, destination, copies, source };
}

const identical = await createUserClients("identical");
const identicalLegacy = await insertLegacyTasks(identical.clients[0], identical.user.id, "Identical");
const identicalSource = await createFirstPlan(identical.clients[0], identicalLegacy, "2031-01-06");
const identicalSourceTasks = await sourceTaskIds(identical.clients[0], identicalSource);
const identicalArgs = {
  p_source_plan_id: identicalSource,
  p_task_ids: identicalSourceTasks,
  p_week_start: "2031-01-13",
};

const identicalStartedAt = performance.now();
const identicalResponses = await Promise.all(identical.clients.map((client) => client.rpc("start_next_week", identicalArgs)));
const identicalElapsedMs = Math.round(performance.now() - identicalStartedAt);
if (identicalResponses.some((response) => response.error)) {
  throw new Error(`Identical concurrent request failed: ${identicalResponses.map((response) => response.error?.message).join(" | ")}`);
}
const identicalReturnedIds = identicalResponses.map((response) => response.data);
if (new Set(identicalReturnedIds).size !== 1) throw new Error("Identical requests returned different plan IDs.");

const identicalState = await accountState(identical.clients[0], identical.user.id, identicalSource, "2031-01-13");
const identicalCopiedSources = identicalState.copies.map((task) => task.copied_from_task_id).sort();
if (identicalState.plans.length !== 2
  || identicalState.source?.status !== "completed"
  || identicalState.destination.status !== "published"
  || identicalState.copies.length !== identicalSourceTasks.length
  || JSON.stringify(identicalCopiedSources) !== JSON.stringify([...identicalSourceTasks].sort())
  || identicalState.copies.some((task) => task.user_id !== identical.user.id)) {
  throw new Error("Identical concurrency final state was incorrect.");
}

console.log(JSON.stringify({
  test: "simultaneous_identical_rollover",
  status: "PASS",
  elapsedMs: identicalElapsedMs,
  returnedPlanIds: identicalReturnedIds,
  finalPlanCount: identicalState.plans.length,
  finalCopiedTaskCount: identicalState.copies.length,
  copiedSourceIds: identicalCopiedSources,
  sourceStatus: identicalState.source.status,
  destinationStatus: identicalState.destination.status,
}));

const conflicting = await createUserClients("conflicting");
const conflictingLegacy = await insertLegacyTasks(conflicting.clients[0], conflicting.user.id, "Conflicting");
const conflictingSource = await createFirstPlan(conflicting.clients[0], conflictingLegacy, "2031-02-03");
const conflictingSourceTasks = await sourceTaskIds(conflicting.clients[0], conflictingSource);
const selections = [conflictingSourceTasks, [conflictingSourceTasks[0]]];
const conflictingRequests = selections.map((selection, index) => conflicting.clients[index].rpc("start_next_week", {
  p_source_plan_id: conflictingSource,
  p_task_ids: selection,
  p_week_start: "2031-02-10",
}));

const conflictStartedAt = performance.now();
const conflictingResponses = await Promise.all(conflictingRequests);
const conflictElapsedMs = Math.round(performance.now() - conflictStartedAt);
const successfulIndexes = conflictingResponses.flatMap((response, index) => response.error ? [] : [index]);
const failedIndexes = conflictingResponses.flatMap((response, index) => response.error ? [index] : []);
if (successfulIndexes.length !== 1 || failedIndexes.length !== 1) {
  throw new Error(`Expected one success and one conflict, got ${JSON.stringify(conflictingResponses)}`);
}
const winnerIndex = successfulIndexes[0];
const loserIndex = failedIndexes[0];
if (!conflictingResponses[loserIndex].error.message.includes("different task selection")) {
  throw new Error(`Unexpected conflict error: ${conflictingResponses[loserIndex].error.message}`);
}

const conflictingState = await accountState(conflicting.clients[0], conflicting.user.id, conflictingSource, "2031-02-10");
const expectedSources = [...selections[winnerIndex]].sort();
const actualSources = conflictingState.copies.map((task) => task.copied_from_task_id).sort();
if (conflictingState.plans.length !== 2
  || conflictingState.source?.status !== "completed"
  || conflictingState.destination.status !== "published"
  || JSON.stringify(actualSources) !== JSON.stringify(expectedSources)
  || conflictingState.copies.some((task) => task.user_id !== conflicting.user.id)) {
  throw new Error("Conflicting concurrency final state was incorrect or partially committed.");
}

const winnerRetry = await conflicting.clients[winnerIndex].rpc("start_next_week", {
  p_source_plan_id: conflictingSource,
  p_task_ids: selections[winnerIndex],
  p_week_start: "2031-02-10",
});
if (winnerRetry.error || winnerRetry.data !== conflictingResponses[winnerIndex].data) {
  throw new Error("Winning request was not idempotent after concurrent execution.");
}
const loserRetry = await conflicting.clients[loserIndex].rpc("start_next_week", {
  p_source_plan_id: conflictingSource,
  p_task_ids: selections[loserIndex],
  p_week_start: "2031-02-10",
});
if (!loserRetry.error?.message.includes("different task selection")) {
  throw new Error("Losing conflicting request did not remain rejected.");
}

console.log(JSON.stringify({
  test: "simultaneous_conflicting_rollover",
  status: "PASS",
  elapsedMs: conflictElapsedMs,
  requestResults: conflictingResponses.map((response, index) => ({
    selectionCount: selections[index].length,
    returnedPlanId: response.data,
    error: response.error?.message ?? null,
  })),
  winnerSelectionCount: selections[winnerIndex].length,
  finalPlanCount: conflictingState.plans.length,
  finalCopiedTaskCount: conflictingState.copies.length,
  copiedSourceIds: actualSources,
  sourceStatus: conflictingState.source.status,
  destinationStatus: conflictingState.destination.status,
  winnerRetryReturnedSamePlan: true,
  loserRetryRemainedRejected: true,
}));
