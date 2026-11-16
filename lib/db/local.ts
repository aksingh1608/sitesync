// Client-side IndexedDB (Dexie). The field app reads ONLY from here.
import Dexie, { type Table } from "dexie";
import type { SyncEvent } from "../events";
import type { Rollout } from "./schema";
import type {
  FieldNoteRow,
  PersonRow,
  ReceiptRow,
  SiteRow,
  StatusUpdateRow,
  TaskRow,
  TimeEntryRow,
} from "../sync/reducers";

export type OutboxStatus = "pending" | "rejected";

export interface OutboxItem {
  /** Auto-increment: the order events were created in, and the order they are sent in. */
  seq?: number;
  /** The event id (also the server primary key). */
  id: string;
  actorId: string;
  type: SyncEvent["type"];
  event: SyncEvent;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  rejectReason: string | null;
  createdAt: Date;
}

export type LastSyncResult =
  | {
      status: "ok";
      at: string;
      accepted: number;
      duplicates: number;
      rejected: { id: string; reason: string }[];
      pulled: number;
    }
  | { status: "error"; at: string; error: string; retryAt: string }
  | { status: "offline"; at: string; simulated: boolean }
  | { status: "skipped"; at: string; reason: string };

/** A recorded voice note or photo, kept on the device until it is uploaded. */
export interface MediaItem {
  /** Client UUID; `note.created` references it as `mediaId`. */
  id: string;
  actorId: string;
  noteId: string;
  kind: "voice" | "photo";
  /**
   * Kept after upload: the recording device always plays its own media from
   * here (works offline). Other devices load it via /api/media/<noteId>.
   */
  blob: Blob | null;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  status: "pending" | "uploaded";
  attempts: number;
  lastError: string | null;
  /** Earliest time of the next upload attempt (same backoff as the outbox). */
  nextAttemptAt: Date | null;
  createdAt: Date;
}

/**
 * "This device already sent this receipt for this person." Receipts like
 * `task.delivered` must fire once per device and person, even after the cache
 * is rebuilt. Key: `${actorId}:${taskId}:${type}`.
 */
export interface ReceiptMark {
  id: string;
  actorId: string;
  taskId: string;
  type: "task.delivered" | "task.seen";
  at: Date;
}

export const receiptMarkId = (actorId: string, taskId: string, type: ReceiptMark["type"]) =>
  `${actorId}:${taskId}:${type}`;

export type DirectoryEntry = { id: string; name: string; role: string; trade: string };

export interface Meta {
  deviceId: string;
  /** Role-picker list, kept so the picker works offline after the first visit. */
  directory: DirectoryEntry[];
  actorId: string | null;
  cursor: string | null;
  lastSyncAt: string | null;
  lastSyncResult: LastSyncResult | null;
  simulateOffline: boolean;
  consecutiveFailures: number;
  nextRetryAt: string | null;
}
type MetaRow<K extends keyof Meta = keyof Meta> = { key: K; value: Meta[K] };

/** Notes from the server carry `mediaUrl` (the authenticated route); `blobPath` is always null here. */
export type CachedFieldNote = FieldNoteRow & { mediaUrl?: string | null };

export type CachedRollout = Omit<Rollout, "seq"> & { seq?: number };

export class LocalDb extends Dexie {
  outbox!: Table<OutboxItem, number>;
  tasks!: Table<TaskRow, string>;
  taskReceipts!: Table<ReceiptRow, [string, string]>;
  timeEntries!: Table<TimeEntryRow, string>;
  statusUpdates!: Table<StatusUpdateRow, string>;
  fieldNotes!: Table<CachedFieldNote, string>;
  sites!: Table<SiteRow, string>;
  people!: Table<PersonRow, string>;
  rollouts!: Table<CachedRollout, string>;
  meta!: Table<MetaRow, string>;
  media!: Table<MediaItem, string>;
  receiptMarks!: Table<ReceiptMark, string>;

  constructor(name = "sitesync") {
    super(name);
    // Schema versions. NEVER edit a released version: add a new one (see
    // CLAUDE.md "Dexie schema versioning"). Dexie diffs the declared stores and
    // only touches tables that changed, so the outbox is preserved.
    this.version(1).stores({
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
    // v2 (Day 2): media upload queue and per-device receipt marks.
    this.version(2)
      .stores({
        media: "id, noteId, [actorId+status]",
        receiptMarks: "id, [actorId+taskId]",
      })
      .upgrade(async (tx) => {
        // Receipts already waiting in the outbox count as sent from this device.
        const receipts = await tx
          .table<OutboxItem, number>("outbox")
          .filter((i) => i.type === "task.delivered" || i.type === "task.seen")
          .toArray();
        await tx.table<ReceiptMark, string>("receiptMarks").bulkPut(
          receipts.map((i) => {
            const taskId = (i.event.payload as { taskId: string }).taskId;
            const type = i.type as ReceiptMark["type"];
            return { id: receiptMarkId(i.actorId, taskId, type), actorId: i.actorId, taskId, type, at: i.createdAt };
          }),
        );
      });
  }

  /** The cache tables that mirror server projections. */
  get cacheTables() {
    return [
      this.tasks,
      this.taskReceipts,
      this.timeEntries,
      this.statusUpdates,
      this.fieldNotes,
      this.sites,
      this.people,
      this.rollouts,
    ];
  }
}

export const localDb = new LocalDb();

// Another tab opened a newer schema version. Dexie closes this connection so the
// upgrade can proceed; tell the UI this tab is stale so it offers a reload.
localDb.on("versionchange", (ev) => {
  if (typeof window !== "undefined" && ev.newVersion) window.dispatchEvent(new Event("sitesync:stale"));
});

const META_DEFAULTS: Omit<Meta, "deviceId"> = {
  directory: [],
  actorId: null,
  cursor: null,
  lastSyncAt: null,
  lastSyncResult: null,
  simulateOffline: false,
  consecutiveFailures: 0,
  nextRetryAt: null,
};

export async function getMeta(): Promise<Meta> {
  const rows = await localDb.meta.toArray();
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Meta>;
  return { ...META_DEFAULTS, deviceId: m.deviceId ?? "", ...m } as Meta;
}

export async function setMeta(patch: Partial<Meta>): Promise<void> {
  await localDb.meta.bulkPut(Object.entries(patch).map(([key, value]) => ({ key, value }) as MetaRow));
}
