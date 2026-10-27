export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export type Day = (typeof DAYS)[number];

export function dayForDate(date = new Date()): Day {
  return DAYS[(date.getDay() + 6) % 7];
}

export function getMonday(date = new Date()) {
  const monday = new Date(date);
  const daysSinceMonday = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - daysSinceMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function dateForDay(day: Day, now = new Date()) {
  const date = getMonday(now);
  date.setDate(date.getDate() + DAYS.indexOf(day));
  return date;
}

export function shortDate(day: Day) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(dateForDay(day));
}

export function weekLabel() {
  const monday = getMonday();
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${format.format(monday)} - ${format.format(sunday)}`;
}
