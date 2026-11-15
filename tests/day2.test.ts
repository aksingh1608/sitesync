// Day 2 server rules: write authorization, revocations, pull pagination,
// note.media_uploaded, clearing the worker status.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, fieldNotes, revocations, statusUpdates, timeEntries } from "@/lib/db/schema";
import type { Db } from "@/lib/sync/store-drizzle";
import { processSync } from "@/lib/sync/service";
import { at, event, ids, makeDb, NOW, sync, taskCreated, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await makeDb()));
afterEach(async () => close());

const T0 = "2026-11-15T09:00:00Z";
const ts = (minute: number) => at(`2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`);

/** A task created by the coordinator, assigned to `assigneeId`. */
async function officeTask(assigneeId = ids.techA, extra: Record<string, string> = {}) {
  const taskId = uuid();
  const r = await sync(db, ids.coordinator, [taskCreated(ids.coordinator, taskId, at(T0), { assigneeId, ...extra })]);
  expect(r.rejected).toEqual([]);
  return taskId;
}

const reassign = (actorId: string, taskId: string, assigneeId: string, minute: number) =>
  event({
    type: "task.updated",
    actorId,
    clientTs: ts(minute),
    payload: { taskId, changes: { assigneeId } },
  });

describe("write authorization", () => {
  it("lets field workers act only on tasks assigned to them", async () => {
    const mine = await officeTask(ids.techA);
    const theirs = await officeTask(ids.techB);
    const on = (taskId: string, minute: number) => [
      event({ type: "task.delivered", actorId: ids.techA, clientTs: ts(minute), payload: { taskId } }),
      event({ type: "task.seen", actorId: ids.techA, clientTs: ts(minute), payload: { taskId } }),
      event({ type: "task.acknowledged", actorId: ids.techA, clientTs: ts(minute), payload: { taskId } }),
      event({
        type: "task.status_changed",
        actorId: ids.techA,
        clientTs: ts(minute + 1),
        payload: { taskId, to: "in_progress" },
      }),
      event({
        type: "note.created",
        actorId: ids.techA,
        clientTs: ts(minute + 1),
        payload: { noteId: uuid(), siteId: ids.siteA, taskId, kind: "text", text: "hi" },
      }),
    ];
    const ok = on(mine, 1);
    const bad = on(theirs, 5);
    const res = await sync(db, ids.techA, [...ok, ...bad]);
    expect(res.accepted).toEqual(ok.map((e) => e.id));
    expect(res.rejected).toEqual(bad.map((e) => ({ id: e.id, reason: "forbidden" })));
  });

  it("reserves reassigning and editing title, due date or priority for coordinators and managers", async () => {
    const taskId = await officeTask(ids.techA);
    const edits = [
      { assigneeId: ids.techB },
      { title: "Renamed" },
      { dueAt: at("2026-11-20T15:00:00Z") },
      { priority: "urgent" as const },
    ].map((changes, i) =>
      event({ type: "task.updated", actorId: ids.techA, clientTs: ts(i), payload: { taskId, changes } }),
    );
    const desc = event({
      type: "task.updated",
      actorId: ids.techA,
      clientTs: ts(9),
      payload: { taskId, changes: { description: "Found a second junction box" } },
    });
    const res = await sync(db, ids.techA, [...edits, desc]);
    expect(res.rejected).toEqual(edits.map((e) => ({ id: e.id, reason: "forbidden" })));
    expect(res.accepted).toEqual([desc.id]); // the assignee may add detail

    const mgr = await sync(db, ids.manager, [
      event({ type: "task.updated", actorId: ids.manager, clientTs: ts(20), payload: { taskId, changes: { title: "Manager edit", priority: "high" } } }),
      reassign(ids.manager, taskId, ids.techB, 21),
    ]);
    expect(mgr.rejected).toEqual([]);
  });

  it("only lets coordinators and managers create tasks for other people", async () => {
    const forOther = taskCreated(ids.techA, uuid(), at(T0), { assigneeId: ids.techB });
    const forSelf = taskCreated(ids.techA, uuid(), at(T0), { assigneeId: ids.techA });
    const res = await sync(db, ids.techA, [forOther, forSelf]);
    expect(res.rejected).toEqual([{ id: forOther.id, reason: "forbidden" }]);
    expect(res.accepted).toEqual([forSelf.id]);

    const mgr = await sync(db, ids.manager, [taskCreated(ids.manager, uuid(), at(T0), { assigneeId: ids.techB })]);
    expect(mgr.rejected).toEqual([]);
  });

  it("lets anyone send a material request or follow-up to the coordinator, but nothing else", async () => {
    const [materialId, followUpId] = [uuid(), uuid()];
    const material = taskCreated(ids.techA, materialId, at(T0), { assigneeId: ids.coordinator, kind: "material_request" });
    const followUp = taskCreated(ids.techA, followUpId, at(T0), { assigneeId: ids.coordinator, kind: "follow_up" });
    const plainTask = taskCreated(ids.techA, uuid(), at(T0), { assigneeId: ids.coordinator, kind: "task" });
    const toManager = taskCreated(ids.techA, uuid(), at(T0), { assigneeId: ids.manager, kind: "material_request" });
    const res = await sync(db, ids.techA, [material, followUp, plainTask, toManager]);
    expect(res.accepted).toEqual([material.id, followUp.id]);
    expect(res.rejected.map((r) => [r.id, r.reason])).toEqual([
      [plainTask.id, "forbidden"],
      [toManager.id, "forbidden"],
    ]);
    // The requester still sees their request (they created it).
    expect(res.changes.tasks.map((t) => t.id).sort()).toEqual([materialId, followUpId].sort());
  });

  it("keeps clock-in/out and status personal", async () => {
    const entry = uuid();
    await sync(db, ids.techA, [
      event({
        type: "time.clock_in",
        actorId: ids.techA,
        clientTs: ts(0),
        payload: { timeEntryId: entry, siteId: ids.siteA, lat: null, lng: null, accuracyM: null, locationError: "denied" },
      }),
    ]);
    const out = event({
      type: "time.clock_out",
      actorId: ids.techB,
      clientTs: ts(5),
      payload: { timeEntryId: entry, lat: null, lng: null },
    });
    const res = await sync(db, ids.techB, [out]);
    expect(res.rejected).toEqual([{ id: out.id, reason: "forbidden" }]);
    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, entry));
    expect(row.clockOutAt).toBeNull();
    expect(row.flagged).toBe(true);
    expect(row.flagReason).toBe("no_location: denied (needs HR review)");
    // An event can only ever be stamped with the requesting actor's id.
    const spoof = event({ type: "status.set", actorId: ids.techA, clientTs: ts(6), payload: { status: "off" } });
    expect((await sync(db, ids.techB, [spoof])).rejected[0].reason).toMatch(/^actor_mismatch/);
  });

  it("never fails the batch: forbidden events sit between accepted ones", async () => {
    const theirs = await officeTask(ids.techB);
    const good1 = event({ type: "status.set", actorId: ids.techA, clientTs: ts(1), payload: { status: "on_site" } });
    const bad = event({ type: "task.acknowledged", actorId: ids.techA, clientTs: ts(2), payload: { taskId: theirs } });
    const good2 = event({ type: "status.set", actorId: ids.techA, clientTs: ts(3), payload: { status: "lunch" } });
    const res = await sync(db, ids.techA, [good1, bad, good2]);
    expect(res.accepted).toEqual([good1.id, good2.id]);
    expect(res.rejected).toEqual([{ id: bad.id, reason: "forbidden" }]);
    const [stored] = await db.select().from(events).where(eq(events.id, bad.id));
    expect(stored).toMatchObject({ applied: false, rejectReason: "forbidden" });
  });
});

