"use client";
// Daily digest: numbers computed from the dashboard's own data, a narrative
// written by the digest agent (checked: it may only use those numbers), and
// "Send to manager" (push). Earlier days are kept.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ModeBadge, postJson, Principles, timed } from "@/components/office/agents";
import { UpdatedAgo, usePolling, useSnapshot, type Json } from "@/components/office/data";
import { ErrorLine, fmtDateTime, fmtDay, PageHeader, Pill } from "@/components/office/ui";
import type { DigestContent, DigestFigures } from "@/lib/agents/digest";
import { canManageTasks } from "@/lib/domain";
import { cn } from "@/lib/utils";

type DigestRow = { id: string; day: string; summary: string; content: Json<DigestContent>; model: string | null; createdAt: string };
type Data = { today: string; canGenerate: boolean; digests: DigestRow[] };

const COLUMNS: [keyof DigestFigures, string][] = [
  ["completed", "Completed"],
  ["blocked", "Blocked now"],
  ["overdue", "Overdue now"],
  ["notAcknowledged", "Not acknowledged"],
  ["materialRequestsRaised", "Material requests"],
  ["safetyIssues", "Safety issues"],
  ["hoursWorked", "Hours worked"],
  ["stageMoves", "Rollout moves"],
];

export default function DigestPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <Digests />
    </Suspense>
  );
}

function Digests() {
  const snap = useSnapshot();
  const { data, error, updatedAt, refresh } = usePolling<Data>("/api/office/digest", 30_000);
  const params = useSearchParams();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const canAct = !!snap.data && canManageTasks(snap.data.actor.role);
  const selectedDay = params.get("day") ?? data?.today ?? null;
  const selected = data?.digests.find((d) => d.day === selectedDay) ?? null;

  async function generate() {
    setBusy("generate");
    setActionError(null);
    setNote(null);
    const [r, ms] = await timed(() => postJson<{ day: string; mode: string }>("/api/office/digest", {}));
    setBusy(null);
    if (!r.ok) return setActionError(r.error);
    setNote(`Generated in ${(ms / 1000).toFixed(1)} s.`);
    await refresh();
    router.replace(`/office/digest?day=${r.data.day}`);
  }
  async function send(id: string) {
    setBusy("send");
    setActionError(null);
    const r = await postJson<{ managers: number; subscriptions: number; delivered: number }>("/api/office/digest/send", { digestId: id });
    setBusy(null);
    if (!r.ok) return setActionError(r.error);
    setNote(
      r.data.subscriptions === 0
        ? `No manager has notifications on in a browser yet (${r.data.managers} manager${r.data.managers === 1 ? "" : "s"}). They can read it here.`
        : `Pushed to ${r.data.delivered} of ${r.data.subscriptions} manager device${r.data.subscriptions === 1 ? "" : "s"}.`,
    );
    await refresh();
  }

  return (
    <>
      <PageHeader title="Daily digest">
        <UpdatedAgo at={updatedAt} error={error} />
        {canAct && (
          <button onClick={generate} disabled={!!busy} className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="digest-generate">
            {busy === "generate" ? "Generating…" : "Generate today's digest"}
          </button>
        )}
      </PageHeader>
      <ErrorLine error={actionError} />
      {note && <p className="mb-2 text-sm text-muted-foreground">{note}</p>}
      <div className="grid gap-4 lg:grid-cols-[12rem_1fr]">
        <nav className="space-y-1 text-sm" aria-label="Days">
          {data?.digests.length === 0 && <p className="text-muted-foreground">No digest yet.</p>}
          {data?.digests.map((d) => (
            <button
              key={d.id}
              onClick={() => router.replace(`/office/digest?day=${d.day}`)}
              className={cn("block w-full rounded-md px-2 py-1 text-left hover:bg-muted", d.day === selectedDay && "bg-muted font-medium")}
            >
              {fmtDay(`${d.day}T12:00:00Z`)}
              {d.day === data.today && <span className="ml-1 text-xs text-muted-foreground">(today)</span>}
            </button>
          ))}
          <p className="pt-2 text-xs text-muted-foreground">The daily cron writes yesterday&apos;s digest each morning.</p>
        </nav>
        <div className="min-w-0 space-y-3">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              No digest for {selectedDay ?? "today"} yet.{canAct ? " Use “Generate today's digest”." : ""}
            </p>
          ) : (
            <DigestView d={selected} canSend={canAct} sending={busy === "send"} onSend={() => send(selected.id)} siteName={(id) => snap.data?.sites.find((s) => s.id === id)?.name ?? "?"} />
          )}
          <Principles>
            <p className="mt-1">The numbers come from the same queries as the board. The agent only writes the text, and a check rejects any number that is not in the data.</p>
          </Principles>
        </div>
      </div>
    </>
  );
}

function DigestView({ d, canSend, sending, onSend, siteName }: { d: DigestRow; canSend: boolean; sending: boolean; onSend: () => void; siteName: (id: string) => string }) {
  const c = d.content;
  const n = c.numbers;
  const summaryOf = new Map(c.narrative.sites.map((s) => [s.siteId, s.summary]));
  return (
    <article className="space-y-3" data-testid="digest">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <h2 className="text-lg font-semibold">{fmtDay(`${d.day}T12:00:00Z`)}</h2>
        <ModeBadge mode={c.mode} />
        {!c.check.ok && <Pill tone="amber">Model used numbers not in the data ({c.check.offending.join(", ")}): template shown</Pill>}
        <span className="text-xs text-muted-foreground">generated {fmtDateTime(d.createdAt)} · “now” counts as of {fmtDateTime(n.asOf)}</span>
        {canSend && (
          <button onClick={onSend} disabled={sending} className="ml-auto h-8 rounded-md border px-3 hover:bg-muted disabled:opacity-50" data-testid="digest-send">
            {sending ? "Sending…" : "Send to manager"}
          </button>
        )}
      </div>
      {c.sentTo && c.sentTo.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sent to manager {c.sentTo.map((s) => `${fmtDateTime(s.at)} (${s.delivered} device${s.delivered === 1 ? "" : "s"})`).join(", ")}
        </p>
      )}
      <p className="whitespace-pre-wrap text-sm leading-relaxed" data-testid="digest-branch">{c.narrative.branch}</p>
      {c.narrative.highlights.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {c.narrative.highlights.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Site</th>
              {COLUMNS.map(([k, label]) => <th key={k} className="px-2 py-1.5 text-right font-medium">{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="font-semibold" data-testid="digest-branch-row">
              <td className="px-2 py-1.5">Branch</td>
              {COLUMNS.map(([k]) => <td key={k} className="px-2 py-1.5 text-right tabular-nums">{n.branch[k]}</td>)}
            </tr>
            {n.sites.map((s) => (
              <tr key={s.siteId} className="align-top">
                <td className="px-2 py-1.5">
                  <div>{s.name || siteName(s.siteId)}</div>
                  {summaryOf.get(s.siteId) && <div className="text-xs text-muted-foreground">{summaryOf.get(s.siteId)}</div>}
                </td>
                {COLUMNS.map(([k]) => <td key={k} className="px-2 py-1.5 text-right tabular-nums">{s[k] || ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {n.moves.length > 0 && (
        <p className="text-sm">
          <span className="font-semibold">Rollout moves: </span>
          {n.moves.map((m) => `${m.name}: ${m.from} → ${m.to}`).join(" · ")}
        </p>
      )}
    </article>
  );
}
