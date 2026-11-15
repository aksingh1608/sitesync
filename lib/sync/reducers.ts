// Pure, deterministic reducers: (current state, event, loaded context) -> new
// state or a rejection. No I/O, no clocks, no randomness. The same functions
// run on the server (authoritative) and on the client (optimistic apply).
import {
  canManageTasks,
  isOfficeRole,
  REQUEST_TASK_KINDS,
  STATUS_TRANSITIONS,
  TASK_LWW_FIELDS,
  TERMINAL_STATUSES,
  type TaskLwwField,
} from "../domain";
import type { EventOf } from "../events";
import { haversineM, isOutsideGeofence } from "../geo";
import type {
  FieldNote,
  FieldStamp,
  Person,
  Site,
  StatusUpdate,
  Task,
  TaskReceipt,
  TimeEntry,
} from "../db/schema";

/** A projection row before the database assigns its `seq`. */
export type Row<T> = Omit<T, "seq"> & { seq?: number };
export type TaskRow = Row<Task>;
export type ReceiptRow = Row<TaskReceipt>;
export type TimeEntryRow = Row<TimeEntry>;
export type StatusUpdateRow = Row<StatusUpdate>;
export type FieldNoteRow = Row<FieldNote>;
export type PersonRow = Row<Person>;
export type SiteRow = Row<Site>;

export type Rejection = { ok: false; reason: string };
/** `changed: false` means the event was valid but had no effect (stale or repeated). */
export type Ok<T> = { ok: true; changed: boolean; value: T };
export type Result<T> = Ok<T> | Rejection;

const reject = (reason: string): Rejection => ({ ok: false, reason });
const ok = <T>(value: T, changed = true): Ok<T> => ({ ok: true, changed, value });

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------
export const stampOf = (ev: { id: string; clientTs: string }): FieldStamp => ({
  ts: new Date(ev.clientTs).toISOString(),
  ev: ev.id,
});

/** Is stamp `a` strictly newer than `b`? Compared by clientTs, ties broken by event id. */
export function isNewer(a: FieldStamp, b: FieldStamp | undefined): boolean {
  if (!b) return true;
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (ta !== tb) return ta > tb;
  return a.ev > b.ev;
}

const earliest = (current: Date | null, candidate: Date): Date =>
  current && current.getTime() <= candidate.getTime() ? current : candidate;

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

// ---------------------------------------------------------------------------
// Write authorization. Reads are scoped in visibility.ts; writes are checked
// here, so the client (optimistic apply) and the server enforce the same rules.
// Every refusal uses the exact reason "forbidden".
// ---------------------------------------------------------------------------
export const FORBIDDEN = "forbidden";
const forbidden = () => reject(FORBIDDEN);

/** Coordinators and managers may act on any task; everyone else only on tasks assigned to them. */
export const canActOnTask = (actor: PersonRow, task: TaskRow) =>
  canManageTasks(actor.role) || task.assigneeId === actor.id;

/** Task fields a field worker may edit on a task assigned to them. */
const ASSIGNEE_EDITABLE_FIELDS: readonly TaskLwwField[] = ["description"];