describe("revocations", () => {
  it("removes a reassigned task from the old assignee and adds it for the new one", async () => {
    const taskId = await officeTask(ids.techA);
    const a0 = await sync(db, ids.techA, []);
    const b0 = await sync(db, ids.techB, []);
    expect(a0.changes.tasks.map((t) => t.id)).toEqual([taskId]);
    expect(b0.changes.tasks).toEqual([]);

    await sync(db, ids.coordinator, [reassign(ids.coordinator, taskId, ids.techB, 0)]);

    const a1 = await sync(db, ids.techA, [], a0.cursor);
    expect(a1.revocations).toEqual([{ entity: "task", entityId: taskId, seq: expect.any(Number) }]);
    expect(a1.changes.tasks).toEqual([]);
    const b1 = await sync(db, ids.techB, [], b0.cursor);
    expect(b1.changes.tasks.map((t) => t.id)).toEqual([taskId]);
    // B gets their own receipt (and sees A's earlier one: receipts on B's tasks are visible to B).
    expect(b1.changes.task_receipts.map((r) => r.personId).sort()).toEqual([ids.techA, ids.techB].sort());
    expect(b1.revocations).toEqual([]);

    // The old assignee can no longer act on it.
    const late = event({ type: "task.acknowledged", actorId: ids.techA, clientTs: ts(5), payload: { taskId } });
    expect((await sync(db, ids.techA, [late], a1.cursor)).rejected).toEqual([{ id: late.id, reason: "forbidden" }]);

    // Handed back: the task comes back after the revocation (higher seq).
    await sync(db, ids.coordinator, [reassign(ids.coordinator, taskId, ids.techA, 10)]);
    const a2 = await sync(db, ids.techA, [], a0.cursor);
    const revSeq = a2.revocations[0]?.seq ?? 0;
    expect(a2.changes.tasks.map((t) => t.id)).toEqual([taskId]);
    expect(a2.changes.tasks[0].seq).toBeGreaterThan(revSeq);
  });

  it("does not revoke from a creator, and never sends revocations to the office", async () => {
    const own = uuid();
    await sync(db, ids.techA, [taskCreated(ids.techA, own, at(T0), { assigneeId: ids.techA })]);
    await sync(db, ids.coordinator, [reassign(ids.coordinator, own, ids.techB, 0)]);
    expect(await db.select().from(revocations)).toEqual([]);
    const a = await sync(db, ids.techA, []);
    expect(a.changes.tasks.map((t) => t.id)).toEqual([own]); // still visible as creator

    const req = uuid();
    await sync(db, ids.techA, [
      taskCreated(ids.techA, req, at(T0), { assigneeId: ids.coordinator, kind: "material_request" }),
    ]);
    // The coordinator (previous assignee, not the creator) hands the request on.
    await sync(db, ids.coordinator, [reassign(ids.coordinator, req, ids.techB, 1)]);
    expect((await db.select().from(revocations)).map((r) => r.actorId)).toEqual([ids.coordinator]);
    expect((await sync(db, ids.coordinator, [])).revocations).toEqual([]);
  });
});

