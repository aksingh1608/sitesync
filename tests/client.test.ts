// End-to-end client <-> server: Dexie (fake-indexeddb) + the real processSync
// on PGlite, with a JSON round-trip in between like the real HTTP route.
import "fake-indexeddb/auto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events } from "@/lib/db/schema";
import { getMeta, localDb, setMeta } from "@/lib/db/local";
import { backoffMs, enqueue, LocalRejectError, setActor, setTransport, sync } from "@/lib/sync/client";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import type { SyncRequest, WireSyncResponse } from "@/lib/sync/protocol";
import { ids, makeDb, taskCreated, uuid, at } from "./helpers";

let db: Db;
let close: () => Promise<void>;
let calls = 0;
let failNext = false;
let dropResponse = false;

beforeEach(async () => {
  ({ db, close } = await makeDb());
  calls = 0;
  failNext = false;
  dropResponse = false;
  setTransport(async (req: SyncRequest) => {
    calls++;
    if (failNext) throw new Error("network down");
    const out = await processSync(db, JSON.parse(JSON.stringify(req)));
    if (!out.ok) throw new Error(out.error);
    if (dropResponse) throw new Error("response lost");
    return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
  });
  await localDb.delete({ disableAutoOpen: false });
  // A coordinator-created task already on the server for techA.
  const r = await processSync(db, {
    deviceId: "office",
    actorId: ids.coordinator,
    cursor: null,
    events: [taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z"))],
  });
  if (!r.ok) throw new Error(r.error);
});
afterEach(async () => {
  setTransport(null);
  await close();
});

const serverEventCount = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(events))[0].n);

describe("client sync engine", () => {
  it("pulls, records delivery, works offline, then syncs every event exactly once", async () => {
    await setActor(ids.techA);
    const first = await sync();
    expect(first.status).toBe("ok");
    const [task] = await localDb.tasks.toArray();
    expect(task.title).toBe("Test task");
    // The delivered receipt was generated and sent automatically.
    expect((await localDb.taskReceipts.get([task.id, ids.techA]))?.deliveredAt).toBeInstanceOf(Date);
    expect(await localDb.outbox.count()).toBe(0);

    // Go offline (demo toggle). Writes land in the outbox and the cache.
    await setMeta({ simulateOffline: true });
    const before = calls;
    const newTaskId = uuid();
    await enqueue({
      type: "task.created",
      payload: { taskId: newTaskId, title: "Offline task", siteId: ids.siteA, assigneeId: ids.techA },
    });
    await enqueue({ type: "task.acknowledged", payload: { taskId: task.id } });
    expect((await sync()).status).toBe("offline");
    expect(calls).toBe(before); // no network call
    expect(await localDb.outbox.count()).toBe(2);
    expect((await localDb.tasks.get(newTaskId))?.title).toBe("Offline task"); // optimistic
    expect((await localDb.taskReceipts.get([task.id, ids.techA]))?.acknowledgedAt).toBeInstanceOf(Date);

    const eventsBefore = await serverEventCount();

    // Back online, but the first response is lost after the server committed.
    await setMeta({ simulateOffline: false });
    dropResponse = true;
    expect((await sync({ manual: true })).status).toBe("error");
    expect(await localDb.outbox.count()).toBe(2);
    expect((await localDb.outbox.toArray())[0]).toMatchObject({ attempts: 1, lastError: "response lost" });

    // The retry resends the same events; the server reports them as duplicates.
    dropResponse = false;
    const ok = await sync({ manual: true });
    expect(ok).toMatchObject({ status: "ok", accepted: 1, duplicates: 2 }); // +1: delivered receipt for the new task
    expect(await localDb.outbox.count()).toBe(0);
    expect(await serverEventCount()).toBe(eventsBefore + 3);
    expect((await localDb.tasks.get(newTaskId))?.seq).toBeGreaterThan(0); // server copy replaced optimistic one
  });

  it("refuses locally invalid writes instead of queueing them", async () => {
    await setActor(ids.techA);
    await sync();
    await expect(
      enqueue({ type: "task.status_changed", payload: { taskId: uuid(), to: "done" } }),
    ).rejects.toBeInstanceOf(LocalRejectError);
    expect(await localDb.outbox.count()).toBe(0);
  });

  it("marks server-rejected events and rebuilds the cache from the server", async () => {
    await setActor(ids.techA);
    await sync();
    const [task] = await localDb.tasks.toArray();
    await setMeta({ simulateOffline: true });
    await enqueue({ type: "task.status_changed", payload: { taskId: task.id, to: "in_progress" } });
    expect((await localDb.tasks.get(task.id))?.status).toBe("in_progress");

    // Meanwhile the office cancels the task, later than the technician's change.
    await processSync(db, {
      deviceId: "office",
      actorId: ids.coordinator,
      cursor: null,
      events: [
        {
          id: uuid(),
          type: "task.status_changed",
          actorId: ids.coordinator,
          deviceId: "office",
          clientTs: new Date(Date.now() + 60_000).toISOString(),
          payload: { taskId: task.id, to: "cancelled" },
        },
      ],
    });

    await setMeta({ simulateOffline: false });
    const res = await sync({ manual: true });
    expect(res.status).toBe("ok");
    const [item] = await localDb.outbox.toArray();
    expect(item.status).toBe("rejected");
    expect(item.rejectReason).toMatch(/^stale_event/);
    expect((await localDb.tasks.get(task.id))?.status).toBe("cancelled");
  });

  it("backs off exponentially after failures, but a manual sync ignores the backoff", async () => {
    await setActor(ids.techA);
    failNext = true;
    expect((await sync()).status).toBe("error");
    const m = await getMeta();
    expect(m.consecutiveFailures).toBe(1);
    expect(Date.parse(m.nextRetryAt!)).toBeGreaterThan(Date.now());
    expect((await sync()).status).toBe("skipped");
    failNext = false;
    expect((await sync({ manual: true })).status).toBe("ok");
    expect((await getMeta()).consecutiveFailures).toBe(0);

    expect(backoffMs(1, () => 0.5)).toBe(2_000);
    expect(backoffMs(4, () => 0.5)).toBe(16_000);
    expect(backoffMs(30, () => 0.5)).toBe(300_000);
  });

  it("runs overlapping sync calls as one", async () => {
    await setActor(ids.techA);
    const [a, b] = [sync(), sync()];
    expect(a).toBe(b);
    await a;
  });
});
