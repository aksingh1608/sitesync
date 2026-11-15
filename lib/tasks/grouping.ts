// Groups a worker's tasks for the field app: Today (incl. overdue),
// This Week, This Month, Follow-ups. Pure, so it is unit tested.
//
// Windows are rolling, in the branch timezone: "This Week" = the next 7 days
// after today, "This Month" = days 8-31. (Calendar weeks would leave "This
// Week" empty every Sunday, which is not useful to a crew planning ahead.)
import { TERMINAL_STATUSES, TASK_PRIORITIES } from "../domain";
import { addDays, dayKey } from "../time";
import type { TaskRow } from "../sync/reducers";

export type TaskGroups = {
  today: TaskRow[];
  thisWeek: TaskRow[];
  thisMonth: TaskRow[];
  followUps: TaskRow[];
  /** Due after this month, or no due date. */
  later: TaskRow[];
  closed: TaskRow[];
};

export const WEEK_DAYS = 7;
export const MONTH_DAYS = 31;

export const isOverdue = (t: TaskRow, now: Date, tz: string) =>
  t.dueAt !== null && !TERMINAL_STATUSES.includes(t.status) && dayKey(t.dueAt, tz) < dayKey(now, tz);

const byDueThenPriority = (a: TaskRow, b: TaskRow) =>
  (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
  TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority) ||
  a.title.localeCompare(b.title);

export function groupTasks(tasks: TaskRow[], now: Date, tz: string): TaskGroups {
  const today = dayKey(now, tz);
  const weekEnd = addDays(today, WEEK_DAYS);
  const monthEnd = addDays(today, MONTH_DAYS);
  const g: TaskGroups = { today: [], thisWeek: [], thisMonth: [], followUps: [], later: [], closed: [] };

  for (const t of [...tasks].sort(byDueThenPriority)) {
    if (TERMINAL_STATUSES.includes(t.status)) g.closed.push(t);
    else if (t.kind === "follow_up") g.followUps.push(t);
    else if (!t.dueAt) g.later.push(t);
    else {
      const due = dayKey(t.dueAt, tz);
      if (due <= today) g.today.push(t);
      else if (due <= weekEnd) g.thisWeek.push(t);
      else if (due <= monthEnd) g.thisMonth.push(t);
      else g.later.push(t);
    }
  }
  return g;
}
