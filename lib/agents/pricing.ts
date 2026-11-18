// Rough cost estimates for /office/agents (list prices, USD). Estimates only:
// the provider's bill is the source of truth.

/** USD per million tokens [input, output], Anthropic list prices (2026-11). */
const CLAUDE_PRICES: [prefix: string, input: number, output: number][] = [
  ["claude-fable-5-2", 8, 40],
  ["claude-fable-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-4", 1, 5],
];

/** USD per audio minute for OpenAI transcription (rough; check the provider's page). */
const TRANSCRIPTION_PER_MIN: [prefix: string, usd: number][] = [
  ["gpt-4o-mini-transcribe", 0.003],
  ["gpt-4o-transcribe", 0.006],
  ["whisper-1", 0.006],
];

export function tokenCostUsd(modelId: string | null, inputTokens: number, outputTokens: number): number | null {
  if (!modelId) return null;
  const p = CLAUDE_PRICES.find(([prefix]) => modelId.startsWith(prefix));
  if (!p) return null;
  return (inputTokens * p[1] + outputTokens * p[2]) / 1_000_000;
}

export function transcriptionCostUsd(modelId: string | null, seconds: number | null): number | null {
  if (!modelId || seconds === null) return null;
  const p = TRANSCRIPTION_PER_MIN.find(([prefix]) => modelId.startsWith(prefix));
  return p ? (seconds / 60) * p[1] : null;
}
