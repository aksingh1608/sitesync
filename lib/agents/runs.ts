// agent_runs bookkeeping: a row is written before the model is called (status
// running) and finished afterwards, so a crash leaves a visible "running" row.
import { and, eq, lt, or } from "drizzle-orm";
import { agentRuns } from "../db/schema";
import type { AgentName, AgentRunStatus } from "../domain";
import type { Db } from "../sync/store-drizzle";
import { uuidv4 } from "../uuid";

/** A run still "running" after this long is presumed crashed; its subject may be claimed again. */
export const STALE_RUN_MS = 5 * 60_000;
/** A run that ended in "error" (database trouble, not a model failure) may be retried after this. */
export const ERROR_RETRY_MS = 60_000;

export type StartRun = {
  agent: AgentName;
  trigger: string;
  actorId?: string | null;
  /** Unique per agent: a second start for the same subject returns null (already claimed). */
  subjectId?: string | null;
  inputSummary: string;
  input?: unknown;
  now?: Date;
};

/** Starts a run. Returns its id, or null when another run already claimed this subject. */
export async function startRun(db: Db, r: StartRun): Promise<string | null> {
  const id = uuidv4();
  const now = r.now ?? new Date();
  const row = {
    id,
    agent: r.agent,
    trigger: r.trigger,
    actorId: r.actorId ?? null,
    subjectId: r.subjectId ?? null,
    inputSummary: r.inputSummary.slice(0, 500),
    input: r.input ?? null,
    status: "running" as const,
    createdAt: now,
  };
  const inserted = await db.insert(agentRuns).values(row).onConflictDoNothing().returning({ id: agentRuns.id });
  if (inserted.length) return id;
  if (!r.subjectId) return null;
  // Take over a run that has been "running" for too long (crashed instance),
  // or retry one that failed on an error (never one that finished: ok / fallback).
  const { id: _id, ...rest } = row;
  void _id;
  const taken = await db
    .update(agentRuns)
    .set({ ...rest, output: null, error: null, finishedAt: null, notes: ["retry of an earlier run"] })
    .where(
      and(
        eq(agentRuns.agent, r.agent),
        eq(agentRuns.subjectId, r.subjectId),
        or(
          and(eq(agentRuns.status, "running"), lt(agentRuns.createdAt, new Date(now.getTime() - STALE_RUN_MS))),
          and(eq(agentRuns.status, "error"), lt(agentRuns.createdAt, new Date(now.getTime() - ERROR_RETRY_MS))),
        ),
      ),
    )
    .returning({ id: agentRuns.id });
  return taken[0]?.id ?? null;
}

export type FinishRun = {
  status: Exclude<AgentRunStatus, "running">;
  output?: unknown;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  error?: string | null;
  notes?: string[];
  now?: Date;
};

export async function finishRun(db: Db, id: string, f: FinishRun): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: f.status,
      output: f.output ?? null,
      model: f.model ?? null,
      tokensIn: f.tokensIn ?? null,
      tokensOut: f.tokensOut ?? null,
      latencyMs: f.latencyMs ?? null,
      costUsd: f.costUsd ?? null,
      error: f.error ? f.error.slice(0, 500) : null,
      notes: f.notes?.length ? f.notes : null,
      finishedAt: f.now ?? new Date(),
    })
    .where(eq(agentRuns.id, id));
}
