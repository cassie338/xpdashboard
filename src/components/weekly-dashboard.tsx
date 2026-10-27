"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dateForDay, dayForDate, DAYS, type Day, shortDate, weekLabel } from "@/lib/week";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type View = "learner" | "parent";
type AuthMode = "signin" | "signup";
type Category = "Math" | "Reading" | "Writing" | "History" | "Life Skills" | "Creative";

interface Task {
  id: string;
  name: string;
  category: Category;
  day: Day;
  xp: number;
}

interface XPEvent {
  id: string;
  taskId: string;
  amount: number;
  earnedAt: string;
  reason?: "task_completed" | "task_unchecked" | "week_reset";
}

interface StoredDashboard {
  learnerName: string;
  tasks: Task[];
  xpEvents: XPEvent[];
  sickDays: Day[];
}

const STORAGE_KEY = "xp-dashboard-week-v1";
const categories: Category[] = ["Math", "Reading", "Writing", "History", "Life Skills", "Creative"];
const confettiColors = ["#6741d9", "#ff9f43", "#c7f36b", "#4ca6d8", "#ff6b7a"];
const sampleTasks: Task[] = [
  { id: "math-practice", name: "Math practice", category: "Math", day: "Monday", xp: 25 },
  { id: "read-book", name: "Read for 20 minutes", category: "Reading", day: "Tuesday", xp: 20 },
  { id: "writing", name: "Write one great paragraph", category: "Writing", day: "Wednesday", xp: 25 },
  { id: "laundry", name: "Fold and put away laundry", category: "Life Skills", day: "Thursday", xp: 15 },
  { id: "build", name: "Build something creative", category: "Creative", day: "Friday", xp: 30 },
];

const defaultDashboard: StoredDashboard = {
  learnerName: "My Learner",
  tasks: sampleTasks,
  xpEvents: [],
  sickDays: [],
};

function loadDashboard(): StoredDashboard {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return defaultDashboard;
  try {
    return { ...defaultDashboard, ...JSON.parse(stored) as StoredDashboard };
  } catch {
    return defaultDashboard;
  }
}

