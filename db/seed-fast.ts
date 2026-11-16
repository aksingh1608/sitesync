// Fast reseed for a remote database (Neon): one WebSocket round trip per
// statement made the event-by-event seed take minutes.
//
// 1. Run the normal seed (every event through processSync and the reducers)
//    against an in-memory PGlite with the same migrations.
// 2. Copy the result to the target in ONE transaction: truncate, then a few
//    bulk INSERTs per table (~20 statements instead of thousands).
//
// `seq` and `server_seq` are not copied: the target assigns fresh values from
// its own sequences (inserted in the original order), so sync_seq still only
// moves forward and existing client cursors stay valid (they pull everything).
import { PGlite } from "@electric-sql/pglite";
import { asc, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as s from "../lib/db/schema";
import type { Db } from "../lib/sync/store-drizzle";
import { seed, type SeedSummary } from "./seed-data";

/** Copied in foreign-key order. Order inside a table: by seq (or server_seq). */
export const COPY_TABLES: PgTable[] = [
  s.branches,
  s.people,
  s.rollouts,
  s.sites,
  s.tasks,
  s.taskReceipts,
  s.timeEntries,
  s.statusUpdates,
  s.fieldNotes,
  s.revocations,
  s.events,
  s.devices,
];

/** Everything the seed owns (wiped before the copy). */
const WIPE = sql`TRUNCATE events, field_notes, status_updates, time_entries, task_receipts, escalations,
  push_subscriptions, digests, revocations, devices, tasks, sites, rollouts, people, branches RESTART IDENTITY CASCADE`;

const CHUNK = 250;

export async function seedViaMemory(target: Db, opts: { now?: Date } = {}): Promise<SeedSummary & { statements: number }> {
  const client = new PGlite();
  try {
    const mem = drizzle({ client });
    await migrate(mem, { migrationsFolder: "./db/migrations" });
    const summary = await seed(mem, opts);

    // Read everything first (local, fast), then write remotely in one go.
    const data: { table: PgTable; rows: Record<string, unknown>[] }[] = [];
    for (const table of COPY_TABLES) {
      const cols = getTableColumns(table) as Record<string, unknown>;
      const order = "serverSeq" in cols ? cols.serverSeq : "seq" in cols ? cols.seq : null;
      const q = mem.select().from(table);
      const rows = (order ? await q.orderBy(asc(order as never)) : await q) as Record<string, unknown>[];
      data.push({
        table,
        rows: rows.map((r) => {
          // Fresh sequence values on the target; bigserial ids too.
          const { seq: _seq, serverSeq: _ss, ...rest } = r;
          void _seq;
          void _ss;
          if (table === s.revocations) delete rest.id;
          return rest;
        }),
      });
    }

    let statements = 1;
    await target.transaction(async (tx) => {
      await tx.execute(WIPE);
      for (const { table, rows } of data) {
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx.insert(table).values(rows.slice(i, i + CHUNK) as never);
          statements++;
        }
      }
    });
    return { ...summary, statements };
  } finally {
    await client.close();
  }
}
