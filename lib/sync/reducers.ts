// Pure, deterministic reducers: (current state, event, loaded context) -> new
// state or a rejection. No I/O, no clocks, no randomness. The same functions
// run on the server (authoritative) and on the client (optimistic apply).
import {
  isOfficeRole,
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

/** Office roles, the assignee and the creator may change a task. */
const canTouchTask = (actor: PersonRow, task: TaskRow) =>
  isOfficeRole(actor.role) || task.assigneeId === actor.id || task.createdBy === actor.id;

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
  if (!isOfficeRole(ctx.actor.role) && ctx.actor.role !== "foreman" && p.assigneeId !== ctx.actor.id) {
    return reject("forbidden: technicians can only create tasks for themselves");
  }

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
): Result<{ task: TaskRow; changedFields: TaskLwwField[]; newRecipientId: string | null }> {
  if (!task) return reject("task_not_found");
  if (!canTouchTask(ctx.actor, task)) return reject("forbidden");
  const c = ev.payload.changes;
  if (c.siteId !== undefined && !ctx.site) return reject("site_not_found");
  if (c.assigneeId !== undefined) {
    if (!ctx.assignee) return reject("assignee_not_found");
    if (!ctx.assignee.active) return reject("assignee_inactive");
    if (!isOfficeRole(ctx.actor.role) && ctx.actor.role !== "foreman" && c.assigneeId !== ctx.actor.id) {
      return reject("forbidden: technicians cannot reassign tasks");
    }
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
  if (changedFields.length === 0) return ok({ task, changedFields, newRecipientId: null }, false);

  const at = new Date(ev.clientTs);
  if (at > next.updatedAt) next.updatedAt = at;
  const newRecipientId =
    changedFields.includes("assigneeId") && next.assigneeId !== task.assigneeId ? next.assigneeId : null;
  return ok({ task: next, changedFields, newRecipientId });
}

export function reduceTaskStatusChanged(
  task: TaskRow | undefined,
  ev: EventOf<"task.status_changed">,
  ctx: { actor: PersonRow },
): Result<TaskRow> {
  if (!task) return reject("task_not_found");
  if (!canTouchTask(ctx.actor, task)) return reject("forbidden");
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
  let base = receipt;
  if (!base) {
    // Only the person the task was sent to can acknowledge receipt of it.
    if (task.assigneeId !== ev.actorId) return reject("not_a_recipient");
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
    flagReason = "no_location: device did not provide a location at clock-in";
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
  if (entry.personId !== ev.actorId) return reject("forbidden: not your time entry");
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
): Result<FieldNoteRow> {
  const p = ev.payload;
  if (existing) return existing.personId === ev.actorId ? ok(existing, false) : reject("note_exists");
  if (!site) return reject("site_not_found");
  if (p.taskId && !task) return reject("task_not_found");
  return ok({
    id: p.noteId,
    personId: ev.actorId,
    siteId: p.siteId,
    taskId: p.taskId,
    kind: p.kind,
    text: p.text,
    blobUrl: p.blobUrl,
    transcript: null,
    processedAt: null,
    createdAt: new Date(ev.clientTs),
  });
}

