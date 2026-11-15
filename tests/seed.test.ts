import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { SEED_IDS, SEED_TASK_ID, seed } from "@/db/seed-data";
import { BRANCH_TIMEZONE } from "@/lib/config";
import { events, taskReceipts, tasks, timeEntries } from "@/lib/db/schema";
import { groupTasks } from "@/lib/tasks/grouping";

describe("seed", () => {
  it("is deterministic, goes through the reducers, and can be re-run", async () => {
    const client = new PGlite();
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: "./db/migrations" });
    const now = new Date("2026-11-15T16:00:00Z");

    const first = await seed(db, { now });
    const second = await seed(db, { now }); // wipes and reseeds
    expect(second).toEqual(first);
    expect(first.tasks).toBeGreaterThanOrEqual(28);

    const allEvents = await db.select().from(events);
    expect(allEvents).toHaveLength(first.events);
    expect(allEvents.every((e) => e.applied && e.rejectReason === null)).toBe(true);

    const entries = await db.select().from(timeEntries);
    expect(entries.filter((e) => e.flagged)).toHaveLength(1);
    expect(entries.find((e) => e.flagged)?.flagReason).toMatch(/^outside_geofence/);

    const receipts = await db.select().from(taskReceipts);
    const states = new Set(
      receipts.map((r) => (r.acknowledgedAt ? "ack" : r.seenAt ? "seen" : r.deliveredAt ? "delivered" : "sent")),
    );
    expect(states).toEqual(new Set(["sent", "delivered", "seen", "ack"]));

    const samTasks = await db.select().from(tasks).where(eq(tasks.assigneeId, SEED_IDS.people.sam));
    const g = groupTasks(samTasks, now, BRANCH_TIMEZONE);
    for (const k of ["today", "thisWeek", "thisMonth", "followUps", "closed"] as const) {
      expect(g[k].length, k).toBeGreaterThan(0);
    }
    const [child] = await db.select().from(tasks).where(eq(tasks.id, SEED_TASK_ID(16)));
    expect(child.parentTaskId).toBe(SEED_TASK_ID(14));
    const [{ n }] = await db.select({ n: sql<number>`count(distinct status)` }).from(tasks);
    expect(Number(n)).toBe(5);
    await client.close();
  });
});
