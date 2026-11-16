// Office dashboard: pure rules + server aggregations against the real seed (PGlite).
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_IDS, SEED_TASK_ID, seed } from "@/db/seed-data";
import { resolveOfficeActor } from "@/lib/office/auth";
import { loadSnapshot, loadTaskDetail, loadTimesheets, teamStats } from "@/lib/office/queries";
import {
  ackOverdue,
  agoLabel,
  behindSchedule,
  entryFlags,
  median,
  needsReview,
  receiptStage,
  rolloutProgress,
  suggestAssignees,
  toCsv,
} from "@/lib/office/rules";
import { timesheetCsv, timesheetRows } from "@/lib/office/timesheets";
import { ROLLOUT_STAGES } from "@/lib/domain";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import { addDays, startOfWeekKey } from "@/lib/time";

const P = SEED_IDS.people;
const NOW = new Date("2026-11-18T16:00:00Z"); // Wednesday 11:00 New York
const MIN = 60_000;

describe("rules", () => {
  const sent = new Date(NOW.getTime() - 31 * MIN);
  const r = (x: Partial<{ deliveredAt: Date; seenAt: Date; acknowledgedAt: Date }> = {}) => ({
    sentAt: sent,
    deliveredAt: null,
    seenAt: null,
    acknowledgedAt: null,
    ...x,
  });

  it("reads the receipt chain and flags slow acknowledgements", () => {
    expect(receiptStage(r())).toBe("sent");
    expect(receiptStage(r({ seenAt: NOW }))).toBe("seen");
    expect(receiptStage(r({ acknowledgedAt: NOW }))).toBe("acknowledged");
    expect(ackOverdue({ status: "open" }, r(), NOW)).toBe(true);
    expect(ackOverdue({ status: "open" }, { ...r(), sentAt: new Date(NOW.getTime() - 29 * MIN) }, NOW)).toBe(false);
    expect(ackOverdue({ status: "open" }, r({ acknowledgedAt: NOW }), NOW)).toBe(false);
    expect(ackOverdue({ status: "done" }, r(), NOW)).toBe(false);
  });

  it("labels freshness honestly", () => {
    expect(agoLabel(null, NOW)).toBe("never synced");
    expect(agoLabel(new Date(NOW.getTime() - 20_000), NOW)).toBe("just now");
    expect(agoLabel(new Date(NOW.getTime() - 3 * MIN), NOW)).toBe("3 min ago");
    expect(agoLabel(new Date(NOW.getTime() - 26 * 60 * MIN), NOW)).toBe("1 day ago");
  });

  it("flags stores past their stage's expected duration", () => {
    const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    expect(behindSchedule({ rolloutStage: "install", stageChangedAt: daysAgo(8) }, NOW)).toMatchObject({ behind: true, days: 8, expected: 7 });
    expect(behindSchedule({ rolloutStage: "install", stageChangedAt: daysAgo(6) }, NOW).behind).toBe(false);
    expect(behindSchedule({ rolloutStage: "done", stageChangedAt: daysAgo(90) }, NOW).behind).toBe(false);
    expect(rolloutProgress(["done", "done", "survey", "install"], ROLLOUT_STAGES)).toMatchObject({ done: 2, total: 4 });
  });

  it("finds timesheet problems", () => {
    const e = { clockInAt: new Date(NOW.getTime() - 20 * 60 * MIN), clockOutAt: null, flagged: false, flagReason: null, reviewStatus: null };
    expect(entryFlags(e, NOW)).toEqual(["missing_clock_out"]);
    expect(entryFlags({ ...e, clockInAt: new Date(NOW.getTime() - 60 * MIN) }, NOW)).toEqual([]);
    expect(entryFlags({ ...e, clockOutAt: NOW, flagged: true, flagReason: "no_location: denied (needs HR review)" }, NOW)).toEqual(["no_location"]);
    expect(needsReview({ ...e, reviewStatus: "rejected" }, NOW)).toBe(false);
  });

  it("writes CSV that spreadsheets open safely", () => {
    expect(toCsv([["a", 'say "hi"', "x,y", null, 1.5, "=SUM(A1)", "-3"]])).toBe('a,"say ""hi""","x,y",,1.5,\'=SUM(A1),-3\r\n');
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("suggests active people with a fitting trade, those at the site first", () => {
    const people = [
      { id: "a", name: "Ann", role: "technician" as const, trade: "lighting" as const, active: true },
      { id: "b", name: "Bob", role: "technician" as const, trade: "lighting" as const, active: true },
      { id: "c", name: "Cat", role: "foreman" as const, trade: "electrical" as const, active: true },
      { id: "d", name: "Dee", role: "technician" as const, trade: "lighting" as const, active: false },
      { id: "e", name: "Eve", role: "coordinator" as const, trade: "general" as const, active: true },
      { id: "f", name: "Fay", role: "technician" as const, trade: "general" as const, active: true },
    ];
    const out = suggestAssignees({ people, trade: "lighting", siteId: "s1", openTasks: [{ assigneeId: "b", siteId: "s1" }], clockedInAt: new Map() });
    expect(out.map((p) => p.id)).toEqual(["b", "a", "f"]);
    expect(out[0]).toMatchObject({ atSite: true, openCount: 1 });
    const clocked = suggestAssignees({ people, trade: "any", siteId: "s2", openTasks: [], clockedInAt: new Map([["c", "s2"]]) });
    expect(clocked[0].id).toBe("c");
  });
});

describe("server queries (seeded)", () => {
  let client: PGlite;
  let db: Db;
  beforeAll(async () => {
    client = new PGlite();
    db = drizzle({ client });
    await migrate(db, { migrationsFolder: "./db/migrations" });
    await seed(db, { now: NOW });
  });
  afterAll(async () => client.close());

  it("only lets office roles in", async () => {
    const cookies = (v: Record<string, string>) => ({ get: (n: string) => (v[n] ? { value: v[n] } : undefined) });
    expect(await resolveOfficeActor(db, cookies({}))).toMatchObject({ ok: false, status: 401 });
    expect(await resolveOfficeActor(db, cookies({ sitesync_actor: P.sam }))).toMatchObject({ ok: false, status: 403 });
    // The office cookie wins over the field one (two roles in one browser).
    expect(await resolveOfficeActor(db, cookies({ sitesync_actor: P.sam, sitesync_office_actor: P.dana }))).toMatchObject({
      ok: true,
      actor: { id: P.dana, role: "coordinator" },
    });
  });

  it("builds the live snapshot: open entries, latest status, freshness, no private paths", async () => {
    const s = await loadSnapshot(db, NOW);
    expect(s.openEntries.map((e) => e.personId).sort()).toEqual([P.luis, P.sam, P.tom].sort());
    expect(s.statuses.find((x) => x.personId === P.aisha)?.status).toBe("traveling");
    expect(s.lastSync.find((d) => d.personId === P.sam)?.lastSyncAt).toBe(new Date(NOW.getTime() - 2 * MIN).toISOString());
    expect(s.tasks.length).toBeGreaterThan(30);
    expect(JSON.stringify(s)).not.toMatch(/blobPath":"notes\//);
    const stores = s.sites.filter((x) => x.kind === "rollout_store");
    expect(stores.filter((x) => behindSchedule(x, NOW).behind).map((x) => x.name.slice(0, 12)).sort()).toEqual(
      ["RetailCo #104", "RetailCo #106", "RetailCo #108", "RetailCo #112"].map((n) => n.slice(0, 12)).sort(),
    );
  });

  it("returns a task's full history with devices, and its follow-ups", async () => {
    const d = await loadTaskDetail(db, SEED_TASK_ID(14));
    expect(d?.history.map((h) => h.type)).toEqual(["task.created", "task.delivered", "task.seen", "task.acknowledged", "task.status_changed"]);
    expect(d?.history.every((h) => h.deviceId === "seed")).toBe(true);
    expect(d?.followUps.map((f) => f.id)).toEqual([SEED_TASK_ID(16)]);
    const withNote = await loadTaskDetail(db, SEED_TASK_ID(1));
    expect(withNote?.notes).toHaveLength(1);
    expect(withNote?.notes[0]).toMatchObject({ blobPath: null, mediaUrl: null });
    expect(await loadTaskDetail(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("lists the week's entries and every unreviewed problem, and exports CSV", async () => {
    const week = startOfWeekKey("2026-11-18");
    const t = await loadTimesheets(db, week, NOW);
    expect(t.week.length).toBeGreaterThan(0);
    const flagged = t.review.filter((e) => needsReview(e, NOW)).map((e) => e.personId).sort();
    expect(flagged).toEqual([P.aisha, P.grace, P.tom].sort());
    const rows = timesheetRows(t, NOW);
    expect(rows.find((r) => r.person === "Aisha Bello")?.flags).toEqual(["Too far from site"]);
    const csv = timesheetCsv(t, NOW);
    expect(csv.startsWith("﻿Person,Date,Site")).toBe(true);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(rows.length + 1);

    // After HR rejects one, it leaves the review list.
    const tom = t.review.find((e) => e.personId === P.tom)!;
    const out = await processSync(
      db,
      {
        deviceId: "web-test",
        actorId: P.priya,
        cursor: null,
        pull: false,
        events: [{ id: "f1000000-0000-4000-8000-000000000001", type: "time.rejected", actorId: P.priya, deviceId: "web-test", clientTs: NOW.toISOString(), payload: { timeEntryId: tom.id, reason: "No clock-out" } }],
      },
      { now: () => NOW },
    );
    expect(out.ok && out.response.rejected).toEqual([]);
    const again = await loadTimesheets(db, week, NOW);
    expect(again.review.some((e) => e.id === tom.id)).toBe(false);
  });

  it("aggregates team stats per person, per site and for the branch in SQL", async () => {
    const to = "2026-11-18";
    const s = await teamStats(db, addDays(to, -13), to, NOW);
    expect(s.daily).toHaveLength(14);
    expect(s.branch.completed).toBe(s.daily.reduce((n, d) => n + d.completed, 0));
    expect(s.branch.completed).toBeGreaterThanOrEqual(2); // tasks 20 and 26 are done
    const luis = s.person.find((p) => p.key === P.luis);
    expect(luis?.completed).toBe(1);
    // Every seeded acknowledgement comes 90 minutes after the task was sent.
    expect(s.branch.medianAckMin).toBe(90);
    expect(s.person.find((p) => p.key === P.tom)?.blocked).toBe(1);
    expect(s.branch.overdue).toBeGreaterThan(0);
    const siteSum = s.site.reduce((n, x) => n + x.completed, 0);
    expect(siteSum).toBe(s.branch.completed);
  });
});
