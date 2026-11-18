// Field report agent: extraction schema with a mocked model, the rule-based
// fallback, dedupe, the urgent safety task, and that it acts only as the
// note's author through events. No real API calls.
import { MockLanguageModelV4, MockTranscriptionModelV4 } from "ai/test";
import { mockLanguage, models } from "./agent-mocks";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fallbackExtract,
  needsReport,
  pendingReportNotes,
  planReportTasks,
  processPendingReports,
  runReportAgent,
  type Extraction,
} from "@/lib/agents/report";
import { agentRuns, events, fieldNotes, tasks } from "@/lib/db/schema";
import { evaluateEscalations } from "@/lib/escalation/rules";
import { loadEscalationState } from "@/lib/escalation/run";
import { clockAt } from "@/lib/clock";
import type { Db } from "@/lib/sync/store-drizzle";
import { ids, makeDb, NOW, sync, uuid } from "./helpers";

const DEMO = "Finished the north lot fixtures, we need 40 more LED panels, and there's an exposed wire near the loading dock";
const extraction: Extraction = {
  summary: "North lot fixtures finished; LED panels needed; exposed wire at the loading dock.",
  workDone: ["Finished the north lot fixtures"],
  materialsUsed: [],
  materialsNeeded: [{ item: "LED panels", qty: 40 }],
  blockers: [],
  safetyIssues: ["Exposed wire near the loading dock"],
  followUps: [{ title: "Confirm panel delivery date", assigneeRole: "coordinator", dueInDays: 1 }],
};

let db: Db;
let close: () => Promise<void>;
const at = NOW.toISOString();
const now = () => NOW;

beforeEach(async () => {
  ({ db, close } = await makeDb());
});
afterEach(async () => close());

/** A technician task + a long text note on it, synced the normal way. */
async function textNoteOnTask(text = DEMO + ". Also the parking lot lights on the east side flicker after dark, please check."): Promise<{ noteId: string; taskId: string }> {
  const taskId = uuid();
  const noteId = uuid();
  await sync(db, ids.coordinator, [
    { id: uuid(), type: "task.created", actorId: ids.coordinator, deviceId: "d", clientTs: at, payload: { taskId, title: "North lot fixtures", siteId: ids.siteA, assigneeId: ids.techA } },
  ]);
  const r = await sync(db, ids.techA, [
    { id: uuid(), type: "note.created", actorId: ids.techA, deviceId: "phone", clientTs: at, payload: { noteId, siteId: ids.siteA, taskId, kind: "text", text } },
  ]);
  expect(r.rejected).toEqual([]);
  return { noteId, taskId };
}

describe("eligibility", () => {
  it("reads long text notes and uploaded voice notes only", () => {
    const base = { processedAt: null, blobPath: null };
    expect(needsReport({ ...base, kind: "text", text: "on my way" })).toBe(false);
    expect(needsReport({ ...base, kind: "text", text: DEMO + " " + DEMO })).toBe(true);
    expect(needsReport({ ...base, kind: "voice", text: null })).toBe(false); // not uploaded yet
    expect(needsReport({ ...base, kind: "voice", text: null, blobPath: "notes/x/y.webm" })).toBe(true);
    expect(needsReport({ ...base, kind: "photo", text: null, blobPath: "notes/x/y.jpg" })).toBe(false);
    expect(needsReport({ kind: "text", text: DEMO + DEMO, blobPath: null, processedAt: new Date() })).toBe(false);
  });
});

describe("fallback extraction (no model)", () => {
  it("finds the demo sentence's work, material and safety issue", () => {
    const x = fallbackExtract(DEMO);
    expect(x.workDone).toEqual(["Finished the north lot fixtures"]);
    expect(x.materialsNeeded).toEqual([{ item: "LED panels", qty: 40 }]);
    expect(x.safetyIssues).toEqual(["There's an exposed wire near the loading dock"]);
  });
});

