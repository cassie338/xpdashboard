import { describe, expect, it } from "vitest";
import { completionEvents, eventsForSelection, tasksForSelection, xpTotal, type Task, type XPEvent } from "./dashboard-model";

const tasks: Task[] = [
  { id: "legacy", learnerId: "learner-one", weeklyPlanId: null, copiedFromTaskId: null, removedAt: null, name: "Legacy", category: "Math", day: "Monday", xp: 20 },
  { id: "week-one", learnerId: "learner-one", weeklyPlanId: "plan-one", copiedFromTaskId: "legacy", removedAt: null, name: "Week one", category: "Math", day: "Monday", xp: 20 },
  { id: "week-two", learnerId: "learner-one", weeklyPlanId: "plan-two", copiedFromTaskId: "week-one", removedAt: null, name: "Week two", category: "Math", day: "Monday", xp: 20 },
  { id: "removed", learnerId: "learner-one", weeklyPlanId: "plan-two", copiedFromTaskId: null, removedAt: "2026-10-14T12:00:00Z", name: "Removed", category: "Reading", day: "Wednesday", xp: 15 },
  { id: "sibling-task", learnerId: "learner-two", weeklyPlanId: "plan-two", copiedFromTaskId: null, removedAt: null, name: "Sibling", category: "Math", day: "Monday", xp: 100 },
];

const events: XPEvent[] = [
  { id: "legacy-event", learnerId: "learner-one", taskId: "legacy", weeklyPlanId: null, amount: 20, earnedAt: "2026-10-01T12:00:00Z" },
  { id: "one-earned", learnerId: "learner-one", taskId: "week-one", weeklyPlanId: "plan-one", amount: 20, earnedAt: "2026-10-05T12:00:00Z" },
  { id: "one-undone", learnerId: "learner-one", taskId: "week-one", weeklyPlanId: "plan-one", amount: -20, earnedAt: "2026-10-05T13:00:00Z" },
  { id: "two-earned", learnerId: "learner-one", taskId: "week-two", weeklyPlanId: "plan-two", amount: 20, earnedAt: "2026-10-12T12:00:00Z" },
  { id: "sibling-earned", learnerId: "learner-two", taskId: "sibling-task", weeklyPlanId: "plan-two", amount: 100, earnedAt: "2026-10-12T12:00:00Z" },
];

describe("weekly plan isolation", () => {
  it("keeps legacy records separate from dated plans", () => {
    expect(tasksForSelection(tasks, "legacy", "learner-one").map((task) => task.id)).toEqual(["legacy"]);
    expect(eventsForSelection(events, "legacy", "learner-one").map((event) => event.id)).toEqual(["legacy-event"]);
  });

  it("hides an archived task without deleting its record", () => {
    expect(tasks).toContainEqual(expect.objectContaining({ id: "removed", removedAt: expect.any(String) }));
    expect(tasksForSelection(tasks, "plan-two", "learner-one").map((task) => task.id)).toEqual(["week-two"]);
  });

  it("does not change prior-week totals when a later week earns XP", () => {
    expect(xpTotal(eventsForSelection(events, "plan-one", "learner-one"))).toBe(0);
    expect(xpTotal(eventsForSelection(events, "plan-two", "learner-one"))).toBe(20);
  });

  it("uses compensating events to undo completion", () => {
    const firstWeek = eventsForSelection(events, "plan-one", "learner-one");
    expect(firstWeek).toHaveLength(2);
    expect(completionEvents(firstWeek).has("week-one")).toBe(false);
  });

  it("keeps sibling tasks and XP out of the selected learner", () => {
    expect(tasksForSelection(tasks, "plan-two", "learner-one").map((task) => task.id)).toEqual(["week-two"]);
    expect(xpTotal(eventsForSelection(events, "plan-two", "learner-one"))).toBe(20);
    expect(xpTotal(eventsForSelection(events, "plan-two", "learner-two"))).toBe(100);
  });
});
