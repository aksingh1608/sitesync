// Field report agent: voice / long text note -> transcript -> structured daily
// log -> follow-up tasks, material requests and urgent safety tasks.
//
// It acts AS THE NOTE'S AUTHOR, through processSync, from device
// `agent:report_agent`: the normal write rules already let a field worker send
// a follow-up or material request to a coordinator and create follow-ups for
// themselves, so the agent can do nothing its author could not. Task and event
// ids are derived from (note id, kind, index): a repeated run is a duplicate,
// never a second task. Notifications are NOT sent here: the Day 4 rules see
// the urgent safety task like any other and handle it.
import { generateText, Output, transcribe } from "ai";
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { agentRuns, fieldNotes, people, sites, tasks, type FieldNote, type NoteReport } from "../db/schema";
import type { TaskKind, TaskPriority } from "../domain";
import type { SyncEventInput } from "../events";
import { readMedia } from "../media/store";
import { processSync } from "../sync/service";
import type { Db } from "../sync/store-drizzle";
import { budgetedModels } from "./budget";
import { MAX_OUTPUT_TOKENS, readUsage, withFallback, type AgentModels } from "./ai";
import { agentDeviceId, stableUuid } from "./ids";
import { tokenCostUsd, transcriptionCostUsd } from "./pricing";
import { finishRun, startRun } from "./runs";

export const REPORT_AGENT = "report_agent" as const;
/** Text notes with fewer words are left alone (a quick "on my way" is not a report). */
export const REPORT_MIN_WORDS = 20;
/** Caps on what one note can create. */
export const MAX_FOLLOW_UPS = 5;
export const MAX_MATERIALS = 5;
export const MAX_SAFETY = 3;

