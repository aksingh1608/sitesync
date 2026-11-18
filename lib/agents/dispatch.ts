// Dispatch agent: a free-text service request (e.g. a pasted customer email)
// -> a draft work order for a coordinator to approve. It never assigns work by
// itself: the draft waits in the "Dispatch drafts" inbox; Approve creates the
// task through a normal task.created event (source dispatch_agent).
//
// The model sees short refs (S1, P2) instead of UUIDs, so it cannot invent an
// id that looks valid; every ref, the assignee's activity and trade are
// checked afterwards and anything invalid is dropped (and noted).
import { generateText, Output } from "ai";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { BRANCH_TIMEZONE } from "../config";
import { dispatchDrafts, people, rollouts, sites, tasks, timeEntries } from "../db/schema";
import { isFieldRole, TASK_KINDS, TASK_PRIORITIES, TRADES, type Role, type TaskKind, type TaskPriority, type Trade } from "../domain";
import { suggestAssignees } from "../office/rules";
import type { Db } from "../sync/store-drizzle";
import { formatInZone } from "../time";
import { uuidv4 } from "../uuid";
import { MAX_OUTPUT_TOKENS, modelsFromEnv, readUsage, withFallback, type AgentModels } from "./ai";
import { tokenCostUsd } from "./pricing";
import { finishRun, startRun } from "./runs";

export const DISPATCH_AGENT = "dispatch_agent" as const;

/** Demo button "Inject sample request": fictional requests only. */
export const SAMPLE_REQUESTS = [
  "Store 106 parking lot lights are out, customer says it's a safety issue for staff leaving after dark. Please send someone today.",
  "Hi team, the breaker for the walk-in cooler at Cobble Corner Home Goods keeps tripping since this morning and they're worried about the stock. Can someone come out? Thanks, Jordan (store manager)",
  "From the GC at Northfield Medical East Wing: we need 4 more duplex receptacles in corridor E-2 before drywall closes on Friday.",
] as const;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
export type DispatchContext = {
  now: Date;
  sites: { ref: string; id: string; name: string; kind: string; address: string; rollout: string | null; stage: string | null }[];
  people: { ref: string; id: string; name: string; role: Role; trade: Trade; active: boolean; clockedInAt: string | null; openTasks: number }[];
  /** Recent tasks at the hinted site (empty without a hint). */
  recent: { title: string; status: string; assignee: string; kind: string }[];
  /** All open tasks (for the rule-based assignee suggestion). */
  openTasks: { assigneeId: string; siteId: string }[];
  siteHintId: string | null;
};

