// Dispatch agent: output validation (ids, activity, trade), invalid-id
// handling, the fallback path, and approve/reject through normal events.
// The model is mocked; no real API calls.
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveDraft,
  fallbackDispatch,
  loadDispatchContext,
  matchSite,
  rejectDraft,
  runDispatchAgent,
  validateDispatch,
  type DispatchContext,
  type DispatchModelOutput,
} from "@/lib/agents/dispatch";
import { agentRuns, dispatchDrafts, people, tasks } from "@/lib/db/schema";
import { processSync } from "@/lib/sync/service";
import type { Db } from "@/lib/sync/store-drizzle";
import { mockLanguage, models } from "./agent-mocks";
import { ids, makeDb, NOW } from "./helpers";

let db: Db;
let close: () => Promise<void>;
let ctx: DispatchContext;
const now = () => NOW;

beforeEach(async () => {
  ({ db, close } = await makeDb());
  ctx = await loadDispatchContext(db, null, NOW);
});
afterEach(async () => close());

const ref = (id: string) => [...ctx.sites, ...ctx.people].find((x) => x.id === id)!.ref;
const good = (): DispatchModelOutput => ({
  siteRef: ref(ids.siteRollout),
  matchedSiteConfidence: 0.92,
  kind: "service_call",
  trade: "lighting",
  priority: "urgent",
  title: "Parking lot lights out at Store 1",
  description: "Customer reports the lot is dark; safety issue.",
  suggestedAssigneeRef: ref(ids.techB),
  alternativeAssigneeRefs: [],
  dueAt: new Date(NOW.getTime() + 4 * 3_600_000).toISOString(),
  reasoning: "Store named in the request. Theo does lighting. Safety issue, so urgent. Extra sentence dropped.",
  missingInfo: [],
});

const process = (req: { actorId: string; deviceId: string; events: unknown[] }) =>
  processSync(db, { ...req, cursor: null, pull: false }, { skipPull: true, now }).then((r) => (r.ok ? r.response : { error: r.error }));

describe("context", () => {
  it("gives the model short refs, never uuids, and only active field people", () => {
    expect(ctx.sites.map((s) => s.ref)).toEqual(["S1", "S2", "S3"]);
    expect(ctx.people.map((p) => p.name).sort()).toEqual(["Tess Tech", "Theo Tech"]);
  });
});

describe("validation", () => {
  it("keeps a valid draft (refs mapped to ids, reasoning capped at 3 sentences)", () => {
    const { draft, notes } = validateDispatch(good(), ctx);
    expect(draft).toMatchObject({ siteId: ids.siteRollout, suggestedAssigneeId: ids.techB, trade: "lighting", priority: "urgent" });
    expect(draft.reasoning.split(". ").length).toBe(3);
    expect(notes).toEqual([]);
  });

  it("drops ids that do not exist and fills the assignee from the rules", () => {
    const { draft, notes } = validateDispatch({ ...good(), siteRef: "S99", suggestedAssigneeRef: "P42", alternativeAssigneeRefs: ["a0000000-0000-4000-8000-000000000002"] }, ctx);
    expect(draft.siteId).toBeNull();
    expect(draft.missingInfo).toContain("Which site is this for?");
    expect(draft.suggestedAssigneeId).toBe(ids.techB); // rules: the lighting tech
    expect(notes.join("\n")).toMatch(/site ref "S99" does not exist/);
    expect(notes.join("\n")).toMatch(/assignee "P42" does not exist/);
    expect(notes.join("\n")).toMatch(/alternative "a0000000-.*" does not exist/);
  });

  it("drops an assignee whose trade does not fit", () => {
    const { draft, notes } = validateDispatch({ ...good(), suggestedAssigneeRef: ref(ids.techA) }, ctx);
    expect(notes[0]).toMatch(/Tess Tech \(electrical\) does not fit trade lighting/);
    expect(draft.suggestedAssigneeId).toBe(ids.techB);
  });

  it("drops an inactive assignee", async () => {
    await db.update(people).set({ active: false }).where(eq(people.id, ids.techB));
    const ctx2 = await loadDispatchContext(db, null, NOW);
    // Inactive people are not even in the list the model sees, so their ref does not exist.
    const { draft } = validateDispatch({ ...good(), suggestedAssigneeRef: "P2" }, ctx2);
    expect(draft.suggestedAssigneeId).not.toBe(ids.techB);
  });

  it("drops an unparseable or far-away due date", () => {
    expect(validateDispatch({ ...good(), dueAt: "next tuesday" }, ctx).draft.dueAt).toBeNull();
    expect(validateDispatch({ ...good(), dueAt: "2031-01-01T00:00:00Z" }, ctx).draft.dueAt).toBeNull();
  });

  it("keeps the site the coordinator picked on the form", async () => {
    const hinted = await loadDispatchContext(db, ids.siteB, NOW);
    const { draft, notes } = validateDispatch({ ...good(), siteRef: hinted.sites.find((s) => s.id === ids.siteRollout)!.ref }, hinted);
    expect(draft.siteId).toBe(ids.siteB);
    expect(notes[0]).toMatch(/kept the site chosen on the form/);
  });
});

