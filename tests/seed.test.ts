import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { SEED_IDS, SEED_TASK_ID, seed } from "@/db/seed-data";
import { COPY_TABLES, seedViaMemory } from "@/db/seed-fast";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { events, taskReceipts, tasks, timeEntries } from "@/lib/db/schema";
import { groupTasks } from "@/lib/tasks/grouping";

describe("seed", () => {
  it("is deterministic, goes through the reducers, and can be re-run", async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: "./db/migrations" });
    const now = new Date("2026-11-11T16:00:00Z"); // a Wednesday

    const first = await seed(db, { now });
    const second = await seed(db, { now }); // wipes and reseeds
    expect(second).toEqual(first);
    expect(first.tasks).toBeGreaterThanOrEqual(28);

    const allEvents = await db.select().from(events);
    expect(allEvents).toHaveLength(first.events);
    expect(allEvents.every((e) => e.applied && e.rejectReason === null)).toBe(true);

    const entries = await db.select().from(timeEntries);
    const flagged = entries.filter((e) => e.flagged).map((e) => e.flagReason);
    expect(flagged).toHaveLength(2);
    expect(flagged.some((r) => r?.startsWith("outside_geofence"))).toBe(true);
    expect(flagged.some((r) => r?.startsWith("no_location: denied"))).toBe(true);
    // One forgotten clock-out from yesterday (plus today's two open entries).
    expect(entries.filter((e) => e.clockOutAt === null)).toHaveLength(3);
    const [lenses] = await db.select().from(tasks).where(eq(tasks.id, SEED_TASK_ID(33)));
    expect(lenses.materialStatus).toBe("approved");

    const receipts = await db.select().from(taskReceipts);
    const states = new Set(
      receipts.map((r) => (r.acknowledgedAt ? "ack" : r.seenAt ? "seen" : r.deliveredAt ? "delivered" : "sent")),
    );
    expect(states).toEqual(new Set(["sent", "delivered", "seen", "ack"]));

    const g = await samGroups(db, now);
    for (const k of ["overdue", "today", "next7", "later", "followUps", "closed"] as const) {
      expect(g[k].length, k).toBeGreaterThan(0);
    }
    const [child] = await db.select().from(tasks).where(eq(tasks.id, SEED_TASK_ID(16)));
    expect(child.parentTaskId).toBe(SEED_TASK_ID(14));
    const [{ n }] = await db.select({ n: sql<number>`count(distinct status)` }).from(tasks);
    expect(Number(n)).toBe(5);
    await client.close();
  });

  it("computes every date relative to the moment it runs, with fixed ids", async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: "./db/migrations" });
    const snapshot = async () => ({
      tasks: await db.select().from(tasks).orderBy(tasks.id),
      entries: await db.select().from(timeEntries).orderBy(timeEntries.id),
      receipts: await db.select().from(taskReceipts).orderBy(taskReceipts.taskId),
      events: (await db.select().from(events).orderBy(events.serverSeq)).map((e) => e.id),
    });

    const t1 = new Date("2026-11-11T16:00:00Z"); // Wednesday
    const t2 = new Date(t1.getTime() + 7 * 86_400_000); // the Wednesday after
    await seed(db, { now: t1 });
    const a = await snapshot();
    await seed(db, { now: t2 });
    const b = await snapshot();

    expect(b.tasks.map((t) => t.id)).toEqual(a.tasks.map((t) => t.id));
    expect(b.entries.map((e) => e.id)).toEqual(a.entries.map((e) => e.id));
    expect(b.events).toEqual(a.events);
    const week = 7 * 86_400_000;
    const shifted = (x: Date | null, y: Date | null) => (x && y ? y.getTime() - x.getTime() : null);
    for (const [i, t] of a.tasks.entries()) {
      if (t.dueAt) expect(shifted(t.dueAt, b.tasks[i].dueAt), t.title).toBe(week);
      expect(shifted(t.createdAt, b.tasks[i].createdAt)).toBe(week);
    }
    for (const [i, e] of a.entries.entries()) expect(shifted(e.clockInAt, b.entries[i].clockInAt)).toBe(week);
    for (const [i, r] of a.receipts.entries()) {
      expect(shifted(r.sentAt, b.receipts[i].sentAt)).toBe(week);
      if (r.acknowledgedAt) expect(shifted(r.acknowledgedAt, b.receipts[i].acknowledgedAt)).toBe(week);
    }
    // Nothing seeded is in the future.
    expect(b.entries.every((e) => e.clockInAt <= t2 && (!e.clockOutAt || e.clockOutAt <= t2))).toBe(true);

    // Rolling windows: every group has work whatever the weekday (Sunday included).
    const sunday = new Date("2026-11-15T23:00:00Z");
    await seed(db, { now: sunday });
    const g = await samGroups(db, sunday);
    for (const k of ["overdue", "today", "next7", "later", "followUps", "closed"] as const) expect(g[k].length, k).toBeGreaterThan(0);
    await client.close();
  });
});

describe("seedViaMemory (fast remote reseed)", () => {
  it("produces the same rows as the direct seed in a few statements, with fresh, forward-only seqs", async () => {
    const now = new Date("2026-11-11T16:00:00Z");
    const open = async () => {
      const client = new PGlite();
      const db = drizzle({ client });
      await migrate(db, { migrationsFolder: "./db/migrations" });
      return { client, db };
    };
    const direct = await open();
    const target = await open();
    await seed(direct.db, { now });
    // Push the target's sequence ahead, as on a database that has been used.
    await target.db.execute(sql`select setval('sync_seq', 100000)`);
    const out = await seedViaMemory(target.db, { now });
    expect(out.statements).toBeLessThan(40);

    const strip = (rows: Record<string, unknown>[]) =>
      rows
        .map(({ seq: _a, serverSeq: _b, serverTs: _c, id, ...r }) => (void _a, void _b, void _c, { id: typeof id === "number" ? null : id, ...r }))
        .map((r) => JSON.stringify(r))
        .sort();
    for (const table of COPY_TABLES) {
      const a = (await direct.db.select().from(table)) as Record<string, unknown>[];
      const b = (await target.db.select().from(table)) as Record<string, unknown>[];
      expect(strip(b)).toEqual(strip(a));
      if (b.length && "seq" in b[0]) expect(b.every((r) => Number(r.seq) > 100000)).toBe(true);
    }
    const evs = await target.db.select().from(events).orderBy(events.serverSeq);
    const directEvs = await direct.db.select().from(events).orderBy(events.serverSeq);
    expect(evs.map((e) => e.id)).toEqual(directEvs.map((e) => e.id)); // replay order kept
    await direct.client.close();
    await target.client.close();
  });
});

async function samGroups(db: Parameters<typeof seed>[0], now: Date) {
  const rows = await db.select().from(tasks).where(eq(tasks.assigneeId, SEED_IDS.people.sam));
  return groupTasks(rows, now, BRANCH_TIMEZONE);
}
