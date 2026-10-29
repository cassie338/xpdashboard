import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" }));
const url = new URL(status.API_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55321") {
  throw new Error(`Refusing non-local Supabase target: ${url.host}`);
}

const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
if (!publishableKey || !secretKey) throw new Error("Local Supabase keys are unavailable.");

const admin = createClient(url.origin, secretKey, { auth: { persistSession: false } });
const password = `Local-only-${crypto.randomUUID()}-A1!`;
const suffix = crypto.randomUUID();
const emails = [`rls-a-${suffix}@example.invalid`, `rls-b-${suffix}@example.invalid`];

const users = [];
for (const email of emails) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error(`Failed to create ${email}`);
  users.push(data.user);
}

const clients = [];
for (const email of emails) {
  const client = createClient(url.origin, publishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  clients.push(client);
}

const [clientA, clientB] = clients;
const [userA, userB] = users;

async function createFirstPlan(client, userId, name) {
  const { data: task, error: taskError } = await client.from("tasks").insert({
    user_id: userId,
    name,
    category: "Math",
    day: "Monday",
    xp: 15,
  }).select("id").single();
  if (taskError) throw taskError;

  const { data: planId, error: planError } = await client.rpc("start_next_week", {
    p_source_plan_id: null,
    p_task_ids: [task.id],
    p_week_start: "2030-01-07",
  });
  if (planError) throw planError;

  const { data: copiedTask, error: copiedError } = await client.from("tasks")
    .select("id")
    .eq("weekly_plan_id", planId)
    .single();
  if (copiedError) throw copiedError;

  const { error: completionError } = await client.rpc("record_task_completion", {
    p_task_id: copiedTask.id,
    p_complete: true,
  });
  if (completionError) throw completionError;
  return { legacyTaskId: task.id, planId, copiedTaskId: copiedTask.id };
}

const recordsA = await createFirstPlan(clientA, userA.id, "Auth user A task");
const recordsB = await createFirstPlan(clientB, userB.id, "Auth user B task");

async function assertCannotAccess(attacker, attackerUser, ownerUser, ownerRecords, attackerRecords) {
  for (const table of ["dashboard_settings", "weekly_plans", "tasks", "xp_events"]) {
    const { data, error } = await attacker.from(table).select("*").eq("user_id", ownerUser.id);
    if (error) throw error;
    if (data.length !== 0) throw new Error(`${attackerUser.email} read ${ownerUser.email} ${table}`);
  }

  const { data: settingsUpdate, error: settingsError } = await attacker.from("dashboard_settings")
    .update({ learner_name: "Forbidden" })
    .eq("user_id", ownerUser.id)
    .select("user_id");
  if (settingsError) throw settingsError;
  if (settingsUpdate.length !== 0) throw new Error("Cross-user settings update changed a row.");

  const { data: deletedTasks, error: deleteError } = await attacker.from("tasks")
    .delete()
    .eq("id", ownerRecords.legacyTaskId)
    .select("id");
  if (deleteError) throw deleteError;
  if (deletedTasks.length !== 0) throw new Error("Cross-user task delete changed a row.");

  const { error: completionError } = await attacker.rpc("record_task_completion", {
    p_task_id: ownerRecords.copiedTaskId,
    p_complete: false,
  });
  if (!completionError) throw new Error("Cross-user completion RPC unexpectedly succeeded.");

  const { error: rolloverError } = await attacker.rpc("start_next_week", {
    p_source_plan_id: ownerRecords.planId,
    p_task_ids: [ownerRecords.copiedTaskId],
    p_week_start: "2030-01-14",
  });
  if (!rolloverError) throw new Error("Cross-user rollover RPC unexpectedly succeeded.");

  const { error: copiedSourceError } = await attacker.from("tasks").insert({
    user_id: attackerUser.id,
    weekly_plan_id: attackerRecords.planId,
    copied_from_task_id: ownerRecords.copiedTaskId,
    name: "Forbidden copy",
    category: "Math",
    day: "Tuesday",
    xp: 10,
  });
  if (!copiedSourceError) throw new Error("Cross-user copied_from_task_id unexpectedly succeeded.");

  const { error: xpUpdateError } = await attacker.from("xp_events")
    .update({ amount: 999 })
    .eq("user_id", ownerUser.id);
  if (!xpUpdateError) throw new Error("Cross-user XP update unexpectedly succeeded.");

  const { error: xpDeleteError } = await attacker.from("xp_events")
    .delete()
    .eq("user_id", ownerUser.id);
  if (!xpDeleteError) throw new Error("Cross-user XP delete unexpectedly succeeded.");
}

await assertCannotAccess(clientA, userA, userB, recordsB, recordsA);
await assertCannotAccess(clientB, userB, userA, recordsA, recordsB);

console.log("real_auth_sessions|PASS|Two local Auth users signed in with separate access tokens.");
console.log("symmetric_cross_user_reads|PASS|Each user saw zero rows belonging to the other across settings, plans, tasks, and XP events.");
console.log("symmetric_cross_user_mutations|PASS|Settings update, task delete, completion, rollover, task copy, and XP update/delete attempts were rejected in both directions.");
