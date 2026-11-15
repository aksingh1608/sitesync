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

export type CachedRollout = Omit<Rollout, "seq"> & { seq?: number };

export class LocalDb extends Dexie {
  outbox!: Table<OutboxItem, number>;
  tasks!: Table<TaskRow, string>;
  taskReceipts!: Table<ReceiptRow, [string, string]>;
  timeEntries!: Table<TimeEntryRow, string>;
  statusUpdates!: Table<StatusUpdateRow, string>;
  fieldNotes!: Table<FieldNoteRow, string>;
  sites!: Table<SiteRow, string>;
  people!: Table<PersonRow, string>;
  rollouts!: Table<CachedRollout, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super("sitesync");
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
