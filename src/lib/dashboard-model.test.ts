import { describe, expect, it } from "vitest";
import { completionEvents, eventsForSelection, tasksForSelection, xpTotal, type Task, type XPEvent } from "./dashboard-model";

const tasks: Task[] = [
  { id: "legacy", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Legacy", category: "Math", day: "Monday", xp: 20 },
  { id: "week-one", weeklyPlanId: "plan-one", copiedFromTaskId: "legacy", removedAt: null, name: "Week one", category: "Math", day: "Monday", xp: 20 },
  { id: "week-two", weeklyPlanId: "plan-two", copiedFromTaskId: "week-one", removedAt: null, name: "Week two", category: "Math", day: "Monday", xp: 20 },
  { id: "removed", weeklyPlanId: "plan-two", copiedFromTaskId: null, removedAt: "2026-10-14T12:00:00Z", name: "Removed", category: "Reading", day: "Wednesday", xp: 15 },
];

const events: XPEvent[] = [
  { id: "legacy-event", taskId: "legacy", weeklyPlanId: null, amount: 20, earnedAt: "2026-10-01T12:00:00Z" },
  { id: "one-earned", taskId: "week-one", weeklyPlanId: "plan-one", amount: 20, earnedAt: "2026-10-05T12:00:00Z" },
  { id: "one-undone", taskId: "week-one", weeklyPlanId: "plan-one", amount: -20, earnedAt: "2026-10-05T13:00:00Z" },
  { id: "two-earned", taskId: "week-two", weeklyPlanId: "plan-two", amount: 20, earnedAt: "2026-10-12T12:00:00Z" },
];

describe("weekly plan isolation", () => {
  it("keeps legacy records separate from dated plans", () => {
    expect(tasksForSelection(tasks, "legacy").map((task) => task.id)).toEqual(["legacy"]);
    expect(eventsForSelection(events, "legacy").map((event) => event.id)).toEqual(["legacy-event"]);
  });

  it("hides an archived task without deleting its record", () => {
    expect(tasks).toContainEqual(expect.objectContaining({ id: "removed", removedAt: expect.any(String) }));
    expect(tasksForSelection(tasks, "plan-two").map((task) => task.id)).toEqual(["week-two"]);
  });

  it("does not change prior-week totals when a later week earns XP", () => {
    expect(xpTotal(eventsForSelection(events, "plan-one"))).toBe(0);
    expect(xpTotal(eventsForSelection(events, "plan-two"))).toBe(20);
  });

  it("uses compensating events to undo completion", () => {
    const firstWeek = eventsForSelection(events, "plan-one");
    expect(firstWeek).toHaveLength(2);
    expect(completionEvents(firstWeek).has("week-one")).toBe(false);
  });
});
