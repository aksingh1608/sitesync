// The single source of truth for event types and payloads, shared by client
// and server. Every client write is one of these events.
import { z } from "zod";
import {
  LOCATION_ERRORS,
  MAX_MEDIA_BYTES,
  NOTE_KINDS,
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
    blobUrl: z.url().nullable().default(null),
    /** Local media id (Dexie `media` table). The blob is uploaded later, then `note.media_uploaded`. */
    mediaId: id.nullable().default(null),
  })
  .refine(
    (n) => n.text !== null || n.blobUrl !== null || n.mediaId !== null,
    "a note needs text, a blobUrl or a mediaId",
  );

export const NoteMediaUploadedPayload = z.strictObject({
  noteId: id,
  blobUrl: z.url().max(2000),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative().max(MAX_MEDIA_BYTES),
  durationSec: z.number().nonnegative().max(60 * 60).optional(),
});

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
]);

/** A validated event (defaults applied). */
export type SyncEvent = z.output<typeof EventSchema>;
/** What a caller may pass in before defaults are applied. */
export type SyncEventInput = z.input<typeof EventSchema>;
export type EventType = SyncEvent["type"];
export type EventOf<T extends EventType> = Extract<SyncEvent, { type: T }>;
export const EVENT_TYPES = EventSchema.options.map((o) => o.shape.type.value) as EventType[];

/** Receipt event types, in chain order. */
export const RECEIPT_EVENT_TYPES = ["task.delivered", "task.seen", "task.acknowledged"] as const;

/** Distributive Omit so each union member keeps its own payload type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the client stamps id, actor, device and time onto it. */
export type EventDraft = DistributiveOmit<SyncEventInput, "id" | "actorId" | "deviceId" | "clientTs">;
