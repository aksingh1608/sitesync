// Server-side reads for the office dashboard (online only; polled every 5 s).
// Writes never happen here: the dashboard posts events to /api/sync like a phone.
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { BRANCH_TIMEZONE } from "../config";
import { devices, events, fieldNotes, people, rollouts, sites, statusUpdates, taskReceipts, tasks, timeEntries } from "../db/schema";
import type { Db } from "../sync/store-drizzle";
import { mediaUrlFor } from "../sync/visibility";
import { addDays, zonedTime } from "../time";

/** Closed tasks older than this are left out of the live snapshot. */
const CLOSED_WINDOW_DAYS = 30;

export async function loadSnapshot(db: Db, now: Date) {
  const closedSince = new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000);
  const [ppl, st, ro, tk, rc, open, statuses, sync, photos] = await Promise.all([
    db
      .select({ id: people.id, name: people.name, role: people.role, trade: people.trade, active: people.active, phone: people.phone })
      .from(people)
      .orderBy(asc(people.name)),
    db.select().from(sites).orderBy(asc(sites.name)),
    db.select().from(rollouts),
    db
      .select()
      .from(tasks)
      .where(or(inArray(tasks.status, ["open", "in_progress", "blocked"]), gte(tasks.updatedAt, closedSince))),
    db.select().from(taskReceipts),
    db.select().from(timeEntries).where(isNull(timeEntries.clockOutAt)),
    // Latest status per person.
    db
      .selectDistinctOn([statusUpdates.personId])
      .from(statusUpdates)
      .orderBy(statusUpdates.personId, desc(statusUpdates.at)),
    db
      .select({
        personId: devices.personId,
        lastSyncAt: sql<string>`max(${devices.lastSyncAt})`.as("last_sync_at"),
        devices: sql<number>`count(*)::int`.as("devices"),
      })
      .from(devices)
      .groupBy(devices.personId),
    db
      .select({ siteId: fieldNotes.siteId, n: sql<number>`count(*)::int`.as("n") })
      .from(fieldNotes)
      .where(and(eq(fieldNotes.kind, "photo"), isNotNull(fieldNotes.blobPath)))
      .groupBy(fieldNotes.siteId),
  ]);
  return {
    now: now.toISOString(),
    people: ppl,
    sites: st.map(({ seq: _s, ...s }) => (void _s, s)),
    rollouts: ro.map(({ seq: _s, ...r }) => (void _s, r)),
    tasks: tk.map(({ seq: _s, fieldTs: _f, ...t }) => (void _s, void _f, t)),
    receipts: rc.map(({ seq: _s, ...r }) => (void _s, r)),
    openEntries: open.map(({ seq: _s, ...e }) => (void _s, e)),
    statuses: statuses.map(({ seq: _s, ...x }) => (void _s, x)),
    lastSync: sync.map((d) => ({ ...d, lastSyncAt: new Date(d.lastSyncAt).toISOString() })),
    photoCounts: Object.fromEntries(photos.map((p) => [p.siteId, Number(p.n)])) as Record<string, number>,
  };
}
export type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>;

/** Everything about one task: history (who did what, when, from which device), notes, follow-ups. */
export async function loadTaskDetail(db: Db, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  const [receipts, notes, followUps, parent] = await Promise.all([
    db.select().from(taskReceipts).where(eq(taskReceipts.taskId, taskId)),
    db.select().from(fieldNotes).where(eq(fieldNotes.taskId, taskId)).orderBy(asc(fieldNotes.createdAt)),
    db.select().from(tasks).where(eq(tasks.parentTaskId, taskId)).orderBy(asc(tasks.createdAt)),
    task.parentTaskId ? db.select().from(tasks).where(eq(tasks.id, task.parentTaskId)) : Promise.resolve([]),
  ]);
  const noteIds = notes.map((n) => n.id);
  const history = await db
    .select({
      id: events.id,
      type: events.type,
      actorId: events.actorId,
      deviceId: events.deviceId,
      clientTs: events.clientTs,
      serverTs: events.serverTs,
      applied: events.applied,
      rejectReason: events.rejectReason,
      payload: events.payload,
    })
    .from(events)
    .where(
      or(
        sql`${events.payload}->>'taskId' = ${taskId}`,
        noteIds.length ? and(eq(events.type, "note.media_uploaded"), inArray(sql`${events.payload}->>'noteId'`, noteIds)) : undefined,
      ),
    )
    .orderBy(asc(events.serverSeq));
  const strip = <T extends { seq: number }>({ seq: _s, ...r }: T) => (void _s, r);
  return {
    task: (({ fieldTs: _f, ...t }) => (void _f, t))(strip(task)),
    receipts: receipts.map(strip),
    // The private blob pathname never leaves the server.
    notes: notes.map(({ blobPath, ...n }) => ({ ...strip(n), blobPath: null, mediaUrl: mediaUrlFor(n.id, blobPath) })),
    followUps: followUps.map((t) => ({ id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId, kind: t.kind })),
    parent: parent[0] ? { id: parent[0].id, title: parent[0].title } : null,
    history,
  };
}
export type TaskDetail = NonNullable<Awaited<ReturnType<typeof loadTaskDetail>>>;

/** Branch-time instants for [fromKey, toKey] inclusive. */
export const rangeInstants = (fromKey: string, toKey: string, tz = BRANCH_TIMEZONE) => ({
  start: zonedTime(fromKey, 0, 0, tz),
  end: zonedTime(addDays(toKey, 1), 0, 0, tz),
});

/**
 * Time entries clocked in during the week (Monday `weekKey` .. Sunday), plus
 * every unreviewed flagged or still-open entry of the last 30 days (the
 * "Needs review" list spans weeks so nothing slips past a week boundary).
 */
