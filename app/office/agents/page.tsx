"use client";
// Agent activity: every agent run with status, latency, tokens, cost estimate
// and output. Shows that the AI is observable and controlled.
import { useState } from "react";
import { Principles, usd } from "@/components/office/agents";
import { UpdatedAgo, usePolling } from "@/components/office/data";
import { fmtDateTime, PageHeader, Pill, Select } from "@/components/office/ui";
import { AGENT_NAMES } from "@/lib/domain";

type Run = {
  id: string;
  agent: string;
  trigger: string;
  actorName: string | null;
  subjectId: string | null;
  inputSummary: string;
  output: unknown;
  status: "running" | "ok" | "fallback" | "error";
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  error: string | null;
  notes: string[] | null;
  createdAt: string;
};
type Data = { config: { model: string | null; transcription: string | null; aiAvailable: boolean; transcriptionAvailable: boolean }; runs: Run[] };

const AGENT_LABEL: Record<string, string> = {
  dispatch_agent: "Dispatch",
  report_agent: "Field report",
  digest_agent: "Daily digest",
  ops_copilot: "Ops copilot",
};
const STATUS_TONE = { ok: "green", fallback: "amber", error: "red", running: "blue" } as const;

export default function AgentsPage() {
  const [agent, setAgent] = useState("");
  const { data, error, updatedAt } = usePolling<Data>(`/api/office/agents${agent ? `?agent=${agent}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const runs = data?.runs ?? [];
  const done = runs.filter((r) => r.status !== "running");
  const lat = done.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
  const cost = done.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  return (
    <>
      <PageHeader title="Agent activity">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>
      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <Select label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)} data-testid="agent-filter">
          <option value="">All agents</option>
          {AGENT_NAMES.map((a) => <option key={a} value={a}>{AGENT_LABEL[a]}</option>)}
        </Select>
        {data && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone={data.config.aiAvailable ? "green" : "amber"}>
              {data.config.aiAvailable ? `Model: ${data.config.model}` : "No ANTHROPIC_API_KEY: every agent uses its fallback"}
            </Pill>
            <Pill tone={data.config.transcriptionAvailable ? "green" : "amber"}>
              {data.config.transcriptionAvailable ? `Speech-to-text: ${data.config.transcription}` : "No OPENAI_API_KEY: voice notes are not transcribed"}
            </Pill>
          </div>
        )}
        {done.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {done.length} runs shown · {done.filter((r) => r.status === "fallback").length} fallback · median {((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)} s · est. cost {usd(cost)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="px-2 py-1.5 font-medium">Agent</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Input</th>
              <th className="px-2 py-1.5 text-right font-medium">Latency</th>
              <th className="px-2 py-1.5 text-right font-medium">Tokens in/out</th>
              <th className="px-2 py-1.5 text-right font-medium">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-muted-foreground">No agent runs yet.</td>
              </tr>
            )}
            {runs.map((r) => (
              <RunRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <Principles />
      </div>
    </>
  );
}

function RunRow({ r, open, onToggle }: { r: Run; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer align-top hover:bg-muted/40" onClick={onToggle} data-testid="agent-run">
        <td className="whitespace-nowrap px-2 py-1.5">{fmtDateTime(r.createdAt)}</td>
        <td className="whitespace-nowrap px-2 py-1.5">
          {AGENT_LABEL[r.agent] ?? r.agent}
          <div className="text-xs text-muted-foreground">{r.trigger}{r.actorName ? ` · ${r.actorName}` : ""}</div>
        </td>
        <td className="px-2 py-1.5">
          <Pill tone={STATUS_TONE[r.status]}>{r.status === "fallback" ? "fallback (AI unavailable)" : r.status}</Pill>
        </td>
        <td className="max-w-md px-2 py-1.5">
          <div className="line-clamp-2">{r.inputSummary}</div>
          {r.error && <div className="text-xs text-amber-800 dark:text-amber-300">{r.error}</div>}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.latencyMs === null ? "—" : `${(r.latencyMs / 1000).toFixed(1)} s`}</td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.tokensIn === null ? "—" : `${r.tokensIn} / ${r.tokensOut}`}</td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{usd(r.costUsd)}</td>
      </tr>
      {open && (
        <tr className="bg-muted/30">
          <td colSpan={7} className="space-y-2 px-2 py-2 text-xs">
            <div>Model: {r.model ?? "none (rules)"}</div>
            {r.notes && r.notes.length > 0 && (
              <ul className="list-disc pl-5">
                {r.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
            <pre className="max-h-80 overflow-auto rounded border bg-background p-2">{JSON.stringify(r.output, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
