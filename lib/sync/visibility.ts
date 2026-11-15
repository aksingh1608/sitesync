// Cursor pull with role-based visibility.
//   technician, foreman: their own tasks (assigned or created), receipts on
//     those tasks, their own time entries / status / notes, the sites they have
//     tasks or time entries at, and those sites' rollouts.
//   coordinator, hr, manager: everything.
// People are a small directory everyone may read (names, roles, trades).
//
// Pagination: every table is read with `seq > cursor ORDER BY seq LIMIT n+1`,
// the rows are merged by seq and the first n are returned. The new cursor is
// the seq of the last returned row, so no row is ever skipped: anything with a
// lower seq in any table was among that table's first n+1 rows.
import { and, asc, gt, inArray, or, eq, type SQL } from "drizzle-orm";
import { isOfficeRole } from "../domain";
import {
  fieldNotes,
  people,
  revocations,
  rollouts,
  sites,
  statusUpdates,
  taskReceipts,
  tasks,
  timeEntries,
  type Person,
} from "../db/schema";
import type { RevocationChange, SyncChanges } from "./protocol";

/** Maximum rows (all tables together, revocations included) per pull. */
export const PULL_PAGE_SIZE = 500;
import type { Db } from "./store-drizzle";

export async function pullChanges(
  db: Db,
  actor: Pick<Person, "id" | "role">,
  cursor: number,
  pageSize = PULL_PAGE_SIZE,
): Promise<{ changes: SyncChanges; revocations: RevocationChange[]; cursor: number; hasMore: boolean }> {
  const all = isOfficeRole(actor.role);
  const limit = pageSize + 1;
  const scope = (since: SQL, own?: SQL) => (all || !own ? since : and(since, own)!);

  const myTaskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(or(eq(tasks.assigneeId, actor.id), eq(tasks.createdBy, actor.id)));
  const mySiteIds = db
    .selectDistinct({ id: tasks.siteId })
    .from(tasks)
    .where(or(eq(tasks.assigneeId, actor.id), eq(tasks.createdBy, actor.id)))
    .union(db.selectDistinct({ id: timeEntries.siteId }).from(timeEntries).where(eq(timeEntries.personId, actor.id)));
  const myRolloutIds = db.selectDistinct({ id: sites.rolloutId }).from(sites).where(inArray(sites.id, mySiteIds));

  const [t, r, te, su, fn, s, p, ro, rv] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(scope(gt(tasks.seq, cursor), or(eq(tasks.assigneeId, actor.id), eq(tasks.createdBy, actor.id))))
      .orderBy(asc(tasks.seq))
      .limit(limit),
    db
      .select()
      .from(taskReceipts)
      .where(
        scope(
          gt(taskReceipts.seq, cursor),
          or(eq(taskReceipts.personId, actor.id), inArray(taskReceipts.taskId, myTaskIds)),
        ),
      )
      .orderBy(asc(taskReceipts.seq))
      .limit(limit),
    db
      .select()
      .from(timeEntries)
      .where(scope(gt(timeEntries.seq, cursor), eq(timeEntries.personId, actor.id)))
      .orderBy(asc(timeEntries.seq))
      .limit(limit),
    db
      .select()
      .from(statusUpdates)
      .where(scope(gt(statusUpdates.seq, cursor), eq(statusUpdates.personId, actor.id)))
      .orderBy(asc(statusUpdates.seq))
      .limit(limit),
    db
      .select()
      .from(fieldNotes)
      .where(scope(gt(fieldNotes.seq, cursor), eq(fieldNotes.personId, actor.id)))
      .orderBy(asc(fieldNotes.seq))
      .limit(limit),
    db
      .select()
      .from(sites)
      .where(scope(gt(sites.seq, cursor), inArray(sites.id, mySiteIds)))
      .orderBy(asc(sites.seq))
      .limit(limit),
    db.select().from(people).where(gt(people.seq, cursor)).orderBy(asc(people.seq))
      .limit(limit),
    db
      .select()
      .from(rollouts)
      .where(scope(gt(rollouts.seq, cursor), inArray(rollouts.id, myRolloutIds)))
      .orderBy(asc(rollouts.seq))
      .limit(limit),
    // The office sees everything, so it is never told to drop a row.
    all
      ? Promise.resolve([])
      : db
          .select({ entity: revocations.entity, entityId: revocations.entityId, seq: revocations.seq })
          .from(revocations)
          .where(and(gt(revocations.seq, cursor), eq(revocations.actorId, actor.id)))
          .orderBy(asc(revocations.seq))
          .limit(limit),
  ]);

  const tables = {
    tasks: t,
    task_receipts: r,
    time_entries: te,
    status_updates: su,
    field_notes: fn,
    sites: s,
    people: p,
    rollouts: ro,
    revocations: rv,
  };
  // Merge by seq and keep the first `pageSize` rows overall.
  const merged = Object.entries(tables)
    .flatMap(([table, rows]) => rows.map((row) => ({ table, row })))
    .sort((a, b) => a.row.seq - b.row.seq);
  const page = merged.slice(0, pageSize);
  const hasMore = merged.length > pageSize;
  const newCursor = page.length ? page[page.length - 1].row.seq : cursor;

  const keep = <T extends { seq: number }>(rows: T[]) => rows.filter((row) => row.seq <= newCursor);
  const changes: SyncChanges = {
    tasks: keep(t),
    task_receipts: keep(r),
    time_entries: keep(te),
    status_updates: keep(su),
    field_notes: keep(fn),
    sites: keep(s),
    people: keep(p),
    rollouts: keep(ro),
  };
  return { changes, revocations: keep(rv), cursor: newCursor, hasMore };
}
