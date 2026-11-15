import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, taskReceipts, tasks, timeEntries } from "@/lib/db/schema";
import { offsetNorth } from "@/lib/geo";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import { at, event, ids, makeDb, NOW, SITE_A, sync, taskCreated, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await makeDb()));
afterEach(async () => close());

const count = async (table: typeof events | typeof tasks) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(table))[0].n);

describe("idempotency", () => {
  it("applies the same batch only once when it is sent twice", async () => {
    const taskId = uuid();
    const batch = [
      taskCreated(ids.coordinator, taskId, at("2026-11-15T10:00:00Z")),
      event({
        type: "task.status_changed",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T10:01:00Z"),
        payload: { taskId, to: "in_progress" },
      }),
    ];

    const first = await sync(db, ids.coordinator, batch);
    expect(first.accepted).toEqual(batch.map((e) => e.id));
    expect(first.duplicates).toEqual([]);
    const [afterFirst] = await db.select().from(tasks).where(eq(tasks.id, taskId));

    const second = await sync(db, ids.coordinator, batch);
    expect(second.accepted).toEqual([]);
    expect(second.duplicates).toEqual(batch.map((e) => e.id));
    expect(second.rejected).toEqual([]);

    const [afterSecond] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(await count(events)).toBe(2);
    expect(await count(tasks)).toBe(1);
    // Not re-applied, so the row was not rewritten either.
    expect(afterSecond.seq).toBe(afterFirst.seq);
    expect(afterSecond.status).toBe("in_progress");
  });

  it("treats a repeated id inside one batch as a duplicate", async () => {
    const e = taskCreated(ids.coordinator, uuid(), at("2026-11-15T10:00:00Z"));
    const res = await sync(db, ids.coordinator, [e, e]);
    expect(res.accepted).toEqual([e.id]);
    expect(res.duplicates).toEqual([e.id]);
  });

  it("reports a resent rejected event as rejected again, with the stored reason", async () => {
    const bad = event({
      type: "task.status_changed",
      actorId: ids.techA,
      clientTs: at("2026-11-15T10:00:00Z"),
      payload: { taskId: uuid(), to: "done" },
    });
    const a = await sync(db, ids.techA, [bad]);
    const b = await sync(db, ids.techA, [bad]);
    expect(a.rejected).toEqual([{ id: bad.id, reason: "task_not_found" }]);
    expect(b.rejected).toEqual([{ id: bad.id, reason: "task_not_found" }]);
    const [row] = await db.select().from(events).where(eq(events.id, bad.id));
    expect(row.applied).toBe(false);
    expect(row.rejectReason).toBe("task_not_found");
  });
});

describe("last write wins per field", () => {
  it("resolves out-of-order edits by clientTs, field by field", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);

    // Device 1 edited title at 10:05 and priority at 10:05.
    // Device 2 edited title at 10:00 (older) and description at 10:10.
    // Device 1's batch arrives first, then device 2's older title edit.
    const newerTitle = event({
      type: "task.updated",
      actorId: ids.coordinator,
      clientTs: at("2026-11-15T10:05:00Z"),
      payload: { taskId, changes: { title: "Newer title", priority: "urgent" } },
    });
    const olderTitle = event({
      type: "task.updated",
      actorId: ids.coordinator,
      clientTs: at("2026-11-15T10:00:00Z"),
      payload: { taskId, changes: { title: "Older title", description: "from device 2" } },
    });
    await sync(db, ids.coordinator, [newerTitle]);
    const res = await sync(db, ids.coordinator, [olderTitle]);
    expect(res.accepted).toEqual([olderTitle.id]);

    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t.title).toBe("Newer title"); // older edit lost on this field
    expect(t.priority).toBe("urgent");
    expect(t.description).toBe("from device 2"); // but won where nobody newer wrote
    expect(t.fieldTs.title?.ev).toBe(newerTitle.id);
    expect(t.fieldTs.description?.ev).toBe(olderTitle.id);
  });

  it("produces the same result whichever order the edits arrive in", async () => {
    const run = async (order: "forward" | "reverse") => {
      const { db: d, close: c } = await makeDb();
      const taskId = "f0000000-0000-4000-8000-000000000001";
      await sync(d, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
      const edits = [
        { id: "f1000000-0000-4000-8000-000000000001", ts: "2026-11-15T10:00:00Z", title: "A" },
        { id: "f1000000-0000-4000-8000-000000000002", ts: "2026-11-15T10:02:00Z", title: "B" },
        { id: "f1000000-0000-4000-8000-000000000003", ts: "2026-11-15T10:01:00Z", title: "C" },
      ].map((e) =>
        event({
          id: e.id,
          type: "task.updated",
          actorId: ids.coordinator,
          clientTs: at(e.ts),
          payload: { taskId, changes: { title: e.title } },
        }),
      );
      if (order === "reverse") edits.reverse();
      for (const e of edits) await sync(d, ids.coordinator, [e]);
      const [t] = await d.select().from(tasks).where(eq(tasks.id, taskId));
      await c();
      return t.title;
    };
    expect(await run("forward")).toBe("B");
    expect(await run("reverse")).toBe("B");
  });

  it("breaks clientTs ties by event id", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
    const ts = at("2026-11-15T10:00:00Z");
    const high = event({
      id: "ffffffff-0000-4000-8000-000000000000",
      type: "task.updated",
      actorId: ids.coordinator,
      clientTs: ts,
      payload: { taskId, changes: { title: "High id" } },
    });
    const low = event({
      id: "00000001-0000-4000-8000-000000000000",
      type: "task.updated",
      actorId: ids.coordinator,
      clientTs: ts,
      payload: { taskId, changes: { title: "Low id" } },
    });
    await sync(db, ids.coordinator, [high, low]);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t.title).toBe("High id");
  });
});

