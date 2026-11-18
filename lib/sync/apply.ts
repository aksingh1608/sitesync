// Orchestrates one event: load what the reducer needs from a store, run the
// pure reducer, write the result. The store is Postgres on the server and
// Dexie on the client, so both sides apply events with identical rules.
import type { RevocableEntity } from "../domain";
import type { SyncEvent } from "../events";
import {
  reduceClockIn,
  reduceClockOut,
  reduceMaterialStatusChanged,
  reduceSiteStageChanged,
  reduceTimeReviewed,
  reduceNoteCreated,
  reduceNoteMediaUploaded,
  reduceNoteProcessed,
  reduceReceipt,
  reduceStatusSet,
  reduceTaskCreated,
  reduceTaskStatusChanged,
  reduceTaskUpdated,
  type FieldNoteRow,
  type PersonRow,
  type ReceiptRow,
  type SiteRow,
  type StatusUpdateRow,
  type TaskRow,
  type TimeEntryRow,
} from "./reducers";

export interface SyncStore {
  getPerson(id: string): Promise<PersonRow | undefined>;
  getSite(id: string): Promise<SiteRow | undefined>;
  getTask(id: string): Promise<TaskRow | undefined>;
  getReceipt(taskId: string, personId: string): Promise<ReceiptRow | undefined>;
  getTimeEntry(id: string): Promise<TimeEntryRow | undefined>;
  getOpenTimeEntry(personId: string): Promise<TimeEntryRow | undefined>;
  getStatusUpdate(id: string): Promise<StatusUpdateRow | undefined>;
  getNote(id: string): Promise<FieldNoteRow | undefined>;

  putTask(row: TaskRow): Promise<void>;
  putReceipt(row: ReceiptRow): Promise<void>;
  putTimeEntry(row: TimeEntryRow): Promise<void>;
  putStatusUpdate(row: StatusUpdateRow): Promise<void>;
  putNote(row: FieldNoteRow): Promise<void>;
  putSite(row: SiteRow): Promise<void>;
  /** Photo notes on a site whose blob has been uploaded (closeout evidence). */
  countPhotoNotes(siteId: string): Promise<number>;
  /**
   * A site (and its rollout) just became relevant to someone, e.g. a task on it
   * was assigned to them. Bump its seq so it reaches that person's next pull.
   */
  touchSite(siteId: string): Promise<void>;
  /** `actorId` can no longer see this row; their next pull tells their device to drop it. */
  revoke(actorId: string, entity: RevocableEntity, entityId: string): Promise<void>;
}

