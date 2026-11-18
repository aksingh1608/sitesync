// Digest agent (numbers match the dashboard, the anti-invention check, the
// template fallback) and ops copilot (role scoping per tool, no write tool,
// tool calling with a mocked model, fallback answers). No real API calls.
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askCopilot, copilotTools, fallbackAnswer, TOOLS_BY_ROLE, type Citation } from "@/lib/agents/copilot";
import { checkNarrative, computeDigestNumbers, generateDigest, listDigests, numbersIn, templateNarrative } from "@/lib/agents/digest";
import { agentRuns } from "@/lib/db/schema";
import { ROLES } from "@/lib/domain";
import { derive } from "@/lib/office/derive";
import { loadSnapshot } from "@/lib/office/queries";
import type { Db } from "@/lib/sync/store-drizzle";
import { dayKey } from "@/lib/time";
import { mockLanguage, models } from "./agent-mocks";
import { ids, makeDb, NOW, sync, uuid } from "./helpers";

let db: Db;
let close: () => Promise<void>;
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();
const DAY = dayKey(NOW, "America/New_York");
const t = { blocked: uuid(), urgent: uuid(), done: uuid(), other: uuid() };

beforeEach(async () => {
  ({ db, close } = await makeDb());
  const mk = (taskId: string, title: string, extra: Record<string, unknown>) => ({
    id: uuid(), type: "task.created", actorId: ids.coordinator, deviceId: "d", clientTs: at(300),
    payload: { taskId, title, siteId: ids.siteA, assigneeId: ids.techA, ...extra },
  });
  await sync(db, ids.coordinator, [
    mk(t.blocked, "Pull feeders to panel B", {}),
    mk(t.urgent, "Exposed junction box", { priority: "urgent" }),
    mk(t.done, "Label circuits", {}),
    mk(t.other, "Store 1 relamp", { siteId: ids.siteRollout, assigneeId: ids.techB }),
  ]);
  await sync(db, ids.techA, [
    { id: uuid(), type: "task.acknowledged", actorId: ids.techA, deviceId: "p", clientTs: at(200), payload: { taskId: t.blocked } },
    { id: uuid(), type: "task.status_changed", actorId: ids.techA, deviceId: "p", clientTs: at(100), payload: { taskId: t.blocked, to: "blocked", reason: "No panel key" } },
    { id: uuid(), type: "task.status_changed", actorId: ids.techA, deviceId: "p", clientTs: at(90), payload: { taskId: t.done, to: "done" } },
    { id: uuid(), type: "time.clock_in", actorId: ids.techA, deviceId: "p", clientTs: at(240), payload: { timeEntryId: uuid(), siteId: ids.siteA, lat: 40.7505, lng: -73.8472, accuracyM: 10 } },
  ]);
});
afterEach(async () => close());

describe("digest numbers", () => {
  it("match the dashboard's own counts (same snapshot + derive)", async () => {
    const n = await computeDigestNumbers(db, DAY, NOW);
    const d = derive(JSON.parse(JSON.stringify(await loadSnapshot(db, NOW))));
    expect(n.branch).toMatchObject({
      blocked: d.counts.blocked,
      overdue: d.counts.overdue,
      notAcknowledged: d.counts.unacked,
      openMaterialRequests: d.counts.materials,
      clockedInNow: d.counts.clockedIn,
    });
    expect(n.branch).toMatchObject({ completed: 1, blocked: 1, notAcknowledged: 2, clockedInNow: 1, hoursWorked: 4 });
    expect(n.sites.map((s) => s.name).sort()).toEqual(["Site A", "Store 1"]);
  });
});

