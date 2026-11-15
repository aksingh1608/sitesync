// Client sync engine.
//  - enqueue(): validate -> apply optimistically to the Dexie cache -> add to outbox.
//  - sync(): send the outbox in order, drop accepted/duplicate events, mark
//    rejected ones, merge server changes, re-apply still-pending events on top.
// No Background Sync API (iOS Safari lacks it). See SyncManager for triggers.
import { EventSchema, type EventDraft, type SyncEvent } from "../events";
import { getMeta, localDb, setMeta, type LastSyncResult, type Meta, type OutboxItem } from "../db/local";
import { uuidv4 } from "../uuid";
import { applyEvent } from "./apply";
import { MAX_EVENTS_PER_SYNC, type SyncRequest, type WireSyncResponse } from "./protocol";
import { dexieStore } from "./store-dexie";

export const ACTOR_COOKIE = "sitesync_actor";
const SYNC_TIMEOUT_MS = 20_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class LocalRejectError extends Error {
  constructor(public reason: string) {
    super(`Rejected locally: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Transport (swappable so tests can call processSync directly)
// ---------------------------------------------------------------------------
export type Transport = (req: SyncRequest) => Promise<WireSyncResponse>;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const httpTransport: Transport = async (req) => {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as WireSyncResponse;
};

let transport: Transport = httpTransport;
export function setTransport(t: Transport | null) {
  transport = t ?? httpTransport;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
/** deviceId is generated once per browser profile and kept. */
export async function ensureDeviceId(): Promise<string> {
  const meta = await getMeta();
  if (meta.deviceId) return meta.deviceId;
  const deviceId = `dev-${uuidv4()}`;
  await setMeta({ deviceId });
  return deviceId;
}

/** Demo mode: pick who you are. The local cache belongs to one actor at a time. */
export async function setActor(actorId: string): Promise<void> {
  await ensureDeviceId();
  const meta = await getMeta();
  if (typeof document !== "undefined") {
    document.cookie = `${ACTOR_COOKIE}=${actorId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }
  if (meta.actorId === actorId) return;
  // Another actor's unsynced events stay in the outbox and are sent when they
  // are active again. The cache is per actor, so clear it.
  await localDb.transaction("rw", [...localDb.cacheTables, localDb.meta], async () => {
    await Promise.all(localDb.cacheTables.map((t) => t.clear()));
    await setMeta({ actorId, cursor: null, lastSyncResult: null, consecutiveFailures: 0, nextRetryAt: null });
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export async function enqueue(draft: EventDraft, opts: { autoSync?: boolean } = {}): Promise<SyncEvent> {
  const meta = await getMeta();
  if (!meta.actorId) throw new Error("No actor selected");
  const deviceId = meta.deviceId || (await ensureDeviceId());
  const event = EventSchema.parse({
    ...draft,
    id: uuidv4(),
    actorId: meta.actorId,
    deviceId,
    clientTs: new Date().toISOString(),
  });

  await localDb.transaction("rw", [...localDb.cacheTables, localDb.outbox], async () => {
    const result = await applyEvent(dexieStore(localDb), event, new Date());
    if (!result.ok) throw new LocalRejectError(result.reason);
    await localDb.outbox.add({
      id: event.id,
      actorId: event.actorId,
      type: event.type,
      event,
      status: "pending",
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      rejectReason: null,
      createdAt: new Date(),
    });
  });

  if (opts.autoSync !== false) void sync().catch(() => {});
  return event;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
let inflight: Promise<LastSyncResult> | null = null;

/** Single-flight: concurrent callers share one run. Also locked across tabs. */
export function sync(opts: { manual?: boolean } = {}): Promise<LastSyncResult> {
  if (inflight) return inflight;
  const run = async (): Promise<LastSyncResult> => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("sitesync-sync", { ifAvailable: true }, async (lock) =>
        lock ? runSync(opts) : skipped("another tab is syncing"),
      );
    }
    return runSync(opts);
  };
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

const nowIso = () => new Date().toISOString();
const skipped = (reason: string): LastSyncResult => ({ status: "skipped", at: nowIso(), reason });

export function backoffMs(failures: number, random = Math.random): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (0.8 + 0.4 * random()));
}

async function pendingFor(actorId: string, limit = MAX_EVENTS_PER_SYNC): Promise<OutboxItem[]> {
  return localDb.outbox
    .where("[actorId+status]")
    .equals([actorId, "pending"])
    .sortBy("seq")
    .then((items) => items.slice(0, limit));
}

async function runSync(opts: { manual?: boolean }): Promise<LastSyncResult> {
  const meta = await getMeta();
  if (!meta.actorId) return skipped("no actor selected");
  if (meta.simulateOffline) {
    const result: LastSyncResult = { status: "offline", at: nowIso(), simulated: true };
    await setMeta({ lastSyncResult: result });
    return result;
  }
  if (!opts.manual && meta.nextRetryAt && Date.parse(meta.nextRetryAt) > Date.now()) {
    return skipped(`backing off until ${meta.nextRetryAt}`);
  }

  const totals = { accepted: 0, duplicates: 0, pulled: 0, rejected: [] as { id: string; reason: string }[] };
  let batch: OutboxItem[] = [];
  try {
    let cursor = meta.cursor;
    // A few rounds: drain >200 pending events, send auto-generated receipts,
    // and rebuild the cache after a rejection.
    for (let round = 0; round < 10; round++) {
      batch = await pendingFor(meta.actorId);
      const res = await transport({
        deviceId: meta.deviceId,
        actorId: meta.actorId,
        cursor,
        events: batch.map((i) => i.event),
      });
      const fullReplace = cursor === null;
      await mergeResponse(meta, res, fullReplace);
      cursor = res.cursor;
      totals.accepted += res.accepted.length;
      totals.duplicates += res.duplicates.length;
      totals.rejected.push(...res.rejected);
      totals.pulled += Object.values(res.changes).reduce((n, rows) => n + rows.length, 0);

      if (res.rejected.length > 0) {
        // A rejected event may have left optimistic state behind: rebuild the
        // cache from the server on the next round.
        cursor = null;
        await setMeta({ cursor: null });
        continue;
      }
      const delivered = await enqueueDeliveredReceipts(meta.actorId);
      const more = (await pendingFor(meta.actorId, 1)).length > 0;
      if (!more && delivered === 0) break;
    }

    const result: LastSyncResult = { status: "ok", at: nowIso(), ...totals };
    await setMeta({ lastSyncAt: result.at, lastSyncResult: result, consecutiveFailures: 0, nextRetryAt: null });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failures = (await getMeta()).consecutiveFailures + 1;
    const retryAt = new Date(Date.now() + backoffMs(failures)).toISOString();
    await localDb.transaction("rw", [localDb.outbox, localDb.meta], async () => {
      for (const item of batch) {
        await localDb.outbox.update(item.seq!, {
          attempts: item.attempts + 1,
          lastError: message,
          lastAttemptAt: new Date(),
        });
      }
      const result: LastSyncResult = { status: "error", at: nowIso(), error: message, retryAt };
      await setMeta({ lastSyncResult: result, consecutiveFailures: failures, nextRetryAt: retryAt });
    });
    return { status: "error", at: nowIso(), error: message, retryAt };
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
const DATE_FIELDS = {
  tasks: ["dueAt", "createdAt", "updatedAt"],
  task_receipts: ["sentAt", "deliveredAt", "seenAt", "acknowledgedAt"],
  time_entries: ["clockInAt", "clockOutAt"],
  status_updates: ["at"],
  field_notes: ["processedAt", "createdAt"],
  sites: [],
  people: [],
  rollouts: [],
} as const;

function revive<T>(rows: object[], fields: readonly string[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const f of fields) if (typeof out[f] === "string") out[f] = new Date(out[f] as string);
    return out as T;
  });
}

async function mergeResponse(meta: Meta, res: WireSyncResponse, fullReplace: boolean) {
  const c = res.changes;
  await localDb.transaction("rw", [...localDb.cacheTables, localDb.outbox, localDb.meta], async () => {
    // 1. Settle the outbox.
    const done = [...res.accepted, ...res.duplicates];
    if (done.length) await localDb.outbox.where("id").anyOf(done).delete();
    for (const r of res.rejected) {
      await localDb.outbox.where("id").equals(r.id).modify({ status: "rejected", rejectReason: r.reason });
    }

    // 2. Server rows win. A full pull replaces the cache entirely.
    if (fullReplace) await Promise.all(localDb.cacheTables.map((t) => t.clear()));
    await localDb.tasks.bulkPut(revive(c.tasks, DATE_FIELDS.tasks));
    await localDb.taskReceipts.bulkPut(revive(c.task_receipts, DATE_FIELDS.task_receipts));
    await localDb.timeEntries.bulkPut(revive(c.time_entries, DATE_FIELDS.time_entries));
    await localDb.statusUpdates.bulkPut(revive(c.status_updates, DATE_FIELDS.status_updates));
    await localDb.fieldNotes.bulkPut(revive(c.field_notes, DATE_FIELDS.field_notes));
    await localDb.sites.bulkPut(revive(c.sites, []));
    await localDb.people.bulkPut(revive(c.people, []));
    await localDb.rollouts.bulkPut(revive(c.rollouts, []));

    // 3. Re-apply events the server has not confirmed yet, so the UI keeps
    //    showing them. Reducers are idempotent, so this is safe to repeat.
    const store = dexieStore(localDb);
    const pending = await localDb.outbox.where("[actorId+status]").equals([meta.actorId!, "pending"]).sortBy("seq");
    for (const item of pending) await applyEvent(store, item.event, new Date());

    await setMeta({ cursor: res.cursor });
  });
}

/**
 * The "delivered" receipt: once a task assigned to me has reached this device
 * from the server, record that, so the office can see it arrived.
 */
async function enqueueDeliveredReceipts(actorId: string): Promise<number> {
  const mine = await localDb.tasks.where("assigneeId").equals(actorId).toArray();
  const queued = new Set(
    (await localDb.outbox.where("[actorId+status]").equals([actorId, "pending"]).toArray())
      .filter((i) => i.type === "task.delivered")
      .map((i) => (i.event.payload as { taskId: string }).taskId),
  );
  let n = 0;
  for (const task of mine) {
    if (task.seq === undefined || queued.has(task.id)) continue;
    const receipt = await localDb.taskReceipts.get([task.id, actorId]);
    if (receipt && receipt.deliveredAt === null) {
      await enqueue({ type: "task.delivered", payload: { taskId: task.id } }, { autoSync: false });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Demo helpers
// ---------------------------------------------------------------------------
export async function setSimulateOffline(on: boolean) {
  await setMeta({ simulateOffline: on });
  if (!on) void sync({ manual: true });
}

export async function resetLocalData() {
  await localDb.delete({ disableAutoOpen: false });
  if (typeof document !== "undefined") document.cookie = `${ACTOR_COOKIE}=; path=/; max-age=0`;
}
