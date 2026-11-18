// Ops copilot: plain-language questions over live data, answered with
// READ-ONLY tools. Each tool runs a fixed, parameterized query (no free-form
// SQL) scoped to the caller's role, and returns the records it used with
// links, so every answer can be checked. There is no write tool.
import { generateText, isStepCount, tool, type ToolSet } from "ai";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { BRANCH_TIMEZONE, ROLLOUT_STAGE_EXPECTED_DAYS } from "../config";
import { people, sites, timeEntries } from "../db/schema";
import { isFieldRole, isOfficeRole, ROLLOUT_STAGES, TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES, type Role } from "../domain";
import { derive } from "../office/derive";
import { loadSnapshot } from "../office/queries";
import { agoLabel, behindSchedule, entryFlags, FLAG_LABEL, stageAgeDays, STAGE_LABEL } from "../office/rules";
import type { Db } from "../sync/store-drizzle";
import { formatInZone } from "../time";
import { MAX_OUTPUT_TOKENS, modelsFromEnv, readUsage, withFallback, type AgentModels } from "./ai";
import { tokenCostUsd } from "./pricing";
import { finishRun, startRun } from "./runs";

export const COPILOT_AGENT = "ops_copilot" as const;
/** Tool-call steps per question (each model call or tool round is a step). */
export const COPILOT_MAX_STEPS = 5;

export const COPILOT_EXAMPLES = [
  "Who is at the hospital job and what's blocked?",
  "Which rollout stores are behind?",
  "Who hasn't acknowledged urgent tasks today?",
] as const;

export type Citation = { kind: "task" | "site" | "person"; id: string; label: string; href: string };
export const linkFor = (kind: Citation["kind"], id: string) =>
  kind === "task" ? `/office/tasks?task=${id}` : kind === "site" ? `/office/tasks?site=${id}` : `/office/tasks?assignee=${id}`;

export type CopilotActor = { id: string; role: Role };

/** Which tools a role gets. HR has no rollouts (as in the dashboard); field roles only their own work. */
export const TOOLS_BY_ROLE: Record<Role, readonly string[]> = {
  coordinator: ["listSites", "getSiteStatus", "listTasks", "getWorker", "getRolloutStatus", "getTimesheetFlags"],
  manager: ["listSites", "getSiteStatus", "listTasks", "getWorker", "getRolloutStatus", "getTimesheetFlags"],
  hr: ["listSites", "getSiteStatus", "listTasks", "getWorker", "getTimesheetFlags"],
  technician: ["listSites", "getSiteStatus", "listTasks", "getWorker"],
  foreman: ["listSites", "getSiteStatus", "listTasks", "getWorker"],
};

/** Words people use for a site that are not in its name ("the hospital job"). */
const SITE_SYNONYMS: Record<string, string[]> = {
  hospital: ["medical", "health", "clinic"],
  medical: ["hospital"],
  clinic: ["medical"],
  shop: ["store", "goods"],
};

