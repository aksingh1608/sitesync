// Daily digest agent. The numbers are computed first, with the same queries
// and rules the dashboard uses (loadSnapshot + derive for "right now",
// teamStats for completions, the event log for the day). The model only writes
// the narrative from those numbers, and a check makes sure every number in its
// text appears in the input; otherwise the template is used.
import { generateText, Output } from "ai";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { BRANCH_TIMEZONE } from "../config";
import { branches, digests, events, people, sites, tasks, timeEntries } from "../db/schema";
import type { RolloutStage } from "../domain";
import { derive } from "../office/derive";
import { loadSnapshot, rangeInstants, teamStats } from "../office/queries";
import { entryHours, STAGE_LABEL } from "../office/rules";
import type { Db } from "../sync/store-drizzle";
import { addDays, dayKey } from "../time";
import { uuidv4 } from "../uuid";
import { MAX_OUTPUT_TOKENS, modelsFromEnv, readUsage, withFallback, type AgentModels } from "./ai";
import { tokenCostUsd } from "./pricing";
import { finishRun, startRun } from "./runs";

export const DIGEST_AGENT = "digest_agent" as const;

export type DigestFigures = {
  completed: number;
  blocked: number;
  overdue: number;
  notAcknowledged: number;
  materialRequestsRaised: number;
  openMaterialRequests: number;
  safetyIssues: number;
  hoursWorked: number;
  stageMoves: number;
  clockedInNow: number;
};
export type DigestNumbers = {
  day: string;
  /** "Right now" counts (blocked, overdue, not acknowledged, open materials, clocked in) are as of this time. */
  asOf: string;
  branch: DigestFigures;
  sites: ({ siteId: string; name: string } & DigestFigures)[];
  moves: { siteId: string; name: string; from: string; to: string }[];
};

const zero = (): DigestFigures => ({
  completed: 0,
  blocked: 0,
  overdue: 0,
  notAcknowledged: 0,
  materialRequestsRaised: 0,
  openMaterialRequests: 0,
  safetyIssues: 0,
  hoursWorked: 0,
  stageMoves: 0,
  clockedInNow: 0,
});

const round1 = (n: number) => Math.round(n * 10) / 10;