describe("pull pagination", () => {
  it("caps each pull and pages through without skipping or repeating rows", async () => {
    // 260 tasks -> 260 tasks + 260 receipts (+ people, sites) > one 500-row page.
    const taskIds: string[] = [];
    for (let b = 0; b < 2; b++) {
      const batch = Array.from({ length: 130 }, () => {
        const id = uuid();
        taskIds.push(id);
        return taskCreated(ids.coordinator, id, at(T0));
      });
      expect((await sync(db, ids.coordinator, batch)).rejected).toEqual([]);
    }

    const seen = { tasks: new Set<string>(), receipts: 0, rows: 0 };
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const res = await sync(db, ids.techA, [], cursor);
      pages++;
      const n = Object.values(res.changes).reduce((k, rows) => k + rows.length, 0) + res.revocations.length;
      expect(n).toBeLessThanOrEqual(500);
      for (const t of res.changes.tasks) {
        expect(seen.tasks.has(t.id)).toBe(false);
        seen.tasks.add(t.id);
      }
      seen.receipts += res.changes.task_receipts.length;
      seen.rows += n;
      if (cursor !== null) expect(Number(res.cursor)).toBeGreaterThan(Number(cursor));
      cursor = res.cursor;
      if (!res.hasMore) break;
      expect(n).toBe(500);
    }
    expect(pages).toBe(2);
    expect(seen.tasks).toEqual(new Set(taskIds));
    expect(seen.receipts).toBe(260);
    const again = await sync(db, ids.techA, [], cursor);
    expect(again.hasMore).toBe(false);
    expect(Object.values(again.changes).every((rows) => rows.length === 0)).toBe(true);
  });

  it("honours a custom page size across tables", async () => {
    for (let i = 0; i < 3; i++) await officeTask(ids.techA);
    const rows: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const out = await processSync(db, { deviceId: "d", actorId: ids.techA, cursor, events: [] }, { now: () => NOW, pageSize: 2 });
      if (!out.ok) throw new Error(out.error);
      const page = Object.values(out.response.changes).flat();
      expect(page.length).toBeLessThanOrEqual(2);
      rows.push(...page.map((r) => r.seq));
      cursor = out.response.cursor;
      if (!out.response.hasMore) break;
    }
    // 3 tasks + 3 receipts + 1 site + 4 people, each exactly once, in seq order.
    expect(rows).toHaveLength(11);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
    expect(new Set(rows).size).toBe(11);
  });
});