export async function loadDispatchContext(db: Db, siteHintId: string | null, now: Date): Promise<DispatchContext> {
  const [st, ro, ppl, open, entries, recent] = await Promise.all([
    db.select().from(sites).orderBy(sites.name),
    db.select({ id: rollouts.id, name: rollouts.name }).from(rollouts),
    db.select().from(people).where(eq(people.active, true)).orderBy(people.name),
    db
      .select({ assigneeId: tasks.assigneeId, siteId: tasks.siteId })
      .from(tasks)
      .where(inArray(tasks.status, ["open", "in_progress", "blocked"])),
    db.select({ personId: timeEntries.personId, siteId: timeEntries.siteId }).from(timeEntries).where(isNull(timeEntries.clockOutAt)),
    siteHintId
      ? db
          .select({ title: tasks.title, status: tasks.status, assigneeId: tasks.assigneeId, kind: tasks.kind })
          .from(tasks)
          .where(eq(tasks.siteId, siteHintId))
          .orderBy(desc(tasks.createdAt))
          .limit(8)
      : Promise.resolve([]),
  ]);
  const rolloutName = new Map(ro.map((r) => [r.id, r.name]));
  const clocked = new Map(entries.map((e) => [e.personId, e.siteId]));
  const field = ppl.filter((p) => isFieldRole(p.role));
  const name = new Map(ppl.map((p) => [p.id, p.name]));
  return {
    now,
    sites: st.map((s, i) => ({
      ref: `S${i + 1}`,
      id: s.id,
      name: s.name,
      kind: s.kind,
      address: s.address,
      rollout: s.rolloutId ? (rolloutName.get(s.rolloutId) ?? null) : null,
      stage: s.rolloutStage,
    })),
    people: field.map((p, i) => ({
      ref: `P${i + 1}`,
      id: p.id,
      name: p.name,
      role: p.role,
      trade: p.trade,
      active: p.active,
      clockedInAt: clocked.get(p.id) ?? null,
      openTasks: open.filter((t) => t.assigneeId === p.id).length,
    })),
    recent: recent.map((t) => ({ title: t.title, status: t.status, kind: t.kind, assignee: name.get(t.assigneeId) ?? "?" })),
    openTasks: open,
    siteHintId,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
/** What the model returns (refs, not ids). */
export const DispatchModelSchema = z.object({
  siteRef: z.string().nullable().describe("S-ref of the site, or null if no site clearly matches"),
  matchedSiteConfidence: z.number().min(0).max(1),
  kind: z.enum(TASK_KINDS),
  trade: z.enum(TRADES),
  priority: z.enum(TASK_PRIORITIES),
  title: z.string().min(1).max(120),
  description: z.string().max(1000),
  suggestedAssigneeRef: z.string().nullable().describe("P-ref of the best field worker"),
  alternativeAssigneeRefs: z.array(z.string()).max(2),
  dueAt: z.string().nullable().describe("ISO 8601 with offset, or null"),
  reasoning: z.string().max(400).describe("At most 3 short sentences."),
  missingInfo: z.array(z.string().max(160)).max(5),
});
export type DispatchModelOutput = z.infer<typeof DispatchModelSchema>;

/** A validated draft, stored in dispatch_drafts.draft and edited in the inbox. */
export type DispatchDraftFields = {
  siteId: string | null;
  matchedSiteConfidence: number;
  kind: TaskKind;
  trade: Trade;
  priority: TaskPriority;
  title: string;
  description: string;
  suggestedAssigneeId: string | null;
  alternativeAssigneeIds: string[];
  dueAt: string | null;
  reasoning: string;
  missingInfo: string[];
};

const SYSTEM = `You are the dispatch assistant of Demo Electrical Co., an electrical contractor.
Turn a service request into ONE draft work order. A coordinator reviews it before anything is assigned.
Rules: pick a site only if the request clearly names it (store number, site name or address), else null and say so in missingInfo.
Pick field workers whose trade fits (general fits everything); prefer people already at that site, then fewer open tasks.
Priority: urgent for safety hazards or a customer that cannot operate; high for outages; normal otherwise.
Use only refs from the lists. Reasoning: at most 3 short sentences. Do not invent facts.`;

const fits = (p: { trade: Trade }, trade: Trade) => p.trade === trade || p.trade === "general";

/**
 * Validates the model's output against the context: refs must exist, the
 * assignee must be an active field worker whose trade fits, the due date must
 * parse. Invalid parts are dropped (and noted); missing assignees are filled
 * from the rule-based suggestion so the coordinator always has someone to approve.
 */
export function validateDispatch(raw: DispatchModelOutput, ctx: DispatchContext): { draft: DispatchDraftFields; notes: string[] } {
  const notes: string[] = [];
  const siteByRef = new Map(ctx.sites.map((s) => [s.ref, s]));
  const personByRef = new Map(ctx.people.map((p) => [p.ref, p]));

  let site = raw.siteRef ? siteByRef.get(raw.siteRef.trim()) : undefined;
  if (raw.siteRef && !site) notes.push(`site ref "${raw.siteRef}" does not exist: dropped`);
  if (ctx.siteHintId && site?.id !== ctx.siteHintId) {
    if (site) notes.push(`model picked ${site.name}; kept the site chosen on the form`);
    site = ctx.sites.find((s) => s.id === ctx.siteHintId);
  }

  const checkPerson = (ref: string, label: string) => {
    const p = personByRef.get(ref.trim());
    if (!p) return void notes.push(`${label} "${ref}" does not exist: dropped`);
    if (!p.active) return void notes.push(`${label} ${p.name} is inactive: dropped`);
    if (!fits(p, raw.trade)) return void notes.push(`${label} ${p.name} (${p.trade}) does not fit trade ${raw.trade}: dropped`);
    return p;
  };
  let suggested = raw.suggestedAssigneeRef ? checkPerson(raw.suggestedAssigneeRef, "assignee") : undefined;
  const alternatives = raw.alternativeAssigneeRefs
    .map((r) => checkPerson(r, "alternative"))
    .filter((p): p is NonNullable<typeof p> => !!p && p.id !== suggested?.id);

  const ruled = ruleAssignees(ctx, raw.trade, site?.id ?? null);
  if (!suggested) {
    suggested = ctx.people.find((p) => p.id === ruled[0]);
    if (suggested) notes.push(`assignee filled from the rules: ${suggested.name}`);
  }
  const altIds = [...new Set([...alternatives.map((p) => p.id), ...ruled])].filter((id) => id !== suggested?.id).slice(0, 2);

  let dueAt: string | null = null;
  if (raw.dueAt) {
    const t = Date.parse(raw.dueAt);
    if (Number.isNaN(t)) notes.push(`due date "${raw.dueAt}" is not a date: dropped`);
    else if (t < ctx.now.getTime() - 3_600_000 || t > ctx.now.getTime() + 90 * 86_400_000) notes.push(`due date ${raw.dueAt} is out of range: dropped`);
    else dueAt = new Date(t).toISOString();
  }
  const sentences = raw.reasoning.split(/(?<=[.!?])\s+/).filter(Boolean);
  return {
    draft: {
      siteId: site?.id ?? null,
      matchedSiteConfidence: site ? Math.round(raw.matchedSiteConfidence * 100) / 100 : 0,
      kind: raw.kind,
      trade: raw.trade,
      priority: raw.priority,
      title: raw.title.trim().slice(0, 120),
      description: raw.description.trim(),
      suggestedAssigneeId: suggested?.id ?? null,
      alternativeAssigneeIds: altIds,
      dueAt,
      reasoning: sentences.slice(0, 3).join(" "),
      missingInfo: [...raw.missingInfo, ...(site ? [] : ["Which site is this for?"])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5),
    },
    notes,
  };
}

function ruleAssignees(ctx: DispatchContext, trade: Trade, siteId: string | null): string[] {
  return suggestAssignees({
    people: ctx.people,
    trade,
    siteId,
    openTasks: ctx.openTasks,
    clockedInAt: new Map(ctx.people.filter((p) => p.clockedInAt).map((p) => [p.id, p.clockedInAt!])),
  }).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Fallback (rules)
// ---------------------------------------------------------------------------
const STOP = new Set(["the", "and", "for", "with", "service", "account", "store", "east", "west", "north", "south", "wing", "expansion"]);

export function matchSite(text: string, ctx: DispatchContext): { site: DispatchContext["sites"][number] | null; confidence: number; why: string } {
  const lower = text.toLowerCase();
  // 1. A store number ("Store 106", "#106").
  for (const m of lower.matchAll(/(?:store|#|no\.?)\s*#?\s*(\d{2,4})\b/g)) {
    const site = ctx.sites.find((s) => new RegExp(`#${m[1]}\\b`).test(s.name));
    if (site) return { site, confidence: 0.9, why: `store number ${m[1]}` };
  }
  // 2. Distinctive words of a site name.
  let best: { site: DispatchContext["sites"][number]; score: number } | null = null;
  for (const s of ctx.sites) {
    const words = s.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
    const score = words.filter((w) => lower.includes(w)).length;
    if (score > (best?.score ?? 0)) best = { site: s, score };
  }
  if (best && best.score >= 1) return { site: best.site, confidence: best.score >= 2 ? 0.7 : 0.5, why: `name match (${best.score} word${best.score > 1 ? "s" : ""})` };
  return { site: null, confidence: 0, why: "no site named" };
}

export function fallbackDispatch(text: string, ctx: DispatchContext): DispatchDraftFields {
  const lower = text.toLowerCase();
  const hinted = ctx.siteHintId ? ctx.sites.find((s) => s.id === ctx.siteHintId) ?? null : null;
  const m = hinted ? { site: hinted, confidence: 1, why: "chosen on the form" } : matchSite(text, ctx);
  const trade: Trade = /\bev\b|charger|charging/.test(lower)
    ? "ev"
    : /\bsign(s|age)?\b/.test(lower)
      ? "signs"
      : /light|lamp|\bled\b|fixture|bulb/.test(lower)
        ? "lighting"
        : "electrical";
  const safety = /safety|hazard|unsafe|danger|sparks?|smok|shock|exposed|burning|fire/.test(lower);
  const outage = /\bout\b|not working|dead|no power|tripp|down\b|flicker/.test(lower);
  const priority: TaskPriority = safety ? "urgent" : outage ? "high" : "normal";
  const firstSentence = text.trim().split(/(?<=[.!?])\s+|\n/)[0].replace(/^(hi|hello)[^,]*,\s*/i, "");
  const due = new Date(ctx.now.getTime() + (priority === "urgent" ? 4 : priority === "high" ? 24 : 72) * 3_600_000);
  const ruled = ruleAssignees(ctx, trade, m.site?.id ?? null);
  return {
    siteId: m.site?.id ?? null,
    matchedSiteConfidence: m.confidence,
    kind: "service_call",
    trade,
    priority,
    title: firstSentence.slice(0, 80) || "Service request",
    description: text.trim().slice(0, 1000),
    suggestedAssigneeId: ruled[0] ?? null,
    alternativeAssigneeIds: ruled.slice(1, 3),
    dueAt: due.toISOString(),
    reasoning: `Rule-based draft: site by ${m.why}; trade ${trade} and priority ${priority} from keywords. Assignee: fitting trade, people at the site first, then fewest open tasks.`,
    missingInfo: m.site ? [] : ["Which site is this for?"],
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function promptFor(text: string, ctx: DispatchContext): string {
  const local = formatInZone(ctx.now, BRANCH_TIMEZONE, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const lines = [
    `Now: ${local} (branch time, America/New_York; ISO ${ctx.now.toISOString()})`,
    "Sites:",
    ...ctx.sites.map((s) => `${s.ref} | ${s.name} | ${s.kind}${s.rollout ? ` | rollout stage ${s.stage}` : ""} | ${s.address}`),
    "Field workers (active):",
    ...ctx.people.map((p) => {
      const at = p.clockedInAt ? ctx.sites.find((s) => s.id === p.clockedInAt)?.ref : null;
      return `${p.ref} | ${p.name} | ${p.role} | trade ${p.trade} | ${at ? `clocked in at ${at}` : "not clocked in"} | ${p.openTasks} open tasks`;
    }),
  ];
  if (ctx.siteHintId) {
    lines.push(`The coordinator chose site ${ctx.sites.find((s) => s.id === ctx.siteHintId)?.ref}.`);
    if (ctx.recent.length) lines.push("Recent tasks there:", ...ctx.recent.map((t) => `- ${t.title} (${t.kind}, ${t.status}, ${t.assignee})`));
  }
  lines.push("", `Request: """${text.slice(0, 3000)}"""`);
  return lines.join("\n");
}

export type DispatchResult = { draftId: string; runId: string | null; mode: "ai" | "fallback"; draft: DispatchDraftFields; notes: string[] };

/** Runs the agent and stores a pending draft. Never throws for model problems. */
export async function runDispatchAgent(
  db: Db,
  input: { text: string; siteHintId: string | null; actorId: string; trigger: string },
  deps: { models?: AgentModels; now?: () => Date } = {},
): Promise<DispatchResult> {
  const models = deps.models ?? modelsFromEnv();
  const now = (deps.now ?? (() => new Date()))();
  const draftId = uuidv4();
  const ctx = await loadDispatchContext(db, input.siteHintId, now);
  const runId = await startRun(db, {
    agent: DISPATCH_AGENT,
    trigger: input.trigger,
    actorId: input.actorId,
    subjectId: draftId,
    inputSummary: input.text.slice(0, 200),
    input: { text: input.text, siteHintId: input.siteHintId, sites: ctx.sites.length, people: ctx.people.length },
    now,
  });

  const r = await withFallback<{ draft: DispatchDraftFields; notes: string[] }>({
    model: models.language,
    missing: "ANTHROPIC_API_KEY not set",
    ai: async (signal) => {
      const res = await generateText({
        model: models.language!,
        providerOptions: models.providerOptions,
        system: SYSTEM,
        prompt: promptFor(input.text, ctx),
        output: Output.object({ schema: DispatchModelSchema }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        abortSignal: signal,
      });
      return { value: validateDispatch(DispatchModelSchema.parse(res.output), ctx), usage: readUsage(res.totalUsage) };
    },
    fallback: () => ({ draft: fallbackDispatch(input.text, ctx), notes: [] }),
  });

  await db.insert(dispatchDrafts).values({
    id: draftId,
    requestText: input.text,
    siteHintId: input.siteHintId,
    status: "pending",
    draft: r.value.draft,
    mode: r.mode,
    runId,
    createdBy: input.actorId,
    createdAt: now,
  });
  if (runId) {
    await finishRun(db, runId, {
      status: r.mode === "ai" ? "ok" : "fallback",
      output: r.value.draft,
      model: r.mode === "ai" ? models.languageId : null,
      tokensIn: r.usage?.inputTokens ?? null,
      tokensOut: r.usage?.outputTokens ?? null,
      latencyMs: r.latencyMs,
      costUsd: r.usage ? tokenCostUsd(models.languageId, r.usage.inputTokens, r.usage.outputTokens) : null,
      error: r.error,
      notes: r.value.notes,
      now: (deps.now ?? (() => new Date()))(),
    });
  }
  return { draftId, runId, mode: r.mode, draft: r.value.draft, notes: r.value.notes };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
/** What the coordinator may change before approving (all optional; defaults to the draft). */
export const ApproveEditsSchema = z.strictObject({
  siteId: z.uuid().optional(),
  assigneeId: z.uuid().optional(),
  kind: z.enum(TASK_KINDS).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const draftTaskId = (draftId: string) => draftId; // one task per draft: the draft id is reused as the task id

/** Claims a pending draft for a decision. Returns false if someone already decided it. */
export async function claimDraft(
  db: Db,
  draftId: string,
  decision: { status: "approved" | "rejected"; by: string; at: Date; reason?: string | null; taskId?: string | null },
): Promise<boolean> {
  const rows = await db
    .update(dispatchDrafts)
    .set({ status: decision.status, decidedBy: decision.by, decidedAt: decision.at, rejectReason: decision.reason ?? null, taskId: decision.taskId ?? null })
    .where(and(eq(dispatchDrafts.id, draftId), eq(dispatchDrafts.status, "pending")))
    .returning({ id: dispatchDrafts.id });
  return rows.length > 0;
}

export type DecideResult = { ok: true; taskId: string | null } | { ok: false; status: 404 | 409 | 422; error: string };

/**
 * Approve: the coordinator's decision creates the task through a normal
 * task.created event (source dispatch_agent) as THEM, so the usual reducer
 * rules (site exists, assignee active, role may assign) apply. The draft is
 * claimed first, so two clicks can never create two tasks; if the event is
 * rejected the claim is undone and the draft stays pending.
 */
export async function approveDraft(
  db: Db,
  input: { draftId: string; actorId: string; edits: z.infer<typeof ApproveEditsSchema>; deviceId: string },
  deps: { now?: () => Date; process: (req: { actorId: string; deviceId: string; events: unknown[] }) => Promise<{ rejected: { id: string; reason: string }[] } | { error: string }> },
): Promise<DecideResult> {
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await db.select().from(dispatchDrafts).where(eq(dispatchDrafts.id, input.draftId));
  if (!row) return { ok: false, status: 404, error: "draft_not_found" };
  if (row.status !== "pending") return { ok: false, status: 409, error: `already_${row.status}` };
  const d = row.draft as unknown as DispatchDraftFields;
  const e = input.edits;
  const siteId = e.siteId ?? d.siteId;
  const assigneeId = e.assigneeId ?? d.suggestedAssigneeId;
  if (!siteId) return { ok: false, status: 422, error: "Pick a site before approving." };
  if (!assigneeId) return { ok: false, status: 422, error: "Pick an assignee before approving." };

  const taskId = draftTaskId(row.id);
  if (!(await claimDraft(db, row.id, { status: "approved", by: input.actorId, at: now, taskId }))) {
    return { ok: false, status: 409, error: "already_decided" };
  }
  const out = await deps.process({
    actorId: input.actorId,
    deviceId: input.deviceId,
    events: [
      {
        id: uuidFromDraft(row.id),
        type: "task.created",
        actorId: input.actorId,
        deviceId: input.deviceId,
        clientTs: now.toISOString(),
        payload: {
          taskId,
          title: e.title ?? d.title,
          description: e.description ?? `${d.description}\n\nFrom a service request, drafted by the dispatch agent and approved in the office.`.trim(),
          siteId,
          assigneeId,
          kind: e.kind ?? d.kind,
          priority: e.priority ?? d.priority,
          dueAt: e.dueAt !== undefined ? e.dueAt : d.dueAt,
          source: "dispatch_agent",
        },
      },
    ],
  });
  const reason = "error" in out ? out.error : out.rejected[0]?.reason;
  if (reason) {
    await db
      .update(dispatchDrafts)
      .set({ status: "pending", decidedBy: null, decidedAt: null, taskId: null })
      .where(eq(dispatchDrafts.id, row.id));
    return { ok: false, status: 422, error: reason };
  }
  return { ok: true, taskId };
}

/** The approval event id: stable per draft, so a retried approval is a duplicate. */
function uuidFromDraft(draftId: string): string {
  // Flip the last hex digit: a valid v4 id that differs from the task id.
  const last = draftId.slice(-1);
  return draftId.slice(0, -1) + (last === "0" ? "1" : "0");
}

export async function rejectDraft(db: Db, input: { draftId: string; actorId: string; reason: string }, now = new Date()): Promise<DecideResult> {
  const [row] = await db.select({ status: dispatchDrafts.status }).from(dispatchDrafts).where(eq(dispatchDrafts.id, input.draftId));
  if (!row) return { ok: false, status: 404, error: "draft_not_found" };
  if (!(await claimDraft(db, input.draftId, { status: "rejected", by: input.actorId, at: now, reason: input.reason }))) {
    return { ok: false, status: 409, error: `already_${row.status}` };
  }
  return { ok: true, taskId: null };
}

export async function listDrafts(db: Db, limit = 40) {
  return db.select().from(dispatchDrafts).orderBy(desc(dispatchDrafts.createdAt)).limit(limit);
}