describe("task status", () => {
  it("does not let an older status event reopen a done task", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
    await sync(db, ids.coordinator, [
      event({
        type: "task.status_changed",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T12:00:00Z"),
        payload: { taskId, to: "done" },
      }),
    ]);

    // The technician was offline and marked it in progress at 11:00, before it was closed.
    const stale = event({
      type: "task.status_changed",
      actorId: ids.techA,
      clientTs: at("2026-11-15T11:00:00Z"),
      payload: { taskId, to: "in_progress" },
    });
    const res = await sync(db, ids.techA, [stale]);
    expect(res.accepted).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/^stale_event/);

    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t.status).toBe("done");
  });

  it("allows a newer event to reopen a done task, but only to open", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [
      taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z")),
      event({
        type: "task.status_changed",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T10:00:00Z"),
        payload: { taskId, to: "done" },
      }),
    ]);
    const bad = event({
      type: "task.status_changed",
      actorId: ids.coordinator,
      clientTs: at("2026-11-15T11:00:00Z"),
      payload: { taskId, to: "in_progress" },
    });
    const good = event({
      type: "task.status_changed",
      actorId: ids.coordinator,
      clientTs: at("2026-11-15T11:01:00Z"),
      payload: { taskId, to: "open" },
    });
    const res = await sync(db, ids.coordinator, [bad, good]);
    expect(res.rejected).toEqual([{ id: bad.id, reason: "invalid_transition: done -> in_progress" }]);
    expect(res.accepted).toEqual([good.id]);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t.status).toBe("open");
  });
});

