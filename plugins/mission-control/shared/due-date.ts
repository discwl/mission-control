// Due dates are calendar days on the user's local calendar (YYYY-MM-DD), compared day by day.

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayNumber = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

export type DueTone = "overdue" | "soon" | "later";

/** How a due date reads on a task card, relative to `today` (also YYYY-MM-DD). */
export function dueLabel(dueDate: string, today: string): { text: string; tone: DueTone } {
  const days = dayNumber(dueDate) - dayNumber(today);
  const [, month, day] = dueDate.split("-").map(Number);
  const short = `${months[month - 1]} ${day}`;
  if (days < 0) return { text: `Overdue · due ${short}`, tone: "overdue" };
  if (days === 0) return { text: "Due today", tone: "soon" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: `Due ${short}`, tone: days <= 3 ? "soon" : "later" };
}

/** Today on the device's calendar, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Earliest due date first; tasks without one keep their order after those that have one. */
export function byDueDate(a: { dueDate?: string }, b: { dueDate?: string }): number {
  if (a.dueDate === b.dueDate) return 0;
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}