const wordCount = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Is this note something the report agent should read? */
export function needsReport(n: Pick<FieldNote, "kind" | "text" | "blobPath" | "processedAt">): boolean {
  if (n.processedAt) return false;
  if (n.kind === "voice") return n.blobPath !== null; // after note.media_uploaded
  if (n.kind === "text") return wordCount(n.text) >= REPORT_MIN_WORDS;
  return false;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
const item = z.string().trim().min(1).max(200);
export const ExtractionSchema = z.object({
  summary: z.string().max(600).describe("One or two plain sentences: what happened on site."),
  workDone: z.array(item).max(10),
  materialsUsed: z.array(z.object({ item, qty: z.number().nonnegative().nullable() })).max(10),
  materialsNeeded: z
    .array(z.object({ item, qty: z.number().nonnegative().nullable() }))
    .max(10)
    .describe("Only materials the worker says they still NEED (to order or bring)."),
  blockers: z.array(item).max(5),
  safetyIssues: z.array(item).max(5).describe("Hazards to people: exposed wiring, no lockout, trip hazards, injuries."),
  followUps: z
    .array(
      z.object({
        title: item.describe("Short imperative task title."),
        assigneeRole: z.enum(["coordinator", "assignee"]).describe("assignee = the worker on this task does it themselves"),
        dueInDays: z.number().int().min(0).max(30),
      }),
    )
    .max(5)
    .describe("Other concrete next actions only. NEVER repeat a material need or a safety issue here: those already become their own tasks. Usually empty."),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You turn a field note from an electrician into a structured daily log for the office of Demo Electrical Co.
Extract only what the note says. Never invent work, quantities or problems. Use empty lists when nothing applies.
Keep each item short (under 12 words). Quantities are numbers or null.
Materials needed and safety issues each become their own task automatically, so do not list them again as follow-ups.`;

const emptyExtraction = (summary: string): Extraction => ({
  summary,
  workDone: [],
  materialsUsed: [],
  materialsNeeded: [],
  blockers: [],
  safetyIssues: [],
  followUps: [],
});

const clean = (s: string) => s.replace(/^\s*(and|but|also|so|then)\s+/i, "").replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };

/**
 * Deterministic keyword extraction, used when the model is unavailable. Good
 * enough for the demo sentences ("we need 40 more LED panels", "exposed wire").
 */
export function fallbackExtract(text: string): Extraction {
  const out = emptyExtraction(text.trim().slice(0, 200));
  const clauses = text
    .split(/[.;!?\n]+|,\s*(?=and\b|but\b|we\b|i\b|there\b|also\b|the\b)/i)
    .flatMap((c) => c.split(/\s+and\s+(?=there|we|i|also|the)\b/i))
    .map(clean)
    .filter((c) => c.length > 2);
  for (const c of clauses) {
    const need = c.match(/\b(?:need|needs|needed|short|ran out of|out of|order|bring)\b\s+(?:about\s+)?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)?\s*(?:more\s+|extra\s+|new\s+)?(.+)/i);
    if (/\b(exposed|live)\s+wir|\bhazard|\bunsafe\b|\bshock|\bsparks?\b|\bsmoke\b|\bfire\b|\binjur|\bno lockout|\barc flash/i.test(c)) {
      out.safetyIssues.push(cap(c));
    } else if (need) {
      const qtyRaw = need[1]?.toLowerCase();
      const qty = qtyRaw ? (/^\d+$/.test(qtyRaw) ? Number(qtyRaw) : (NUMBER_WORDS[qtyRaw] ?? null)) : null;
      out.materialsNeeded.push({ item: clean(need[2]).replace(/^(of|the)\s+/i, ""), qty });
    } else if (/\b(blocked|waiting (?:on|for)|can't|cannot|no access|locked out|stuck)\b/i.test(c)) {
      out.blockers.push(cap(c));
    } else if (/\b(follow up|call back|come back|return|schedule|check again|needs? a quote)\b/i.test(c)) {
      out.followUps.push({ title: cap(c), assigneeRole: "coordinator", dueInDays: 1 });
    } else if (/\b(finished|completed|installed|replaced|done with|wrapped up|fixed|pulled|terminated|mounted)\b/i.test(c)) {
      out.workDone.push(cap(c));
    }
  }
  out.workDone = out.workDone.slice(0, 10);
  out.materialsNeeded = out.materialsNeeded.slice(0, 10);
  out.safetyIssues = out.safetyIssues.slice(0, 5);
  out.blockers = out.blockers.slice(0, 5);
  out.followUps = out.followUps.slice(0, 5);
  return out;
}

// ---------------------------------------------------------------------------
// Planning the writes (pure)
// ---------------------------------------------------------------------------
export type ReportContext = {
  note: Pick<FieldNote, "id" | "personId" | "siteId" | "taskId" | "kind">;
  authorName: string;
  siteName: string;
  /** The note's own task (its assignee may get "assignee" follow-ups). */
  task: { id: string; title: string; assigneeId: string } | null;
  /** Who office follow-ups, materials and safety issues go to. Null = none active. */
  coordinatorId: string | null;
  now: Date;
};

export type PlannedTask = {
  taskId: string;
  eventId: string;
  title: string;
  description: string;
  kind: TaskKind;
  priority: TaskPriority;
  assigneeId: string;
  dueAt: string | null;
};

const DAY = 86_400_000;
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "for", "to", "at", "on", "in", "near", "more", "new", "extra", "some", "order", "get", "need", "needs", "make", "safe", "fix", "check", "there", "is", "are", "by"]);
/** Significant words of a phrase (plural "s" removed), for overlap checks. */
function keywords(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map((w) => w.replace(/s$/, "")));
}
const qtyText = (m: { item: string; qty: number | null | undefined }) => (m.qty ? `${m.qty} × ${m.item}` : m.item);

/**
 * Which tasks a report creates. Ids depend only on (note, kind, index), so
 * planning twice for the same note yields the same ids (dedupe).
 */
export function planReportTasks(x: Extraction, ctx: ReportContext): { tasks: PlannedTask[]; notes: string[] } {
  const notes: string[] = [];
  // A follow-up that restates a material or a safety issue would be a second
  // task for the same thing (the material request / safety task covers it).
  const covered = [...x.materialsNeeded.map((m) => m.item), ...x.safetyIssues].map(keywords);
  const followUps = x.followUps.filter((f) => {
    const k = keywords(f.title);
    const dup = covered.some((c) => [...c].filter((w) => k.has(w)).length >= Math.min(2, c.size));
    if (dup) notes.push(`follow-up "${f.title}" dropped: covered by a material request or safety task`);
    return !dup;
  });
  const out: PlannedTask[] = [];
  const from = `From ${ctx.authorName}'s ${ctx.note.kind} note at ${ctx.siteName} (created by the report agent).`;
  const add = (kind: "follow_up" | "material" | "safety", i: number, t: Omit<PlannedTask, "taskId" | "eventId">) =>
    out.push({
      ...t,
      title: t.title.slice(0, 200),
      taskId: stableUuid(`report:${ctx.note.id}:${kind}:${i}`),
      eventId: stableUuid(`report-event:${ctx.note.id}:${kind}:${i}`),
    });

  followUps.slice(0, MAX_FOLLOW_UPS).forEach((f, i) => {
    // "assignee" only when the note is on a task and its assignee is the author
    // (that is who the agent acts as; anyone else needs a coordinator).
    const self = f.assigneeRole === "assignee" && ctx.task && ctx.task.assigneeId === ctx.note.personId;
    const assigneeId = self ? ctx.note.personId : ctx.coordinatorId;
    if (!assigneeId) return void notes.push(`follow-up "${f.title}" skipped: no active coordinator`);
    add("follow_up", i, {
      title: f.title,
      description: from,
      kind: "follow_up",
      priority: "normal",
      assigneeId,
      dueAt: new Date(ctx.now.getTime() + Math.max(0, f.dueInDays) * DAY).toISOString(),
    });
  });
  x.materialsNeeded.slice(0, MAX_MATERIALS).forEach((m, i) => {
    if (!ctx.coordinatorId) return void notes.push(`material "${m.item}" skipped: no active coordinator`);
    add("material", i, {
      title: `Material: ${qtyText(m)}`,
      description: `${from} Needed at ${ctx.siteName}${ctx.task ? ` for "${ctx.task.title}"` : ""}.`,
      kind: "material_request",
      priority: "normal",
      assigneeId: ctx.coordinatorId,
      dueAt: null,
    });
  });
  x.safetyIssues.slice(0, MAX_SAFETY).forEach((s, i) => {
    if (!ctx.coordinatorId) return void notes.push(`safety issue "${s}" skipped: no active coordinator`);
    add("safety", i, {
      title: `Safety: ${s}`,
      description: `${from} Reported safety issue at ${ctx.siteName}: ${s}. Check the site and make it safe.`,
      kind: "follow_up",
      priority: "urgent",
      assigneeId: ctx.coordinatorId,
      dueAt: ctx.now.toISOString(),
    });
  });
  return { tasks: out, notes };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------
export type ReportDeps = {
  models?: AgentModels;
  /** Reads a voice note's audio (tests inject this). */
  readAudio?: (blobPath: string, mimeType: string) => Promise<Uint8Array | null>;
  now?: () => Date;
};

async function readAudioDefault(blobPath: string, mimeType: string): Promise<Uint8Array | null> {
  const r = await readMedia(blobPath, mimeType);
  if (!r || r.status !== 200) return null;
  return r.body instanceof Uint8Array ? r.body : new Uint8Array(await new Response(r.body).arrayBuffer());
}

export const noteProcessedEventId = (noteId: string) => stableUuid(`note.processed:${noteId}`);

export type ReportOutcome =
  | { status: "skipped"; reason: string }
  | { status: "ok" | "fallback"; runId: string; created: string[]; rejected: { id: string; reason: string }[] };

/** Reads one note and acts on it. Never throws for model problems; DB errors propagate. */
export async function runReportAgent(db: Db, noteId: string, opts: { trigger: string; deps?: ReportDeps }): Promise<ReportOutcome> {
  const deps = opts.deps ?? {};
  const models = deps.models ?? (await budgetedModels(db));
  const now = deps.now ?? (() => new Date());

  const [note] = await db.select().from(fieldNotes).where(eq(fieldNotes.id, noteId));
  if (!note) return { status: "skipped", reason: "note_not_found" };
  if (!needsReport(note)) return { status: "skipped", reason: "not_eligible" };

  const runId = await startRun(db, {
    agent: REPORT_AGENT,
    trigger: opts.trigger,
    subjectId: note.id,
    inputSummary: `${note.kind} note ${note.id.slice(0, 8)}${note.text ? `: ${note.text.slice(0, 120)}` : ""}`,
    input: { noteId: note.id, kind: note.kind, text: note.text, durationSec: note.durationSec },
    now: now(),
  });
  if (!runId) return { status: "skipped", reason: "already_claimed" };

  const runNotes: string[] = [];
  try {
    const [[author], [site], taskRows, coordinators] = await Promise.all([
      db.select().from(people).where(eq(people.id, note.personId)),
      db.select().from(sites).where(eq(sites.id, note.siteId)),
      note.taskId ? db.select().from(tasks).where(eq(tasks.id, note.taskId)) : Promise.resolve([]),
      db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.role, "coordinator"), eq(people.active, true)))
        .orderBy(asc(people.name)),
    ]);
    const task = taskRows[0] ?? null;

    // 1. Transcribe (voice notes).
    let transcript: string | null = null;
    let transcriptError: string | null = null;
    let transcribeCost: number | null = null;
    let transcribeMs = 0;
    if (note.kind === "voice") {
      const audio = note.blobPath ? await (deps.readAudio ?? readAudioDefault)(note.blobPath, note.mimeType ?? "audio/webm") : null;
      const t = await withFallback<string | null>({
        model: audio ? models.transcription : null,
        missing: audio ? "OPENAI_API_KEY not set" : "audio not readable",
        ai: async (signal) => {
          const r = await transcribe({ model: models.transcription!, audio: audio!, abortSignal: signal, maxRetries: 1 });
          return { value: r.text.trim() || null, usage: null };
        },
        fallback: () => null,
      });
      transcript = t.value;
      transcribeMs = t.latencyMs;
      if (t.mode === "fallback") {
        // Shown to the worker on the note: say what to do instead, not which key is missing.
        transcriptError = models.transcription
          ? "This voice note could not be transcribed. Add a typed or dictated text note for the report."
          : "Voice notes are not transcribed in this demo. For a report, type or dictate a text note (keyboard mic).";
        runNotes.push(`transcription unavailable: ${t.error}`);
      } else {
        transcribeCost = transcriptionCostUsd(models.transcriptionId, note.durationSec ?? null);
      }
    }

    // 2. Extract.
    const text = (note.kind === "voice" ? transcript : note.text)?.trim() ?? "";
    const x = text
      ? await withFallback<Extraction>({
          model: models.language,
          missing: "ANTHROPIC_API_KEY not set",
          ai: async (signal) => {
            const r = await generateText({
              model: models.language!,
              providerOptions: models.providerOptions,
              system: SYSTEM,
              prompt: [
                `Site: ${site?.name ?? "unknown"}`,
                task ? `Task: ${task.title}` : null,
                `Worker: ${author?.name ?? "unknown"} (${author?.trade ?? "?"})`,
                `Note (${note.kind}): """${text.slice(0, 4000)}"""`,
              ]
                .filter(Boolean)
                .join("\n"),
              output: Output.object({ schema: ExtractionSchema }),
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              maxRetries: 1,
              abortSignal: signal,
            });
            return { value: ExtractionSchema.parse(r.output), usage: readUsage(r.totalUsage) };
          },
          fallback: () => fallbackExtract(text),
        })
      : {
          value: emptyExtraction(note.kind === "voice" ? "Voice note could not be transcribed." : ""),
          mode: "fallback" as const,
          usage: null,
          latencyMs: 0,
          error: "no text to read",
        };
    if (x.error && x.mode === "fallback") runNotes.push(`extraction fallback: ${x.error}`);

    // 3. Create tasks as the author (deterministic ids: repeats are duplicates).
    const ctx: ReportContext = {
      note,
      authorName: author?.name ?? "A worker",
      siteName: site?.name ?? "the site",
      task: task ? { id: task.id, title: task.title, assigneeId: task.assigneeId } : null,
      coordinatorId: coordinators[0]?.id ?? null,
      now: now(),
    };
    const plan = planReportTasks(x.value, ctx);
    runNotes.push(...plan.notes);
    const deviceId = agentDeviceId(REPORT_AGENT);
    const at = now().toISOString();
    const taskEvents: SyncEventInput[] = plan.tasks.map((t) => ({
      id: t.eventId,
      type: "task.created",
      actorId: note.personId,
      deviceId,
      clientTs: at,
      payload: {
        taskId: t.taskId,
        title: t.title,
        description: t.description,
        siteId: note.siteId,
        assigneeId: t.assigneeId,
        kind: t.kind,
        priority: t.priority,
        dueAt: t.dueAt,
        parentTaskId: note.taskId,
        source: "report_agent",
      },
    }));
    const write = taskEvents.length
      ? await processSync(db, { deviceId, actorId: note.personId, cursor: null, events: taskEvents }, { trusted: true, skipPull: true, now })
      : null;
    if (write && !write.ok) throw new Error(`task write refused: ${write.error}`);
    const rejected = write?.ok ? write.response.rejected : [];
    const rejectedIds = new Set(rejected.map((r) => r.id));
    const created = plan.tasks.filter((t) => !rejectedIds.has(t.eventId));
    for (const r of rejected) runNotes.push(`task event ${r.id.slice(0, 8)} rejected: ${r.reason}`);

    // 4. Record the log on the note (first processing wins).
    const report: NoteReport = {
      ...x.value,
      mode: x.mode,
      createdTasks: created.map((t) => ({ id: t.taskId, title: t.title, kind: t.kind, priority: t.priority })),
      transcriptError,
    };
    const processed = await processSync(
      db,
      {
        deviceId,
        actorId: note.personId,
        cursor: null,
        events: [
          {
            id: noteProcessedEventId(note.id),
            type: "note.processed",
            actorId: note.personId,
            deviceId,
            clientTs: at,
            payload: { noteId: note.id, transcript, report },
          },
        ],
      },
      { trusted: true, skipPull: true, now },
    );
    if (!processed.ok) throw new Error(`note.processed refused: ${processed.error}`);
    const pr = processed.response.rejected[0];
    if (pr) runNotes.push(`note.processed rejected: ${pr.reason}`);

    const usage = x.usage;
    const llmCost = usage ? tokenCostUsd(models.languageId, usage.inputTokens, usage.outputTokens) : null;
    const status = x.mode === "ai" ? "ok" : "fallback";
    await finishRun(db, runId, {
      status,
      output: { transcript, report, created: created.map((t) => t.taskId) },
      model: [x.mode === "ai" ? models.languageId : null, transcript ? models.transcriptionId : null].filter(Boolean).join(" + ") || null,
      tokensIn: usage?.inputTokens ?? null,
      tokensOut: usage?.outputTokens ?? null,
      latencyMs: transcribeMs + x.latencyMs,
      costUsd: llmCost === null && transcribeCost === null ? null : (llmCost ?? 0) + (transcribeCost ?? 0),
      error: x.mode === "fallback" ? (transcriptError ?? x.error) : null,
      notes: runNotes,
      now: now(),
    });
    return { status, runId, created: created.map((t) => t.taskId), rejected };
  } catch (err) {
    await finishRun(db, runId, { status: "error", error: (err as Error).message, notes: runNotes, now: now() }).catch(() => {});
    throw err;
  }
}

