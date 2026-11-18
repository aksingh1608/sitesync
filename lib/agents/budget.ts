// A daily ceiling on model calls, so a leaked access code or a runaway loop
// cannot run up the AI bill: over the cap, agents use their rule-based
// fallback (the demo keeps working, just without AI).
import { and, gte, isNotNull, sql } from "drizzle-orm";
import { agentRuns } from "../db/schema";
import type { Db } from "../sync/store-drizzle";
import { modelsFromEnv, type AgentModels } from "./ai";

export const DEFAULT_AI_DAILY_RUN_CAP = 300;

export const aiDailyCap = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.AI_DAILY_RUN_CAP);
  return Number.isFinite(n) && n >= 0 && env.AI_DAILY_RUN_CAP?.trim() ? n : DEFAULT_AI_DAILY_RUN_CAP;
};

/** Model runs in the last 24 h (runs that actually used a model). */
export async function aiRunsLast24h(db: Db, now: Date = new Date()): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(gte(agentRuns.createdAt, new Date(now.getTime() - 86_400_000)), isNotNull(agentRuns.model)));
  return Number(r?.n ?? 0);
}

/** The configured models, or none (fallback) when today's cap is used up. */
export async function budgetedModels(db: Db, now: Date = new Date()): Promise<AgentModels> {
  const models = modelsFromEnv();
  if (!models.language && !models.transcription) return models;
  if ((await aiRunsLast24h(db, now)) < aiDailyCap()) return models;
  console.warn("[agents] daily AI cap reached: using rule-based fallbacks");
  return { ...models, language: null, languageId: null, transcription: null, transcriptionId: null };
}
