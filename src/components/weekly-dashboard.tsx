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
  type PlanSelection,
  type StoredDashboard,
  type Task,
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
  { id: "math-practice", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Math practice", category: "Math", day: "Monday", xp: 25 },
  { id: "read-book", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Read for 20 minutes", category: "Reading", day: "Tuesday", xp: 20 },
  { id: "writing", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Write one great paragraph", category: "Writing", day: "Wednesday", xp: 25 },
  { id: "laundry", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Fold and put away laundry", category: "Life Skills", day: "Thursday", xp: 15 },
  { id: "build", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Build something creative", category: "Creative", day: "Friday", xp: 30 },
];

const defaultDashboard: StoredDashboard = {
  learnerName: "My Learner",
  plans: [],
  tasks: sampleTasks,
  xpEvents: [],
  legacySickDays: [],
};

function loadLocalDashboard(): StoredDashboard {
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    try {
      return { ...defaultDashboard, ...JSON.parse(current) as StoredDashboard };
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
      tasks?: Array<Omit<Task, "weeklyPlanId" | "copiedFromTaskId">>;
      xpEvents?: Array<Omit<XPEvent, "weeklyPlanId">>;
    };
    return {
      learnerName: parsed.learnerName ?? defaultDashboard.learnerName,
      plans: [],
      legacySickDays: parsed.sickDays ?? [],
      tasks: (parsed.tasks ?? sampleTasks).map((task) => ({ ...task, weeklyPlanId: null, copiedFromTaskId: null, removedAt: null })),
      xpEvents: (parsed.xpEvents ?? []).map((event) => ({ ...event, weeklyPlanId: null })),
    };
  } catch {
    return defaultDashboard;
  }
}

async function loadSupabaseDashboard(client: SupabaseClient, userId: string, importLocal = true): Promise<StoredDashboard> {
  const [settingsResult, plansResult, tasksResult, eventsResult] = await Promise.all([
    client.from("dashboard_settings").select("learner_name, sick_days, initialized").eq("user_id", userId).maybeSingle(),
    client.from("weekly_plans").select("id, week_start, status, sick_days, created_at, completed_at").eq("user_id", userId).order("week_start", { ascending: false }),
    client.from("tasks").select("id, weekly_plan_id, copied_from_task_id, removed_at, name, category, day, xp, created_at").eq("user_id", userId).order("created_at"),
    client.from("xp_events").select("id, weekly_plan_id, task_id, amount, reason, earned_at").eq("user_id", userId).order("earned_at"),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (plansResult.error) throw plansResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (eventsResult.error) throw eventsResult.error;

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
    return loadSupabaseDashboard(client, userId, false);
  }

  if (!settings) {
    const { error } = await client.from("dashboard_settings").insert({ user_id: userId });
    if (error) throw error;
  }

  return {
    learnerName: settings?.learner_name ?? defaultDashboard.learnerName,
    legacySickDays: (settings?.sick_days ?? []) as Day[],
    plans: (plansResult.data ?? []).map((plan) => ({
      id: plan.id,
      weekStart: plan.week_start,
      status: plan.status,
      sickDays: plan.sick_days as Day[],
      createdAt: plan.created_at,
      completedAt: plan.completed_at,
    })),
    tasks: (tasksResult.data ?? []).map((task) => ({
      id: task.id,
      weeklyPlanId: task.weekly_plan_id,
      copiedFromTaskId: task.copied_from_task_id,
      removedAt: task.removed_at,
      name: task.name,
      category: task.category as Category,
      day: task.day as Day,
      xp: task.xp,
    })),
    xpEvents: (eventsResult.data ?? []).map((event) => ({
      id: event.id,
      weeklyPlanId: event.weekly_plan_id,
      taskId: event.task_id,
      amount: event.amount,
      earnedAt: event.earned_at,
      reason: event.reason as XPEvent["reason"],
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

  useEffect(() => {
    if (supabase) {
      const client = supabase;
      client.auth.getSession().then(({ data }) => {
        setUserId(data.session?.user.id ?? null);
        setAuthChecked(true);
      });
      const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
        window.requestAnimationFrame(() => {
          setUserId(session?.user.id ?? null);
          setAuthChecked(true);
        });
      });
      return () => listener.subscription.unsubscribe();
    }
    const frame = window.requestAnimationFrame(() => {
      const local = loadLocalDashboard();
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
    const refresh = async () => {
      try {
        const next = await loadSupabaseDashboard(client, userId);
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
    const channel = client.channel(`dashboard-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "dashboard_settings", filter: `user_id=eq.${userId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "weekly_plans", filter: `user_id=eq.${userId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${userId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "xp_events", filter: `user_id=eq.${userId}` }, refresh)
      .subscribe();
    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [supabase, userId]);

  useEffect(() => {
    if (ready && !supabase) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dashboard));
  }, [dashboard, ready, supabase]);

  async function reloadRemote(preferredPlan?: PlanSelection) {
    if (!supabase || !userId) return;
    const next = await loadSupabaseDashboard(supabase, userId, false);
    setDashboard(next);
    if (preferredPlan) setSelectedPlan(preferredPlan);
    setSyncError("");
  }

  const plan = selectedPlan === "legacy" ? null : dashboard.plans.find((candidate) => candidate.id === selectedPlan) ?? null;
  const isFirstPlanSetup = selectedPlan === "legacy" && dashboard.plans.length === 0;
  const selectedTasks = tasksForSelection(dashboard.tasks, selectedPlan);
  const selectedEvents = eventsForSelection(dashboard.xpEvents, selectedPlan);
  const earnedByTask = completionEvents(selectedEvents);
  const sickDays = plan?.sickDays ?? dashboard.legacySickDays;
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

  function changeSelection(selection: PlanSelection) {
    setSelectedPlan(selection);
    setExcludedRolloverTasks(new Set());
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
    const complete = earnedByTask.has(task.id);
    if (supabase && userId) {
      const { error } = await supabase.rpc("record_task_completion", { p_task_id: task.id, p_complete: !complete });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => {
        const taskBalance = current.xpEvents.filter((event) => event.taskId === task.id).reduce((total, event) => total + event.amount, 0);
        const currentlyComplete = taskBalance > 0;
        return {
          ...current,
          xpEvents: [...current.xpEvents, {
          id: crypto.randomUUID(),
          taskId: task.id,
          weeklyPlanId: task.weeklyPlanId,
          amount: currentlyComplete ? -taskBalance : task.xp,
          earnedAt: new Date().toISOString(),
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
      });
      if (error) return setSyncError(error.message);
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        tasks: [...current.tasks, { id: crypto.randomUUID(), weeklyPlanId: plan.id, copiedFromTaskId: null, removedAt: null, name, category: taskCategory, day: taskDay, xp: taskXP }],
      }));
    }
    setTaskName("");
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
          const newPlan: WeeklyPlan = { id: newPlanId, weekStart: nextWeekStart, status: "published", sickDays: [...sickDays], createdAt: now, completedAt: null };
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
    if (!supabase || !userId || !dashboard.learnerName.trim()) return;
    const { error } = await supabase.from("dashboard_settings").update({ learner_name: dashboard.learnerName.trim(), updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) setSyncError(error.message);
    else setSyncError("");
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
          <div className="flex flex-wrap items-center gap-3"><label className="week-picker-label">View week<select className="week-picker" value={selectedPlan} onChange={(event) => changeSelection(event.target.value)}>{dashboard.plans.map((candidate) => <option key={candidate.id} value={candidate.id}>{weekLabel(candidate.weekStart)}{candidate.status === "completed" ? " · History" : " · Current"}</option>)}<option value="legacy">{isFirstPlanSetup ? `${weekLabel()} · Setup` : "Legacy / Unassigned"}</option></select></label><div className="flex rounded-xl border border-[var(--line)] bg-white p-1"><button className={`mode-button ${view === "learner" ? "mode-button-active" : ""}`} onClick={() => setView("learner")}>Learner</button><button className={`mode-button ${view === "parent" ? "mode-button-active" : ""}`} onClick={requestParentView}>Parent</button></div>{supabase ? <button className="text-sm font-black text-[var(--muted)]" type="button" onClick={() => void supabase.auth.signOut()}>Sign out</button> : null}</div>
        </header>

        {syncError ? <p className="mt-4 rounded-xl bg-[#fff0ec] p-3 text-sm font-bold text-[var(--danger)]" role="alert">Sync problem: {syncError}</p> : null}
        {isFirstPlanSetup ? <p className="history-notice mt-5"><strong>Set up this week:</strong> A parent can include or exclude the tasks below, then start the week to make its task copies editable.</p> : selectedPlan === "legacy" ? <p className="history-notice mt-5"><strong>Legacy / Unassigned:</strong> These records are preserved exactly as they were. They are read-only and are not counted in any dated weekly plan.</p> : plan?.status === "completed" ? <p className="history-notice mt-5"><strong>Completed week:</strong> This history is read-only. Its tasks and XP cannot be changed.</p> : null}

        <section className="overview-panel mt-5">
          <div className="reminder-panel"><p className="text-xs font-black uppercase tracking-[.18em] text-[var(--purple)]">{isFirstPlanSetup ? weekLabel(selectedWeekStart) : selectedPlan === "legacy" ? "Legacy / Unassigned" : weekLabel(selectedWeekStart)}</p><h2 className="mt-2 max-w-2xl text-3xl font-black leading-[1.04] tracking-[-.03em] sm:text-4xl">{isFirstPlanSetup ? "Choose this week's tasks." : allComplete ? `You cleared the week, ${dashboard.learnerName}!` : editable ? "Finish early. Enjoy your whole day free." : "A preserved record of effort."}</h2><p className="mt-3 max-w-xl text-sm font-semibold text-[var(--muted)] sm:text-base">{isFirstPlanSetup ? "Open Parent view, adjust what belongs this week, then start the week." : editable ? "Choose any task, on any day. Every finished task moves you closer to free time." : "Past effort stays visible without changing earned XP."}</p></div>
          <div className="xp-summary">{showDailyProgress ? <ProgressTracker label="Daily" earned={dailyXP} target={todayPlannedXP} tone="daily" detail={todayIsSick ? "Sick Day · Tasks were optional" : `${todayDay}'s assigned tasks`} /> : null}<ProgressTracker label={isFirstPlanSetup ? "Weekly preview" : selectedPlan === "legacy" ? "Legacy" : "Weekly"} earned={isFirstPlanSetup ? 0 : earnedXP} target={plannedXP} tone="weekly" detail={isFirstPlanSetup ? `${rolloverTasks.length} tasks selected · Parent setup needed` : `${expectedTasksLeft} expected tasks left · Sick Days removed`} /></div>
        </section>

        {view === "learner" ? (
          <section className="mt-5">
            <div className="mb-4 flex items-end justify-between"><div><p className="label">Monday through Sunday</p><h2 className="mt-1 text-3xl font-black">My whole week</h2></div><p className="hidden font-bold text-[var(--muted)] sm:block">{isFirstPlanSetup ? "Parent setup needed" : editable ? "Any task. Any day." : "Read-only history"}</p></div>
            <div className="week-grid">
              {DAYS.map((day) => {
                const dayTasks = selectedTasks.filter((task) => task.day === day);
                const dayDate = dateForDay(day, selectedWeekStart);
                const isSickDay = sickDays.includes(day);
                const clearedEarly = selectedPlan !== "legacy" && dayTasks.length > 0 && dayTasks.every((task) => { const event = earnedByTask.get(task.id); return event ? new Date(event.earnedAt) < dayDate : false; });
                const isToday = showDailyProgress && dayDate.toDateString() === new Date().toDateString();
                const dateCaption = selectedPlan === "legacy" && !isFirstPlanSetup ? "Unassigned" : isToday ? "Today" : shortDate(day, selectedWeekStart);
                return <article key={day} className={`day-card ${isToday ? "day-card-today" : ""} ${clearedEarly ? "day-card-cleared" : ""} ${isSickDay ? "day-card-sick" : ""}`}><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-black uppercase tracking-[.16em] text-[var(--muted)]">{dateCaption}</p><h3 className="mt-1 text-xl font-black">{day}</h3></div>{isSickDay ? <span className="sick-badge">Sick Day</span> : clearedEarly ? <span className="off-badge">Day off</span> : null}</div>{editable ? <button className={`sick-day-button ${isSickDay ? "sick-day-button-active" : ""}`} type="button" onClick={() => void toggleSickDay(day)} aria-pressed={isSickDay}>{isSickDay ? "Remove Sick Day" : "Mark Sick Day"}</button> : null}{isSickDay ? <p className="mt-2 text-xs font-bold text-[var(--muted)]">These tasks are optional, but their earned XP is preserved.</p> : null}<div className="mt-4 grid gap-3">{dayTasks.map((task) => { const complete = earnedByTask.has(task.id); return <button key={task.id} className={`task-button ${complete ? "task-button-complete" : ""}`} onClick={() => void toggleTask(task)} aria-pressed={complete} disabled={!editable}><span className="task-check" aria-hidden>{complete ? "✓" : ""}</span><span className="min-w-0 flex-1 text-left"><strong className="block leading-tight">{task.name}</strong><small className="mt-1 block font-bold text-[var(--muted)]">{complete ? editable ? "Done · Tap to undo" : "Completed" : task.category}</small></span><span className="whitespace-nowrap font-black text-[var(--purple)]">+{task.xp}</span></button>; })}{!dayTasks.length ? <p className="rounded-xl border-2 border-dashed border-[var(--line)] p-4 text-center text-sm font-bold text-[var(--muted)]">Open day</p> : null}</div></article>;
              })}
            </div>
          </section>
        ) : (
          <section className="mt-7 grid gap-6 lg:grid-cols-[.72fr_1.28fr]">
            <div className="grid h-fit gap-6">
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