/** Notes waiting for the report agent (oldest first), not already claimed by a live run. */
export async function pendingReportNotes(db: Db, limit = 3): Promise<string[]> {
  // Finished runs never repeat; live runs are left alone (errors retry, see startRun).
  const claimed = db
    .select({ id: agentRuns.subjectId })
    .from(agentRuns)
    .where(and(eq(agentRuns.agent, REPORT_AGENT), isNotNull(agentRuns.subjectId), inArray(agentRuns.status, ["ok", "fallback", "running"])));
  const rows = await db
    .select({ id: fieldNotes.id, kind: fieldNotes.kind, text: fieldNotes.text, blobPath: fieldNotes.blobPath, processedAt: fieldNotes.processedAt })
    .from(fieldNotes)
    .where(
      and(
        isNull(fieldNotes.processedAt),
        or(and(eq(fieldNotes.kind, "voice"), isNotNull(fieldNotes.blobPath)), eq(fieldNotes.kind, "text")),
        notInArray(sql`${fieldNotes.id}::text`, claimed),
      ),
    )
    .orderBy(asc(fieldNotes.createdAt))
    .limit(limit * 4);
  return rows.filter(needsReport).slice(0, limit).map((r) => r.id);
}

/**
 * Processes up to `limit` waiting notes. Used after syncs and uploads (via
 * `after()`), and by the office poll as a safety net. Never throws.
 */
export async function processPendingReports(db: Db, opts: { trigger: string; limit?: number; deps?: ReportDeps }) {
  const done: ReportOutcome[] = [];
  try {
    for (const id of await pendingReportNotes(db, opts.limit ?? 3)) {
      try {
        done.push(await runReportAgent(db, id, opts));
      } catch (err) {
        console.error("[agents] report run failed for note", id, err);
      }
    }
  } catch (err) {
    console.error("[agents] report queue failed:", err);
  }
  return done;
}
