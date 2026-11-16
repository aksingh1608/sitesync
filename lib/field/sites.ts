// Which site to preselect on Clock and Notes. Pure, so it is unit tested.
// Order: the task being worked on > where I'm clocked in > a site with work due
// today or overdue > any site with open work > the first site (by name).
import { TERMINAL_STATUSES } from "../domain";
import type { SiteRow, TaskRow, TimeEntryRow } from "../sync/reducers";
import { dayKey } from "../time";

export function defaultSiteId(input: {
  sites: Pick<SiteRow, "id" | "name">[];
  myTasks: Pick<TaskRow, "siteId" | "status" | "dueAt">[];
  myEntries?: Pick<TimeEntryRow, "siteId" | "clockOutAt">[];
  taskSiteId?: string | null;
  now: Date;
  tz: string;
}): string | null {
  const known = new Set(input.sites.map((s) => s.id));
  const ok = (id: string | null | undefined): id is string => !!id && known.has(id);
  if (ok(input.taskSiteId)) return input.taskSiteId;
  const open = input.myEntries?.find((e) => e.clockOutAt === null)?.siteId;
  if (ok(open)) return open;
  const today = dayKey(input.now, input.tz);
  const active = input.myTasks
    .filter((t) => !TERMINAL_STATUSES.includes(t.status))
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
  const dueNow = active.find((t) => t.dueAt && dayKey(t.dueAt, input.tz) <= today)?.siteId;
  if (ok(dueNow)) return dueNow;
  const any = active.find((t) => ok(t.siteId))?.siteId;
  if (ok(any)) return any;
  return [...input.sites].sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? null;
}

/** Sites with my work first (today/overdue, then open), then the rest by name. */
export function rankSites<S extends Pick<SiteRow, "id" | "name">>(
  sites: S[],
  myTasks: Pick<TaskRow, "siteId" | "status" | "dueAt">[],
  now: Date,
  tz: string,
): S[] {
  const today = dayKey(now, tz);
  const active = myTasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  const rank = (s: S) =>
    active.some((t) => t.siteId === s.id && t.dueAt && dayKey(t.dueAt, tz) <= today)
      ? 0
      : active.some((t) => t.siteId === s.id)
        ? 1
        : 2;
  return [...sites].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