describe("note media", () => {
  const voiceNote = (noteId: string, mediaId: string) =>
    event({
      type: "note.created",
      actorId: ids.techA,
      clientTs: ts(0),
      payload: { noteId, siteId: ids.siteA, kind: "voice", mediaId },
    });
  const uploaded = (actorId: string, noteId: string, blobUrl: string, minute = 1) =>
    event({
      type: "note.media_uploaded",
      actorId,
      clientTs: ts(minute),
      payload: { noteId, blobUrl, mimeType: "audio/mp4", sizeBytes: 12345, durationSec: 7.5 },
    });

  it("attaches the uploaded blob to the note once, first upload wins", async () => {
    const noteId = uuid();
    const created = voiceNote(noteId, uuid());
    const up = uploaded(ids.techA, noteId, "https://blob.example.com/a.m4a");
    const res = await sync(db, ids.techA, [created, up]);
    expect(res.accepted).toEqual([created.id, up.id]);
    const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(note).toMatchObject({ blobUrl: "https://blob.example.com/a.m4a", mimeType: "audio/mp4", sizeBytes: 12345, durationSec: 7.5 });

    const second = uploaded(ids.techA, noteId, "https://blob.example.com/b.m4a", 2);
    expect((await sync(db, ids.techA, [second])).accepted).toEqual([second.id]);
    const [after] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(after.blobUrl).toBe("https://blob.example.com/a.m4a");
    expect(after.seq).toBe(note.seq); // unchanged, not rewritten
  });

  it("rejects uploads for someone else's note or a note without media", async () => {
    const noteId = uuid();
    await sync(db, ids.techA, [voiceNote(noteId, uuid())]);
    const other = uploaded(ids.techB, noteId, "https://blob.example.com/x.m4a");
    expect((await sync(db, ids.techB, [other])).rejected).toEqual([{ id: other.id, reason: "forbidden" }]);

    const textNote = uuid();
    await sync(db, ids.techA, [
      event({ type: "note.created", actorId: ids.techA, clientTs: ts(0), payload: { noteId: textNote, siteId: ids.siteA, kind: "text", text: "t" } }),
    ]);
    const bad = uploaded(ids.techA, textNote, "https://blob.example.com/y.m4a");
    expect((await sync(db, ids.techA, [bad])).rejected[0].reason).toBe("note_has_no_media");
    const missing = uploaded(ids.techA, uuid(), "https://blob.example.com/z.m4a");
    expect((await sync(db, ids.techA, [missing])).rejected[0].reason).toBe("note_not_found");
  });

  it("refuses a note with neither text nor media", async () => {
    const empty = event({ type: "note.created", actorId: ids.techA, clientTs: ts(0), payload: { noteId: uuid(), siteId: ids.siteA, kind: "text" } });
    expect((await sync(db, ids.techA, [empty])).rejected[0].reason).toMatch(/^invalid_event/);
  });
});

describe("worker status", () => {
  it("can be cleared", async () => {
    await sync(db, ids.techA, [
      event({ type: "status.set", actorId: ids.techA, clientTs: ts(0), payload: { status: "lunch" } }),
      event({ type: "status.set", actorId: ids.techA, clientTs: ts(1), payload: { status: null } }),
    ]);
    const rows = await db.select().from(statusUpdates).orderBy(statusUpdates.at);
    expect(rows.map((r) => r.status)).toEqual(["lunch", null]);
  });
});
