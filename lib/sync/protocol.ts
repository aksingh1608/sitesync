// Wire format for POST /api/sync, shared by client and server.
import { z } from "zod";
import type { RevocableEntity } from "../domain";
import type { FieldNote, Person, Rollout, Site, StatusUpdate, Task, TaskReceipt, TimeEntry } from "../db/schema";

export const MAX_EVENTS_PER_SYNC = 200;

export const SyncRequestSchema = z.strictObject({
  deviceId: z.string().min(1).max(100),
  actorId: z.uuid(),
  /** Opaque to the client. Currently the highest `seq` it has seen. */
  cursor: z
    .string()
    .regex(/^\d{1,16}$/)
    .nullable(),
  /**
   * Each event is validated on its own so one bad event is rejected without
   * failing the batch. Only the envelope shape here can produce a 400.
   */
  events: z.array(z.unknown()).max(MAX_EVENTS_PER_SYNC),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

/** Serialized rows: Dates become ISO strings over JSON. */
export type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

export type SyncChanges = {
  tasks: Task[];
  task_receipts: TaskReceipt[];
  time_entries: TimeEntry[];
  status_updates: StatusUpdate[];
  /** `blobPath` is always null on the wire; `mediaUrl` is the authenticated route. */
  field_notes: PulledFieldNote[];
  sites: Site[];
  people: Person[];
  rollouts: Rollout[];
};
export type PulledFieldNote = FieldNote & { mediaUrl: string | null };

export type ChangeTable = keyof SyncChanges;
export const CHANGE_TABLES: ChangeTable[] = [
  "tasks",
  "task_receipts",
  "time_entries",
  "status_updates",
  "field_notes",
  "sites",
  "people",
  "rollouts",
];

/** "Drop this row from your device": you can no longer see it. */
export type RevocationChange = { entity: RevocableEntity; entityId: string; seq: number };

export type SyncResponse = {
  accepted: string[];
  duplicates: string[];
  rejected: { id: string; reason: string }[];
  changes: SyncChanges;
  revocations: RevocationChange[];
  cursor: string;
  /** The pull stopped at a page boundary: ask again from `cursor` for the rest. */
  hasMore: boolean;
  /** Lets the client notice a badly wrong device clock. */
  serverTime: string;
};

export type WireSyncResponse = Omit<SyncResponse, "changes"> & {
  changes: { [K in ChangeTable]: Wire<SyncChanges[K][number]>[] };
};