const fmt = (d: string | Date | null) => (d ? formatInZone(d, BRANCH_TIMEZONE) : null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/**
 * The data layer behind the tools: one snapshot (the dashboard's query) per
 * question, filtered by role. Field roles only ever see their own tasks, the
 * sites they work at and themselves (same rule as the sync pull).
 */
export function copilotData(db: Db, actor: CopilotActor, now: Date) {
  let snapPromise: ReturnType<typeof load> | null = null;
  async function load() {
    // JSON round trip: the same shape (dates as strings) the dashboard's derive() gets.
    const s = JSON.parse(JSON.stringify(await loadSnapshot(db, now))) as Json<Awaited<ReturnType<typeof loadSnapshot>>>;
    if (isOfficeRole(actor.role)) return s;
    const tasks = s.tasks.filter((t) => t.assigneeId === actor.id || t.createdBy === actor.id);
    const siteIds = new Set([...tasks.map((t) => t.siteId), ...s.openEntries.filter((e) => e.personId === actor.id).map((e) => e.siteId)]);
    return {
      ...s,
      tasks,
      receipts: s.receipts.filter((r) => tasks.some((t) => t.id === r.taskId)),
      sites: s.sites.filter((x) => siteIds.has(x.id)),
      openEntries: s.openEntries.filter((e) => e.personId === actor.id),
      statuses: s.statuses.filter((x) => x.personId === actor.id),
      lastSync: s.lastSync.filter((x) => x.personId === actor.id),
    };
  }
  const snap = () => (snapPromise ??= load());
  const view = async () => {
    const s = await snap();
    return { s, d: derive(s) };
  };
  const findSite = (s: Awaited<ReturnType<typeof snap>>, q: { siteId?: string; name?: string }) => {
    if (q.siteId) return s.sites.find((x) => x.id === q.siteId) ?? null;
    if (!q.name) return null;
    const n = norm(q.name);
    const num = n.match(/\d{2,4}/)?.[0];
    return (
      s.sites.find((x) => norm(x.name) === n) ??
      (num ? s.sites.find((x) => new RegExp(`#${num}\\b`).test(x.name)) : undefined) ??
      s.sites.find((x) => norm(x.name).includes(n)) ??
      s.sites.find((x) =>
        n
          .split(" ")
          .filter((w) => w.length > 3)
          .flatMap((w) => [w, ...(SITE_SYNONYMS[w] ?? [])])
          .some((w) => norm(x.name).includes(w)),
      ) ??
      null
    );
  };
  return { snap, view, findSite };
}

/** JSON over the wire: Dates become strings. */
type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

type TaskRow = { id: string; title: string; status: string; priority: string; kind: string; siteId: string; assigneeId: string; dueAt: string | null };

/** Builds the role-scoped, read-only tool set. `cite` collects every record a tool returned. */
export function copilotTools(db: Db, actor: CopilotActor, now: Date, cite: (c: Citation) => void): ToolSet {
  const data = copilotData(db, actor, now);
  const allowed = new Set(TOOLS_BY_ROLE[actor.role]);

  const taskOut = (t: TaskRow, d: Awaited<ReturnType<typeof data.view>>["d"]) => {
    cite({ kind: "task", id: t.id, label: t.title, href: linkFor("task", t.id) });
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      kind: t.kind,
      site: d.site.get(t.siteId)?.name ?? null,
      assignee: d.person.get(t.assigneeId)?.name ?? null,
      due: fmt(t.dueAt),
      receipt: d.stageOf(t as never),
      overdue: d.inView(t as never, "overdue"),
      link: linkFor("task", t.id),
    };
  };
  const personOut = (id: string, d: Awaited<ReturnType<typeof data.view>>["d"]) => {
    const p = d.person.get(id);
    if (p) cite({ kind: "person", id, label: p.name, href: linkFor("person", id) });
    return p ? { id, name: p.name, link: linkFor("person", id) } : null;
  };
  const siteOut = (id: string, name: string) => {
    cite({ kind: "site", id, label: name, href: linkFor("site", id) });
    return { id, name, link: linkFor("site", id) };
  };

  const all: ToolSet = {
    listSites: tool({
      description: "List sites (jobs, service accounts, rollout stores) with open task and clocked-in counts. Use it to find a site id by name.",
      inputSchema: z.object({ kind: z.enum(["construction", "service", "rollout_store"]).optional() }),
      execute: async ({ kind }) => {
        const { s, d } = await data.view();
        return s.sites
          .filter((x) => !kind || x.kind === kind)
          .map((x) => ({
            ...siteOut(x.id, x.name),
            kind: x.kind,
            stage: x.rolloutStage ? STAGE_LABEL[x.rolloutStage] : null,
            openTasks: d.open.filter((t) => t.siteId === x.id).length,
            clockedIn: s.openEntries.filter((e) => e.siteId === x.id).length,
          }));
      },
    }),
    getSiteStatus: tool({
      description: "Who is clocked in at a site and its open tasks (blocked, overdue, not acknowledged). Pass siteId or a name such as 'hospital' or 'Store 106'.",
      inputSchema: z.object({ siteId: z.string().optional(), name: z.string().max(100).optional() }),
      execute: async (q) => {
        const { s, d } = await data.view();
        const site = data.findSite(s, q);
        if (!site) return { error: "No site matches (or it is outside what you can see)." };
        return {
          site: { ...siteOut(site.id, site.name), kind: site.kind, address: site.address, stage: site.rolloutStage ? STAGE_LABEL[site.rolloutStage] : null },
          clockedIn: s.openEntries
            .filter((e) => e.siteId === site.id)
            .map((e) => ({ ...personOut(e.personId, d), since: fmt(e.clockInAt) })),
          openTasks: d.open.filter((t) => t.siteId === site.id).map((t) => taskOut(t, d)),
        };
      },
    }),
    listTasks: tool({
      description: "Open tasks matching filters (all filters optional). unacknowledged = the assignee has not tapped 'Got it'.",
      inputSchema: z.object({
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        kind: z.enum(TASK_KINDS).optional(),
        siteId: z.string().optional(),
        assigneeId: z.string().optional(),
        unacknowledged: z.boolean().optional(),
        overdue: z.boolean().optional(),
        createdToday: z.boolean().optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async (f) => {
        const { s, d } = await data.view();
        const today = formatInZone(now, BRANCH_TIMEZONE, { year: "numeric", month: "2-digit", day: "2-digit" });
        const rows = (f.status && ["done", "cancelled"].includes(f.status) ? s.tasks : d.open)
          .filter((t) => !f.status || t.status === f.status)
          .filter((t) => !f.priority || t.priority === f.priority)
          .filter((t) => !f.kind || t.kind === f.kind)
          .filter((t) => !f.siteId || t.siteId === f.siteId)
          .filter((t) => !f.assigneeId || t.assigneeId === f.assigneeId)
          .filter((t) => f.unacknowledged === undefined || d.inView(t, "unacked") === f.unacknowledged)
          .filter((t) => f.overdue === undefined || d.inView(t, "overdue") === f.overdue)
          .filter((t) => !f.createdToday || formatInZone(t.createdAt, BRANCH_TIMEZONE, { year: "numeric", month: "2-digit", day: "2-digit" }) === today);
        return { total: rows.length, tasks: rows.slice(0, f.limit ?? 15).map((t) => taskOut(t, d)) };
      },
    }),
    getWorker: tool({
      description: "One field worker: where they are clocked in, their status, last sync and open tasks. Pass personId or a name.",
      inputSchema: z.object({ personId: z.string().optional(), name: z.string().max(100).optional() }),
      execute: async (q) => {
        const { s, d } = await data.view();
        const visible = isOfficeRole(actor.role) ? s.people : s.people.filter((p) => p.id === actor.id);
        const p = q.personId ? visible.find((x) => x.id === q.personId) : visible.find((x) => q.name && norm(x.name).includes(norm(q.name)));
        if (!p) return { error: "No person matches (or it is outside what you can see)." };
        const entry = d.openEntry.get(p.id);
        return {
          person: { ...personOut(p.id, d), role: p.role, trade: p.trade, active: p.active },
          clockedInAt: entry ? { ...siteOut(entry.siteId, d.site.get(entry.siteId)?.name ?? "?"), since: fmt(entry.clockInAt) } : null,
          status: d.status.get(p.id)?.status ?? null,
          lastSynced: agoLabel(d.lastSync.get(p.id) ?? null, d.now),
          openTasks: d.open.filter((t) => t.assigneeId === p.id).map((t) => taskOut(t, d)),
        };
      },
    }),
    getRolloutStatus: tool({
      description: "Rollout stores by stage, days in stage and whether they are behind schedule.",
      inputSchema: z.object({ behindOnly: z.boolean().optional(), stage: z.enum(ROLLOUT_STAGES).optional() }),
      execute: async (q) => {
        const { s } = await data.view();
        const stores = s.sites
          .filter((x) => x.kind === "rollout_store" && x.rolloutStage)
          .map((x) => ({
            x,
            days: stageAgeDays(x.stageChangedAt, new Date(s.now)),
            behind: behindSchedule(x, new Date(s.now)).behind,
          }))
          .filter((r) => (!q.behindOnly || r.behind) && (!q.stage || r.x.rolloutStage === q.stage));
        return stores.map((r) => ({
          ...siteOut(r.x.id, r.x.name),
          stage: STAGE_LABEL[r.x.rolloutStage!],
          daysInStage: r.days,
          expectedDays: ROLLOUT_STAGE_EXPECTED_DAYS[r.x.rolloutStage!],
          behind: r.behind,
        }));
      },
    }),
    getTimesheetFlags: tool({
      description: "Time entries of the last N days that need HR review: outside the geofence, no location, or missing clock-out.",
      inputSchema: z.object({ days: z.number().int().min(1).max(14).optional() }),
      execute: async ({ days }) => {
        const since = new Date(now.getTime() - (days ?? 7) * 86_400_000);
        const rows = await db
          .select({ e: timeEntries, person: people.name, site: sites.name })
          .from(timeEntries)
          .innerJoin(people, eq(people.id, timeEntries.personId))
          .innerJoin(sites, eq(sites.id, timeEntries.siteId))
          .where(
            and(
              gte(timeEntries.clockInAt, since),
              isNull(timeEntries.reviewStatus),
              or(eq(timeEntries.flagged, true), isNull(timeEntries.clockOutAt)),
              isFieldRole(actor.role) ? eq(timeEntries.personId, actor.id) : undefined,
            ),
          )
          .orderBy(desc(timeEntries.clockInAt))
          .limit(25);
        return rows
          .map((r) => ({ r, flags: entryFlags(r.e, now) }))
          .filter((x) => x.flags.length)
          .map(({ r, flags }) => {
            cite({ kind: "person", id: r.e.personId, label: r.person, href: linkFor("person", r.e.personId) });
            return {
              person: r.person,
              personLink: linkFor("person", r.e.personId),
              site: r.site,
              clockIn: fmt(r.e.clockInAt),
              clockOut: fmt(r.e.clockOutAt),
              flags: flags.map((f) => FLAG_LABEL[f]),
              timesheetsLink: "/office/timesheets",
            };
          });
      },
    }),
  };
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name)));
}