describe("number check", () => {
  it("finds numbers that are not in the data", async () => {
    const n = await computeDigestNumbers(db, DAY, NOW);
    expect(numbersIn("3 tasks, 4.5 hours at #106")).toEqual([3, 4.5, 106]);
    expect(checkNarrative("1 task completed; 1 blocked; 2 not acknowledged; 4 hours at Store 1.", n)).toEqual([]);
    expect(checkNarrative("17 tasks completed, up 25% on yesterday.", n)).toEqual([17, 25]);
    // The template only ever uses the data's own numbers.
    const tpl = templateNarrative(n);
    expect(checkNarrative([tpl.branch, ...tpl.sites.map((s) => s.summary), ...tpl.highlights].join(" "), n)).toEqual([]);
  });

  it("an invented number makes the digest use the template (and the run is logged as fallback)", async () => {
    const lying = mockLanguage({ branch: "12 tasks completed today across 9 sites.", sites: [], highlights: [] });
    const out = await generateDigest(db, { day: DAY, now: NOW, trigger: "test" }, { models: models(lying) });
    expect(out.content.mode).toBe("fallback");
    expect(out.content.check).toEqual({ ok: false, offending: [12, 9] });
    expect(out.content.narrative.branch).toMatch(/^Branch summary for/);
    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ status: "fallback", tokensIn: 300 });
    expect(run.notes?.[0]).toMatch(/number check failed/);
  });

  it("a truthful narrative is kept and stored", async () => {
    const honest = mockLanguage({ branch: "1 task completed and 1 blocked at Site A; 2 tasks are not acknowledged yet.", sites: [{ ref: "S1", summary: "1 blocked task." }], highlights: ["Unblock the feeder pull."] });
    const out = await generateDigest(db, { day: DAY, now: NOW, trigger: "test" }, { models: models(honest) });
    expect(out.content.mode).toBe("ai");
    expect(out.content.narrative.sites).toHaveLength(1);
    const list = await listDigests(db);
    expect(list[0]).toMatchObject({ day: DAY, id: out.id });
  });

  it("without a key: template, nothing crashes", async () => {
    const out = await generateDigest(db, { day: DAY, now: NOW, trigger: "test" }, { models: models() });
    expect(out.content.mode).toBe("fallback");
    expect(out.content.narrative.branch).toContain("1 tasks completed today".replace("tasks", "tasks"));
  });
});

describe("copilot tools", () => {
  const noop = () => {};
  const exec = async (tools: Awaited<ReturnType<typeof copilotTools>>, name: string, input: object) =>
    (await tools[name].execute!(input as never, { toolCallId: "t", messages: [] } as never)) as never;

  it("has no write tool for any role", () => {
    for (const role of ROLES) {
      const names = Object.keys(copilotTools(db, { id: ids.coordinator, role }, NOW, noop));
      expect(names).toEqual([...TOOLS_BY_ROLE[role]]);
      for (const n of names) expect(n).toMatch(/^(list|get)/);
    }
  });

  it("HR gets no rollout tool; coordinators and managers do", () => {
    expect(copilotTools(db, { id: ids.coordinator, role: "hr" }, NOW, noop).getRolloutStatus).toBeUndefined();
    expect(copilotTools(db, { id: ids.coordinator, role: "coordinator" }, NOW, noop).getRolloutStatus).toBeDefined();
  });

  it("scopes every tool to the caller: a technician sees only their own work", async () => {
    const tech = copilotTools(db, { id: ids.techB, role: "technician" }, NOW, noop);
    const office = copilotTools(db, { id: ids.coordinator, role: "coordinator" }, NOW, noop);
    const mine = (await exec(tech, "listTasks", {})) as { tasks: { title: string }[] };
    expect(mine.tasks.map((x) => x.title)).toEqual(["Store 1 relamp"]);
    expect(((await exec(office, "listTasks", {})) as { total: number }).total).toBe(3);
    expect(((await exec(tech, "listSites", {})) as { name: string }[]).map((s) => s.name)).toEqual(["Store 1"]);
    expect(await exec(tech, "getSiteStatus", { name: "Site A" })).toMatchObject({ error: expect.any(String) });
    expect(await exec(tech, "getWorker", { name: "Tess" })).toMatchObject({ error: expect.any(String) });
    expect(await exec(office, "getWorker", { name: "Tess" })).toMatchObject({ person: { name: "Tess Tech" } });
  });

  it("tools never write: running every tool leaves the database unchanged", async () => {
    const before = JSON.stringify(await loadSnapshot(db, NOW));
    const cited: Citation[] = [];
    const tools = copilotTools(db, { id: ids.manager, role: "manager" }, NOW, (c) => cited.push(c));
    for (const [name, input] of Object.entries({ listSites: {}, getSiteStatus: { name: "Site A" }, listTasks: { status: "blocked" }, getWorker: { name: "Tess" }, getRolloutStatus: {}, getTimesheetFlags: {} })) {
      await exec(tools, name, input);
    }
    expect(JSON.stringify(await loadSnapshot(db, NOW))).toBe(before);
    expect(cited.some((c) => c.kind === "task" && c.href === `/office/tasks?task=${t.blocked}`)).toBe(true);
  });

  it("fallback routes questions to the right tool with links", async () => {
    const tools = copilotTools(db, { id: ids.coordinator, role: "coordinator" }, NOW, noop);
    const blocked = await fallbackAnswer("Who is at Site A and what's blocked?", tools);
    expect(blocked.toolCalls).toEqual(["getSiteStatus"]);
    expect(blocked.answer).toContain(`[Pull feeders to panel B](/office/tasks?task=${t.blocked})`);
    expect(blocked.answer).toContain(`[Tess Tech](/office/tasks?assignee=${ids.techA})`);
    const unacked = await fallbackAnswer("Who hasn't acknowledged urgent tasks today?", tools);
    expect(unacked.answer).toContain("Exposed junction box");
    expect(unacked.answer).not.toContain("Label circuits");
    expect((await fallbackAnswer("Which rollout stores are behind?", tools)).toolCalls).toEqual(["getRolloutStatus"]);
  });
});

