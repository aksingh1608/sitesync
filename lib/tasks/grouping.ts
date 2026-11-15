// Groups a worker's tasks for the field app. Pure, so it is unit tested.
//
// Everything is computed in the BRANCH timezone (America/New_York), never the
// device's: a worker (or a tester in Berlin) sees the same buckets as the office.
//   Overdue     due before today (not done/cancelled, not a follow-up)
//   Today       due today
//   This Week   after today, up to and including Sunday (weeks start Monday)
//   This Month  after this week, up to the last day of this calendar month
//   Follow-ups  kind = follow_up, whatever the date
//   Later       after this month, or no due date
//   Closed      done / cancelled
import { TERMINAL_STATUSES, TASK_PRIORITIES } from "../domain";
import { addDays, dayKey, endOfMonthKey, endOfWeekKey } from "../time";
import type { TaskRow } from "../sync/reducers";

export type TaskGroups = {
  overdue: TaskRow[];
  today: TaskRow[];
  thisWeek: TaskRow[];
  thisMonth: TaskRow[];
  followUps: TaskRow[];
  later: TaskRow[];
  closed: TaskRow[];
};
export type GroupKey = keyof TaskGroups;

export const isOverdue = (t: TaskRow, now: Date, tz: string) =>
  t.dueAt !== null && !TERMINAL_STATUSES.includes(t.status) && dayKey(t.dueAt, tz) < dayKey(now, tz);

const byDueThenPriority = (a: TaskRow, b: TaskRow) =>
  (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
  TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority) ||
  a.title.localeCompare(b.title);

export function groupTasks(tasks: TaskRow[], now: Date, tz: string): TaskGroups {
  const today = dayKey(now, tz);
  const weekEnd = endOfWeekKey(today);
  const monthEnd = endOfMonthKey(today);
  const g: TaskGroups = {
    overdue: [],
    today: [],
    thisWeek: [],
    thisMonth: [],
    followUps: [],
    later: [],
    closed: [],
  };

  for (const t of [...tasks].sort(byDueThenPriority)) {
    if (TERMINAL_STATUSES.includes(t.status)) g.closed.push(t);
    else if (t.kind === "follow_up") g.followUps.push(t);
    else if (!t.dueAt) g.later.push(t);
    else {
      const due = dayKey(t.dueAt, tz);
      if (due < today) g.overdue.push(t);
      else if (due === today) g.today.push(t);
      else if (due <= weekEnd) g.thisWeek.push(t);
      else if (due <= monthEnd) g.thisMonth.push(t);
      else g.later.push(t);
    }
  }
  return g;
}

/** Day key of tomorrow in the branch timezone (handy for UI defaults). */
export const tomorrowKey = (now: Date, tz: string) => addDays(dayKey(now, tz), 1);
