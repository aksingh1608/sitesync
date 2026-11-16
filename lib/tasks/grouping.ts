// Groups a worker's tasks for the field app. Pure, so it is unit tested.
//
// Rolling windows in the BRANCH timezone (America/New_York), never the
// device's: a worker (or a tester in Berlin) sees the same buckets as the office.
//   Overdue      due before today (not done/cancelled, not a follow-up)
//   Today        due today
//   Next 7 days  due tomorrow up to today + 7
//   Later        due after that, or no due date
//   Follow-ups   kind = follow_up, whatever the date
//   Closed       done / cancelled
// (Calendar weeks were tried on Day 2 and dropped: on a Sunday evening "This
// Week" was empty while tomorrow's work showed under "This Month".)
import { TERMINAL_STATUSES, TASK_PRIORITIES } from "../domain";
import { addDays, dayKey } from "../time";
import type { TaskRow } from "../sync/reducers";

export const NEXT_DAYS = 7;

export type TaskGroups = {
  overdue: TaskRow[];
  today: TaskRow[];
  next7: TaskRow[];
  later: TaskRow[];
  followUps: TaskRow[];
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
  const windowEnd = addDays(today, NEXT_DAYS);
  const g: TaskGroups = { overdue: [], today: [], next7: [], later: [], followUps: [], closed: [] };

  for (const t of [...tasks].sort(byDueThenPriority)) {
    if (TERMINAL_STATUSES.includes(t.status)) g.closed.push(t);
    else if (t.kind === "follow_up") g.followUps.push(t);
    else if (!t.dueAt) g.later.push(t);
    else {
      const due = dayKey(t.dueAt, tz);
      if (due < today) g.overdue.push(t);
      else if (due === today) g.today.push(t);
      else if (due <= windowEnd) g.next7.push(t);
      else g.later.push(t);
    }
  }
  return g;
}

/** Day key of tomorrow in the branch timezone (handy for UI defaults). */
export const tomorrowKey = (now: Date, tz: string) => addDays(dayKey(now, tz), 1);
