// Day 3 server rules: material requests, rollout stages (closeout needs a photo),
// timesheet review, device freshness.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devices, fieldNotes, people, sites, tasks, timeEntries } from "@/lib/db/schema";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import { at, event, ids, makeDb, NOW, sync, taskCreated, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
const hr = "a0000000-0000-4000-8000-000000000005";
beforeEach(async () => {
  ({ db, close } = await makeDb());
  await db.insert(people).values({ id: hr, branchId: ids.branch, name: "Hana HR", role: "hr", trade: "general" });
});
afterEach(async () => close());

const ts = (minute: number) => at(`2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`);
const reasons = (r: { rejected: { reason: string }[] }) => r.rejected.map((x) => x.reason);

describe("material.status_changed", () => {
  async function request() {
    const taskId = uuid();
    const r = await sync(db, ids.techA, [
      taskCreated(ids.techA, taskId, ts(0), { assigneeId: ids.coordinator, kind: "material_request", title: "Need wire" }),
    ]);
    expect(r.rejected).toEqual([]);
    return taskId;
  }
  const move = (actorId: string, taskId: string, to: string, minute: number) =>
    event({ type: "material.status_changed", actorId, clientTs: ts(minute), payload: { taskId, to } } as never);

  it("moves forward only; delivered closes the request", async () => {
    const taskId = await request();
    expect(reasons(await sync(db, ids.coordinator, [move(ids.coordinator, taskId, "approved", 1)]))).toEqual([]);
    expect(reasons(await sync(db, ids.coordinator, [move(ids.coordinator, taskId, "ordered", 2)]))).toEqual([]);
    expect(reasons(await sync(db, ids.coordinator, [move(ids.coordinator, taskId, "approved", 3)]))[0]).toMatch(
      /^invalid_transition/,
    );
    expect(reasons(await sync(db, ids.manager, [move(ids.manager, taskId, "delivered", 4)]))).toEqual([]);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(t).toMatchObject({ materialStatus: "delivered", status: "done" });
    expect(t.materialStatusAt?.toISOString()).toBe(ts(4));
  });

  it("is office-only and only for material requests", async () => {
    const taskId = await request();
    expect(reasons(await sync(db, ids.techA, [move(ids.techA, taskId, "approved", 1)]))).toEqual(["forbidden"]);
    expect(reasons(await sync(db, hr, [move(hr, taskId, "approved", 1)]))).toEqual(["forbidden"]);
    const plain = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, plain, ts(0))]);
    expect(reasons(await sync(db, ids.coordinator, [move(ids.coordinator, plain, "approved", 1)]))).toEqual([
      "not_a_material_request",
    ]);
  });
});

describe("site.stage_changed", () => {
  const stage = (actorId: string, from: string, to: string, minute: number, siteId = ids.siteRollout) =>
    event({ type: "site.stage_changed", actorId, clientTs: ts(minute), payload: { siteId, from, to } } as never);
  const photo = async (uploaded: boolean, kind: "photo" | "text" = "photo") => {
    const noteId = uuid();
    const r = await sync(db, ids.techA, [
      event({
        type: "note.created",
        actorId: ids.techA,
        clientTs: ts(5),
        payload: kind === "photo" ? { noteId, siteId: ids.siteRollout, kind, mediaId: uuid() } : { noteId, siteId: ids.siteRollout, kind, text: "done" },
      }),
    ]);
    expect(r.rejected).toEqual([]);
    if (uploaded) await db.update(fieldNotes).set({ blobPath: `notes/${noteId}/x.jpg` }).where(eq(fieldNotes.id, noteId));
  };

  it("moves a store, records when, and rejects a stale board", async () => {
    expect(reasons(await sync(db, ids.coordinator, [stage(ids.coordinator, "install", "punch_list", 1)]))).toEqual([]);
    const [s] = await db.select().from(sites).where(eq(sites.id, ids.siteRollout));
    expect(s.rolloutStage).toBe("punch_list");
    expect(s.stageChangedAt?.toISOString()).toBe(ts(1));
    // Someone else's board still says "install".
    expect(reasons(await sync(db, ids.manager, [stage(ids.manager, "install", "survey", 2)]))[0]).toMatch(/^stage_conflict/);
    // The same move again is a no-op, not an error.
    expect(reasons(await sync(db, ids.manager, [stage(ids.manager, "install", "punch_list", 3)]))).toEqual([]);
  });

  it("blocks Closeout without an uploaded photo note, allows it with one", async () => {
    await photo(false); // still on the phone
    await photo(true, "text");
    const blocked = await sync(db, ids.coordinator, [stage(ids.coordinator, "install", "closeout", 1)]);
    expect(reasons(blocked)[0]).toMatch(/^photo_required/);
    await photo(true);
    expect(reasons(await sync(db, ids.coordinator, [stage(ids.coordinator, "install", "closeout", 6)]))).toEqual([]);
  });

  it("is for coordinators and managers, on rollout stores only", async () => {
    expect(reasons(await sync(db, ids.techA, [stage(ids.techA, "install", "punch_list", 1)]))).toEqual(["forbidden"]);
    expect(reasons(await sync(db, hr, [stage(hr, "install", "punch_list", 1)]))).toEqual(["forbidden"]);
    expect(reasons(await sync(db, ids.coordinator, [stage(ids.coordinator, "install", "punch_list", 1, ids.siteA)]))).toEqual([
      "not_a_rollout_store",
    ]);
  });

  it("rejects from == to at the schema level", async () => {
    expect(reasons(await sync(db, ids.coordinator, [stage(ids.coordinator, "install", "install", 1)]))[0]).toMatch(/^invalid_event/);
  });
});

