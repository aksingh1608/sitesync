// SyncStore backed by Postgres via Drizzle. Every write sets
// seq = nextval('sync_seq') so the row shows up in the next cursor pull.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
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
} from "../db/schema";
import type { SyncStore } from "./apply";

/** Any Drizzle Postgres database or transaction (Neon, PGlite, ...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, any>;

const nextSeq = sql`nextval('sync_seq')`;

function withoutSeq<T extends { seq?: number }>(row: T): Omit<T, "seq"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seq: _seq, ...rest } = row;
  return rest;
}

const first = <T>(rows: T[]): T | undefined => rows[0];

export function drizzleStore(db: Db): SyncStore {
  return {
    getPerson: async (id) => first(await db.select().from(people).where(eq(people.id, id))),
    getSite: async (id) => first(await db.select().from(sites).where(eq(sites.id, id))),
    getTask: async (id) => first(await db.select().from(tasks).where(eq(tasks.id, id))),
    getReceipt: async (taskId, personId) =>
      first(
        await db
          .select()
          .from(taskReceipts)
          .where(and(eq(taskReceipts.taskId, taskId), eq(taskReceipts.personId, personId))),
      ),
    getTimeEntry: async (id) => first(await db.select().from(timeEntries).where(eq(timeEntries.id, id))),
    getOpenTimeEntry: async (personId) =>
      first(
        await db
          .select()
          .from(timeEntries)
          .where(and(eq(timeEntries.personId, personId), isNull(timeEntries.clockOutAt)))
          .limit(1),
      ),
    getStatusUpdate: async (id) => first(await db.select().from(statusUpdates).where(eq(statusUpdates.id, id))),
    getNote: async (id) => first(await db.select().from(fieldNotes).where(eq(fieldNotes.id, id))),

    putTask: async (row) => {
      const v = withoutSeq(row);
      await db
        .insert(tasks)
        .values(v)
        .onConflictDoUpdate({ target: tasks.id, set: { ...v, seq: nextSeq } });
    },
    putReceipt: async (row) => {
      const v = withoutSeq(row);
      await db
        .insert(taskReceipts)
        .values(v)
        .onConflictDoUpdate({
          target: [taskReceipts.taskId, taskReceipts.personId],
          set: { ...v, seq: nextSeq },
        });
    },
    putTimeEntry: async (row) => {
      const v = withoutSeq(row);
      await db
        .insert(timeEntries)
        .values(v)
        .onConflictDoUpdate({ target: timeEntries.id, set: { ...v, seq: nextSeq } });
    },
    putStatusUpdate: async (row) => {
      const v = withoutSeq(row);
      await db
        .insert(statusUpdates)
        .values(v)
        .onConflictDoUpdate({ target: statusUpdates.id, set: { ...v, seq: nextSeq } });
    },
    putNote: async (row) => {
      const v = withoutSeq(row);
      await db
        .insert(fieldNotes)
        .values(v)
        .onConflictDoUpdate({ target: fieldNotes.id, set: { ...v, seq: nextSeq } });
    },
    touchSite: async (siteId) => {
      const [site] = await db
        .update(sites)
        .set({ seq: nextSeq })
        .where(eq(sites.id, siteId))
        .returning({ rolloutId: sites.rolloutId });
      if (site?.rolloutId) {
        await db.update(rollouts).set({ seq: nextSeq }).where(eq(rollouts.id, site.rolloutId));
      }
    },
    revoke: async (actorId, entity, entityId) => {
      await db
        .insert(revocations)
        .values({ actorId, entity, entityId })
        .onConflictDoUpdate({
          target: [revocations.actorId, revocations.entity, revocations.entityId],
          set: { seq: nextSeq },
        });
    },
  };
}