/** All digest numbers for one branch day. `now` is demo-clock time (same as the board). */
export async function computeDigestNumbers(db: Db, day: string, now: Date): Promise<DigestNumbers> {
  const { start, end } = rangeInstants(day, day);
  const [snap, stats, raised, entries, moves, siteRows] = await Promise.all([
    loadSnapshot(db, now),
    teamStats(db, day, day, now),
    db
      .select({ siteId: tasks.siteId, kind: tasks.kind, priority: tasks.priority, source: tasks.source, title: tasks.title })
      .from(tasks)
      .where(and(gte(tasks.createdAt, start), lt(tasks.createdAt, end))),
    db
      .select({ siteId: timeEntries.siteId, clockInAt: timeEntries.clockInAt, clockOutAt: timeEntries.clockOutAt })
      .from(timeEntries)
      .where(and(gte(timeEntries.clockInAt, start), lt(timeEntries.clockInAt, end))),
    db
      .select({ payload: events.payload, clientTs: events.clientTs })
      .from(events)
      .where(and(eq(events.type, "site.stage_changed"), eq(events.applied, true), gte(events.clientTs, start), lt(events.clientTs, end)))
      .orderBy(asc(events.serverSeq)),
    db.select({ id: sites.id, name: sites.name }).from(sites),
  ]);
  // The snapshot is JSON-shaped for derive (dates as strings), exactly like the dashboard sees it.
  const d = derive(JSON.parse(JSON.stringify(snap)));
  const name = new Map(siteRows.map((s) => [s.id, s.name]));
  const bySite = new Map<string, DigestFigures>();
  const fig = (siteId: string) => {
    let f = bySite.get(siteId);
    if (!f) bySite.set(siteId, (f = zero()));
    return f;
  };
  const branch = zero();
  const add = (siteId: string, k: keyof DigestFigures, n = 1) => {
    fig(siteId)[k] = round1(fig(siteId)[k] + n);
    branch[k] = round1(branch[k] + n);
  };

  for (const t of d.open) {
    if (t.status === "blocked") add(t.siteId, "blocked");
    if (d.inView(t, "overdue")) add(t.siteId, "overdue");
    if (d.inView(t, "unacked")) add(t.siteId, "notAcknowledged");
  }
  for (const t of snap.tasks) if (d.inView(JSON.parse(JSON.stringify(t)), "materials")) add(t.siteId, "openMaterialRequests");
  for (const e of snap.openEntries) add(e.siteId, "clockedInNow");
  for (const s of stats.site) if (s.completed) add(s.key, "completed", s.completed);
  for (const t of raised) {
    if (t.kind === "material_request") add(t.siteId, "materialRequestsRaised");
    if (t.source === "report_agent" && t.priority === "urgent" && t.title.startsWith("Safety:")) add(t.siteId, "safetyIssues");
  }
  for (const e of entries) {
    const h = entryHours(e, now);
    if (h !== null) add(e.siteId, "hoursWorked", h);
  }
  const moveList = moves.map((m) => {
    const p = m.payload as { siteId: string; from: RolloutStage; to: RolloutStage };
    add(p.siteId, "stageMoves");
    return { siteId: p.siteId, name: name.get(p.siteId) ?? "?", from: STAGE_LABEL[p.from] ?? p.from, to: STAGE_LABEL[p.to] ?? p.to };
  });
  // Branch completions straight from teamStats (same number as the Team page).
  branch.completed = stats.branch.completed;

  return {
    day,
    asOf: now.toISOString(),
    branch,
    sites: [...bySite.entries()]
      .filter(([, f]) => Object.values(f).some((v) => v > 0))
      .map(([siteId, f]) => ({ siteId, name: name.get(siteId) ?? "?", ...f }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    moves: moveList,
  };
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------
export type DigestNarrative = { branch: string; sites: { siteId: string; summary: string }[]; highlights: string[] };

const NarrativeSchema = z.object({
  branch: z.string().max(800).describe("3-5 sentences for the branch manager."),
  sites: z.array(z.object({ ref: z.string(), summary: z.string().max(400) })).max(20),
  highlights: z.array(z.string().max(200)).max(5).describe("What needs attention first."),
});

const LABELS: Record<keyof DigestFigures, string> = {
  completed: "tasks completed today",
  blocked: "blocked now",
  overdue: "overdue now",
  notAcknowledged: "not acknowledged now",
  materialRequestsRaised: "material requests raised today",
  openMaterialRequests: "open material requests now",
  safetyIssues: "safety issues reported today",
  hoursWorked: "hours worked today",
  stageMoves: "rollout stage moves today",
  clockedInNow: "clocked in now",
};

const describe = (f: DigestFigures) =>
  (Object.keys(LABELS) as (keyof DigestFigures)[])
    .filter((k) => f[k] > 0)
    .map((k) => `${f[k]} ${LABELS[k]}`)
    .join(", ");

/** Deterministic text used when the model is unavailable or its numbers do not check out. */
export function templateNarrative(n: DigestNumbers): DigestNarrative {
  const b = n.branch;
  const branch = `Branch summary for ${n.day}: ${describe(b) || "no activity recorded"}.` + (n.moves.length ? ` Rollout moves: ${n.moves.map((m) => `${m.name} ${m.from} → ${m.to}`).join("; ")}.` : "");
  const highlights = [
    b.safetyIssues ? `${b.safetyIssues} safety issue${b.safetyIssues > 1 ? "s" : ""} reported: check the urgent tasks.` : null,
    b.blocked ? `${b.blocked} blocked task${b.blocked > 1 ? "s" : ""} need a decision.` : null,
    b.notAcknowledged ? `${b.notAcknowledged} task${b.notAcknowledged > 1 ? "s" : ""} not acknowledged yet.` : null,
    b.overdue ? `${b.overdue} overdue task${b.overdue > 1 ? "s" : ""}.` : null,
  ].filter((x): x is string => !!x);
  return { branch, sites: n.sites.map((s) => ({ siteId: s.siteId, summary: `${describe(s)}.` })), highlights };
}

/** Every number written in the text (digits only: "40", "3.5", "#106"). */
export const numbersIn = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

/**
 * The anti-invention check: every number in the narrative must appear in the
 * input data (figures, site names, the date). Returns the offending numbers.
 */
export function checkNarrative(text: string, n: DigestNumbers): number[] {
  const allowed = new Set<number>();
  const addAll = (vals: number[]) => vals.forEach((v) => allowed.add(v));
  addAll(Object.values(n.branch));
  for (const s of n.sites) {
    addAll(Object.values(s).filter((v): v is number => typeof v === "number"));
    addAll(numbersIn(s.name));
  }
  for (const m of n.moves) addAll(numbersIn(m.name));
  addAll(numbersIn(n.day)); // 2026, 11, 18
  addAll(n.day.split("-").map(Number));
  return [...new Set(numbersIn(text).filter((v) => !allowed.has(v)))];
}

const SYSTEM = `You write the end-of-day digest for the branch manager of Demo Electrical Co., an electrical contractor.
Use ONLY the numbers given. Never compute new numbers (no sums, differences or percentages) and never invent any.
Plain, short sentences. Lead with what needs attention (safety, blocked, not acknowledged, overdue). Site summaries only for the listed sites, by ref.`;

function digestPrompt(n: DigestNumbers, refs: Map<string, string>): string {
  const lines = [`Day: ${n.day} (branch time). "now" counts are as of the time of writing.`, `Branch: ${describe(n.branch) || "no activity"}`];
  for (const s of n.sites) lines.push(`${refs.get(s.siteId)} ${s.name}: ${describe(s)}`);
  if (n.moves.length) lines.push(`Rollout stage moves: ${n.moves.map((m) => `${m.name} ${m.from} -> ${m.to}`).join("; ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
export type DigestContent = {
  numbers: DigestNumbers;
  narrative: DigestNarrative;
  mode: "ai" | "fallback";
  /** Numbers the model wrote that were not in the data (then the template was used). */
  check: { ok: boolean; offending: number[] };
  sentTo?: { at: string; people: number; delivered: number }[];
};

export async function generateDigest(
  db: Db,
  input: { day: string; now: Date; trigger: string; actorId?: string | null },
  deps: { models?: AgentModels; real?: () => Date } = {},
) {
  const models = deps.models ?? modelsFromEnv();
  const real = deps.real ?? (() => new Date());
  const numbers = await computeDigestNumbers(db, input.day, input.now);
  const runId = await startRun(db, {
    agent: DIGEST_AGENT,
    trigger: input.trigger,
    actorId: input.actorId,
    inputSummary: `Digest for ${input.day}: ${describe(numbers.branch) || "no activity"}`.slice(0, 300),
    input: numbers,
    now: real(),
  });
  const refs = new Map(numbers.sites.map((s, i) => [s.siteId, `S${i + 1}`]));
  const byRef = new Map([...refs.entries()].map(([id, r]) => [r, id]));
  let check = { ok: true, offending: [] as number[] };
  // Tokens spent on a narrative that then failed the number check still count.
  let spent: ReturnType<typeof readUsage> = null;

  const r = await withFallback<DigestNarrative>({
    model: models.language,
    missing: "ANTHROPIC_API_KEY not set",
    ai: async (signal) => {
      const res = await generateText({
        model: models.language!,
        providerOptions: models.providerOptions,
        system: SYSTEM,
        prompt: digestPrompt(numbers, refs),
        output: Output.object({ schema: NarrativeSchema }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 1,
        abortSignal: signal,
      });
      spent = readUsage(res.totalUsage);
      const o = NarrativeSchema.parse(res.output);
      const narrative: DigestNarrative = {
        branch: o.branch,
        sites: o.sites.flatMap((s) => (byRef.has(s.ref) ? [{ siteId: byRef.get(s.ref)!, summary: s.summary }] : [])),
        highlights: o.highlights,
      };
      const text = [narrative.branch, ...narrative.sites.map((s) => s.summary), ...narrative.highlights].join("\n");
      const offending = checkNarrative(text, numbers);
      if (offending.length) {
        check = { ok: false, offending };
        // Counted as a model failure: the template is used instead.
        throw Object.assign(new Error(`narrative has numbers not in the data: ${offending.join(", ")}`), { name: "NumberCheckFailed" });
      }
      return { value: narrative, usage: spent };
    },
    fallback: () => templateNarrative(numbers),
  });

  const usage = r.usage ?? spent;
  const content: DigestContent = { numbers, narrative: r.value, mode: r.mode, check };
  const [branch] = await db.select({ id: branches.id }).from(branches).limit(1);
  const id = uuidv4();
  const { start, end } = rangeInstants(input.day, input.day);
  await db.insert(digests).values({
    id,
    branchId: branch.id,
    personId: null,
    kind: "daily",
    periodStart: start,
    periodEnd: end,
    summary: r.value.branch,
    content,
    model: r.mode === "ai" ? models.languageId : null,
    createdAt: real(),
  });
  if (runId) {
    await finishRun(db, runId, {
      status: r.mode === "ai" ? "ok" : "fallback",
      output: { digestId: id, narrative: r.value, check },
      model: usage ? models.languageId : null,
      tokensIn: usage?.inputTokens ?? null,
      tokensOut: usage?.outputTokens ?? null,
      latencyMs: r.latencyMs,
      costUsd: usage ? tokenCostUsd(models.languageId, usage.inputTokens, usage.outputTokens) : null,
      error: r.error,
      notes: check.ok ? [] : [`number check failed (${check.offending.join(", ")}): template used`],
      now: real(),
    });
  }
  return { id, content };
}

/** Latest digest per day, newest day first. */
export async function listDigests(db: Db, limit = 14) {
  const rows = await db
    .selectDistinctOn([digests.periodStart], {
      id: digests.id,
      periodStart: digests.periodStart,
      summary: digests.summary,
      content: digests.content,
      model: digests.model,
      createdAt: digests.createdAt,
    })
    .from(digests)
    .where(eq(digests.kind, "daily"))
    .orderBy(sql`${digests.periodStart} desc`, sql`${digests.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, day: dayKey(r.periodStart, BRANCH_TIMEZONE), content: r.content as DigestContent }));
}

export const yesterdayKey = (now: Date) => addDays(dayKey(now, BRANCH_TIMEZONE), -1);

export async function managerIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: people.id }).from(people).where(and(eq(people.role, "manager"), eq(people.active, true)));
  return rows.map((r) => r.id);
}

export async function loadDigest(db: Db, id: string) {
  const [row] = await db.select().from(digests).where(inArray(digests.id, [id]));
  return row ? { ...row, day: dayKey(row.periodStart, BRANCH_TIMEZONE), content: row.content as DigestContent } : null;
}