async function loadSupabaseDashboard(client: SupabaseClient, userId: string, importLocal = true): Promise<StoredDashboard> {
  const [{ data: settings, error: settingsError }, { data: tasks, error: tasksError }, { data: events, error: eventsError }] = await Promise.all([
    client.from("dashboard_settings").select("learner_name, sick_days, initialized").eq("user_id", userId).maybeSingle(),
    client.from("tasks").select("id, name, category, day, xp, created_at").eq("user_id", userId).order("created_at"),
    client.from("xp_events").select("id, task_id, amount, reason, earned_at").eq("user_id", userId).order("earned_at"),
  ]);
  if (settingsError) throw settingsError;
  if (tasksError) throw tasksError;
  if (eventsError) throw eventsError;

  if (!settings?.initialized && importLocal) {
    const local = loadDashboard();
    const activeLocalTasks = new Set<string>();
    for (const event of local.xpEvents) {
      if (event.amount > 0) activeLocalTasks.add(event.taskId);
      if (event.amount < 0) activeLocalTasks.delete(event.taskId);
    }
    const { error: settingsUpsertError } = await client.from("dashboard_settings").upsert({ user_id: userId, learner_name: local.learnerName, sick_days: local.sickDays, initialized: true });
    if (settingsUpsertError) throw settingsUpsertError;
    for (const task of local.tasks) {
      const { data: inserted, error: insertError } = await client.from("tasks").insert({ user_id: userId, name: task.name, category: task.category, day: task.day, xp: task.xp }).select("id").single();
      if (insertError) throw insertError;
      if (activeLocalTasks.has(task.id)) {
        const { error: completionError } = await client.rpc("record_task_completion", { p_task_id: inserted.id, p_complete: true });
        if (completionError) throw completionError;
      }
    }
    return loadSupabaseDashboard(client, userId, false);
  }

  if (!settings) {
    const { error } = await client.from("dashboard_settings").insert({ user_id: userId });
    if (error) throw error;
  }

  return {
    learnerName: settings?.learner_name ?? defaultDashboard.learnerName,
    sickDays: (settings?.sick_days ?? []) as Day[],
    tasks: (tasks ?? []).map((task) => ({ id: task.id, name: task.name, category: task.category as Category, day: task.day as Day, xp: task.xp })),
    xpEvents: (events ?? []).map((event) => ({ id: event.id, taskId: event.task_id, amount: event.amount, earnedAt: event.earned_at, reason: event.reason as XPEvent["reason"] })),
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
      setDashboard(loadDashboard());
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

  async function reloadRemote() {
    if (!supabase || !userId) return;
    const next = await loadSupabaseDashboard(supabase, userId, false);
    setDashboard(next);
  }

  const earnedByTask = new Map<string, XPEvent>();
  for (const event of dashboard.xpEvents) {
    if (event.amount > 0) earnedByTask.set(event.taskId, event);
    if (event.amount < 0) earnedByTask.delete(event.taskId);
  }
  const earnedXP = Math.max(0, dashboard.xpEvents.reduce((total, event) => total + event.amount, 0));
  const todayDay = dayForDate();
  const expectedTasks = dashboard.tasks.filter((task) => !dashboard.sickDays.includes(task.day));
  const plannedXP = expectedTasks.reduce((total, task) => total + task.xp, 0);
  const todayTasks = dashboard.tasks.filter((task) => task.day === todayDay);
  const todayIsSick = dashboard.sickDays.includes(todayDay);
  const todayPlannedXP = todayIsSick ? 0 : todayTasks.reduce((total, task) => total + task.xp, 0);
  const dailyXP = todayTasks.filter((task) => earnedByTask.has(task.id)).reduce((total, task) => total + task.xp, 0);
  const expectedTasksLeft = expectedTasks.filter((task) => !earnedByTask.has(task.id)).length;
  const allComplete = dashboard.tasks.length > 0 && expectedTasksLeft === 0;

  async function toggleTask(task: Task) {
    const complete = earnedByTask.has(task.id);
    if (supabase && userId) {
      const { error } = await supabase.rpc("record_task_completion", { p_task_id: task.id, p_complete: !complete });
      if (error) {
        setSyncError(error.message);
        return;
      }
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        xpEvents: [...current.xpEvents, {
          id: crypto.randomUUID(),
          taskId: task.id,
          amount: complete ? -task.xp : task.xp,
          earnedAt: new Date().toISOString(),
          reason: complete ? "task_unchecked" : "task_completed",
        }],
      }));
    }
    if (!complete && !dashboard.sickDays.includes(task.day)) {
      const otherTasksForDay = dashboard.tasks.filter((candidate) => candidate.day === task.day && candidate.id !== task.id);
      if (otherTasksForDay.every((candidate) => earnedByTask.has(candidate.id))) setCelebrationDay(task.day);
    }
  }

  async function addTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = taskName.trim();
    if (!name) return;
    if (supabase && userId) {
      const { error } = await supabase.from("tasks").insert({ user_id: userId, name, category: taskCategory, day: taskDay, xp: taskXP });
      if (error) {
        setSyncError(error.message);
        return;
      }
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        tasks: [...current.tasks, { id: crypto.randomUUID(), name, category: taskCategory, day: taskDay, xp: taskXP }],
      }));
    }
    setTaskName("");
  }

  async function removeTask(taskId: string) {
    if (earnedByTask.has(taskId)) return;
    if (supabase && userId) {
      const { error } = await supabase.from("tasks").delete().eq("id", taskId).eq("user_id", userId);
      if (error) {
        setSyncError(error.message);
        return;
      }
      await reloadRemote();
    } else {
      setDashboard((current) => ({
        ...current,
        tasks: current.tasks.filter((task) => task.id !== taskId),
      }));
    }
  }

  async function resetWeek() {
    if (supabase && userId) {
      const { error } = await supabase.rpc("reset_task_completions");
      if (error) {
        setSyncError(error.message);
        return;
      }
      await reloadRemote();
      return;
    }
    const resetAt = new Date().toISOString();
    setDashboard((current) => ({
      ...current,
      xpEvents: [
        ...current.xpEvents,
        ...current.tasks.flatMap((task) => earnedByTask.has(task.id)
          ? [{ id: crypto.randomUUID(), taskId: task.id, amount: -task.xp, earnedAt: resetAt, reason: "week_reset" as const }]
          : []),
      ],
    }));
  }

  async function toggleSickDay(day: Day) {
    const sickDays = dashboard.sickDays.includes(day)
      ? dashboard.sickDays.filter((sickDay) => sickDay !== day)
      : [...dashboard.sickDays, day];
    if (supabase && userId) {
      const { error } = await supabase.from("dashboard_settings").update({ sick_days: sickDays, updated_at: new Date().toISOString() }).eq("user_id", userId);
      if (error) {
        setSyncError(error.message);
        return;
      }
      await reloadRemote();
    } else {
      setDashboard((current) => ({ ...current, sickDays }));
    }
  }

  async function saveLearnerName() {
    if (!supabase || !userId || !dashboard.learnerName.trim()) return;
    const { error } = await supabase.from("dashboard_settings").update({ learner_name: dashboard.learnerName.trim(), updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) setSyncError(error.message);
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthMessage("");
    const result = authMode === "signup"
      ? await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword })
      : await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
    if (result.error) {
      setAuthMessage(result.error.message);
      return;
    }
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
    if (parentAnswer.trim() !== "1987") {
      setParentGateError(true);
      return;
    }
    setView("parent");
    setShowParentGate(false);
    setParentAnswer("");
  }

  if (supabase && !authChecked) {
    return <main className="auth-page"><div className="auth-card text-center"><p className="label">XP Dashboard</p><h1 className="mt-2 text-3xl font-black">Connecting your family...</h1></div></main>;
  }

  if (supabase && !userId) {
    return <main className="auth-page"><form className="auth-card" onSubmit={submitAuth}><div className="grid h-14 w-14 place-items-center rounded-xl bg-[var(--ink)] text-xl font-black text-white">XP</div><p className="label mt-6">Shared family account</p><h1 className="mt-2 text-3xl font-black">{authMode === "signin" ? "Sign in to your week" : "Create your family login"}</h1><p className="mt-3 text-sm font-semibold text-[var(--muted)]">Use the same login once on your computer and your learner&apos;s computer.</p><label className="field-label mt-6">Email<input className="field" type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required /></label><label className="field-label mt-4">Password<input className="field" type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={8} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required /></label>{authMessage ? <p className="mt-4 rounded-xl bg-[var(--paper)] p-3 text-sm font-bold" role="status">{authMessage}</p> : null}<button className="primary-button mt-5 w-full" type="submit">{authMode === "signin" ? "Sign in" : "Create account"}</button><button className="mt-4 w-full text-sm font-black text-[var(--purple)]" type="button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthMessage(""); }}>{authMode === "signin" ? "First time? Create the family account" : "Already have an account? Sign in"}</button></form></main>;
  }

  if (supabase && !ready) {
    return <main className="auth-page"><div className="auth-card text-center"><p className="label">XP Dashboard</p><h1 className="mt-2 text-3xl font-black">Loading your week...</h1>{syncError ? <p className="mt-4 font-bold text-[var(--danger)]">{syncError}</p> : null}</div></main>;
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-7 lg:px-10">
      <div className="mx-auto max-w-[1400px]">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--ink)] text-xl font-black text-white">XP</div>
            <div><p className="text-xs font-black uppercase tracking-[.22em] text-[var(--muted)]">Weekly effort</p><h1 className="text-2xl font-black tracking-tight">XP Dashboard</h1></div>
          </div>
          <div className="flex items-center gap-3"><div className="flex rounded-xl border border-[var(--line)] bg-white p-1"><button className={`mode-button ${view === "learner" ? "mode-button-active" : ""}`} onClick={() => setView("learner")}>Learner</button><button className={`mode-button ${view === "parent" ? "mode-button-active" : ""}`} onClick={requestParentView}>Parent</button></div>{supabase ? <button className="text-sm font-black text-[var(--muted)]" type="button" onClick={() => void supabase.auth.signOut()}>Sign out</button> : null}</div>
        </header>

        {syncError ? <p className="mt-4 rounded-xl bg-[#fff0ec] p-3 text-sm font-bold text-[var(--danger)]" role="alert">Sync problem: {syncError}</p> : null}

        <section className="overview-panel mt-5">
          <div className="reminder-panel">
            <p className="text-xs font-black uppercase tracking-[.18em] text-[var(--purple)]">{weekLabel()}</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-black leading-[1.04] tracking-[-.03em] sm:text-4xl">{allComplete ? `You cleared the week, ${dashboard.learnerName}!` : "Finish early. Enjoy your whole day free."}</h2>
            <p className="mt-3 max-w-xl text-sm font-semibold text-[var(--muted)] sm:text-base">Choose any task, on any day. Every finished task moves you closer to free time.</p>
          </div>
          <div className="xp-summary">
            <ProgressTracker label="Daily" earned={dailyXP} target={todayPlannedXP} tone="daily" detail={todayIsSick ? "Sick Day · Today's tasks are optional" : `${todayDay}'s assigned tasks`} />
            <ProgressTracker label="Weekly" earned={earnedXP} target={plannedXP} tone="weekly" detail={`${expectedTasksLeft} expected tasks left · Sick Days removed`} />
          </div>
        </section>

        {view === "learner" ? (
          <section className="mt-5">
            <div className="mb-4 flex items-end justify-between"><div><p className="label">Monday through Sunday</p><h2 className="mt-1 text-3xl font-black">My whole week</h2></div><p className="hidden font-bold text-[var(--muted)] sm:block">Any task. Any day.</p></div>
            <div className="week-grid">
              {DAYS.map((day) => {
                const tasks = dashboard.tasks.filter((task) => task.day === day);
                const dayDate = dateForDay(day);
                const now = new Date();
                const isSickDay = dashboard.sickDays.includes(day);
                const clearedEarly = tasks.length > 0 && tasks.every((task) => {
                  const event = earnedByTask.get(task.id);
                  return event ? new Date(event.earnedAt) < dayDate : false;
                });
                const isToday = dayDate.toDateString() === now.toDateString();
                return (
                  <article key={day} className={`day-card ${isToday ? "day-card-today" : ""} ${clearedEarly ? "day-card-cleared" : ""} ${isSickDay ? "day-card-sick" : ""}`}>
                    <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-black uppercase tracking-[.16em] text-[var(--muted)]">{isToday ? "Today" : shortDate(day)}</p><h3 className="mt-1 text-xl font-black">{day}</h3></div>{isSickDay ? <span className="sick-badge">Sick Day</span> : clearedEarly ? <span className="off-badge">Day off</span> : null}</div>
                    <button className={`sick-day-button ${isSickDay ? "sick-day-button-active" : ""}`} type="button" onClick={() => toggleSickDay(day)} aria-pressed={isSickDay}>{isSickDay ? "Remove Sick Day" : "Mark Sick Day"}</button>
                    {isSickDay ? <p className="mt-2 text-xs font-bold text-[var(--muted)]">These tasks are optional, but you can still earn their XP.</p> : null}
                    <div className="mt-4 grid gap-3">
                      {tasks.map((task) => {
                        const complete = earnedByTask.has(task.id);
                        return <button key={task.id} className={`task-button ${complete ? "task-button-complete" : ""}`} onClick={() => toggleTask(task)} aria-pressed={complete}><span className="task-check" aria-hidden>{complete ? "✓" : ""}</span><span className="min-w-0 flex-1 text-left"><strong className="block leading-tight">{task.name}</strong><small className="mt-1 block font-bold text-[var(--muted)]">{complete ? "Done · Tap to undo" : task.category}</small></span><span className="whitespace-nowrap font-black text-[var(--purple)]">+{task.xp}</span></button>;
                      })}
                      {!tasks.length ? <p className="rounded-xl border-2 border-dashed border-[var(--line)] p-4 text-center text-sm font-bold text-[var(--muted)]">Open day</p> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="mt-7 grid gap-6 lg:grid-cols-[.72fr_1.28fr]">
            <form className="paper-panel h-fit" onSubmit={addTask}>
              <p className="label">Plan the week</p><h2 className="mt-1 text-3xl font-black">Add a task</h2>
              <label className="field-label mt-6">Task name<input className="field" value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="Read for 20 minutes" maxLength={80} required /></label>
              <div className="mt-4 grid grid-cols-2 gap-3"><label className="field-label">Planned day<select className="field" value={taskDay} onChange={(event) => setTaskDay(event.target.value as Day)}>{DAYS.map((day) => <option key={day}>{day}</option>)}</select></label><label className="field-label">XP<input className="field" type="number" min="1" max="500" value={taskXP} onChange={(event) => setTaskXP(Number(event.target.value))} required /></label></div>
              <label className="field-label mt-4">Category<select className="field" value={taskCategory} onChange={(event) => setTaskCategory(event.target.value as Category)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
              <button className="primary-button mt-5 w-full" type="submit">Add to the week</button>
            </form>

            <div className="paper-panel">
              <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="label">Parent controls</p><h2 className="mt-1 text-3xl font-black">Weekly plan</h2></div><button className="text-button" type="button" onClick={resetWeek}>Reset completions</button></div>
              <div className="mt-6 grid items-end gap-3 sm:grid-cols-[1fr_auto]"><label className="field-label">Learner name<input className="field" value={dashboard.learnerName} onChange={(event) => setDashboard((current) => ({ ...current, learnerName: event.target.value }))} onBlur={() => void saveLearnerName()} /></label><div className="rounded-xl bg-[var(--paper)] px-4 py-3"><p className="text-xs font-black uppercase tracking-[.12em] text-[var(--muted)]">Goals update automatically</p><p className="mt-1 font-black">Today: {todayPlannedXP} XP · Week: {plannedXP} XP</p></div></div>
              <div className="mt-6 overflow-hidden rounded-xl border border-[var(--line)] bg-white">
                {DAYS.flatMap((day) => dashboard.tasks.filter((task) => task.day === day)).map((task) => { const complete = earnedByTask.has(task.id); return <div key={task.id} className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-[var(--line)] p-4 first:border-t-0"><div><strong>{task.name}</strong><p className="mt-1 text-sm font-bold text-[var(--muted)]">{task.day} · {task.category} · {task.xp} XP</p></div><button className="remove-button" type="button" onClick={() => removeTask(task.id)} aria-label={complete ? `${task.name} has earned XP` : `Remove ${task.name}`} disabled={complete}>{complete ? "Earned" : "Remove"}</button></div>; })}
                {!dashboard.tasks.length ? <p className="p-8 text-center font-bold text-[var(--muted)]">Add the first task for this week.</p> : null}
              </div>
            </div>
          </section>
        )}

        <footer className="mt-12 border-t-2 border-[var(--ink)] py-6 text-sm font-bold text-[var(--muted)]">Effort earns XP. Working ahead earns freedom.</footer>
      </div>
      {showParentGate ? <div className="gate-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowParentGate(false); }}><form className="gate-dialog" role="dialog" aria-modal="true" aria-labelledby="parent-gate-title" onSubmit={submitParentGate}><p className="label">Parent check</p><h2 id="parent-gate-title" className="mt-2 text-2xl font-black">What is your birthyear?</h2><label className="field-label mt-5">Birth year<input className="field" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={parentAnswer} onChange={(event) => { setParentAnswer(event.target.value); setParentGateError(false); }} autoFocus required /></label>{parentGateError ? <p className="mt-3 text-sm font-bold text-[var(--danger)]" role="alert">That answer is not correct.</p> : null}<div className="mt-5 grid grid-cols-2 gap-3"><button className="secondary-button" type="button" onClick={() => setShowParentGate(false)}>Cancel</button><button className="primary-button" type="submit">Continue</button></div></form></div> : null}
      {celebrationDay ? <div className="celebration" role="dialog" aria-modal="true" aria-labelledby="celebration-title">{Array.from({ length: 56 }, (_, index) => <span key={index} className="confetti-piece" style={{ left: `${(index * 37) % 100}%`, top: `${(index * 53) % 100}%`, backgroundColor: confettiColors[index % confettiColors.length], animationDelay: `${(index % 14) * 70}ms`, animationDuration: `${1800 + (index % 7) * 170}ms`, width: index % 3 === 0 ? "12px" : "8px", height: index % 4 === 0 ? "18px" : "11px" }} aria-hidden />)}<div className="celebration-card"><div className="celebration-star" aria-hidden>★</div><p className="label text-[var(--purple)]">Daily goal complete</p><h2 id="celebration-title" className="mt-2 text-4xl font-black tracking-tight">You cleared {celebrationDay}!</h2><p className="mt-3 font-semibold text-[var(--muted)]">Every XP point for the day is complete. Great work!</p><button className="primary-button mt-6 w-full" type="button" onClick={() => setCelebrationDay(null)} autoFocus>Awesome!</button></div></div> : null}
    </main>
  );
}
