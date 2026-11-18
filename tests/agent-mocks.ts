// Mocked models for agent tests: tests never call a real API.
import { MockLanguageModelV4 } from "ai/test";
import type { AgentModels } from "@/lib/agents/ai";

const usage = {
  inputTokens: { total: 300, noCache: 300, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 120, text: 120, reasoning: undefined },
};

export function mockLanguage(json: unknown, calls?: { n: number }) {
  return new MockLanguageModelV4({
    modelId: "claude-opus-5-5",
    doGenerate: async () => {
      if (calls) calls.n++;
      return {
        content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

export function models(language: unknown = null, transcription: unknown = null): AgentModels {
  return {
    language: language as AgentModels["language"],
    languageId: language ? "claude-opus-5-5" : null,
    providerOptions: undefined,
    transcription: transcription as AgentModels["transcription"],
    transcriptionId: transcription ? "gpt-4o-mini-transcribe" : null,
  };
}

