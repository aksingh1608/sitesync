// Day 2 client behaviour against the real server code (PGlite).
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDb, localDb, setMeta } from "@/lib/db/local";
import { enqueue, markSeen, setActor, setTransport, sync } from "@/lib/sync/client";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import type { SyncRequest, WireSyncResponse } from "@/lib/sync/protocol";
import { at, event, ids, makeDb, taskCreated, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
let requests: SyncRequest[] = [];

beforeEach(async () => {
  ({ db, close } = await makeDb());
  requests = [];
  setTransport(async (req) => {
    requests.push(req);
    const out = await processSync(db, JSON.parse(JSON.stringify(req)));
    if (!out.ok) throw new Error(out.error);
    return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
  });
  await localDb.delete({ disableAutoOpen: false });
});
afterEach(async () => {
  setTransport(null);
  await close();
});

const office = async (events: unknown[]) => {
  const r = await processSync(db, { deviceId: "office", actorId: ids.coordinator, cursor: null, events });
  if (!r.ok) throw new Error(r.error);
  expect(r.response.rejected).toEqual([]);
};
const sentTypes = () => requests.flatMap((r) => (r.events as { type: string }[]).map((e) => e.type));

describe("reassignment on the device", () => {
  it("removes the task from the old assignee's device and adds it to the new one's", async () => {
    const taskId = uuid();
    await office([taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);

    await setActor(ids.techA);
    await sync();
    expect(await localDb.tasks.get(taskId)).toBeDefined();
    expect(await localDb.taskReceipts.get([taskId, ids.techA])).toBeDefined();

    await office([
      event({
        type: "task.updated",
        actorId: ids.coordinator,
        clientTs: at("2026-11-15T10:00:00Z"),
        payload: { taskId, changes: { assigneeId: ids.techB } },
      }),
    ]);
    expect((await sync()).status).toBe("ok");
    expect(await localDb.tasks.get(taskId)).toBeUndefined();
    expect(await localDb.taskReceipts.where("taskId").equals(taskId).count()).toBe(0);

    await setActor(ids.techB); // B's device
    await sync();
    expect((await localDb.tasks.get(taskId))?.assigneeId).toBe(ids.techB);
    expect((await localDb.taskReceipts.get([taskId, ids.techB]))?.deliveredAt).toBeInstanceOf(Date);
  });
});

describe("paging", () => {
  it("keeps pulling until hasMore is false, inside one sync() call", async () => {
    const batch = Array.from({ length: 150 }, () => taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z")));
    await office(batch.slice(0, 100));
    await office(batch.slice(100));
    // Make the page small via a wrapping transport, to prove the loop.
    setTransport(async (req) => {
      requests.push(req);
      const out = await processSync(db, JSON.parse(JSON.stringify(req)), { pageSize: 120 });
      if (!out.ok) throw new Error(out.error);
      return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
    });
    await setActor(ids.techA);
    const res = await sync();
    expect(res.status).toBe("ok");
    expect(await localDb.tasks.count()).toBe(150);
    expect(requests.length).toBeGreaterThanOrEqual(3); // 150 tasks + 150 receipts + ... at 120 per page
    // All delivered receipts went out once, after the pages were in.
    expect(sentTypes().filter((t) => t === "task.delivered")).toHaveLength(150);
    expect(await localDb.outbox.count()).toBe(0);
  });
});

describe("receipts fire once per device and person", () => {
  it("sends task.delivered once, even after the cache is rebuilt", async () => {
    const taskId = uuid();
    await office([taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
    await setActor(ids.techA);
    await setMeta({ simulateOffline: true });
    await sync(); // offline: nothing pulled yet, so nothing delivered
    await setMeta({ simulateOffline: false });

    // First sync pulls the task; the delivered receipt is queued while the
    // response is lost, so the server never sees it in that round.
    let drop = true;
    setTransport(async (req) => {
      requests.push(req);
      const out = await processSync(db, JSON.parse(JSON.stringify(req)));
      if (!out.ok) throw new Error(out.error);
      if (drop && req.events.length > 0) {
        drop = false;
        throw new Error("lost");
      }
      return JSON.parse(JSON.stringify(out.response)) as WireSyncResponse;
    });
    await sync({ manual: true });
    await sync({ manual: true });
    // Force a full rebuild of the cache: the mark survives, so no second receipt.
    await setMeta({ cursor: null });
    await sync({ manual: true });
    await setMeta({ cursor: null });
    await sync({ manual: true });
    const delivered = requests.flatMap((r) => r.events as { type: string; id: string }[]).filter((e) => e.type === "task.delivered");
    expect(new Set(delivered.map((e) => e.id)).size).toBe(1); // one event, possibly resent
    expect(await localDb.receiptMarks.count()).toBe(1);
  });

  it("sends task.seen the first time the detail opens, and only then", async () => {
    const taskId = uuid();
    await office([taskCreated(ids.coordinator, taskId, at("2026-11-15T09:00:00Z"))]);
    await setActor(ids.techA);
    await sync();
    expect(await markSeen(taskId)).toBe(true);
    expect(await markSeen(taskId)).toBe(false);
    await sync();
    expect(await markSeen(taskId)).toBe(false);
    expect(sentTypes().filter((t) => t === "task.seen")).toHaveLength(1);
    expect((await localDb.taskReceipts.get([taskId, ids.techA]))?.seenAt).toBeInstanceOf(Date);

    // Not my task -> nothing is sent.
    const other = uuid();
    await office([taskCreated(ids.coordinator, other, at("2026-11-15T09:00:00Z"), { assigneeId: ids.techB })]);
    expect(await markSeen(other)).toBe(false);
  });

  it("refuses forbidden writes locally, before they reach the outbox", async () => {
    const theirs = uuid();
    await office([
      taskCreated(ids.coordinator, theirs, at("2026-11-15T09:00:00Z"), { assigneeId: ids.techB }),
      taskCreated(ids.coordinator, uuid(), at("2026-11-15T09:00:00Z")), // puts Site A on techA's device
    ]);
    await setActor(ids.techA);
    await sync();
    await expect(
      enqueue({ type: "task.created", payload: { taskId: uuid(), title: "x", siteId: ids.siteA, assigneeId: ids.techB } }),
    ).rejects.toMatchObject({ reason: "forbidden" });
    expect(await localDb.outbox.count()).toBe(0);
  });
});

describe("Dexie schema upgrade", () => {
  it("upgrades a v1 database to v2 without losing the outbox", async () => {
    const name = `upgrade-${uuid()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      outbox: "++seq, &id, status, actorId, [actorId+status]",
      tasks: "id, assigneeId, createdBy, siteId, dueAt, status, seq",
      taskReceipts: "[taskId+personId], taskId, personId",
      timeEntries: "id, personId, siteId",
      statusUpdates: "id, personId, at",
      fieldNotes: "id, personId, siteId, taskId",
      sites: "id, rolloutId",
      people: "id, role",
      rollouts: "id",
      meta: "key",
    });
    const taskId = uuid();
    const mk = (type: string) => {
      const id = uuid();
      return {
        id,
        actorId: ids.techA,
        type,
        event: { id, type, actorId: ids.techA, deviceId: "d", clientTs: at("2026-11-15T10:00:00Z"), payload: { taskId } },
        status: "pending",
        attempts: 2,
        lastError: "offline",
        lastAttemptAt: null,
        rejectReason: null,
        createdAt: new Date(),
      };
    };
    await v1.table("outbox").bulkAdd([mk("task.delivered"), mk("task.acknowledged")]);
    await v1.table("meta").put({ key: "deviceId", value: "dev-keep-me" });
    v1.close();

    const v2 = new LocalDb(name);
    await v2.open();
    expect(v2.verno).toBe(2);
    const outbox = await v2.outbox.orderBy("seq").toArray();
    expect(outbox.map((i) => [i.type, i.attempts, i.lastError])).toEqual([
      ["task.delivered", 2, "offline"],
      ["task.acknowledged", 2, "offline"],
    ]);
    expect((await v2.meta.get("deviceId"))?.value).toBe("dev-keep-me");
    expect((await v2.receiptMarks.toArray()).map((m) => m.id)).toEqual([`${ids.techA}:${taskId}:task.delivered`]);
    expect(await v2.media.count()).toBe(0);
    v2.close();
  });
});