export type ApplyResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/** Events stamped this far in the future are rejected as a broken device clock. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export async function applyEvent(store: SyncStore, ev: SyncEvent, now: Date): Promise<ApplyResult> {
  if (Date.parse(ev.clientTs) > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "client_ts_in_future" };
  }
  const actor = await store.getPerson(ev.actorId);
  if (!actor) return { ok: false, reason: "actor_not_found" };
  if (!actor.active) return { ok: false, reason: "actor_inactive" };

  switch (ev.type) {
    case "task.created": {
      const p = ev.payload;
      const [existing, site, assignee, parent] = await Promise.all([
        store.getTask(p.taskId),
        store.getSite(p.siteId),
        store.getPerson(p.assigneeId),
        p.parentTaskId ? store.getTask(p.parentTaskId) : Promise.resolve(undefined),
      ]);
      const r = reduceTaskCreated(existing, ev, { actor, site, assignee, parent });
      if (!r.ok) return r;
      if (r.changed) {
        await store.putTask(r.value.task);
        if (r.value.receipt) await store.putReceipt(r.value.receipt);
        await store.touchSite(p.siteId);
      }
      return { ok: true, changed: r.changed };
    }

    case "task.updated": {
      const c = ev.payload.changes;
      const [task, site, assignee] = await Promise.all([
        store.getTask(ev.payload.taskId),
        c.siteId ? store.getSite(c.siteId) : Promise.resolve(undefined),
        c.assigneeId ? store.getPerson(c.assigneeId) : Promise.resolve(undefined),
      ]);
      const r = reduceTaskUpdated(task, ev, { actor, site, assignee });
      if (!r.ok) return r;
      if (r.changed) {
        const next = r.value.task;
        await store.putTask(next);
        if (r.value.newRecipientId) {
          const existing = await store.getReceipt(next.id, r.value.newRecipientId);
          if (!existing) {
            await store.putReceipt({
              taskId: next.id,
              personId: r.value.newRecipientId,
              sentAt: new Date(ev.clientTs),
              deliveredAt: null,
              seenAt: null,
              acknowledgedAt: null,
            });
          }
        }
        if (r.value.revokedFrom) await store.revoke(r.value.revokedFrom, "task", next.id);
        if (r.value.newRecipientId || r.value.changedFields.includes("siteId")) {
          await store.touchSite(next.siteId);
        }
      }
      return { ok: true, changed: r.changed };
    }

    case "task.status_changed": {
      const task = await store.getTask(ev.payload.taskId);
      const r = reduceTaskStatusChanged(task, ev, { actor });
      if (!r.ok) return r;
      if (r.value !== task) await store.putTask(r.value);
      return { ok: true, changed: r.changed };
    }

    case "task.delivered":
    case "task.seen":
    case "task.acknowledged": {
      const [task, receipt] = await Promise.all([
        store.getTask(ev.payload.taskId),
        store.getReceipt(ev.payload.taskId, ev.actorId),
      ]);
      const r = reduceReceipt(task, receipt, ev);
      if (!r.ok) return r;
      if (r.changed) await store.putReceipt(r.value);
      return { ok: true, changed: r.changed };
    }

    case "time.clock_in": {
      const [existing, open, site] = await Promise.all([
        store.getTimeEntry(ev.payload.timeEntryId),
        store.getOpenTimeEntry(ev.actorId),
        store.getSite(ev.payload.siteId),
      ]);
      const r = reduceClockIn(existing, open, site, ev);
      if (!r.ok) return r;
      if (r.changed) {
        await store.putTimeEntry(r.value);
        await store.touchSite(ev.payload.siteId);
      }
      return { ok: true, changed: r.changed };
    }

    case "time.clock_out": {
      const entry = await store.getTimeEntry(ev.payload.timeEntryId);
      const r = reduceClockOut(entry, ev);
      if (!r.ok) return r;
      if (r.changed) await store.putTimeEntry(r.value);
      return { ok: true, changed: r.changed };
    }

    case "status.set": {
      const r = reduceStatusSet(await store.getStatusUpdate(ev.id), ev);
      if (!r.ok) return r;
      if (r.changed) await store.putStatusUpdate(r.value);
      return { ok: true, changed: r.changed };
    }

    case "note.created": {
      const p = ev.payload;
      const [existing, site, task] = await Promise.all([
        store.getNote(p.noteId),
        store.getSite(p.siteId),
        p.taskId ? store.getTask(p.taskId) : Promise.resolve(undefined),
      ]);
      const r = reduceNoteCreated(existing, site, task, ev, actor);
      if (!r.ok) return r;
      if (r.changed) await store.putNote(r.value);
      return { ok: true, changed: r.changed };
    }

    case "note.media_uploaded": {
      const r = reduceNoteMediaUploaded(await store.getNote(ev.payload.noteId), ev);
      if (!r.ok) return r;
      if (r.changed) await store.putNote(r.value);
      return { ok: true, changed: r.changed };
    }

    case "note.processed": {
      const r = reduceNoteProcessed(await store.getNote(ev.payload.noteId), ev);
      if (!r.ok) return r;
      if (r.changed) await store.putNote(r.value);
      return { ok: true, changed: r.changed };
    }

    case "material.status_changed": {
      const task = await store.getTask(ev.payload.taskId);
      const r = reduceMaterialStatusChanged(task, ev, { actor });
      if (!r.ok) return r;
      if (r.changed) await store.putTask(r.value);
      return { ok: true, changed: r.changed };
    }

    case "site.stage_changed": {
      const [site, photoCount] = await Promise.all([
        store.getSite(ev.payload.siteId),
        store.countPhotoNotes(ev.payload.siteId),
      ]);
      const r = reduceSiteStageChanged(site, ev, { actor, photoCount });
      if (!r.ok) return r;
      if (r.changed) await store.putSite(r.value);
      return { ok: true, changed: r.changed };
    }

    case "time.approved":
    case "time.rejected": {
      const r = reduceTimeReviewed(await store.getTimeEntry(ev.payload.timeEntryId), ev, { actor });
      if (!r.ok) return r;
      if (r.changed) await store.putTimeEntry(r.value);
      return { ok: true, changed: r.changed };
    }

    default: {
      const unreachable: never = ev;
      return { ok: false, reason: `unknown_event_type: ${(unreachable as { type: string }).type}` };
    }
  }
}