describe("time.approved / time.rejected", () => {
  const entryId = "f0000000-0000-4000-8000-000000000001";
  async function clock(out: boolean) {
    const evs = [
      event({
        type: "time.clock_in",
        actorId: ids.techA,
        clientTs: ts(0),
        payload: { timeEntryId: entryId, siteId: ids.siteA, lat: 40.7505, lng: -73.8472, accuracyM: 5, safetyCheckDone: true },
      }),
    ];
    if (out) evs.push(event({ type: "time.clock_out", actorId: ids.techA, clientTs: ts(30), payload: { timeEntryId: entryId, lat: null, lng: null } }));
    expect((await sync(db, ids.techA, evs)).rejected).toEqual([]);
  }
  const review = (actorId: string, minute: number, reason?: string) =>
    event({
      type: reason ? "time.rejected" : "time.approved",
      actorId,
      clientTs: ts(minute),
      payload: reason ? { timeEntryId: entryId, reason } : { timeEntryId: entryId },
    } as never);
  const entry = async () => (await db.select().from(timeEntries).where(eq(timeEntries.id, entryId)))[0];

  it("lets HR and managers decide; the later decision wins", async () => {
    await clock(true);
    expect(reasons(await sync(db, hr, [review(hr, 40)]))).toEqual([]);
    expect(await entry()).toMatchObject({ reviewStatus: "approved", reviewedBy: hr, reviewReason: null });
    expect(reasons(await sync(db, ids.manager, [review(ids.manager, 45, "Wrong site")]))).toEqual([]);
    expect(await entry()).toMatchObject({ reviewStatus: "rejected", reviewedBy: ids.manager, reviewReason: "Wrong site" });
    // An older approval arriving late loses.
    expect(reasons(await sync(db, hr, [review(hr, 41)]))).toEqual([]);
    expect((await entry()).reviewStatus).toBe("rejected");
  });

  it("is forbidden for coordinators and field workers", async () => {
    await clock(true);
    expect(reasons(await sync(db, ids.coordinator, [review(ids.coordinator, 40)]))).toEqual(["forbidden"]);
    expect(reasons(await sync(db, ids.techA, [review(ids.techA, 40)]))).toEqual(["forbidden"]);
  });

  it("can reject but not approve an entry with no clock-out; a reason is required", async () => {
    await clock(false);
    expect(reasons(await sync(db, hr, [review(hr, 40)]))[0]).toMatch(/^entry_open/);
    expect(reasons(await sync(db, hr, [review(hr, 41, "Missing clock-out")]))).toEqual([]);
    expect(reasons(await sync(db, hr, [review(hr, 42, "  ")]))[0]).toMatch(/^invalid_event/);
  });
});

