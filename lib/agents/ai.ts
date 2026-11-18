// The only place agents get a model. Server-only: the phone never calls an AI
// API. Every model call goes through `withFallback`, which enforces the
// timeout, measures latency and tokens, and swaps in the deterministic
// rule-based output when the key is missing, the call times out or errors.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel, TranscriptionModel } from "ai";

/** A model call slower than this is abandoned and the fallback runs instead. */
export const AGENT_TIMEOUT_MS = 20_000;
/** Output cap per call (thinking included), to keep runs cheap and quick. */
export const MAX_OUTPUT_TOKENS = 1_200;
/** Shown wherever an agent's output came from the rule-based fallback. */
export const FALLBACK_LABEL = "Fallback (AI unavailable)";

/** Current default (Anthropic models list, 2026-11): the Opus line, run at low effort. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export type AgentModels = {
  /** Null when ANTHROPIC_API_KEY is not set: every agent falls back. */
  language: LanguageModel | null;
  languageId: string | null;
  /** Provider options for every language-model call (effort). */
  providerOptions: { anthropic: { effort: Effort } } | undefined;
  /** Null when OPENAI_API_KEY is not set: voice notes get no transcript. */
  transcription: TranscriptionModel | null;
  transcriptionId: string | null;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export function modelsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentModels {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const languageId = env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  const transcriptionId = env.OPENAI_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
  // "none" leaves effort out (older models without the effort parameter).
  const effortEnv = (env.ANTHROPIC_EFFORT?.trim() || "low") as (typeof EFFORTS)[number] | "none";
  const effort = EFFORTS.includes(effortEnv as never) ? (effortEnv as (typeof EFFORTS)[number]) : undefined;
  return {
    language: anthropicKey ? createAnthropic({ apiKey: anthropicKey })(languageId) : null,
    languageId: anthropicKey ? languageId : null,
    providerOptions: effort ? { anthropic: { effort } } : undefined,
    transcription: openaiKey ? createOpenAI({ apiKey: openaiKey }).transcription(transcriptionId) : null,
    transcriptionId: openaiKey ? transcriptionId : null,
  };
}

export type Usage = { inputTokens: number; outputTokens: number };
export type CallResult<T> = {
  value: T;
  mode: "ai" | "fallback";
  usage: Usage | null;
  latencyMs: number;
  /** Why the fallback ran (missing key, timeout, error, invalid output). */
  error: string | null;
};

/** Reads token counts from an AI SDK usage object (shape differs per call type). */
export function readUsage(u: { inputTokens?: number | null; outputTokens?: number | null } | undefined | null): Usage | null {
  if (!u) return null;
  return { inputTokens: Number(u.inputTokens ?? 0), outputTokens: Number(u.outputTokens ?? 0) };
}

function describeAiError(err: unknown): string {
  const e = err as { name?: string; message?: string; statusCode?: number; cause?: unknown };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `timeout after ${AGENT_TIMEOUT_MS / 1000} s`;
  const status = e?.statusCode ? `HTTP ${e.statusCode}: ` : "";
  return `${status}${e?.name ?? "Error"}: ${(e?.message ?? String(err)).slice(0, 300)}`;
}

/**
 * Runs `ai` with a hard timeout; on a missing model, timeout, error or a
 * result that `ai` itself rejects (throw), returns `fallback()` instead.
 * Never throws (unless the fallback itself does, which is a bug).
 */
export async function withFallback<T>(opts: {
  model: LanguageModel | TranscriptionModel | null;
  missing: string;
  ai: (signal: AbortSignal) => Promise<{ value: T; usage: Usage | null }>;
  fallback: () => T | Promise<T>;
  timeoutMs?: number;
}): Promise<CallResult<T>> {
  const started = Date.now();
  if (!opts.model) {
    return { value: await opts.fallback(), mode: "fallback", usage: null, latencyMs: Date.now() - started, error: opts.missing };
  }
  try {
    const { value, usage } = await opts.ai(AbortSignal.timeout(opts.timeoutMs ?? AGENT_TIMEOUT_MS));
    return { value, mode: "ai", usage, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    console.warn("[agents] model call failed, using the fallback:", describeAiError(err));
    return { value: await opts.fallback(), mode: "fallback", usage: null, latencyMs: Date.now() - started, error: describeAiError(err) };
  }
}
