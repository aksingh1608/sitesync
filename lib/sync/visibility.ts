// Cursor pull with role-based visibility.
//   technician, foreman: their own tasks (assigned or created), receipts on
//     those tasks, their own time entries / status / notes, the sites they have
//     tasks or time entries at, and those sites' rollouts.
//   coordinator, hr, manager: everything.
// People are a small directory everyone may read (names, roles, trades).
import { and, gt, inArray, or, eq, type SQL } from "drizzle-orm";
import { isOfficeRole } from "../domain";
import {
  fieldNotes,
  people,
  rollouts,
  sites,
  statusUpdates,
  taskReceipts,
  tasks,
  timeEntries,
  type Person,
} from "../db/schema";
import type { SyncChanges } from "./protocol";
import type { Db } from "./store-drizzle";

export async function pullChanges(
  db: Db,
  actor: Pick<Person, "id" | "role">,
  cursor: number,
): Promise<{ changes: SyncChanges; cursor: number }> {
  const all = isOfficeRole(actor.role);
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

  const [t, r, te, su, fn, s, p, ro] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(scope(gt(tasks.seq, cursor), or(eq(tasks.assigneeId, actor.id), eq(tasks.createdBy, actor.id))))
      .orderBy(tasks.seq),
    db
      .select()
      .from(taskReceipts)
      .where(
        scope(
          gt(taskReceipts.seq, cursor),
          or(eq(taskReceipts.personId, actor.id), inArray(taskReceipts.taskId, myTaskIds)),
        ),
      )
      .orderBy(taskReceipts.seq),
    db
      .select()
      .from(timeEntries)
      .where(scope(gt(timeEntries.seq, cursor), eq(timeEntries.personId, actor.id)))
      .orderBy(timeEntries.seq),
    db
      .select()
      .from(statusUpdates)
      .where(scope(gt(statusUpdates.seq, cursor), eq(statusUpdates.personId, actor.id)))
      .orderBy(statusUpdates.seq),
    db
      .select()
      .from(fieldNotes)
      .where(scope(gt(fieldNotes.seq, cursor), eq(fieldNotes.personId, actor.id)))
      .orderBy(fieldNotes.seq),
    db
      .select()
      .from(sites)
      .where(scope(gt(sites.seq, cursor), inArray(sites.id, mySiteIds)))
      .orderBy(sites.seq),
    db.select().from(people).where(gt(people.seq, cursor)).orderBy(people.seq),
    db
      .select()
      .from(rollouts)
      .where(scope(gt(rollouts.seq, cursor), inArray(rollouts.id, myRolloutIds)))
      .orderBy(rollouts.seq),
  ]);

  const changes: SyncChanges = {
    tasks: t,
    task_receipts: r,
    time_entries: te,
    status_updates: su,
    field_notes: fn,
    sites: s,
    people: p,
    rollouts: ro,
  };
  let max = cursor;
  for (const rows of Object.values(changes)) for (const row of rows) if (row.seq > max) max = row.seq;
  return { changes, cursor: max };
}
