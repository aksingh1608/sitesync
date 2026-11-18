"use client";
// Demo control panel (managers): health strip, Reset demo, and the demo steps
// as buttons in the order of docs/demo-script.md.
import Link from "next/link";
import { useState } from "react";
import { postJson, timed } from "@/components/office/agents";
import { UpdatedAgo, usePolling, useSnapshot } from "@/components/office/data";
import { offsetLabel } from "@/components/office/escalations";
import { fmtDateTime, PageHeader } from "@/components/office/ui";
import type { Check, Health } from "@/lib/demo/health";
import { cn } from "@/lib/utils";

type Data = { health: Health; samples: string[] };

export default function DemoPage() {
  const snap = useSnapshot();
  const { data, error, updatedAt, refresh } = usePolling<Data>("/api/office/demo", 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ text: string; href?: string; tone?: "error" }[]>([]);
  const [armed, setArmed] = useState(false);
  const [sample, setSample] = useState(0);
  if (snap.data && snap.data.actor.role !== "manager") return <p className="text-sm text-muted-foreground">Managers only.</p>;

  const say = (text: string, href?: string, tone?: "error") => setLog((l) => [{ text, href, tone }, ...l].slice(0, 8));
  async function step(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
      await Promise.all([refresh(), snap.refresh()]);
    }
  }

  const reset = () =>
    step("reset", async () => {
      if (!armed) return setArmed(true);
      setArmed(false);
      const [r, ms] = await timed(() => postJson<{ seconds: number }>("/api/office/demo/reset", {}));
      if (!r.ok) return say(`Reset failed: ${r.error}. Try again (it is one transaction, nothing half-done).`, undefined, "error");
      say(`Demo reset in ${(ms / 1000).toFixed(1)} s. Now on each phone: Me → "Reset this device", then pick the person again.`);
    });
  const inject = () =>
    step("inject", async () => {
      const text = data?.samples[sample] ?? "";
      const [r, ms] = await timed(() => postJson<{ mode: string; draft: { title: string } }>("/api/office/dispatch", { text }));
      if (!r.ok) return say(`Dispatch failed: ${r.error}`, undefined, "error");
      say(`Draft "${r.data.draft.title}" ready in ${(ms / 1000).toFixed(1)} s (${r.data.mode === "ai" ? "AI" : "fallback"}).`, "/office/dispatch");
      setSample((sample + 1) % (data?.samples.length || 1));
    });
  const clock = (action: "+30m" | "+1h" | "reset") =>
    step(action, async () => {
      const r = await postJson<{ clock: { offsetMs: number }; run: { sent: number; skipped: number; failed: number } }>("/api/office/demo-clock", { action });
      if (!r.ok) return say(`Clock failed: ${r.error}`, undefined, "error");
      say(
        `Demo clock ${offsetLabel(r.data.clock.offsetMs)}. Rules ran: ${r.data.run.sent} sent, ${r.data.run.skipped} skipped, ${r.data.run.failed} failed.`,
        "/office",
      );
    });
  const digest = () =>
    step("digest", async () => {
      const [r, ms] = await timed(() => postJson<{ day: string; mode: string }>("/api/office/digest", {}));
      if (!r.ok) return say(`Digest failed: ${r.error}`, undefined, "error");
      say(`Digest for ${r.data.day} in ${(ms / 1000).toFixed(1)} s (${r.data.mode === "ai" ? "AI" : "template"}).`, `/office/digest?day=${r.data.day}`);
    });

  const h = data?.health;
  return (
    <>
      <PageHeader title="Demo control">
        <UpdatedAgo at={updatedAt} error={error} />
      </PageHeader>

      {h && (
        <section className="mb-4 flex flex-wrap gap-2" aria-label="Health" data-testid="demo-health">
          {[h.db, h.ai, h.transcription, h.push, h.sms, h.budget].map((c) => <HealthPill key={c.label} c={c} />)}
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
            v{h.version.app}
            {h.version.commit && ` · ${h.version.commit}`}
            {h.version.builtAt && ` · built ${fmtDateTime(h.version.builtAt)}`}
            {h.version.deployment && ` · ${h.version.deployment}`}
          </span>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border p-3 text-sm">
          <h2 className="font-semibold">Demo steps, in order</h2>
          <ol className="space-y-2">
            <Step n={1} title="Inject sample service request">
              <select className="h-8 max-w-full rounded-md border bg-background px-2 text-sm" value={sample} onChange={(e) => setSample(Number(e.target.value))}>
                {data?.samples.map((s, i) => <option key={i} value={i}>{s.slice(0, 70)}…</option>)}
              </select>
              <Btn onClick={inject} busy={busy === "inject"} testId="demo-inject">Inject</Btn>
            </Step>
            <Step n={2} title="Open the dispatch draft and approve it">
              <Link href="/office/dispatch" className="h-8 rounded-md border px-3 leading-8 hover:bg-muted">Open dispatch drafts</Link>
            </Step>
            <Step n={3} title="Fast-forward the rules clock: click +30 min three times">
              <Btn onClick={() => clock("+30m")} busy={busy === "+30m"} testId="demo-ff30">+30 min</Btn>
              <span className="text-xs text-muted-foreground">1st: reminder push · 2nd: SMS · 3rd: coordinator alert</span>
            </Step>
            <Step n={4} title="Or jump (skips the SMS step: only the highest due step is sent)">
              <Btn onClick={() => clock("+1h")} busy={busy === "+1h"} testId="demo-ff60" variant="ghost">+1 hour</Btn>
              <Btn onClick={() => clock("reset")} busy={busy === "reset"} variant="ghost">Reset clock</Btn>
            </Step>
            <Step n={5} title="Generate today's digest">
              <Btn onClick={digest} busy={busy === "digest"} testId="demo-digest">Generate digest</Btn>
            </Step>
          </ol>
          <p className="text-xs text-muted-foreground">
            Full script with talking points: docs/demo-script.md. The field-report step is done on the phone (a dictated
            text note); the board and the task drawer show the result.
          </p>
        </section>

        <section className="space-y-3 rounded-lg border p-3 text-sm">
          <h2 className="font-semibold">Reset between runs</h2>
          <p>
            Reseeds the demo data relative to now, resets the demo clock, and clears escalations, the SMS log, agent runs,
            dispatch drafts and digests. Takes about 10 s.
          </p>
          <button
            onClick={reset}
            disabled={!!busy}
            className={cn("h-9 rounded-md px-3 font-medium text-white disabled:opacity-50", armed ? "bg-red-700" : "bg-slate-800")}
            data-testid="demo-reset"
          >
            {busy === "reset" ? "Resetting…" : armed ? "Tap again to wipe and reseed" : "Reset demo"}
          </button>
          <div className="rounded-md bg-muted/60 p-2 text-xs">
            <p className="font-semibold">Then on each phone</p>
            <p>Field app → Me → &ldquo;Reset this device&rdquo; (tap twice) → pick the person again (technician: Sam Novak).</p>
          </div>
          <div className="space-y-1">
            {log.map((l, i) => (
              <p key={i} className={cn("text-xs", l.tone === "error" ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
                {l.text} {l.href && <Link href={l.href} className="underline">Open</Link>}
              </p>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function HealthPill({ c }: { c: Check }) {
  return (
    <span
      title={c.detail}
      className={cn(
        "rounded-md border px-2 py-1 text-xs",
        c.ok === true && "border-green-300 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-100",
        c.ok === false && "border-red-300 bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-100",
        c.ok === null && "border-slate-300 bg-muted text-foreground",
      )}
    >
      <span className="font-semibold">{c.label}:</span> {c.detail}
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="space-y-1">
      <div className="font-medium">
        {n}. {title}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

function Btn({ onClick, busy, children, testId, variant }: { onClick: () => void; busy: boolean; children: React.ReactNode; testId?: string; variant?: "ghost" }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      className={cn("h-8 rounded-md px-3 text-sm disabled:opacity-50", variant === "ghost" ? "border hover:bg-muted" : "bg-primary font-medium text-primary-foreground")}
    >
      {busy ? "…" : children}
    </button>
  );
}
