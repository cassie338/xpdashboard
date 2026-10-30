"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  categories,
  completionEvents,
  eventsForSelection,
  tasksForSelection,
  xpTotal,
  type Category,
  type LearnerProfile,
  type ParentStruggleObservation,
  type PlanSelection,
  type StoredDashboard,
  type SupportMode,
  type Task,
  type TaskSwapRequest,
  type WeeklyPlan,
  type XPEvent,
} from "@/lib/dashboard-model";
import { addDays, currentWeekStart, dateForDay, dayForDate, DAYS, type Day, shortDate, weekLabel } from "@/lib/week";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type View = "learner" | "parent";
type AuthMode = "signin" | "signup";

const STORAGE_KEY = "xp-dashboard-week-v2";
const LEGACY_STORAGE_KEY = "xp-dashboard-week-v1";
const confettiColors = ["#6741d9", "#ff9f43", "#c7f36b", "#4ca6d8", "#ff6b7a"];
const sampleTasks: Task[] = [
  { id: "math-practice", learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Math practice", category: "Math", day: "Monday", xp: 25, position: 0, supportMode: "independent" },
  { id: "read-book", learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Read for 20 minutes", category: "Reading", day: "Tuesday", xp: 20, position: 0, supportMode: "independent" },
  { id: "writing", learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Write one great paragraph", category: "Writing", day: "Wednesday", xp: 25, position: 0, supportMode: "independent" },
  { id: "laundry", learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Fold and put away laundry", category: "Life Skills", day: "Thursday", xp: 15, position: 0, supportMode: "with_parent" },
  { id: "build", learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Build something creative", category: "Creative", day: "Friday", xp: 30, position: 0, supportMode: "independent" },
];

const defaultDashboard: StoredDashboard = {
  learnerName: "My Learner",
  plans: [],
  tasks: sampleTasks,
  xpEvents: [],
  taskSessions: [],
  helpRequests: [],
  parentStruggles: [],
  taskSwapRequests: [],
  legacySickDays: [],
};

function loadLocalDashboard(): StoredDashboard {
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    try {
      const parsed = JSON.parse(current) as StoredDashboard;
      return {
        ...defaultDashboard,
        ...parsed,
        plans: (parsed.plans ?? []).map((plan) => ({ ...plan, learnerId: plan.learnerId ?? "local", dailyRewards: plan.dailyRewards ?? {} })),
        tasks: (parsed.tasks ?? []).map((task, position) => ({ ...task, learnerId: task.learnerId ?? "local", position: task.position ?? position, supportMode: task.supportMode ?? "independent" })),
        xpEvents: (parsed.xpEvents ?? []).map((event) => ({ ...event, learnerId: event.learnerId ?? "local" })),
        taskSessions: parsed.taskSessions ?? [],
        helpRequests: parsed.helpRequests ?? [],
        parentStruggles: parsed.parentStruggles ?? [],
        taskSwapRequests: parsed.taskSwapRequests ?? [],
      };
    } catch {
      return defaultDashboard;
    }
  }

  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return defaultDashboard;
  try {
    const parsed = JSON.parse(legacy) as {
      learnerName?: string;
      sickDays?: Day[];
      tasks?: Array<Omit<Task, "learnerId" | "weeklyPlanId" | "copiedFromTaskId" | "removedAt">>;
      xpEvents?: Array<Omit<XPEvent, "learnerId" | "weeklyPlanId">>;
    };
    return {
      learnerName: parsed.learnerName ?? defaultDashboard.learnerName,
      plans: [],
      legacySickDays: parsed.sickDays ?? [],
      tasks: (parsed.tasks ?? sampleTasks).map((task, position) => ({ ...task, learnerId: "local", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, position, supportMode: "independent" })),
      xpEvents: (parsed.xpEvents ?? []).map((event) => ({ ...event, learnerId: "local", weeklyPlanId: null })),
      taskSessions: [],
      helpRequests: [],
      parentStruggles: [],
      taskSwapRequests: [],
    };
  } catch {
    return defaultDashboard;
  }
}

async function loadLearners(client: SupabaseClient, userId: string): Promise<LearnerProfile[]> {
  const { data, error } = await client.from("learners").select("id, display_name, is_default").eq("user_id", userId).order("created_at");
  if (error) throw error;
  return (data ?? []).map((learner) => ({ id: learner.id, displayName: learner.display_name, isDefault: learner.is_default }));
}

async function loadSupabaseDashboard(client: SupabaseClient, userId: string, learnerId: string, importLocal = true): Promise<StoredDashboard> {
  const [settingsResult, plansResult, tasksResult, eventsResult, sessionsResult, helpResult, strugglesResult, swapsResult] = await Promise.all([
    client.from("dashboard_settings").select("learner_name, sick_days, initialized").eq("user_id", userId).eq("learner_id", learnerId).maybeSingle(),
    client.from("weekly_plans").select("id, learner_id, week_start, status, sick_days, daily_rewards, created_at, completed_at").eq("user_id", userId).eq("learner_id", learnerId).order("week_start", { ascending: false }),
    client.from("tasks").select("id, learner_id, weekly_plan_id, copied_from_task_id, removed_at, name, category, day, xp, position, support_mode, created_at").eq("user_id", userId).eq("learner_id", learnerId).order("position").order("created_at"),
    client.from("xp_events").select("id, learner_id, weekly_plan_id, task_id, amount, reason, earned_at").eq("user_id", userId).eq("learner_id", learnerId).order("earned_at"),
    client.from("task_sessions").select("id, task_id, started_at, ended_at, status").eq("user_id", userId).eq("learner_id", learnerId).order("started_at"),
    client.from("help_requests").select("id, task_id, status, requested_at, resolved_at").eq("user_id", userId).eq("learner_id", learnerId).order("requested_at", { ascending: false }),
    client.from("parent_struggle_observations").select("id, task_id, category, description, provenance, recorded_at").eq("user_id", userId).eq("learner_id", learnerId).order("recorded_at", { ascending: false }),
    client.from("task_swap_requests").select("id, weekly_plan_id, original_task_id, replacement_task_id, day, requested_name, status, requested_at, reviewed_at").eq("user_id", userId).eq("learner_id", learnerId).order("requested_at", { ascending: false }),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (plansResult.error) throw plansResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (eventsResult.error) throw eventsResult.error;
  if (sessionsResult.error) throw sessionsResult.error;
  if (helpResult.error) throw helpResult.error;
  if (strugglesResult.error) throw strugglesResult.error;
  if (swapsResult.error) throw swapsResult.error;

  const settings = settingsResult.data;
  if (!settings?.initialized && importLocal) {
    const local = loadLocalDashboard();
    if (local.plans.length > 0) {
      throw new Error("Local dated plans cannot be flattened into Legacy / Unassigned. Use an isolated migration before importing this browser.");
    }
    const activeLocalTasks = completionEvents(local.xpEvents);
    const { error: importError } = await client.rpc("import_legacy_dashboard", {
      p_learner_name: local.learnerName,
      p_sick_days: local.legacySickDays,
      p_tasks: local.tasks.filter((task) => !task.removedAt).map((task) => ({ id: task.id, name: task.name, category: task.category, day: task.day, xp: task.xp })),
      p_completed_task_ids: [...activeLocalTasks.keys()],
    });
    if (importError) throw importError;
    return loadSupabaseDashboard(client, userId, learnerId, false);
  }

  return {
    learnerName: settings?.learner_name ?? defaultDashboard.learnerName,
    legacySickDays: (settings?.sick_days ?? []) as Day[],
    plans: (plansResult.data ?? []).map((plan) => ({
      id: plan.id,
      learnerId: plan.learner_id,
      weekStart: plan.week_start,
      status: plan.status,
      sickDays: plan.sick_days as Day[],
      dailyRewards: (plan.daily_rewards ?? {}) as Partial<Record<Day, string>>,
      createdAt: plan.created_at,
      completedAt: plan.completed_at,
    })),
    tasks: (tasksResult.data ?? []).map((task) => ({
      id: task.id,
      learnerId: task.learner_id,
      weeklyPlanId: task.weekly_plan_id,
      copiedFromTaskId: task.copied_from_task_id,
      removedAt: task.removed_at,
      name: task.name,
      category: task.category as Category,
      day: task.day as Day,
      xp: task.xp,
      position: task.position,
      supportMode: task.support_mode as SupportMode,
    })),
    xpEvents: (eventsResult.data ?? []).map((event) => ({
      id: event.id,
      learnerId: event.learner_id,
      weeklyPlanId: event.weekly_plan_id,
      taskId: event.task_id,
      amount: event.amount,
      earnedAt: event.earned_at,
      reason: event.reason as XPEvent["reason"],
    })),
    taskSessions: (sessionsResult.data ?? []).map((session) => ({
      id: session.id,
      taskId: session.task_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      status: session.status as "started" | "completed",
    })),
    helpRequests: (helpResult.data ?? []).map((request) => ({
      id: request.id,
      taskId: request.task_id,
      status: request.status as "requested" | "resolved",
      requestedAt: request.requested_at,
      resolvedAt: request.resolved_at,
    })),
    parentStruggles: (strugglesResult.data ?? []).map((observation) => ({
      id: observation.id,
      taskId: observation.task_id,
      category: observation.category as Category,
      description: observation.description,
      provenance: observation.provenance as ParentStruggleObservation["provenance"],
      recordedAt: observation.recorded_at,
    })),
    taskSwapRequests: (swapsResult.data ?? []).map((request) => ({
      id: request.id,
      weeklyPlanId: request.weekly_plan_id,
      originalTaskId: request.original_task_id,
      replacementTaskId: request.replacement_task_id,
      day: request.day as Day,
      requestedName: request.requested_name,
      status: request.status as TaskSwapRequest["status"],
      requestedAt: request.requested_at,
      reviewedAt: request.reviewed_at,
    })),
  };
}

function ProgressTracker({ label, earned, target, tone, detail }: { label: string; earned: number; target: number; tone: "daily" | "weekly"; detail: string }) {
  const rawPercent = target > 0 ? Math.round((earned / target) * 100) : 0;
  const barPercent = target > 0 ? Math.min(100, rawPercent) : earned > 0 ? 100 : 0;
  const progressLabel = target === 0 && earned > 0 ? "Extra XP" : `${rawPercent}%`;
  return (
    <div className="tracker">
      <div className="flex items-end justify-between gap-3"><div><p className="tracker-label">{label}</p><p className="mt-1 text-2xl font-black tabular-nums">{earned}<span className="text-sm text-[var(--muted)]"> / {target} XP</span></p></div><span className="font-black text-[var(--purple)]">{progressLabel}</span></div>
      <div className="progress-track" aria-label={`${label}: ${earned} of ${target} XP`}><div className={`progress-fill progress-fill-${tone}`} style={{ width: `${barPercent}%` }} /></div>
      <p className="mt-2 text-xs font-bold text-[var(--muted)]">{detail}</p>
    </div>
  );
}

export function WeeklyDashboard() {
  const supabase = getSupabaseBrowserClient();
  const [view, setView] = useState<View>("learner");
  const [selectedPlan, setSelectedPlan] = useState<PlanSelection>("legacy");
  const [excludedRolloverTasks, setExcludedRolloverTasks] = useState<Set<string>>(new Set());
  const [celebrationDay, setCelebrationDay] = useState<Day | null>(null);
  const [showParentGate, setShowParentGate] = useState(false);
  const [parentAnswer, setParentAnswer] = useState("");
  const [parentGateError, setParentGateError] = useState(false);
  const [dashboard, setDashboard] = useState<StoredDashboard>(defaultDashboard);
  const [ready, setReady] = useState(false);
  const [authChecked, setAuthChecked] = useState(!supabase);
  const [userId, setUserId] = useState<string | null>(null);
  const [learners, setLearners] = useState<LearnerProfile[]>([]);
  const [selectedLearnerId, setSelectedLearnerId] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [syncError, setSyncError] = useState("");
  const [rollingOver, setRollingOver] = useState(false);
  const [taskName, setTaskName] = useState("");
  const [taskXP, setTaskXP] = useState(20);
  const [taskDay, setTaskDay] = useState<Day>("Monday");
  const [taskCategory, setTaskCategory] = useState<Category>("Math");
  const [taskSupportMode, setTaskSupportMode] = useState<SupportMode>("independent");
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [helpMessage, setHelpMessage] = useState("");
  const [showSwapForm, setShowSwapForm] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [newLearnerName, setNewLearnerName] = useState("");
  const [addingLearner, setAddingLearner] = useState(false);

  useEffect(() => {
    if (supabase) {
      const client = supabase;
      client.auth.getUser().then(async ({ data, error }) => {
        if (error || !data.user) {
          await client.auth.signOut({ scope: "local" });
          setUserId(null);
        } else {
          setUserId(data.user.id);
        }
        setAuthChecked(true);
      });
      const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
        window.requestAnimationFrame(() => {
          setUserId(session?.user.id ?? null);
          setReady(false);
          if (!session) {
            setLearners([]);
            setSelectedLearnerId(null);
          }
          setAuthChecked(true);
        });
      });
      return () => listener.subscription.unsubscribe();
    }
    const frame = window.requestAnimationFrame(() => {
      const local = loadLocalDashboard();
      setLearners([{ id: "local", displayName: local.learnerName, isDefault: true }]);
      setSelectedLearnerId("local");
      setDashboard(local);
      setSelectedPlan(local.plans[0]?.id ?? "legacy");
      setReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [supabase]);

  useEffect(() => {
    if (!supabase || !userId) return;
    let active = true;
    const client = supabase;
    const refreshLearners = async () => {
      try {
        const next = await loadLearners(client, userId);
        if (!active) return;
        setLearners(next);
        setSelectedLearnerId((current) => next.some((learner) => learner.id === current)
          ? current
          : next.find((learner) => learner.isDefault)?.id ?? next[0]?.id ?? null);
      } catch (error) {
        if (active) setSyncError(error instanceof Error ? error.message : "Unable to load learners.");
      }
    };
    void refreshLearners();
    const channel = client.channel(`learners-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "learners", filter: `user_id=eq.${userId}` }, refreshLearners)
      .subscribe();
    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [supabase, userId]);

  useEffect(() => {
    if (!supabase || !userId || !selectedLearnerId) return;
    let active = true;
    const client = supabase;
    const refresh = async () => {
      try {
        const next = await loadSupabaseDashboard(client, userId, selectedLearnerId);
        if (active) {
          setDashboard(next);
          setSelectedPlan((current) => current === "legacy" && next.plans.length === 0
            ? "legacy"
            : next.plans.some((plan) => plan.id === current) ? current : next.plans[0]?.id ?? "legacy");
          setReady(true);
          setSyncError("");
        }
      } catch (error) {
        if (active) setSyncError(error instanceof Error ? error.message : "Unable to synchronize the dashboard.");
      }
    };
    void refresh();
    const channel = client.channel(`dashboard-${userId}-${selectedLearnerId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "dashboard_settings", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "weekly_plans", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "xp_events", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "task_sessions", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "help_requests", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "parent_struggle_observations", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "task_swap_requests", filter: `learner_id=eq.${selectedLearnerId}` }, refresh)
      .subscribe();
    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [supabase, userId, selectedLearnerId]);

  useEffect(() => {
    if (ready && !supabase) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboard));
  }, [dashboard, ready, supabase]);

  async function reloadRemote(preferredPlan?: PlanSelection) {
    if (!supabase || !userId || !selectedLearnerId) return;
    const next = await loadSupabaseDashboard(supabase, userId, selectedLearnerId, false);
    setDashboard(next);
    if (preferredPlan) setSelectedPlan(preferredPlan);
    setSyncError("");
  }

  const plan = selectedPlan === "legacy" ? null : dashboard.plans.find((candidate) => candidate.id === selectedPlan) ?? null;
  const isFirstPlanSetup = selectedPlan === "legacy" && dashboard.plans.length === 0;
  const selectedTasks = tasksForSelection(dashboard.tasks, selectedPlan, selectedLearnerId ?? "local");
  const selectedEvents = eventsForSelection(dashboard.xpEvents, selectedPlan, selectedLearnerId ?? "local");
  const earnedByTask = completionEvents(selectedEvents);
  const sickDays = plan?.sickDays ?? dashboard.legacySickDays;
  const orderedTasks = [...selectedTasks].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.position - b.position || a.name.localeCompare(b.name));
  const incompleteTasks = orderedTasks.filter((task) => !earnedByTask.has(task.id));
  const expectedIncompleteTasks = incompleteTasks.filter((task) => !sickDays.includes(task.day));
  const todayIncomplete = expectedIncompleteTasks.filter((task) => task.day === dayForDate());
  const suggestedTask = todayIncomplete[0] ?? expectedIncompleteTasks.find((task) => DAYS.indexOf(task.day) >= DAYS.indexOf(dayForDate())) ?? expectedIncompleteTasks[0] ?? null;
  const focusedTask = incompleteTasks.find((task) => task.id === focusedTaskId) ?? suggestedTask;
  const activeSession = focusedTask ? dashboard.taskSessions.find((session) => session.taskId === focusedTask.id && !session.endedAt) ?? null : null;
  const activeHelpRequest = focusedTask ? dashboard.helpRequests.find((request) => request.taskId === focusedTask.id && request.status === "requested") ?? null : null;
  const focusedDayTasks = focusedTask ? orderedTasks.filter((task) => task.day === focusedTask.day && !sickDays.includes(task.day)) : [];
  const focusedDayXP = focusedDayTasks.filter((task) => earnedByTask.has(task.id)).reduce((total, task) => total + task.xp, 0);
  const focusedDayPlannedXP = focusedDayTasks.reduce((total, task) => total + task.xp, 0);
  const selectedTaskIds = new Set(selectedTasks.map((task) => task.id));
  const activePlanHelpRequests = dashboard.helpRequests.filter((request) => request.status === "requested" && selectedTaskIds.has(request.taskId));
  const parentLedTasks = orderedTasks.filter((task) => task.supportMode === "with_parent");
  const selectedSwapRequests = plan ? dashboard.taskSwapRequests.filter((request) => request.weeklyPlanId === plan.id) : [];
  const focusedPendingSwap = focusedTask ? selectedSwapRequests.find((request) => request.originalTaskId === focusedTask.id && request.status === "pending") ?? null : null;
  const focusedDayActiveSwap = focusedTask ? selectedSwapRequests.find((request) => request.day === focusedTask.day && (request.status === "pending" || request.status === "approved")) ?? null : null;
  const editable = plan?.status === "published";
  const selectedWeekStart = plan?.weekStart ?? currentWeekStart();
  const earnedXP = xpTotal(selectedEvents);
  const todayDay = dayForDate();
  const expectedTasks = selectedTasks.filter((task) => !sickDays.includes(task.day));
  const plannedXP = expectedTasks.reduce((total, task) => total + task.xp, 0);
  const todayTasks = selectedTasks.filter((task) => task.day === todayDay);
  const todayIsSick = sickDays.includes(todayDay);
  const todayPlannedXP = todayIsSick ? 0 : todayTasks.reduce((total, task) => total + task.xp, 0);
  const dailyXP = todayTasks.filter((task) => earnedByTask.has(task.id)).reduce((total, task) => total + task.xp, 0);
  const expectedTasksLeft = expectedTasks.filter((task) => !earnedByTask.has(task.id)).length;
  const allComplete = selectedTasks.length > 0 && expectedTasksLeft === 0;
  const hasFollowingPlan = plan ? dashboard.plans.some((candidate) => candidate.weekStart === addDays(plan.weekStart, 7)) : dashboard.plans.length > 0;
  const latestPlan = dashboard.plans[0] ?? null;
  const canStartNextWeek = selectedTasks.length > 0 && !hasFollowingPlan && (
    selectedPlan === "legacy" ? dashboard.plans.length === 0 : editable && plan?.id === latestPlan?.id
  );
  const showDailyProgress = plan?.status === "published" && plan.weekStart === currentWeekStart();
  const rolloverTasks = selectedTasks.filter((task) => !excludedRolloverTasks.has(task.id));
  const nextWeekStart = plan ? addDays(plan.weekStart, 7) : currentWeekStart();

  function changeLearner(learnerId: string) {
    setReady(false);
    setSelectedPlan("legacy");
    setExcludedRolloverTasks(new Set());
    setCelebrationDay(null);
    setShowSwapForm(false);
    setSelectedLearnerId(learnerId);
  }

  function changeSelection(selection: PlanSelection) {
    setSelectedPlan(selection);
    setExcludedRolloverTasks(new Set());
    setShowSwapForm(false);
  }

  function toggleRolloverTask(taskId: string) {
    setExcludedRolloverTasks((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  async function toggleTask(task: Task) {
    if (!editable) return;
    if (dashboard.taskSwapRequests.some((request) => request.originalTaskId === task.id && request.status === "pending")) {
      setSyncError("A parent needs to review this swap before the task can be completed.");
      return;
    }
    const complete = earnedByTask.has(task.id);
    if (supabase && userId) {
      const { error } = await supabase.rpc("record_task_completion", { p_task_id: task.id, p_complete: !complete });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => {
        const taskBalance = current.xpEvents.filter((event) => event.taskId === task.id).reduce((total, event) => total + event.amount, 0);
        const currentlyComplete = taskBalance > 0;
        const now = new Date().toISOString();
        return {
          ...current,
          taskSessions: currentlyComplete ? current.taskSessions : current.taskSessions.map((session) => session.taskId === task.id && !session.endedAt ? { ...session, status: "completed", endedAt: now } : session),
          xpEvents: [...current.xpEvents, {
          id: crypto.randomUUID(),
          learnerId: task.learnerId,
          taskId: task.id,
          weeklyPlanId: task.weeklyPlanId,
          amount: currentlyComplete ? -taskBalance : task.xp,
          earnedAt: now,
          reason: currentlyComplete ? "task_unchecked" : "task_completed",
        }],
        };
      });
    }
    if (!complete && !sickDays.includes(task.day)) {
      const otherTasksForDay = selectedTasks.filter((candidate) => candidate.day === task.day && candidate.id !== task.id);
      if (otherTasksForDay.every((candidate) => earnedByTask.has(candidate.id))) setCelebrationDay(task.day);
    }
  }

  async function startFocusedTask() {
    if (!focusedTask || !editable) return;
    setHelpMessage("");
    if (supabase && userId) {
      const { error } = await supabase.rpc("start_task", { p_task_id: focusedTask.id });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        taskSessions: [...current.taskSessions, { id: crypto.randomUUID(), taskId: focusedTask.id, startedAt: new Date().toISOString(), endedAt: null, status: "started" }],
      }));
    }
  }

  async function requestHelp() {
    if (!focusedTask) return;
    setHelpMessage("");
    if (!supabase) {
      setDashboard((current) => ({ ...current, helpRequests: [...current.helpRequests, { id: crypto.randomUUID(), taskId: focusedTask.id, status: "requested", requestedAt: new Date().toISOString(), resolvedAt: null }] }));
      setHelpMessage("Your help request is saved for your parent.");
      return;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return setSyncError("Sign in again to request help.");
    const response = await fetch("/api/help-request", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskId: focusedTask.id }),
    });
    const result = await response.json() as { error?: string; emailed?: boolean };
    if (!response.ok) return setSyncError(result.error ?? "Unable to request help.");
    setHelpMessage(result.emailed ? "Your parent got an email. Help is on the way." : "Your help request is saved for your parent.");
    await reloadRemote();
  }

  async function resolveHelpRequest(requestId: string) {
    if (!supabase) {
      setDashboard((current) => ({ ...current, helpRequests: current.helpRequests.map((request) => request.id === requestId ? { ...request, status: "resolved", resolvedAt: new Date().toISOString() } : request) }));
      return;
    }
    const { error } = await supabase.rpc("resolve_help_request", { p_help_request_id: requestId });
    if (error) return setSyncError(error.message);
    await reloadRemote();
  }

  async function setSupportMode(task: Task, supportMode: SupportMode) {
    if (!supabase) {
      setDashboard((current) => ({ ...current, tasks: current.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, supportMode } : candidate) }));
      return;
    }
    const { error } = await supabase.rpc("set_task_support_mode", { p_task_id: task.id, p_support_mode: supportMode });
    if (error) return setSyncError(error.message);
    await reloadRemote();
  }

  async function saveDailyReward(day: Day, reward: string) {
    if (!plan) return;
    if (!supabase) {
      setDashboard((current) => ({ ...current, plans: current.plans.map((candidate) => candidate.id === plan.id ? { ...candidate, dailyRewards: { ...candidate.dailyRewards, [day]: reward.trim() } } : candidate) }));
      return;
    }
    const { error } = await supabase.rpc("set_daily_reward", { p_weekly_plan_id: plan.id, p_day: day, p_reward: reward });
    if (error) return setSyncError(error.message);
    await reloadRemote();
  }

  async function recordParentStruggle(event: React.FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault();
    if (!editable || task.supportMode !== "with_parent") return;
    const form = event.currentTarget;
    const description = String(new FormData(form).get("description") ?? "").trim();
    if (!description) return;
    setSyncError("");
    if (!supabase) {
      setDashboard((current) => ({
        ...current,
        parentStruggles: [{ id: crypto.randomUUID(), taskId: task.id, category: task.category, description, provenance: "parent_reported", recordedAt: new Date().toISOString() }, ...current.parentStruggles],
      }));
      form.reset();
      return;
    }
    const { error } = await supabase.rpc("record_parent_struggle", { p_task_id: task.id, p_description: description });
    if (error) return setSyncError(error.message);
    form.reset();
    await reloadRemote();
  }

  async function requestTaskSwap(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!focusedTask || !editable || activeSession || focusedDayActiveSwap) return;
    const form = event.currentTarget;
    const requestedName = String(new FormData(form).get("requestedName") ?? "").trim();
    if (!requestedName) return;
    setSyncError("");
    if (!supabase) {
      setDashboard((current) => ({
        ...current,
        taskSwapRequests: [{ id: crypto.randomUUID(), weeklyPlanId: focusedTask.weeklyPlanId as string, originalTaskId: focusedTask.id, replacementTaskId: null, day: focusedTask.day, requestedName, status: "pending", requestedAt: new Date().toISOString(), reviewedAt: null }, ...current.taskSwapRequests],
      }));
      form.reset();
      setShowSwapForm(false);
      return;
    }
    const { error } = await supabase.rpc("request_task_swap", { p_task_id: focusedTask.id, p_requested_name: requestedName });
    if (error) return setSyncError(error.message);
    form.reset();
    setShowSwapForm(false);
    await reloadRemote();
  }

  async function reviewTaskSwap(request: TaskSwapRequest, approve: boolean) {
    setSyncError("");
    if (!supabase) {
      const now = new Date().toISOString();
      setDashboard((current) => {
        const original = current.tasks.find((task) => task.id === request.originalTaskId);
        if (!original) return current;
        const replacementId = approve ? crypto.randomUUID() : null;
        return {
          ...current,
          tasks: approve ? [...current.tasks.map((task) => task.id === original.id ? { ...task, removedAt: now } : task), { ...original, id: replacementId as string, copiedFromTaskId: null, removedAt: null, name: request.requestedName }] : current.tasks,
          taskSwapRequests: current.taskSwapRequests.map((candidate) => candidate.id === request.id ? { ...candidate, status: approve ? "approved" : "rejected", replacementTaskId: replacementId, reviewedAt: now } : candidate),
        };
      });
      return;
    }
    const { error } = await supabase.rpc("review_task_swap", { p_swap_request_id: request.id, p_approve: approve });
    if (error) return setSyncError(error.message);
    await reloadRemote();
  }

  async function reorderDay(day: Day, taskIds: string[]) {
    if (!plan) return;
    if (!supabase) {
      const positions = new Map(taskIds.map((id, position) => [id, position]));
      setDashboard((current) => ({ ...current, tasks: current.tasks.map((task) => task.day === day && positions.has(task.id) ? { ...task, position: positions.get(task.id) as number } : task) }));
      return;
    }
    const { error } = await supabase.rpc("reorder_daily_tasks", { p_weekly_plan_id: plan.id, p_day: day, p_task_ids: taskIds });
    if (error) return setSyncError(error.message);
    await reloadRemote();
  }

  async function moveTask(task: Task, direction: -1 | 1) {
    const dayTasks = selectedTasks.filter((candidate) => candidate.day === task.day).sort((a, b) => a.position - b.position);
    const index = dayTasks.findIndex((candidate) => candidate.id === task.id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= dayTasks.length) return;
    [dayTasks[index], dayTasks[destination]] = [dayTasks[destination], dayTasks[index]];
    await reorderDay(task.day, dayTasks.map((candidate) => candidate.id));
  }

  async function dropTask(target: Task) {
    if (!draggedTaskId || draggedTaskId === target.id) return setDraggedTaskId(null);
    const dayTasks = selectedTasks.filter((candidate) => candidate.day === target.day).sort((a, b) => a.position - b.position);
    const from = dayTasks.findIndex((candidate) => candidate.id === draggedTaskId);
    const to = dayTasks.findIndex((candidate) => candidate.id === target.id);
    setDraggedTaskId(null);
    if (from < 0 || to < 0) return;
    const [moved] = dayTasks.splice(from, 1);
    dayTasks.splice(to, 0, moved);
    await reorderDay(target.day, dayTasks.map((candidate) => candidate.id));
  }

  async function addTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = taskName.trim();
    if (!name || !plan || !editable) return;
    if (supabase && userId) {
      const { error } = await supabase.rpc("create_weekly_task", {
        p_weekly_plan_id: plan.id,
        p_name: name,
        p_category: taskCategory,
        p_day: taskDay,
        p_xp: taskXP,
        p_support_mode: taskSupportMode,
      });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        tasks: [...current.tasks, { id: crypto.randomUUID(), learnerId: plan.learnerId, weeklyPlanId: plan.id, copiedFromTaskId: null, removedAt: null, name, category: taskCategory, day: taskDay, xp: taskXP, position: selectedTasks.filter((task) => task.day === taskDay).length, supportMode: taskSupportMode }],
      }));
    }
    setTaskName("");
    setTaskSupportMode("independent");
  }

  async function removeTask(taskId: string) {
    if (!editable || earnedByTask.has(taskId)) return;
    if (supabase && userId) {
      const { error } = await supabase.rpc("delete_weekly_task", { p_task_id: taskId });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        tasks: current.tasks.map((task) => task.id === taskId ? { ...task, removedAt: new Date().toISOString() } : task),
      }));
    }
  }

  async function toggleSickDay(day: Day) {
    if (!plan || !editable) return;
    const nextSickDays = sickDays.includes(day) ? sickDays.filter((sickDay) => sickDay !== day) : [...sickDays, day];
    if (supabase && userId) {
      const { error } = await supabase.rpc("set_weekly_plan_sick_days", { p_weekly_plan_id: plan.id, p_sick_days: nextSickDays });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        plans: current.plans.map((candidate) => candidate.id === plan.id ? { ...candidate, sickDays: nextSickDays } : candidate),
      }));
    }
  }

  async function startNextWeek() {
    if (!canStartNextWeek || rolloverTasks.length === 0) return;
    setRollingOver(true);
    setSyncError("");
    try {
      if (supabase && userId) {
        const { data, error } = await supabase.rpc("start_next_week", {
          p_source_plan_id: plan?.id ?? null,
          p_task_ids: rolloverTasks.map((task) => task.id),
          p_week_start: nextWeekStart,
        });
        if (error) throw error;
        await reloadRemote(data as string);
      } else {
        const existing = dashboard.plans.find((candidate) => candidate.weekStart === nextWeekStart);
        const selectedIds = rolloverTasks.map((task) => task.id).sort();
        if (existing) {
          const copiedIds = dashboard.tasks.filter((task) => task.weeklyPlanId === existing.id && task.copiedFromTaskId).map((task) => task.copiedFromTaskId as string).sort();
          if (JSON.stringify(copiedIds) !== JSON.stringify(selectedIds)) throw new Error("This weekly plan already exists with a different task selection.");
          setSelectedPlan(existing.id);
        } else {
          const newPlanId = crypto.randomUUID();
          const now = new Date().toISOString();
          const newPlan: WeeklyPlan = { id: newPlanId, learnerId: plan?.learnerId ?? selectedLearnerId ?? "local", weekStart: nextWeekStart, status: "published", sickDays: [...sickDays], dailyRewards: {}, createdAt: now, completedAt: null };
          const copiedTasks = rolloverTasks.map((task) => ({ ...task, id: crypto.randomUUID(), weeklyPlanId: newPlanId, copiedFromTaskId: task.id, removedAt: null }));
          setDashboard((current) => ({
            ...current,
            plans: [newPlan, ...current.plans.map((candidate) => plan && candidate.id === plan.id ? { ...candidate, status: "completed" as const, completedAt: now } : candidate)],
            tasks: [...current.tasks, ...copiedTasks],
          }));
          setSelectedPlan(newPlanId);
        }
        setExcludedRolloverTasks(new Set());
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Unable to start the next week.");
    } finally {
      setRollingOver(false);
    }
  }

  async function saveLearnerName() {
    if (!dashboard.learnerName.trim() || !selectedLearnerId) return;
    if (supabase && userId) {
      const { error } = await supabase.rpc("set_learner_name", { p_learner_id: selectedLearnerId, p_display_name: dashboard.learnerName.trim() });
      if (error) return setSyncError(error.message);
      setLearners(await loadLearners(supabase, userId));
      setSyncError("");
    } else {
      setLearners((current) => current.map((learner) => learner.id === selectedLearnerId ? { ...learner, displayName: dashboard.learnerName.trim() } : learner));
    }
  }

  async function addLearner(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = newLearnerName.trim();
    if (!supabase || !userId || !displayName) return;
    setAddingLearner(true);
    setSyncError("");
    try {
      const { data, error } = await supabase.rpc("create_family_learner", { p_display_name: displayName, p_week_start: currentWeekStart() });
      if (error) throw error;
      const nextLearners = await loadLearners(supabase, userId);
      setLearners(nextLearners);
      changeLearner(data as string);
      setNewLearnerName("");
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Unable to add learner.");
    } finally {
      setAddingLearner(false);
    }
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthMessage("");
    const result = authMode === "signup"
      ? await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword })
      : await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
    if (result.error) return setAuthMessage(result.error.message);
    if (authMode === "signup" && !result.data.session) setAuthMessage("Check your email, confirm the account, then return here to sign in.");
  }

  function requestParentView() {
    if (view === "parent") return;
    setParentAnswer("");
    setParentGateError(false);
    setShowParentGate(true);
  }

  function submitParentGate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (parentAnswer.trim() !== "1987") return setParentGateError(true);
    setView("parent");
    setShowParentGate(false);
    setParentAnswer("");
  }

  if (supabase && !authChecked) return <main className="auth-page"><div className="auth-card text-center"><p className="label">XP Dashboard</p><h1 className="mt-2 text-3xl font-black">Connecting your family...</h1></div></main>;
  if (supabase && !userId) return <main className="auth-page"><form className="auth-card" onSubmit={submitAuth}><div className="grid h-14 w-14 place-items-center rounded-xl bg-[var(--ink)] text-xl font-black text-white">XP</div><p className="label mt-6">Shared family account</p><h1 className="mt-2 text-3xl font-black">{authMode === "signin" ? "Sign in to your week" : "Create your family login"}</h1><p className="mt-3 text-sm font-semibold text-[var(--muted)]">Use the same login once on your computer and your learner&apos;s computer.</p><label className="field-label mt-6">Email<input className="field" type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required /></label><label className="field-label mt-4">Password<input className="field" type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={8} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required /></label>{authMessage ? <p className="mt-4 rounded-xl bg-[var(--paper)] p-3 text-sm font-bold" role="status">{authMessage}</p> : null}<button className="primary-button mt-5 w-full" type="submit">{authMode === "signin" ? "Sign in" : "Create account"}</button><button className="mt-4 w-full text-sm font-black text-[var(--purple)]" type="button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthMessage(""); }}>{authMode === "signin" ? "First time? Create the family account" : "Already have an account? Sign in"}</button></form></main>;
  if (supabase && !ready) return <main className="auth-page"><div className="auth-card text-center"><p className="label">XP Dashboard</p><h1 className="mt-2 text-3xl font-black">Loading your week...</h1>{syncError ? <p className="mt-4 font-bold text-[var(--danger)]">{syncError}</p> : null}</div></main>;

  return (
    <main className="min-h-screen px-4 py-5 sm:px-7 lg:px-10">
      <div className="mx-auto max-w-[1400px]">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--ink)] text-xl font-black text-white">XP</div><div><p className="text-xs font-black uppercase tracking-[.22em] text-[var(--muted)]">Weekly effort</p><h1 className="text-2xl font-black tracking-tight">XP Dashboard</h1></div></div>
          <div className="flex flex-wrap items-center gap-3"><label className="week-picker-label">Learner<select className="week-picker" value={selectedLearnerId ?? ""} onChange={(event) => changeLearner(event.target.value)}>{learners.map((learner) => <option key={learner.id} value={learner.id}>{learner.displayName}</option>)}</select></label><label className="week-picker-label">View week<select className="week-picker" value={selectedPlan} onChange={(event) => changeSelection(event.target.value)}>{dashboard.plans.map((candidate) => <option key={candidate.id} value={candidate.id}>{weekLabel(candidate.weekStart)}{candidate.status === "completed" ? " · History" : " · Current"}</option>)}<option value="legacy">{isFirstPlanSetup ? `${weekLabel()} · Setup` : "Legacy / Unassigned"}</option></select></label><div className="flex rounded-xl border border-[var(--line)] bg-white p-1"><button className={`mode-button ${view === "learner" ? "mode-button-active" : ""}`} onClick={() => setView("learner")}>Learner</button><button className={`mode-button ${view === "parent" ? "mode-button-active" : ""}`} onClick={requestParentView}>Parent</button></div>{supabase ? <button className="text-sm font-black text-[var(--muted)]" type="button" onClick={() => void supabase.auth.signOut()}>Sign out</button> : null}</div>
        </header>

        {syncError ? <p className="mt-4 rounded-xl bg-[#fff0ec] p-3 text-sm font-bold text-[var(--danger)]" role="alert">Sync problem: {syncError}</p> : null}
        {isFirstPlanSetup ? <p className="history-notice mt-5"><strong>Set up this week:</strong> A parent can include or exclude the tasks below, then start the week to make its task copies editable.</p> : selectedPlan === "legacy" ? <p className="history-notice mt-5"><strong>Legacy / Unassigned:</strong> These records are preserved exactly as they were. They are read-only and are not counted in any dated weekly plan.</p> : plan?.status === "completed" ? <p className="history-notice mt-5"><strong>Completed week:</strong> This history is read-only. Its tasks and XP cannot be changed.</p> : null}

        <section className="overview-panel mt-5">
          <div className="reminder-panel"><p className="text-xs font-black uppercase tracking-[.18em] text-[var(--purple)]">{isFirstPlanSetup ? weekLabel(selectedWeekStart) : selectedPlan === "legacy" ? "Legacy / Unassigned" : weekLabel(selectedWeekStart)}</p><h2 className="mt-2 max-w-2xl text-3xl font-black leading-[1.04] tracking-[-.03em] sm:text-4xl">{isFirstPlanSetup ? "Choose this week's tasks." : allComplete ? `You cleared the week, ${dashboard.learnerName}!` : editable ? "Finish early. Enjoy your whole day free." : "A preserved record of effort."}</h2><p className="mt-3 max-w-xl text-sm font-semibold text-[var(--muted)] sm:text-base">{isFirstPlanSetup ? "Open Parent view, adjust what belongs this week, then start the week." : editable ? "Choose any task, on any day. Every finished task moves you closer to free time." : "Past effort stays visible without changing earned XP."}</p></div>
          <div className="xp-summary">{showDailyProgress && view === "parent" ? <ProgressTracker label="Daily" earned={dailyXP} target={todayPlannedXP} tone="daily" detail={todayIsSick ? "Sick Day · Tasks were optional" : `${todayDay}'s assigned tasks`} /> : null}<ProgressTracker label={isFirstPlanSetup ? "Weekly preview" : selectedPlan === "legacy" ? "Legacy" : "Weekly"} earned={isFirstPlanSetup ? 0 : earnedXP} target={plannedXP} tone="weekly" detail={isFirstPlanSetup ? `${rolloverTasks.length} tasks selected · Parent setup needed` : `${expectedTasksLeft} expected tasks left · Sick Days removed`} /></div>
        </section>

        {view === "learner" ? (
          <section className="mt-5">
            <div className="mb-4">
              <p className="label">One step at a time</p>
              <h2 className="mt-1 text-3xl font-black">What do I do next?</h2>
            </div>

            {editable && focusedTask ? (
              <article className="focus-card">
                <div className="focus-card-main">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="focus-day">{focusedTask.day}</span>
                    <span className="support-badge">{focusedTask.supportMode === "with_parent" ? "Do with a parent" : "Try it independently"}</span>
                  </div>
                  <p className="mt-5 text-sm font-black uppercase tracking-[.16em] text-[var(--muted)]">{activeSession ? "You are working on" : focusedTask.id === suggestedTask?.id ? "Suggested next" : "You chose"}</p>
                  <h3 className="mt-2 text-4xl font-black leading-tight tracking-[-.03em]">{focusedTask.name}</h3>
                  <p className="mt-2 font-bold text-[var(--muted)]">{focusedTask.category} · Earn {focusedTask.xp} XP for your effort</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    {!activeSession ? <button className="primary-button focus-action" type="button" onClick={() => void startFocusedTask()} disabled={Boolean(focusedPendingSwap)}>{focusedTask.supportMode === "with_parent" ? "Start with my parent" : "Start this task"}</button> : <button className="primary-button focus-action" type="button" onClick={() => void toggleTask(focusedTask)}>I finished it</button>}
                    <button className="secondary-button focus-action" type="button" onClick={() => void requestHelp()} disabled={Boolean(activeHelpRequest)}>{activeHelpRequest ? "Help requested" : "I need help"}</button>
                    <button className="secondary-button focus-action" type="button" onClick={() => setShowSwapForm((current) => !current)} disabled={Boolean(activeSession || focusedDayActiveSwap)}>{focusedPendingSwap ? "Swap pending" : focusedDayActiveSwap ? "Daily swap used" : "Swap this activity"}</button>
                  </div>
                  {focusedPendingSwap ? <p className="swap-status mt-4"><strong>Waiting for parent approval:</strong> {focusedPendingSwap.requestedName}</p> : null}
                  {showSwapForm && !focusedDayActiveSwap ? <form className="swap-form mt-4" onSubmit={(event) => void requestTaskSwap(event)}><label className="field-label">What do you want to do instead?<input className="field" name="requestedName" placeholder="Piano" maxLength={80} autoFocus required /></label><div className="mt-2 grid grid-cols-2 gap-2"><button className="secondary-button" type="button" onClick={() => setShowSwapForm(false)}>Cancel</button><button className="primary-button" type="submit">Ask my parent</button></div><p>One approved swap is allowed each day.</p></form> : null}
                  {helpMessage ? <p className="mt-4 rounded-xl bg-white/70 p-3 text-sm font-black" role="status">{helpMessage}</p> : null}
                </div>
                <aside className="focus-progress">
                  <ProgressTracker label="Daily" earned={focusedDayXP} target={focusedDayPlannedXP} tone="daily" detail={sickDays.includes(focusedTask.day) ? "Sick Day · Tasks are optional" : `${focusedTask.day}'s assigned tasks`} />
                  {plan?.dailyRewards[focusedTask.day] ? <div className="reward-note"><span aria-hidden>★</span><p><strong>When the day is done</strong>{plan.dailyRewards[focusedTask.day]}</p></div> : null}
                </aside>
              </article>
            ) : allComplete && plan ? (
              <article className="focus-card focus-card-complete"><div><p className="label">The week is complete</p><h3 className="mt-2 text-4xl font-black">You did every task!</h3><p className="mt-3 font-bold text-[var(--muted)]">Your effort earned {earnedXP} XP.</p></div></article>
            ) : <p className="paper-panel font-bold text-[var(--muted)]">A parent needs to start the week before tasks appear here.</p>}

            {editable && incompleteTasks.length > 1 ? <label className="mt-4 block max-w-xl text-sm font-black">Want to choose something else?<select className="field mt-2" value={focusedTask?.id ?? ""} onChange={(event) => { setFocusedTaskId(event.target.value); setHelpMessage(""); setShowSwapForm(false); }}>{incompleteTasks.map((task) => <option key={task.id} value={task.id}>{task.day}: {task.name}</option>)}</select></label> : null}

            <div className="mb-4 mt-8 flex items-end justify-between"><div><p className="label">Monday through Sunday</p><h2 className="mt-1 text-3xl font-black">My whole week</h2></div><p className="hidden font-bold text-[var(--muted)] sm:block">{isFirstPlanSetup ? "Parent setup needed" : editable ? "You may choose another task." : "Read-only history"}</p></div>
            <div className="week-grid">
              {DAYS.map((day) => {
                const dayTasks = orderedTasks.filter((task) => task.day === day);
                const dayDate = dateForDay(day, selectedWeekStart);
                const isSickDay = sickDays.includes(day);
                const clearedEarly = selectedPlan !== "legacy" && dayTasks.length > 0 && dayTasks.every((task) => { const event = earnedByTask.get(task.id); return event ? new Date(event.earnedAt) < dayDate : false; });
                const isToday = showDailyProgress && dayDate.toDateString() === new Date().toDateString();
                const dateCaption = selectedPlan === "legacy" && !isFirstPlanSetup ? "Unassigned" : isToday ? "Today" : shortDate(day, selectedWeekStart);
                return <article key={day} className={`day-card ${isToday ? "day-card-today" : ""} ${clearedEarly ? "day-card-cleared" : ""} ${isSickDay ? "day-card-sick" : ""}`}><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-black uppercase tracking-[.16em] text-[var(--muted)]">{dateCaption}</p><h3 className="mt-1 text-xl font-black">{day}</h3></div>{isSickDay ? <span className="sick-badge">Sick Day</span> : clearedEarly ? <span className="off-badge">Day off</span> : null}</div>{isSickDay ? <p className="mt-2 text-xs font-bold text-[var(--muted)]">These tasks are optional, but their earned XP is preserved.</p> : null}<div className="mt-4 grid gap-3">{dayTasks.map((task) => { const complete = earnedByTask.has(task.id); return <div key={task.id} className={`task-button ${complete ? "task-button-complete" : ""} ${focusedTask?.id === task.id ? "task-button-focused" : ""}`}><button className="task-check-button" type="button" onClick={() => void toggleTask(task)} aria-label={`${complete ? "Undo" : "Complete"} ${task.name}`} aria-pressed={complete} disabled={!editable}><span className="task-check" aria-hidden>{complete ? "✓" : ""}</span></button><button className="task-select-button" type="button" onClick={() => { if (!editable) return; if (complete) void toggleTask(task); else setFocusedTaskId(task.id); }} disabled={!editable}><span className="min-w-0 flex-1 text-left"><strong className="block leading-tight">{task.name}</strong><small className="mt-1 block font-bold text-[var(--muted)]">{complete ? "Completed · Tap to undo" : task.supportMode === "with_parent" ? "With a parent" : task.category}</small></span><span className="whitespace-nowrap font-black text-[var(--purple)]">+{task.xp}</span></button></div>; })}{!dayTasks.length ? <p className="rounded-xl border-2 border-dashed border-[var(--line)] p-4 text-center text-sm font-bold text-[var(--muted)]">Open day</p> : null}</div></article>;
              })}
            </div>
          </section>
        ) : (
          <section className="mt-7 grid gap-6 lg:grid-cols-[.72fr_1.28fr]">
            <div className="grid h-fit gap-6">
              {selectedSwapRequests.length ? <div className="paper-panel"><p className="label">Needs parent review</p><h2 className="mt-1 text-2xl font-black">Swap requests</h2><p className="mt-2 text-sm font-semibold text-[var(--muted)]">An approved swap keeps the original XP and counts toward the day&apos;s reward.</p><div className="mt-4 grid gap-3">{selectedSwapRequests.map((request) => { const original = dashboard.tasks.find((task) => task.id === request.originalTaskId); return <article key={request.id} className={`swap-request swap-request-${request.status}`}><div><span className="status-badge">{request.status}</span><h3 className="mt-2 font-black">{original?.name ?? "Original activity"} → {request.requestedName}</h3><p>{request.day} · {original?.xp ?? 0} XP · Requested {new Date(request.requestedAt).toLocaleString()}</p></div>{request.status === "pending" && editable ? <div className="mt-3 grid grid-cols-2 gap-2"><button className="secondary-button" type="button" onClick={() => void reviewTaskSwap(request, false)}>Keep original</button><button className="primary-button" type="button" onClick={() => void reviewTaskSwap(request, true)}>Approve swap</button></div> : null}</article>; })}</div></div> : null}
              {parentLedTasks.length ? <div className="paper-panel"><p className="label">Parent-led work</p><h2 className="mt-1 text-2xl font-black">Struggles</h2><p className="mt-2 text-sm font-semibold text-[var(--muted)]">Save what you noticed during work together. These notes do not change XP or completion.</p><div className="mt-5 grid gap-5">{categories.map((category) => { const categoryTasks = parentLedTasks.filter((task) => task.category === category); if (!categoryTasks.length) return null; return <section key={category} className="struggle-category"><h3>{category}</h3><div className="mt-3 grid gap-3">{categoryTasks.map((task) => { const observations = dashboard.parentStruggles.filter((observation) => observation.taskId === task.id); return <article key={task.id} className="struggle-task"><div><strong>{task.name}</strong><p>{task.day} · Parent-led</p></div>{editable ? <form className="mt-3" onSubmit={(event) => void recordParentStruggle(event, task)}><label className="field-label">Struggle noticed<textarea className="field struggle-field" name="description" aria-label={`Struggle noticed for ${task.name}`} placeholder="Describe what was difficult or the error you noticed" maxLength={1000} required /></label><button className="secondary-button mt-2 w-full" type="submit">Save struggle</button></form> : null}<div className="mt-3 grid gap-2">{observations.map((observation) => <div key={observation.id} className="struggle-observation"><p>{observation.description}</p><small>Parent reported · {new Date(observation.recordedAt).toLocaleString()}</small></div>)}{!observations.length ? <p className="text-xs font-bold text-[var(--muted)]">No struggles recorded yet.</p> : null}</div></article>; })}</div></section>; })}</div></div> : null}
              {plan && editable ? <div className="paper-panel"><p className="label">Next-task setup</p><h2 className="mt-1 text-2xl font-black">Plan each day</h2><p className="mt-2 text-sm font-semibold text-[var(--muted)]">Drag tasks into a suggested order. Learners may still choose another task.</p><div className="mt-5 grid gap-5">{DAYS.map((day) => { const dayTasks = orderedTasks.filter((task) => task.day === day); return <section key={day} className="parent-day-plan"><div className="flex items-center justify-between gap-3"><h3 className="text-lg font-black">{day}</h3><button className={`sick-day-button ${sickDays.includes(day) ? "sick-day-button-active" : ""}`} type="button" onClick={() => void toggleSickDay(day)}>{sickDays.includes(day) ? "Sick day" : "Mark sick"}</button></div><label className="field-label mt-3">Daily reward<input key={`${plan.id}-${day}-${plan.dailyRewards[day] ?? ""}`} className="field" defaultValue={plan.dailyRewards[day] ?? ""} placeholder="Example: choose tonight's game" maxLength={160} onBlur={(event) => void saveDailyReward(day, event.currentTarget.value)} /></label><div className="mt-3 grid gap-2">{dayTasks.map((task, index) => <div key={task.id} className="parent-order-row" draggable onDragStart={() => setDraggedTaskId(task.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropTask(task)}><span className="drag-handle" aria-hidden>⋮⋮</span><div className="min-w-0 flex-1"><strong className="block truncate">{task.name}</strong><select className="support-select" value={task.supportMode} onChange={(event) => void setSupportMode(task, event.target.value as SupportMode)} aria-label={`Support for ${task.name}`}><option value="independent">Try independently</option><option value="with_parent">Do with a parent</option></select></div><div className="flex gap-1"><button className="order-button" type="button" onClick={() => void moveTask(task, -1)} disabled={index === 0} aria-label={`Move ${task.name} earlier`}>↑</button><button className="order-button" type="button" onClick={() => void moveTask(task, 1)} disabled={index === dayTasks.length - 1} aria-label={`Move ${task.name} later`}>↓</button></div></div>)}</div></section>; })}</div></div> : null}
              {activePlanHelpRequests.length ? <div className="paper-panel"><p className="label">Needs you</p><h2 className="mt-1 text-2xl font-black">Help requests</h2><div className="mt-4 grid gap-3">{activePlanHelpRequests.map((request) => { const task = selectedTasks.find((candidate) => candidate.id === request.taskId); return <div key={request.id} className="help-request-row"><div><strong>{task?.name ?? "Task"}</strong><p>{task?.day} · Requested {new Date(request.requestedAt).toLocaleString()}</p></div><button className="secondary-button" type="button" onClick={() => void resolveHelpRequest(request.id)}>Resolved</button></div>; })}</div></div> : null}
              {supabase ? <form className="paper-panel" onSubmit={addLearner}><p className="label">Family learners</p><h2 className="mt-1 text-2xl font-black">Add another learner</h2><p className="mt-2 text-sm font-semibold text-[var(--muted)]">Each learner gets a separate weekly plan, task history, and XP total under this family login.</p><label className="field-label mt-5">Learner name<input className="field" value={newLearnerName} onChange={(event) => setNewLearnerName(event.target.value)} placeholder="Learner name" maxLength={80} required /></label><button className="secondary-button mt-4 w-full" type="submit" disabled={addingLearner}>{addingLearner ? "Adding learner..." : "Add learner"}</button></form> : null}
              <form className="paper-panel" onSubmit={addTask}><p className="label">Plan the week</p><h2 className="mt-1 text-3xl font-black">Add a task</h2>{editable ? <><label className="field-label mt-6">Task name<input className="field" value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="Read for 20 minutes" maxLength={80} required /></label><div className="mt-4 grid grid-cols-2 gap-3"><label className="field-label">Planned day<select className="field" value={taskDay} onChange={(event) => setTaskDay(event.target.value as Day)}>{DAYS.map((day) => <option key={day}>{day}</option>)}</select></label><label className="field-label">XP<input className="field" type="number" min="1" max="500" value={taskXP} onChange={(event) => setTaskXP(Number(event.target.value))} required /></label></div><label className="field-label mt-4">Category<select className="field" value={taskCategory} onChange={(event) => setTaskCategory(event.target.value as Category)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><button className="primary-button mt-5 w-full" type="submit">Add to the week</button></> : <p className="mt-5 font-bold text-[var(--muted)]">Select the current published week to add tasks.</p>}</form>
              {canStartNextWeek ? <div className="paper-panel"><p className="label">{plan ? "Rollover" : "First dated plan"}</p><h2 className="mt-1 text-2xl font-black">{plan ? "Start next week" : "Start this week"}</h2><p className="mt-2 text-sm font-semibold text-[var(--muted)]">Copy selected tasks into {weekLabel(nextWeekStart)}. New task IDs and a fresh completion state will be created.</p>{plan ? <div className="mt-4 grid gap-2">{selectedTasks.map((task) => <label key={task.id} className="rollover-task"><input type="checkbox" checked={!excludedRolloverTasks.has(task.id)} onChange={() => toggleRolloverTask(task.id)} /><span><strong>{task.name}</strong><small>{task.day} · {task.xp} XP</small></span></label>)}</div> : <p className="mt-4 rounded-xl bg-[var(--paper)] p-3 text-sm font-bold text-[var(--muted)]">Use the Include controls in the weekly plan, then start the week. After it starts, you can add or remove its task copies.</p>}<button className="primary-button mt-5 w-full" type="button" disabled={rollingOver || rolloverTasks.length === 0} onClick={() => void startNextWeek()}>{rollingOver ? "Starting week..." : plan ? "Start next week" : "Start first weekly plan"}</button></div> : null}
            </div>

            <div className="paper-panel"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="label">Parent controls</p><h2 className="mt-1 text-3xl font-black">Weekly plan</h2></div><span className={`status-badge ${editable ? "status-current" : ""}`}>{isFirstPlanSetup ? "Setup" : selectedPlan === "legacy" ? "Legacy" : plan?.status === "completed" ? "Completed" : "Current"}</span></div><div className="mt-6 grid items-end gap-3 sm:grid-cols-[1fr_auto]"><label className="field-label">Learner name<input className="field" value={dashboard.learnerName} onChange={(event) => setDashboard((current) => ({ ...current, learnerName: event.target.value }))} onBlur={() => void saveLearnerName()} /></label><div className="rounded-xl bg-[var(--paper)] px-4 py-3"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--muted)]">Goals update automatically</p><p className="mt-1 font-black">{showDailyProgress ? `Today: ${todayPlannedXP} XP · ` : ""}Week: {isFirstPlanSetup ? rolloverTasks.filter((task) => !sickDays.includes(task.day)).reduce((total, task) => total + task.xp, 0) : plannedXP} XP</p></div></div><div className="mt-6 overflow-hidden rounded-xl border border-[var(--line)] bg-white">{DAYS.flatMap((day) => selectedTasks.filter((task) => task.day === day)).map((task) => { const complete = earnedByTask.has(task.id); const included = !excludedRolloverTasks.has(task.id); return <div key={task.id} className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-[var(--line)] p-4 first:border-t-0"><div><strong>{task.name}</strong><p className="mt-1 text-sm font-bold text-[var(--muted)]">{task.day} · {task.category} · {task.xp} XP</p></div>{isFirstPlanSetup ? <button className="remove-button" type="button" onClick={() => toggleRolloverTask(task.id)} aria-pressed={included} aria-label={`${included ? "Exclude" : "Include"} ${task.name}`}>{included ? "Included" : "Excluded"}</button> : editable ? <button className="remove-button" type="button" onClick={() => void removeTask(task.id)} aria-label={complete ? `${task.name} has earned XP` : `Remove ${task.name}`} disabled={complete}>{complete ? "Earned" : "Remove"}</button> : <span className="text-xs font-black uppercase text-[var(--muted)]">Preserved</span>}</div>; })}{!selectedTasks.length ? <p className="p-8 text-center font-bold text-[var(--muted)]">No tasks in this view.</p> : null}</div></div>
          </section>
        )}

        <footer className="mt-12 border-t-2 border-[var(--ink)] py-6 text-sm font-bold text-[var(--muted)]">Effort earns XP. Working ahead earns freedom.</footer>
      </div>
      {showParentGate ? <div className="gate-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowParentGate(false); }}><form className="gate-dialog" role="dialog" aria-modal="true" aria-labelledby="parent-gate-title" onSubmit={submitParentGate}><p className="label">Parent check</p><h2 id="parent-gate-title" className="mt-2 text-2xl font-black">What is your birthyear?</h2><label className="field-label mt-5">Birth year<input className="field" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={parentAnswer} onChange={(event) => { setParentAnswer(event.target.value); setParentGateError(false); }} autoFocus required /></label>{parentGateError ? <p className="mt-3 text-sm font-bold text-[var(--danger)]" role="alert">That answer is not correct.</p> : null}<div className="mt-5 grid grid-cols-2 gap-3"><button className="secondary-button" type="button" onClick={() => setShowParentGate(false)}>Cancel</button><button className="primary-button" type="submit">Continue</button></div></form></div> : null}
      {celebrationDay ? <div className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title">{Array.from({ length: 56 }, (_, index) => <span key={index} className="confetti-piece" style={{ left: `${(index * 37) % 100}%`, top: `${(index * 53) % 100}%`, backgroundColor: confettiColors[index % confettiColors.length], animationDelay: `${(index % 14) * 70}ms`, animationDuration: `${1800 + (index % 7) * 170}ms`, width: index % 3 === 0 ? "12px" : "8px", height: index % 4 === 0 ? "18px" : "11px" }} aria-hidden />)}<div className="celebration-card"><div className="celebration-star" aria-hidden>★</div><p className="label text-[var(--purple)]">Daily goal complete</p><h2 id="celebration-title" className="mt-2 text-4xl font-black tracking-tight">You cleared {celebrationDay}!</h2><p className="mt-3 font-semibold text-[var(--muted)]">Every XP point for the day is complete. Great work!</p><button className="primary-button mt-6 w-full" type="button" onClick={() => setCelebrationDay(null)} autoFocus>Awesome!</button></div></div> : null}
    </main>
  );
}