describe("planning", () => {
  const ctx = {
    note: { id: "f0000000-0000-4000-8000-000000000001", personId: ids.techA, siteId: ids.siteA, taskId: "f0000000-0000-4000-8000-000000000002", kind: "voice" as const },
    authorName: "Tess",
    siteName: "Site A",
    task: { id: "f0000000-0000-4000-8000-000000000002", title: "North lot", assigneeId: ids.techA },
    coordinatorId: ids.coordinator,
    now: NOW,
  };
  it("is deterministic: the same note always plans the same ids", () => {
    const a = planReportTasks(extraction, ctx).tasks.map((t) => t.taskId);
    const b = planReportTasks(extraction, ctx).tasks.map((t) => t.taskId);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });
  it("a safety issue becomes an urgent task for the coordinator", () => {
    const safety = planReportTasks(extraction, ctx).tasks.find((t) => t.title.startsWith("Safety:"))!;
    expect(safety).toMatchObject({ priority: "urgent", assigneeId: ids.coordinator, kind: "follow_up" });
  });
  it("'assignee' follow-ups go to the author only when they own the note's task", () => {
    const x = { ...extraction, followUps: [{ title: "Re-check panel 3", assigneeRole: "assignee" as const, dueInDays: 2 }] };
    expect(planReportTasks(x, ctx).tasks[0].assigneeId).toBe(ids.techA);
    expect(planReportTasks(x, { ...ctx, task: null }).tasks[0].assigneeId).toBe(ids.coordinator);
  });
});