describe("receipts", () => {
  it("keeps the earliest timestamp and never regresses", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);

    const receipt = async () =>
      (await db.select().from(taskReceipts).where(eq(taskReceipts.taskId, taskId)))[0];
    expect((await receipt()).sentAt.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect((await receipt()).deliveredAt).toBeNull();

    // Acknowledged at 10:30 arrives first: it implies delivered and seen.
    await sync(db, ids.techA, [
      event({ type: "task.acknowledged", actorId: ids.techA, clientTs: at("2026-11-15T10:30:00Z"), payload: { taskId } }),
    ]);
    let r = await receipt();
    expect(r.deliveredAt?.toISOString()).toBe("2026-11-15T10:30:00.000Z");
    expect(r.seenAt?.toISOString()).toBe("2026-11-15T10:30:00.000Z");
    expect(r.acknowledgedAt?.toISOString()).toBe("2026-11-15T10:30:00.000Z");

    // The earlier delivered/seen events arrive late: they move times earlier.
    await sync(db, ids.techA, [
      event({ type: "task.delivered", actorId: ids.techA, clientTs: at("2026-11-15T09:05:00Z"), payload: { taskId } }),
      event({ type: "task.seen", actorId: ids.techA, clientTs: at("2026-11-15T10:00:00Z"), payload: { taskId } }),
    ]);
    r = await receipt();
    expect(r.deliveredAt?.toISOString()).toBe("2026-11-15T09:05:00.000Z");
    expect(r.seenAt?.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(r.acknowledgedAt?.toISOString()).toBe("2026-11-15T10:30:00.000Z");

    // Later repeats never move a timestamp forward or clear one.
    await sync(db, ids.techA, [
      event({ type: "task.delivered", actorId: ids.techA, clientTs: at("2026-11-15T14:00:00Z"), payload: { taskId } }),
      event({ type: "task.acknowledged", actorId: ids.techA, clientTs: at("2026-11-15T14:00:00Z"), payload: { taskId } }),
    ]);
    const final = await receipt();
    expect(final.deliveredAt?.toISOString()).toBe("2026-11-15T09:05:00.000Z");
    expect(final.seenAt?.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(final.acknowledgedAt?.toISOString()).toBe("2026-11-15T10:30:00.000Z");
  });

  it("rejects receipts from someone the task was not sent to", async () => {
    const taskId = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
    const res = await sync(db, ids.techB, [
      event({ type: "task.seen", actorId: ids.techB, clientTs: at("2026-11-15T10:00:00Z"), payload: { taskId } }),
    ]);
    expect(res.rejected[0].reason).toBe("forbidden");
  });
});

describe("clock-in geofence", () => {
  const clockIn = (distanceM: number) => {
    const p = offsetNorth(SITE_A.lat, SITE_A.lng, distanceM);
    return event({
      type: "time.clock_in",
      actorId: ids.techA,
      clientTs: at("2026-11-15T07:00:00Z"),
      payload: { timeEntryId: uuid(), siteId: ids.siteA, lat: p.lat, lng: p.lng, accuracyM: 5 },
    });
  };
  const entry = async (id: string) => (await db.select().from(timeEntries).where(eq(timeEntries.id, id)))[0];
  const idOf = (e: ReturnType<typeof clockIn>) => (e.payload as { timeEntryId: string }).timeEntryId;

  it("does not flag a clock-in just inside the radius", async () => {
    const e = clockIn(SITE_A.radius - 0.5);
    await sync(db, ids.techA, [e]);
    const row = await entry(idOf(e));
    expect(row.clockInDistanceM).toBeCloseTo(SITE_A.radius - 0.5, 1);
    expect(row.flagged).toBe(false);
    expect(row.flagReason).toBeNull();
  });

  it("flags a clock-in just outside the radius", async () => {
    const e = clockIn(SITE_A.radius + 0.5);
    await sync(db, ids.techA, [e]);
    const row = await entry(idOf(e));
    expect(row.flagged).toBe(true);
    expect(row.flagReason).toMatch(/^outside_geofence/);
  });

  it("flags a clock-in with no location", async () => {
    const e = event({
      type: "time.clock_in",
      actorId: ids.techA,
      clientTs: at("2026-11-15T07:00:00Z"),
      payload: { timeEntryId: uuid(), siteId: ids.siteA, lat: null, lng: null, accuracyM: null },
    });
    await sync(db, ids.techA, [e]);
    expect((await entry(idOf(e))).flagReason).toMatch(/^no_location/);
  });

  it("rejects a second clock-in while one is open, and accepts clock-out then clock-in", async () => {
    const first = clockIn(10);
    const second = clockIn(10);
    const res = await sync(db, ids.techA, [first, second]);
    expect(res.rejected).toEqual([{ id: second.id, reason: "already_clocked_in" }]);
    const out = event({
      type: "time.clock_out",
      actorId: ids.techA,
      clientTs: at("2026-11-15T15:00:00Z"),
      payload: { timeEntryId: idOf(first), lat: SITE_A.lat, lng: SITE_A.lng },
    });
    const third = event({ ...clockIn(10), clientTs: at("2026-11-15T15:30:00Z") });
    const res2 = await sync(db, ids.techA, [out, third]);
    expect(res2.accepted).toEqual([out.id, third.id]);
  });
});

describe("cursor pull and visibility", () => {
  it("returns only rows the actor may see, and only rows newer than the cursor", async () => {
    const taskA = uuid();
    const taskB = uuid();
    await sync(db, ids.coordinator, [
      taskCreated(ids.coordinator, taskA, at("2026-11-15T09:00:00Z"), { assigneeId: ids.techA, siteId: ids.siteA }),
      taskCreated(ids.coordinator, taskB, at("2026-11-15T09:00:00Z"), {
        assigneeId: ids.techB,
        siteId: ids.siteRollout,
      }),
    ]);
    await sync(db, ids.techB, [
      event({
        type: "time.clock_in",
        actorId: ids.techB,
        clientTs: at("2026-11-15T08:00:00Z"),
        payload: { timeEntryId: uuid(), siteId: ids.siteRollout, lat: 40.7, lng: -73.9, accuracyM: 5 },
      }),
    ]);

    const a = await sync(db, ids.techA, []);
    expect(a.changes.tasks.map((t) => t.id)).toEqual([taskA]);
    expect(a.changes.task_receipts.map((r) => r.taskId)).toEqual([taskA]);
    expect(a.changes.time_entries).toEqual([]);
    expect(a.changes.sites.map((s) => s.id)).toEqual([ids.siteA]);
    expect(a.changes.rollouts).toEqual([]);
    expect(a.changes.people).toHaveLength(4); // the directory is shared

    const b = await sync(db, ids.techB, []);
    expect(b.changes.tasks.map((t) => t.id)).toEqual([taskB]);
    expect(b.changes.time_entries).toHaveLength(1);
    expect(b.changes.sites.map((s) => s.id)).toEqual([ids.siteRollout]);
    expect(b.changes.rollouts.map((r) => r.id)).toEqual([ids.rollout]);

    const office = await sync(db, ids.manager, []);
    expect(office.changes.tasks.map((t) => t.id).sort()).toEqual([taskA, taskB].sort());
    expect(office.changes.time_entries).toHaveLength(1);
    expect(office.changes.sites).toHaveLength(3);

    // Pulling again from the returned cursor gives nothing new.
    const again = await sync(db, ids.techA, [], a.cursor);
    expect(Object.values(again.changes).every((rows) => rows.length === 0)).toBe(true);
    expect(again.cursor).toBe(a.cursor);

    // A change to techA's task shows up after the cursor; a change to techB's does not.
    await sync(db, ids.coordinator, [
      event({
        type: "task.updated",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T10:00:00Z"),
        payload: { taskId: taskA, changes: { priority: "high" } },
      }),
      event({
        type: "task.updated",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T10:00:00Z"),
        payload: { taskId: taskB, changes: { priority: "high" } },
      }),
    ]);
    const delta = await sync(db, ids.techA, [], a.cursor);
    expect(delta.changes.tasks.map((t) => t.id)).toEqual([taskA]);
    expect(Number(delta.cursor)).toBeGreaterThan(Number(a.cursor));
  });

  it("sends a site again when it newly becomes relevant to a technician", async () => {
    const first = await sync(db, ids.techA, []);
    expect(first.changes.sites).toEqual([]);
    await sync(db, ids.coordinator, [
      taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"), { siteId: ids.siteB }),
    ]);
    const next = await sync(db, ids.techA, [], first.cursor);
    expect(next.changes.sites.map((s) => s.id)).toEqual([ids.siteB]);
  });
});

describe("validation", () => {
  it("rejects an invalid event without failing the rest of the batch", async () => {
    const good1 = taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"));
    const malformed = { id: uuid(), type: "task.created", actorId: ids.coordinator, payload: { title: "" } };
    const unknownType = event({ type: "task.exploded", actorId: ids.coordinator, clientTs: at("2026-11-15T09:00:00Z"), payload: {} } as never);
    const notAnObject = 42;
    const badRef = taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"), { siteId: uuid() });
    const otherActor = taskCreated(ids.techA, uuid(), at("2026-11-15T09:00:00Z"));
    const good2 = taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:01:00Z"));

    const res = await sync(db, ids.coordinator, [good1, malformed, unknownType, notAnObject, badRef, otherActor, good2]);
    expect(res.accepted).toEqual([good1.id, good2.id]);
    expect(res.rejected.map((r) => r.id)).toEqual([malformed.id, unknownType.id, "index:3", badRef.id, otherActor.id]);
    expect(res.rejected[0].reason).toMatch(/^invalid_event/);
    expect(res.rejected[3].reason).toBe("site_not_found");
    expect(res.rejected[4].reason).toMatch(/^actor_mismatch/);
    expect(await count(tasks)).toBe(2);
  });

  it("rejects events with a clientTs far in the future", async () => {
    const e = taskCreated(ids.coordinator, uuid(), new Date(NOW.getTime() + 3 * 86_400_000).toISOString());
    const res = await sync(db, ids.coordinator, [e]);
    expect(res.rejected).toEqual([{ id: e.id, reason: "client_ts_in_future" }]);
  });

  it("refuses an unknown actor", async () => {
    const out = await processSync(db, { deviceId: "d", actorId: uuid(), cursor: null, events: [] });
    expect(out).toEqual({ ok: false, status: 403, error: "unknown_actor" });
  });

  it("stops technicians from creating tasks for other people", async () => {
    const e = taskCreated(ids.techA, uuid(), at("2026-11-15T09:00:00Z"), { assigneeId: ids.techB });
    const res = await sync(db, ids.techA, [e]);
    expect(res.rejected[0].reason).toMatch(/^forbidden/);
  });
});
