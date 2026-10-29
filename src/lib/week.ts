export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export type Day = (typeof DAYS)[number];

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(value: string, days: number) {
  const date = dateFromKey(value);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

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

export function currentWeekStart(date = new Date()) {
  return dateKey(getMonday(date));
}

export function dateForDay(day: Day, weekStart = currentWeekStart()) {
  const date = dateFromKey(weekStart);
  date.setDate(date.getDate() + DAYS.indexOf(day));
  return date;
}

export function shortDate(day: Day, weekStart?: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(dateForDay(day, weekStart));
}

export function weekLabel(weekStart = currentWeekStart()) {
  const monday = dateFromKey(weekStart);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${format.format(monday)} - ${format.format(sunday)}`;
}