const SYSTEM = `You are the operations copilot of Demo Electrical Co. (an electrical contractor), used by office staff.
Answer from tool results only, using your tools to look things up. If the tools return nothing relevant, say so plainly. Never guess.
Be brief: a sentence or two, then a short list if needed. Cite every task, site or person you mention as a markdown link using the "link" field from the tool result, e.g. [Panel swap](/office/tasks?task=...).
You can only read. You cannot assign, change, send or approve anything: if asked, say the coordinator must do it in the dashboard.`;

export type CopilotAnswer = {
  answer: string;
  citations: Citation[];
  mode: "ai" | "fallback";
  steps: number;
  runId: string | null;
  toolCalls: string[];
};

/** Rule-based answers when the model is unavailable: route the question to one tool by keywords. */
export async function fallbackAnswer(question: string, tools: ToolSet): Promise<{ answer: string; toolCalls: string[] }> {
  const q = question.toLowerCase();
  const call = async (name: string, input: Record<string, unknown>) =>
    tools[name]?.execute ? ((await tools[name].execute!(input as never, { toolCallId: "fallback", messages: [] } as never)) as unknown) : null;
  const md = (rows: { title?: string; name?: string; link: string; extra?: string }[]) =>
    rows.length ? rows.map((r) => `- [${r.title ?? r.name}](${r.link})${r.extra ? ` (${r.extra})` : ""}`).join("\n") : "- none";

  if (/behind|rollout|stores?\b/.test(q) && tools.getRolloutStatus) {
    const rows = (await call("getRolloutStatus", { behindOnly: true })) as { name: string; link: string; stage: string; daysInStage: number | null }[];
    return { answer: `Rollout stores behind schedule:\n${md(rows.map((r) => ({ ...r, extra: `${r.stage}, ${r.daysInStage} days in stage` })))}`, toolCalls: ["getRolloutStatus"] };
  }
  if (/acknowledg|got it|unacked/.test(q)) {
    const urgent = /urgent/.test(q);
    const r = (await call("listTasks", { unacknowledged: true, ...(urgent ? { priority: "urgent" } : {}) })) as { tasks: { title: string; link: string; assignee: string | null }[] };
    return { answer: `${urgent ? "Urgent tasks" : "Tasks"} not acknowledged yet:\n${md(r.tasks.map((t) => ({ ...t, extra: t.assignee ?? "" })))}`, toolCalls: ["listTasks"] };
  }
  if (/timesheet|clock.?out|geofence|flag/.test(q) && tools.getTimesheetFlags) {
    const rows = (await call("getTimesheetFlags", {})) as { person: string; personLink: string; site: string; flags: string[] }[];
    return { answer: `Time entries that need review:\n${md(rows.map((r) => ({ name: r.person, link: r.personLink, extra: `${r.site}: ${r.flags.join(", ")}` })))}`, toolCalls: ["getTimesheetFlags"] };
  }
  const siteWord = q.match(/(?:at|on|for)\s+(?:the\s+)?([a-z0-9# ]+?)(?:\s+(?:job|site|store))?(?:\s+and\b|\?|$)/)?.[1] ?? q.match(/store\s*#?\s*\d+/)?.[0];
  if (siteWord) {
    const r = (await call("getSiteStatus", { name: siteWord })) as { error?: string; site?: { name: string; link: string }; clockedIn?: { name: string; link: string; since: string }[]; openTasks?: { title: string; link: string; status: string; assignee: string | null }[] };
    if (r && !r.error && r.site) {
      const blocked = (r.openTasks ?? []).filter((t) => t.status === "blocked");
      return {
        answer: `[${r.site.name}](${r.site.link}):\nClocked in:\n${md((r.clockedIn ?? []).map((p) => ({ ...p, extra: `since ${p.since}` })))}\nBlocked:\n${md(blocked.map((t) => ({ ...t, extra: t.assignee ?? "" })))}\nOpen tasks: ${(r.openTasks ?? []).length}`,
        toolCalls: ["getSiteStatus"],
      };
    }
  }
  if (/blocked/.test(q)) {
    const r = (await call("listTasks", { status: "blocked" })) as { tasks: { title: string; link: string; site: string | null }[] };
    return { answer: `Blocked tasks:\n${md(r.tasks.map((t) => ({ ...t, extra: t.site ?? "" })))}`, toolCalls: ["listTasks"] };
  }
  if (/overdue|late/.test(q)) {
    const r = (await call("listTasks", { overdue: true })) as { tasks: { title: string; link: string; assignee: string | null }[] };
    return { answer: `Overdue tasks:\n${md(r.tasks.map((t) => ({ ...t, extra: t.assignee ?? "" })))}`, toolCalls: ["listTasks"] };
  }
  return {
    answer: "I can answer questions about sites, tasks, workers, rollouts and timesheet flags. Try one of the examples (blocked work at a site, stores behind schedule, unacknowledged urgent tasks).",
    toolCalls: [],
  };
}

export async function askCopilot(
  db: Db,
  input: { question: string; actor: CopilotActor; now: Date; trigger?: string },
  deps: { models?: AgentModels; real?: () => Date } = {},
): Promise<CopilotAnswer> {
  const models = deps.models ?? modelsFromEnv();
  const real = deps.real ?? (() => new Date());
  const cited = new Map<string, Citation>();
  const cite = (c: Citation) => cited.set(`${c.kind}:${c.id}`, c);
  const tools = copilotTools(db, input.actor, input.now, cite);
  const runId = await startRun(db, {
    agent: COPILOT_AGENT,
    trigger: input.trigger ?? "office",
    actorId: input.actor.id,
    inputSummary: input.question.slice(0, 300),
    input: { question: input.question, role: input.actor.role, tools: Object.keys(tools) },
    now: real(),
  });
  let toolCalls: string[] = [];
  let steps = 0;
  const r = await withFallback<string>({
    model: models.language,
    missing: "ANTHROPIC_API_KEY not set",
    ai: async (signal) => {
      const res = await generateText({
        model: models.language!,
        providerOptions: models.providerOptions,
        system: `${SYSTEM}\nNow: ${formatInZone(input.now, BRANCH_TIMEZONE, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (branch time). Asker's role: ${input.actor.role}.`,
        prompt: input.question,
        tools,
        stopWhen: isStepCount(COPILOT_MAX_STEPS),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        abortSignal: signal,
      });
      steps = res.steps.length;
      toolCalls = res.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
      if (!res.text.trim()) throw new Error(`no answer after ${steps} steps (step limit ${COPILOT_MAX_STEPS})`);
      return { value: res.text.trim(), usage: readUsage(res.totalUsage) };
    },
    fallback: async () => {
      cited.clear();
      const f = await fallbackAnswer(input.question, tools);
      toolCalls = f.toolCalls;
      return f.answer;
    },
  });
  const citations = [...cited.values()];
  const out: CopilotAnswer = { answer: r.value, citations, mode: r.mode, steps, runId, toolCalls };
  if (runId) {
    await finishRun(db, runId, {
      status: r.mode === "ai" ? "ok" : "fallback",
      output: { answer: r.value, toolCalls, citations: citations.length },
      model: r.mode === "ai" ? models.languageId : null,
      tokensIn: r.usage?.inputTokens ?? null,
      tokensOut: r.usage?.outputTokens ?? null,
      latencyMs: r.latencyMs,
      costUsd: r.usage ? tokenCostUsd(models.languageId, r.usage.inputTokens, r.usage.outputTokens) : null,
      error: r.error,
      notes: toolCalls.length ? [`tools: ${toolCalls.join(", ")}`] : [],
      now: real(),
    });
  }
  return out;
}
