// The single source of truth for event types and payloads, shared by client
// and server. Every client write is one of these events.
import { z } from "zod";
import {
  LOCATION_ERRORS,
  MATERIAL_STATUSES,
  MAX_MEDIA_BYTES,
  NOTE_KINDS,
  ROLLOUT_STAGES,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  WORKER_STATUSES,
} from "./domain";

const id = z.uuid();
const isoTs = z.iso.datetime({ offset: true });
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

/** Fields common to every event. */
const envelope = {
  /** Client-generated UUID v4. Primary key on the server, so resends are ignored. */
  id: z.uuid({ version: "v4" }),
  actorId: id,
  deviceId: z.string().min(1).max(100),
  /** When the action happened on the device (not when it was synced). */
  clientTs: isoTs,
};

const taskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  siteId: id,
  assigneeId: id,
  kind: z.enum(TASK_KINDS),
  priority: z.enum(TASK_PRIORITIES),
  dueAt: isoTs.nullable(),
};

export const TaskCreatedPayload = z.strictObject({
  taskId: id,
  ...taskFields,
  description: taskFields.description.default(""),
  kind: taskFields.kind.default("task"),
  priority: taskFields.priority.default("normal"),
  dueAt: taskFields.dueAt.default(null),
  parentTaskId: id.nullable().default(null),
  source: z.enum(TASK_SOURCES).default("manual"),
});

export const TaskUpdatedPayload = z.strictObject({
  taskId: id,
  changes: z
    .strictObject(taskFields)
    .partial()
    .refine((c) => Object.keys(c).length > 0, "changes must include at least one field"),
});

export const TaskStatusChangedPayload = z.strictObject({
  taskId: id,
  to: z.enum(TASK_STATUSES),
  reason: z.string().max(1000).optional(),
});

const TaskReceiptPayload = z.strictObject({ taskId: id });

export const ClockInPayload = z.strictObject({
  /** Client-generated so the matching clock-out can reference it while offline. */
  timeEntryId: id,
  siteId: id,
  /** Null when the device could not get a location (permission denied, timeout). */
  lat: lat.nullable(),
  lng: lng.nullable(),
  accuracyM: z.number().nonnegative().max(100_000).nullable(),
  safetyCheckDone: z.boolean().default(false),
  /** Why lat/lng are null, so HR can tell "indoors" from "permission denied". */
  locationError: z.enum(LOCATION_ERRORS).nullable().default(null),
});

export const ClockOutPayload = z.strictObject({
  timeEntryId: id,
  lat: lat.nullable(),
  lng: lng.nullable(),
  accuracyM: z.number().nonnegative().max(100_000).nullable().default(null),
  locationError: z.enum(LOCATION_ERRORS).nullable().default(null),
});

export const StatusSetPayload = z.strictObject({
  /** Null clears the (optional) status. */
  status: z.enum(WORKER_STATUSES).nullable(),
  note: z.string().max(500).nullable().default(null),
});

export const NoteCreatedPayload = z
  .strictObject({
    noteId: id,
    siteId: id,
    taskId: id.nullable().default(null),
    kind: z.enum(NOTE_KINDS),
    text: z.string().max(10_000).nullable().default(null),
    /**
     * Local media id (Dexie `media` table). The device uploads the blob later;
     * the SERVER then records `note.media_uploaded`. Devices never send URLs.
     */
    mediaId: id.nullable().default(null),
  })
  .refine((n) => n.text !== null || n.mediaId !== null, "a note needs text or a mediaId");

/** `notes/<noteId>/<mediaId>.<ext>`: the only pathname shape the upload route writes. */
export const MEDIA_PATH_RE = /^notes\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
export const mediaPathFor = (noteId: string, mediaId: string, ext: string) => `notes/${noteId}/${mediaId}.${ext}`;

/** Written by the server (POST /api/media) after it stored the blob. Never accepted from devices. */
export const NoteMediaUploadedPayload = z.strictObject({
  noteId: id,
  blobPath: z.string().regex(MEDIA_PATH_RE),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative().max(MAX_MEDIA_BYTES),
  durationSec: z.number().nonnegative().max(60 * 60).optional(),
});

/** Office: progress a material request (approved -> ordered -> delivered, forward only). */
export const MaterialStatusChangedPayload = z.strictObject({
  taskId: id,
  to: z.enum(MATERIAL_STATUSES),
  note: z.string().max(1000).optional(),
});

/**
 * Office: move a rollout store to another stage. `from` is the stage the sender
 * saw, so a move based on a stale board is rejected instead of silently applied.
 */
export const SiteStageChangedPayload = z
  .strictObject({
    siteId: id,
    from: z.enum(ROLLOUT_STAGES),
    to: z.enum(ROLLOUT_STAGES),
    note: z.string().max(1000).optional(),
  })
  .refine((p) => p.from !== p.to, "from and to must differ");

/** HR: approve a time entry. */
export const TimeApprovedPayload = z.strictObject({ timeEntryId: id });
/** HR: reject a time entry. A reason is required (the worker and payroll see it). */
export const TimeRejectedPayload = z.strictObject({ timeEntryId: id, reason: z.string().trim().min(1).max(1000) });

const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, type: z.literal(type), payload });

export const EventSchema = z.discriminatedUnion("type", [
  ev("task.created", TaskCreatedPayload),
  ev("task.updated", TaskUpdatedPayload),
  ev("task.status_changed", TaskStatusChangedPayload),
  ev("task.delivered", TaskReceiptPayload),
  ev("task.seen", TaskReceiptPayload),
  ev("task.acknowledged", TaskReceiptPayload),
  ev("time.clock_in", ClockInPayload),
  ev("time.clock_out", ClockOutPayload),
  ev("status.set", StatusSetPayload),
  ev("note.created", NoteCreatedPayload),
  ev("note.media_uploaded", NoteMediaUploadedPayload),
  ev("material.status_changed", MaterialStatusChangedPayload),
  ev("site.stage_changed", SiteStageChangedPayload),
  ev("time.approved", TimeApprovedPayload),
  ev("time.rejected", TimeRejectedPayload),
]);

/** A validated event (defaults applied). */
export type SyncEvent = z.output<typeof EventSchema>;
/** What a caller may pass in before defaults are applied. */
export type SyncEventInput = z.input<typeof EventSchema>;
export type EventType = SyncEvent["type"];
export type EventOf<T extends EventType> = Extract<SyncEvent, { type: T }>;
export const EVENT_TYPES = EventSchema.options.map((o) => o.shape.type.value) as EventType[];

/**
 * Event types only the server may create (via processSync's `trusted` option).
 * /api/sync rejects them from devices with "forbidden".
 */
export const SERVER_ONLY_EVENT_TYPES: readonly EventType[] = ["note.media_uploaded"];

/** Receipt event types, in chain order. */
export const RECEIPT_EVENT_TYPES = ["task.delivered", "task.seen", "task.acknowledged"] as const;

/** Distributive Omit so each union member keeps its own payload type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the client stamps id, actor, device and time onto it. */
export type EventDraft = DistributiveOmit<SyncEventInput, "id" | "actorId" | "deviceId" | "clientTs">;