describe("devices (office freshness)", () => {
  it("records the last successful sync per device only when asked (POST /api/sync)", async () => {
    const req = { deviceId: "web-1", actorId: ids.techA, cursor: null, events: [], appVersion: "0.3.0" };
    await processSync(db, req, { now: () => NOW });
    expect(await db.select().from(devices)).toEqual([]);
    await processSync(db, req, { now: () => NOW, recordDevice: true });
    const later = new Date(NOW.getTime() + 60_000);
    await processSync(db, { ...req, actorId: ids.techB }, { now: () => later, recordDevice: true });
    expect(await db.select().from(devices)).toEqual([{ id: "web-1", personId: ids.techB, lastSyncAt: later, appVersion: "0.3.0" }]);
  });

  it("skips the pull when pull: false (office writes)", async () => {
    const out = await processSync(db, { deviceId: "web-1", actorId: ids.coordinator, cursor: null, events: [], pull: false });
    if (!out.ok) throw new Error(out.error);
    expect(out.response.changes.people).toEqual([]);
    expect(out.response.cursor).toBe("0");
  });
});

describe("office status changes on any task (Part A item 3)", () => {
  const status = (actorId: string, taskId: string, to: string, minute: number, reason?: string) =>
    event({ type: "task.status_changed", actorId, clientTs: ts(minute), payload: { taskId, to, ...(reason ? { reason } : {}) } } as never);
  const statusOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0].status;

  /** A technician's own to-do: created by and assigned to techA (the coordinator is neither). */
  async function techTask() {
    const id = uuid();
    expect((await sync(db, ids.techA, [taskCreated(ids.techA, id, ts(0), { assigneeId: ids.techA })])).rejected).toEqual([]);
    return id;
  }

  it("lets a coordinator cancel and reopen a task that is neither theirs nor created by them", async () => {
    const id = await techTask();
    expect(reasons(await sync(db, ids.coordinator, [status(ids.coordinator, id, "cancelled", 1, "Duplicate")]))).toEqual([]);
    expect(await statusOf(id)).toBe("cancelled");
    expect(reasons(await sync(db, ids.coordinator, [status(ids.coordinator, id, "open", 2)]))).toEqual([]);
    expect(await statusOf(id)).toBe("open");
  });

  it("lets a manager move any task through allowed transitions (done -> reopen)", async () => {
    const id = uuid();
    await sync(db, ids.coordinator, [taskCreated(ids.coordinator, id, ts(0), { assigneeId: ids.techB })]);
    for (const [to, m] of [["in_progress", 1], ["blocked", 2], ["done", 3], ["open", 4]] as const) {
      expect(reasons(await sync(db, ids.manager, [status(ids.manager, id, to, m)])), to).toEqual([]);
    }
    expect(await statusOf(id)).toBe("open");
    // Transition rules still apply to the office: a done task can only be reopened.
    await sync(db, ids.manager, [status(ids.manager, id, "done", 5)]);
    expect(reasons(await sync(db, ids.manager, [status(ids.manager, id, "blocked", 6)]))[0]).toMatch(/^invalid_transition/);
  });

  it("an older field event cannot reopen a task the office cancelled", async () => {
    const id = await techTask();
    await sync(db, ids.coordinator, [status(ids.coordinator, id, "cancelled", 5, "Customer cancelled")]);
    expect(reasons(await sync(db, ids.techA, [status(ids.techA, id, "in_progress", 3)]))[0]).toMatch(/^stale_event/);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("keeps the Day 2 rule for everyone else: HR, and a creator who is not the assignee", async () => {
    const id = await techTask();
    expect(reasons(await sync(db, hr, [status(hr, id, "cancelled", 1, "x")]))).toEqual(["forbidden"]);
    // techA raises a material request for the coordinator, then tries to close it.
    const req = uuid();
    await sync(db, ids.techA, [taskCreated(ids.techA, req, ts(0), { assigneeId: ids.coordinator, kind: "material_request" })]);
    expect(reasons(await sync(db, ids.techA, [status(ids.techA, req, "cancelled", 1)]))).toEqual(["forbidden"]);
    expect(reasons(await sync(db, ids.coordinator, [status(ids.coordinator, req, "cancelled", 2, "Have stock")]))).toEqual([]);
  });
});