describe("runReportAgent", () => {
  it("with the model: stores the log, creates a material request and an urgent safety task as the author", async () => {
    const { noteId, taskId } = await textNoteOnTask();
    const out = await runReportAgent(db, noteId, { trigger: "test", deps: { models: models(mockLanguage(extraction)), now } });
    expect(out.status).toBe("ok");

    const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(note.processedAt).not.toBeNull();
    expect(note.report?.mode).toBe("ai");
    expect(note.report?.createdTasks).toHaveLength(3);

    const created = await db.select().from(tasks).where(eq(tasks.source, "report_agent"));
    expect(created).toHaveLength(3);
    for (const t of created) {
      expect(t.createdBy).toBe(ids.techA); // the agent acted as the note's author
      expect(t.parentTaskId).toBe(taskId);
    }
    expect(created.find((t) => t.kind === "material_request")).toMatchObject({ title: "Material: 40 × LED panels", assigneeId: ids.coordinator });
    expect(created.find((t) => t.priority === "urgent")).toMatchObject({ assigneeId: ids.coordinator, title: "Safety: Exposed wire near the loading dock" });

    // Every write went through the event log from the agent's device.
    const evs = await db.select().from(events).where(eq(events.deviceId, "agent:report_agent"));
    expect(evs.map((e) => e.type).sort()).toEqual(["note.processed", "task.created", "task.created", "task.created"]);
    expect(evs.every((e) => e.applied)).toBe(true);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.subjectId, noteId));
    expect(run).toMatchObject({ agent: "report_agent", status: "ok", tokensIn: 300, tokensOut: 120, model: "claude-opus-5-5" });
    expect(run.costUsd).toBeCloseTo((300 * 4 + 120 * 20) / 1e6, 8);
  });

  it("the Day 4 rules pick up the urgent safety task (ack ladder for the coordinator)", async () => {
    const { noteId } = await textNoteOnTask();
    await runReportAgent(db, noteId, { trigger: "test", deps: { models: models(mockLanguage(extraction)), now } });
    const [safety] = await db.select().from(tasks).where(and(eq(tasks.source, "report_agent"), eq(tasks.priority, "urgent")));
    const actions = evaluateEscalations(await loadEscalationState(db), clockAt(NOW));
    expect(actions.some((a) => a.kind !== "resolve" && a.taskId === safety.id && a.rule === "ack")).toBe(true);
  });

  it("never creates the same follow-up twice (second run is skipped; replayed events are duplicates)", async () => {
    const { noteId } = await textNoteOnTask();
    const calls = { n: 0 };
    const deps = { models: models(mockLanguage(extraction, calls)), now };
    await runReportAgent(db, noteId, { trigger: "test", deps });
    expect(await runReportAgent(db, noteId, { trigger: "test", deps })).toEqual({ status: "skipped", reason: "not_eligible" });
    expect(calls.n).toBe(1);
    expect(await pendingReportNotes(db)).toEqual([]);

    // Even if the processed flag were lost, re-planning yields the same ids: duplicates, not new tasks.
    await db.update(fieldNotes).set({ processedAt: null }).where(eq(fieldNotes.id, noteId));
    await db.delete(agentRuns);
    await runReportAgent(db, noteId, { trigger: "test", deps });
    expect(await db.select().from(tasks).where(eq(tasks.source, "report_agent"))).toHaveLength(3);
  });

  it("falls back to rules when the model errors, and when there is no key", async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("overloaded"); } });
    const a = await textNoteOnTask();
    expect((await runReportAgent(db, a.noteId, { trigger: "test", deps: { models: models(broken), now } })).status).toBe("fallback");
    const b = await textNoteOnTask();
    expect((await runReportAgent(db, b.noteId, { trigger: "test", deps: { models: models(), now } })).status).toBe("fallback");
    const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, b.noteId));
    expect(note.report).toMatchObject({ mode: "fallback", materialsNeeded: [{ item: "LED panels", qty: 40 }] });
    const runs = await db.select().from(agentRuns);
    expect(runs.map((r) => r.status)).toEqual(["fallback", "fallback"]);
    expect(runs.map((r) => r.error)).toEqual([expect.stringContaining("overloaded"), "ANTHROPIC_API_KEY not set"]);
  });

  it("invalid model output is rejected by the schema and the fallback runs", async () => {
    const { noteId } = await textNoteOnTask();
    const out = await runReportAgent(db, noteId, { trigger: "test", deps: { models: models(mockLanguage({ summary: 3 })), now } });
    expect(out.status).toBe("fallback");
  });

  it("voice note: transcribes, then extracts; without a transcription key it records why", async () => {
    const noteId = uuid();
    const mediaId = uuid();
    await sync(db, ids.techA, [
      { id: uuid(), type: "note.created", actorId: ids.techA, deviceId: "phone", clientTs: at, payload: { noteId, siteId: ids.siteA, kind: "voice", mediaId } },
    ]);
    await db.update(fieldNotes).set({ blobPath: `notes/${noteId}/${mediaId}.webm`, mimeType: "audio/webm", durationSec: 9 }).where(eq(fieldNotes.id, noteId));
    const stt = new MockTranscriptionModelV4({
      doGenerate: async () => ({ text: DEMO, segments: [], language: "en", durationInSeconds: 9, warnings: [], response: { timestamp: NOW, modelId: "mock" } }),
    });
    const readAudio = async () => new Uint8Array([1, 2, 3]);
    const out = await runReportAgent(db, noteId, { trigger: "test", deps: { models: models(mockLanguage(extraction), stt), readAudio, now } });
    expect(out.status).toBe("ok");
    const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(note.transcript).toBe(DEMO);
    expect(note.report?.createdTasks).toHaveLength(3);

    const n2 = uuid();
    await sync(db, ids.techA, [
      { id: uuid(), type: "note.created", actorId: ids.techA, deviceId: "phone", clientTs: at, payload: { noteId: n2, siteId: ids.siteA, kind: "voice", mediaId: uuid() } },
    ]);
    await db.update(fieldNotes).set({ blobPath: `notes/${n2}/x.webm`, mimeType: "audio/webm" }).where(eq(fieldNotes.id, n2));
    expect((await runReportAgent(db, n2, { trigger: "test", deps: { models: models(mockLanguage(extraction)), readAudio, now } })).status).toBe("fallback");
    const [v2] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, n2));
    expect(v2.transcript).toBeNull();
    expect(v2.report?.transcriptError).toContain("OPENAI_API_KEY");
    expect(v2.report?.createdTasks).toEqual([]);
  });

  it("devices cannot send note.processed themselves", async () => {
    const { noteId } = await textNoteOnTask();
    const r = await sync(db, ids.techA, [
      {
        id: uuid(),
        type: "note.processed",
        actorId: ids.techA,
        deviceId: "phone",
        clientTs: at,
        payload: { noteId, transcript: null, report: { ...extraction, mode: "ai", createdTasks: [] } },
      },
    ]);
    expect(r.rejected[0].reason).toBe("forbidden");
  });

  it("the queue processes waiting notes and leaves short ones alone", async () => {
    const { noteId } = await textNoteOnTask();
    await textNoteOnTask("on my way");
    const done = await processPendingReports(db, { trigger: "test", deps: { models: models(mockLanguage(extraction)), now } });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "ok" });
    const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
    expect(note.processedAt).not.toBeNull();
  });
});