export async function loadTimesheets(db: Db, weekKey: string, now: Date) {
  const { start, end } = rangeInstants(weekKey, addDays(weekKey, 6));
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [week, review, ppl, st] = await Promise.all([
    db
      .select()
      .from(timeEntries)
      .where(and(gte(timeEntries.clockInAt, start), lt(timeEntries.clockInAt, end)))
      .orderBy(asc(timeEntries.clockInAt)),
    db
      .select()
      .from(timeEntries)
      .where(
        and(
          gte(timeEntries.clockInAt, since),
          isNull(timeEntries.reviewStatus),
          or(eq(timeEntries.flagged, true), isNull(timeEntries.clockOutAt)),
        ),
      )
      .orderBy(asc(timeEntries.clockInAt)),
    db.select({ id: people.id, name: people.name, role: people.role, trade: people.trade }).from(people).orderBy(asc(people.name)),
    db.select({ id: sites.id, name: sites.name }).from(sites),
  ]);
  const strip = <T extends { seq: number }>({ seq: _s, ...r }: T) => (void _s, r);
  return { weekKey, week: week.map(strip), review: review.map(strip), people: ppl, sites: st };
}
export type Timesheets = Awaited<ReturnType<typeof loadTimesheets>>;

// ---------------------------------------------------------------------------
// Team stats (aggregated in SQL)
// ---------------------------------------------------------------------------
type StatRow = { key: string; completed: number; medianAckMin: number | null; overdue: number; blocked: number };

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/**
 * For tasks in [from, to] (branch days):
 *   completed      status done, closed (status stamp) inside the range
 *   medianAckMin   median minutes from sent to acknowledged, for receipts sent in the range
 *   overdue        still open now, due inside the range and before now
 *   blocked        blocked now, created before the end of the range
 * per person (assignee), per site and for the whole branch, plus completions per day.
 */
export async function teamStats(db: Db, fromKey: string, toKey: string, now: Date, tz = BRANCH_TIMEZONE) {
  const { start, end } = rangeInstants(fromKey, toKey, tz);
  const doneAt = sql`(${tasks.fieldTs}->'status'->>'ts')::timestamptz`;
  const groups = { person: tasks.assigneeId, site: tasks.siteId } as const;

  async function by(group: "person" | "site" | "branch"): Promise<StatRow[]> {
    const key = group === "branch" ? sql`'branch'` : groups[group];
    const receiptKey = group === "branch" ? sql`'branch'` : group === "person" ? taskReceipts.personId : tasks.siteId;
    const [completed, acks, overdue, blocked] = await Promise.all([
      db
        .select({ key: sql<string>`${key}`.as("key"), n: sql<number>`count(*)::int`.as("n") })
        .from(tasks)
        .where(and(eq(tasks.status, "done"), sql`${doneAt} >= ${start.toISOString()}::timestamptz`, sql`${doneAt} < ${end.toISOString()}::timestamptz`))
        .groupBy(sql`1`),
      db
        .select({
          key: sql<string>`${receiptKey}`.as("key"),
          m: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${taskReceipts.acknowledgedAt} - ${taskReceipts.sentAt})) / 60)`.as("m"),
        })
        .from(taskReceipts)
        .innerJoin(tasks, and(eq(tasks.id, taskReceipts.taskId), eq(tasks.assigneeId, taskReceipts.personId)))
        .where(and(isNotNull(taskReceipts.acknowledgedAt), gte(taskReceipts.sentAt, start), lt(taskReceipts.sentAt, end)))
        .groupBy(sql`1`),
      db
        .select({ key: sql<string>`${key}`.as("key"), n: sql<number>`count(*)::int`.as("n") })
        .from(tasks)
        .where(
          and(
            inArray(tasks.status, ["open", "in_progress", "blocked"]),
            gte(tasks.dueAt, start),
            lt(tasks.dueAt, end),
            lt(tasks.dueAt, now),
          ),
        )
        .groupBy(sql`1`),
      db
        .select({ key: sql<string>`${key}`.as("key"), n: sql<number>`count(*)::int`.as("n") })
        .from(tasks)
        .where(and(eq(tasks.status, "blocked"), lt(tasks.createdAt, end)))
        .groupBy(sql`1`),
    ]);
    const keys = new Set([...completed, ...acks, ...overdue, ...blocked].map((r) => r.key));
    const find = <T extends { key: string }>(rows: T[], k: string) => rows.find((r) => r.key === k);
    return [...keys].map((k) => ({
      key: k,
      completed: num(find(completed, k)?.n),
      medianAckMin: numOrNull(find(acks, k)?.m),
      overdue: num(find(overdue, k)?.n),
      blocked: num(find(blocked, k)?.n),
    }));
  }

  const [person, site, branch, daily] = await Promise.all([
    by("person"),
    by("site"),
    by("branch"),
    db
      .select({
        day: sql<string>`to_char(${doneAt} at time zone ${tz}, 'YYYY-MM-DD')`.as("day"),
        n: sql<number>`count(*)::int`.as("n"),
      })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), sql`${doneAt} >= ${start.toISOString()}::timestamptz`, sql`${doneAt} < ${end.toISOString()}::timestamptz`))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);
  const days: { day: string; completed: number }[] = [];
  for (let k = fromKey; k <= toKey && days.length < 400; k = addDays(k, 1)) {
    days.push({ day: k, completed: num(daily.find((d) => d.day === k)?.n) });
  }
  const empty = { key: "branch", completed: 0, medianAckMin: null, overdue: 0, blocked: 0 };
  return { from: fromKey, to: toKey, branch: branch[0] ?? empty, person, site, daily: days };
}
export type TeamStats = Awaited<ReturnType<typeof teamStats>>;
