import type { Day } from "@/lib/week";

export const categories = ["Math", "Reading", "Writing", "History", "Life Skills", "Creative"] as const;
export type Category = (typeof categories)[number];
export type PlanStatus = "published" | "completed";
export type PlanSelection = string | "legacy";
export type SupportMode = "independent" | "with_parent";

export interface LearnerProfile {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface WeeklyPlan {
  id: string;
  learnerId: string;
  weekStart: string;
  status: PlanStatus;
  sickDays: Day[];
  dailyRewards: Partial<Record<Day, string>>;
  createdAt: string;
  completedAt: string | null;
}

export interface Task {
  id: string;
  learnerId: string;
  weeklyPlanId: string | null;
  copiedFromTaskId: string | null;
  removedAt: string | null;
  name: string;
  category: Category;
  day: Day;
  xp: number;
  position: number;
  supportMode: SupportMode;
}

export interface XPEvent {
  id: string;
  learnerId: string;
  taskId: string;
  weeklyPlanId: string | null;
  amount: number;
  earnedAt: string;
  reason?: "task_completed" | "task_unchecked" | "week_reset";
}

export interface StoredDashboard {
  learnerName: string;
  plans: WeeklyPlan[];
  tasks: Task[];
  xpEvents: XPEvent[];
  taskSessions: TaskSession[];
  helpRequests: HelpRequest[];
  legacySickDays: Day[];
}

export interface TaskSession {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string | null;
  status: "started" | "completed";
}

export interface HelpRequest {
  id: string;
  taskId: string;
  status: "requested" | "resolved";
  requestedAt: string;
  resolvedAt: string | null;
}

export function tasksForSelection(tasks: Task[], selection: PlanSelection, learnerId: string) {
  return tasks.filter((task) => task.learnerId === learnerId && !task.removedAt && (selection === "legacy" ? task.weeklyPlanId === null : task.weeklyPlanId === selection));
}

export function eventsForSelection(events: XPEvent[], selection: PlanSelection, learnerId: string) {
  return events.filter((event) => event.learnerId === learnerId && (selection === "legacy" ? event.weeklyPlanId === null : event.weeklyPlanId === selection));
}

export function completionEvents(events: XPEvent[]) {
  const balances = new Map<string, number>();
  const earned = new Map<string, XPEvent>();
  for (const event of events) {
    const balance = (balances.get(event.taskId) ?? 0) + event.amount;
    balances.set(event.taskId, balance);
    if (event.amount > 0) earned.set(event.taskId, event);
    if (balance <= 0) earned.delete(event.taskId);
  }
  return earned;
}

export function xpTotal(events: XPEvent[]) {
  return Math.max(0, events.reduce((total, event) => total + event.amount, 0));
}