describe("fallback (rules)", () => {
  it("matches a store number and picks trade, priority and assignee", () => {
    ctx.sites.find((s) => s.id === ids.siteRollout)!.name = "RetailCo #106 - Harlem";
    expect(matchSite("Store 106 lights are out", ctx).site?.id).toBe(ids.siteRollout);
    const d = fallbackDispatch("Store 106 parking lot lights are out, customer says it's a safety issue.", ctx);
    expect(d).toMatchObject({ siteId: ids.siteRollout, trade: "lighting", priority: "urgent", suggestedAssigneeId: ids.techB, kind: "service_call" });
  });
  it("asks for the site when none is named", () => {
    const d = fallbackDispatch("The breaker keeps tripping.", ctx);
    expect(d.siteId).toBeNull();
    expect(d.missingInfo).toEqual(["Which site is this for?"]);
    expect(d.priority).toBe("high");
  });
});

describe("runDispatchAgent", () => {
  const input = { text: "Store 1 parking lot lights are out, safety issue.", siteHintId: null, actorId: ids.coordinator, trigger: "test" };

  it("stores a pending AI draft and logs the run", async () => {
    const r = await runDispatchAgent(db, input, { models: models(mockLanguage(good())), now });
    expect(r.mode).toBe("ai");
    const [row] = await db.select().from(dispatchDrafts);
    expect(row).toMatchObject({ status: "pending", mode: "ai", createdBy: ids.coordinator });
    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ agent: "dispatch_agent", status: "ok", subjectId: r.draftId, tokensIn: 300 });
  });

  it("falls back without a key, on errors and on invalid output", async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("timeout"); } });
    for (const m of [models(), models(broken), models(mockLanguage({ title: 1 }))]) {
      const r = await runDispatchAgent(db, input, { models: m, now });
      expect(r.mode).toBe("fallback");
      expect(r.draft.reasoning).toMatch(/^Rule-based draft/);
    }
    expect((await db.select().from(agentRuns)).map((r) => r.status)).toEqual(["fallback", "fallback", "fallback"]);
  });
});

describe("decisions", () => {
  it("approve creates the task through an event (source dispatch_agent) exactly once", async () => {
    const r = await runDispatchAgent(db, { text: "Store 1 lights out", siteHintId: null, actorId: ids.coordinator, trigger: "test" }, { models: models(mockLanguage(good())), now });
    const a = await approveDraft(db, { draftId: r.draftId, actorId: ids.coordinator, edits: { title: "Lot lights out (edited)" }, deviceId: "web-test" }, { now, process });
    expect(a).toEqual({ ok: true, taskId: r.draftId });
    const [t] = await db.select().from(tasks);
    expect(t).toMatchObject({ source: "dispatch_agent", assigneeId: ids.techB, siteId: ids.siteRollout, title: "Lot lights out (edited)", createdBy: ids.coordinator });

    const again = await approveDraft(db, { draftId: r.draftId, actorId: ids.coordinator, edits: {}, deviceId: "web-test" }, { now, process });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(await db.select().from(tasks)).toHaveLength(1);
  });

  it("a refused event leaves the draft pending (e.g. a technician cannot assign others)", async () => {
    const r = await runDispatchAgent(db, { text: "Store 1 lights out", siteHintId: null, actorId: ids.coordinator, trigger: "test" }, { models: models(mockLanguage(good())), now });
    const a = await approveDraft(db, { draftId: r.draftId, actorId: ids.techA, edits: {}, deviceId: "web-test" }, { now, process });
    expect(a).toMatchObject({ ok: false, error: "forbidden" });
    const [row] = await db.select().from(dispatchDrafts);
    expect(row.status).toBe("pending");
  });

  it("approve needs a site", async () => {
    const r = await runDispatchAgent(db, { text: "breaker trips", siteHintId: null, actorId: ids.coordinator, trigger: "test" }, { models: models(), now });
    expect(await approveDraft(db, { draftId: r.draftId, actorId: ids.coordinator, edits: {}, deviceId: "w" }, { now, process })).toMatchObject({ ok: false, status: 422 });
    const ok = await approveDraft(db, { draftId: r.draftId, actorId: ids.coordinator, edits: { siteId: ids.siteB }, deviceId: "w" }, { now, process });
    expect(ok.ok).toBe(true);
  });

  it("reject stores the reason and blocks a later approval", async () => {
    const r = await runDispatchAgent(db, { text: "Store 1 lights out", siteHintId: null, actorId: ids.coordinator, trigger: "test" }, { models: models(), now });
    expect(await rejectDraft(db, { draftId: r.draftId, actorId: ids.manager, reason: "Duplicate of yesterday's call" }, NOW)).toEqual({ ok: true, taskId: null });
    const [row] = await db.select().from(dispatchDrafts);
    expect(row).toMatchObject({ status: "rejected", rejectReason: "Duplicate of yesterday's call", decidedBy: ids.manager });
    expect(await approveDraft(db, { draftId: r.draftId, actorId: ids.coordinator, edits: {}, deviceId: "w" }, { now, process })).toMatchObject({ ok: false, status: 409 });
  });
});