describe("askCopilot", () => {
  it("calls tools through the model, answers with links and logs the run", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      modelId: "claude-opus-5-5",
      doGenerate: async () => {
        call++;
        const usage = { inputTokens: { total: 500, noCache: 500, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 50, text: 50, reasoning: undefined } };
        if (call === 1) {
          return { content: [{ type: "tool-call", toolCallId: "c1", toolName: "listTasks", input: JSON.stringify({ status: "blocked" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] };
        }
        return { content: [{ type: "text", text: `One task is blocked: [Pull feeders to panel B](/office/tasks?task=${t.blocked}).` }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    const out = await askCopilot(db, { question: "What's blocked?", actor: { id: ids.coordinator, role: "coordinator" }, now: NOW }, { models: models(model) });
    expect(out).toMatchObject({ mode: "ai", steps: 2, toolCalls: ["listTasks"] });
    expect(out.answer).toContain(t.blocked);
    expect(out.citations.map((c) => c.id)).toContain(t.blocked);
    const [run] = await db.select().from(agentRuns);
    expect(run).toMatchObject({ agent: "ops_copilot", status: "ok", tokensIn: 1000, tokensOut: 100 });
  });

  it("stops after the step limit and falls back (never loops forever)", async () => {
    let calls = 0;
    const looping = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "tool-call", toolCallId: `c${calls}`, toolName: "listSites", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
          warnings: [],
        };
      },
    });
    const out = await askCopilot(db, { question: "What's blocked?", actor: { id: ids.coordinator, role: "coordinator" }, now: NOW }, { models: models(looping) });
    expect(calls).toBe(5);
    expect(out.mode).toBe("fallback");
    expect(out.answer).toMatch(/Blocked tasks/);
  });

  it("without a key it answers by rules", async () => {
    const out = await askCopilot(db, { question: "Which rollout stores are behind?", actor: { id: ids.manager, role: "manager" }, now: NOW }, { models: models() });
    expect(out.mode).toBe("fallback");
    expect(out.answer).toMatch(/^Rollout stores behind schedule/);
  });
});