export function canCreateTask(
  actor: PersonRow,
  p: { assigneeId: string; kind: string },
  assignee: PersonRow,
): boolean {
  if (canManageTasks(actor.role)) return true;
  if (p.assigneeId === actor.id) return true; // your own to-do
  // Anyone may send a material request or follow-up to a coordinator.
  return REQUEST_TASK_KINDS.includes(p.kind as never) && assignee.role === "coordinator";
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export type TaskCreatedCtx = {
  actor: PersonRow;
  site: SiteRow | undefined;
  assignee: PersonRow | undefined;
  parent: TaskRow | undefined;
};

export function reduceTaskCreated(
  existing: TaskRow | undefined,
  ev: EventOf<"task.created">,
  ctx: TaskCreatedCtx,
): Result<{ task: TaskRow; receipt: ReceiptRow | null }> {
  const p = ev.payload;
  if (existing) {
    // Re-applying the same creation event is a no-op; a different one is a clash.
    if (existing.fieldTs.title?.ev === ev.id) return ok({ task: existing, receipt: null }, false);
    return reject("task_exists");
  }
  if (!ctx.site) return reject("site_not_found");
  if (!ctx.assignee) return reject("assignee_not_found");
  if (!ctx.assignee.active) return reject("assignee_inactive");
  if (p.parentTaskId && !ctx.parent) return reject("parent_task_not_found");
  if (!canCreateTask(ctx.actor, p, ctx.assignee)) return forbidden();

  const at = new Date(ev.clientTs);
  const stamp = stampOf(ev);
  const fieldTs = Object.fromEntries(
    [...TASK_LWW_FIELDS, "status" as const].map((f) => [f, stamp]),
  );
  const task: TaskRow = {
    id: p.taskId,
    title: p.title,
    description: p.description,
    siteId: p.siteId,
    assigneeId: p.assigneeId,
    createdBy: ev.actorId,
    kind: p.kind,
    priority: p.priority,
    status: "open",
    dueAt: p.dueAt ? new Date(p.dueAt) : null,
    parentTaskId: p.parentTaskId,
    source: p.source,
    createdAt: at,
    updatedAt: at,
    fieldTs,
  };
  const receipt: ReceiptRow = {
    taskId: p.taskId,
    personId: p.assigneeId,
    sentAt: at,
    deliveredAt: null,
    seenAt: null,
    acknowledgedAt: null,
  };
  return ok({ task, receipt });
}

export type TaskUpdatedCtx = {
  actor: PersonRow;
  /** Present when `changes.siteId` is set. */
  site?: SiteRow;
  /** Present when `changes.assigneeId` is set. */
  assignee?: PersonRow;
};

/** Per-field last-write-wins. Older edits are accepted but lose, field by field. */
export function reduceTaskUpdated(
  task: TaskRow | undefined,
  ev: EventOf<"task.updated">,
  ctx: TaskUpdatedCtx,
): Result<{
  task: TaskRow;
  changedFields: TaskLwwField[];
  newRecipientId: string | null;
  /** The previous assignee, when they lost visibility of the task by this change. */
  revokedFrom: string | null;
}> {
  if (!task) return reject("task_not_found");
  const c = ev.payload.changes;
  if (!canManageTasks(ctx.actor.role)) {
    const fields = Object.keys(c) as TaskLwwField[];
    if (task.assigneeId !== ctx.actor.id || fields.some((f) => !ASSIGNEE_EDITABLE_FIELDS.includes(f))) {
      return forbidden();
    }
  }
  if (c.siteId !== undefined && !ctx.site) return reject("site_not_found");
  if (c.assigneeId !== undefined) {
    if (!ctx.assignee) return reject("assignee_not_found");
    if (!ctx.assignee.active) return reject("assignee_inactive");
  }

  const stamp = stampOf(ev);
  const next: TaskRow = { ...task, fieldTs: { ...task.fieldTs } };
  const changedFields: TaskLwwField[] = [];
  for (const field of TASK_LWW_FIELDS) {
    const value = c[field];
    if (value === undefined || !isNewer(stamp, task.fieldTs[field])) continue;
    next.fieldTs[field] = stamp;
    changedFields.push(field);
    if (field === "dueAt") next.dueAt = value === null ? null : new Date(value as string);
    else (next as Record<string, unknown>)[field] = value;
  }
  if (changedFields.length === 0) {
    return ok({ task, changedFields, newRecipientId: null, revokedFrom: null }, false);
  }

  const at = new Date(ev.clientTs);
  if (at > next.updatedAt) next.updatedAt = at;
  const newRecipientId =
    changedFields.includes("assigneeId") && next.assigneeId !== task.assigneeId ? next.assigneeId : null;
  // The old assignee keeps seeing a task they created; otherwise it leaves their device.
  const revokedFrom = newRecipientId && task.assigneeId !== task.createdBy ? task.assigneeId : null;
  return ok({ task: next, changedFields, newRecipientId, revokedFrom });
}

export function reduceTaskStatusChanged(
  task: TaskRow | undefined,
  ev: EventOf<"task.status_changed">,
  ctx: { actor: PersonRow },
): Result<TaskRow> {
  if (!task) return reject("task_not_found");
  if (!canActOnTask(ctx.actor, task)) return forbidden();
  const stamp = stampOf(ev);
  const current = task.fieldTs.status;
  if (current?.ev === ev.id) return ok(task, false); // same event re-applied
  const to = ev.payload.to;

  if (!isNewer(stamp, current)) {
    // An older event never moves a task out of a terminal state.
    if (TERMINAL_STATUSES.includes(task.status)) {
      return reject(`stale_event: task is ${task.status}; an older status change cannot reopen it`);
    }
    return ok(task, false); // superseded by a newer status change
  }
  if (to === task.status) {
    return ok({ ...task, fieldTs: { ...task.fieldTs, status: stamp } }, false);
  }
  if (!STATUS_TRANSITIONS[task.status].includes(to)) {
    return reject(`invalid_transition: ${task.status} -> ${to}`);
  }
  const at = new Date(ev.clientTs);
  return ok({
    ...task,
    status: to,
    fieldTs: { ...task.fieldTs, status: stamp },
    updatedAt: at > task.updatedAt ? at : task.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Receipts: monotonic. Keep the earliest timestamp, never clear one. Later
// stages imply earlier ones (acknowledged implies seen implies delivered).
// ---------------------------------------------------------------------------
export function reduceReceipt(
  task: TaskRow | undefined,
  receipt: ReceiptRow | undefined,
  ev: EventOf<"task.delivered" | "task.seen" | "task.acknowledged">,
): Result<ReceiptRow> {
  if (!task) return reject("task_not_found");
  // Only the person the task is (currently) assigned to records receipts.
  if (task.assigneeId !== ev.actorId) return forbidden();
  let base = receipt;
  if (!base) {
    base = {
      taskId: task.id,
      personId: ev.actorId,
      sentAt: task.createdAt,
      deliveredAt: null,
      seenAt: null,
      acknowledgedAt: null,
    };
  }
  const at = new Date(ev.clientTs);
  const next: ReceiptRow = { ...base };
  next.deliveredAt = earliest(base.deliveredAt, at);
  if (ev.type !== "task.delivered") next.seenAt = earliest(base.seenAt, at);
  if (ev.type === "task.acknowledged") next.acknowledgedAt = earliest(base.acknowledgedAt, at);

  const changed =
    !receipt ||
    !sameTime(next.deliveredAt, base.deliveredAt) ||
    !sameTime(next.seenAt, base.seenAt) ||
    !sameTime(next.acknowledgedAt, base.acknowledgedAt);
  return ok(next, changed);
}

// ---------------------------------------------------------------------------
// Time entries. Location is captured only at clock-in and clock-out.
// ---------------------------------------------------------------------------
export function reduceClockIn(
  existing: TimeEntryRow | undefined,
  openEntry: TimeEntryRow | undefined,
  site: SiteRow | undefined,
  ev: EventOf<"time.clock_in">,
): Result<TimeEntryRow> {
  const p = ev.payload;
  const at = new Date(ev.clientTs);
  if (existing) {
    if (existing.personId === ev.actorId && existing.clockInAt.getTime() === at.getTime()) {
      return ok(existing, false);
    }
    return reject("time_entry_exists");
  }
  if (!site) return reject("site_not_found");
  if (openEntry) return reject("already_clocked_in");

  let distance: number | null = null;
  let flagged = false;
  let flagReason: string | null = null;
  if (p.lat === null || p.lng === null) {
    flagged = true;
    flagReason = `no_location: ${p.locationError ?? "unavailable"} (needs HR review)`;
  } else {
    distance = haversineM(p.lat, p.lng, site.lat, site.lng);
    if (isOutsideGeofence(distance, site.geofenceRadiusM)) {
      flagged = true;
      flagReason = `outside_geofence: ${Math.round(distance)} m from site (radius ${site.geofenceRadiusM} m)`;
    }
  }
  return ok({
    id: p.timeEntryId,
    personId: ev.actorId,
    siteId: p.siteId,
    clockInAt: at,
    clockInLat: p.lat,
    clockInLng: p.lng,
    clockInAccuracyM: p.accuracyM,
    clockInDistanceM: distance,
    clockOutAt: null,
    clockOutLat: null,
    clockOutLng: null,
    flagged,
    flagReason,
    safetyCheckDone: p.safetyCheckDone,
  });
}

export function reduceClockOut(
  entry: TimeEntryRow | undefined,
  ev: EventOf<"time.clock_out">,
): Result<TimeEntryRow> {
  if (!entry) return reject("time_entry_not_found");
  if (entry.personId !== ev.actorId) return forbidden();
  const at = new Date(ev.clientTs);
  if (entry.clockOutAt) {
    if (entry.clockOutAt.getTime() === at.getTime()) return ok(entry, false);
    return reject("already_clocked_out");
  }
  if (at < entry.clockInAt) return reject("clock_out_before_clock_in");
  return ok({
    ...entry,
    clockOutAt: at,
    clockOutLat: ev.payload.lat,
    clockOutLng: ev.payload.lng,
  });
}

// ---------------------------------------------------------------------------
// Worker status and field notes (append-only)
// ---------------------------------------------------------------------------
export function reduceStatusSet(
  existing: StatusUpdateRow | undefined,
  ev: EventOf<"status.set">,
): Result<StatusUpdateRow> {
  if (existing) return ok(existing, false);
  return ok({
    id: ev.id,
    personId: ev.actorId,
    status: ev.payload.status,
    note: ev.payload.note,
    at: new Date(ev.clientTs),
  });
}

export function reduceNoteCreated(
  existing: FieldNoteRow | undefined,
  site: SiteRow | undefined,
  task: TaskRow | undefined,
  ev: EventOf<"note.created">,
  actor: PersonRow,
): Result<FieldNoteRow> {
  const p = ev.payload;
  if (existing) return existing.personId === ev.actorId ? ok(existing, false) : reject("note_exists");
  if (!site) return reject("site_not_found");
  if (p.taskId && !task) return reject("task_not_found");
  // Field workers note only on their own tasks; the office may note anywhere.
  if (task && !isOfficeRole(actor.role) && task.assigneeId !== actor.id) return forbidden();
  return ok({
    id: p.noteId,
    personId: ev.actorId,
    siteId: p.siteId,
    taskId: p.taskId,
    kind: p.kind,
    text: p.text,
    blobUrl: p.blobUrl,
    mediaId: p.mediaId,
    mimeType: null,
    sizeBytes: null,
    durationSec: null,
    transcript: null,
    processedAt: null,
    createdAt: new Date(ev.clientTs),
  });
}


/**
 * The note's blob reached storage. The first upload wins: a retried upload
 * writes to the same path, so a second event with another URL is ignored.
 */
export function reduceNoteMediaUploaded(
  note: FieldNoteRow | undefined,
  ev: EventOf<"note.media_uploaded">,
): Result<FieldNoteRow> {
  if (!note) return reject("note_not_found");
  if (note.personId !== ev.actorId) return forbidden();
  if (note.mediaId === null) return reject("note_has_no_media");
  if (note.blobUrl !== null) return ok(note, false);
  const p = ev.payload;
  return ok({
    ...note,
    blobUrl: p.blobUrl,
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    durationSec: p.durationSec ?? null,
  });
}
