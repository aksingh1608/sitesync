"use client";
// Shared bits for the Day 5 agent screens: mode badge, the principles note,
// a small POST helper and the ops copilot panel (a drawer on every office page).
import { Bot, Send } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { Role } from "@/lib/domain";
import { cn } from "@/lib/utils";
import { Drawer, ErrorLine, Pill } from "./ui";

export const FALLBACK_LABEL = "Fallback (AI unavailable)";

export function ModeBadge({ mode }: { mode: "ai" | "fallback" | string }) {
  return mode === "ai" ? <Pill tone="blue">AI</Pill> : <Pill tone="amber">{FALLBACK_LABEL}</Pill>;
}

/** The AI coordinator pitch, shown where agents act. */
export function Principles({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-950 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100">
      <p className="font-semibold">How the agents work</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        <li>AI handles messy input; fixed rules handle anything that must be reliable. Agents never send SMS, escalate or approve timesheets.</li>
        <li>Agents suggest, people decide: nothing is assigned to a person without a coordinator&apos;s approval.</li>
        <li>Everything is logged (Agent activity), and every agent write is a normal event in the log.</li>
        <li>If the AI is unavailable, a rule-based fallback runs, labelled &ldquo;{FALLBACK_LABEL}&rdquo;.</li>
      </ul>
      {children}
    </div>
  );
}

export async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: "Access code needed: reload the page." };
      if (res.status === 503) return { ok: false, error: "The database didn't answer. Try again in a few seconds." };
      return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "No connection. Try again when online." };
  }
}

/** Runs `fn` and measures how long it took (ms). */
export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const out = await fn();
  return [out, Math.round(performance.now() - started)];
}

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

// ---------------------------------------------------------------------------
// Minimal markdown for copilot answers: links (internal only), bold, lists.
// ---------------------------------------------------------------------------
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      // Only links into this app: the model must never send the coordinator elsewhere.
      out.push(
        m[2].startsWith("/office/") ? (
          <Link key={`${key}-${i++}`} href={m[2]} className="text-blue-700 underline underline-offset-2 dark:text-blue-300">
            {m[1]}
          </Link>
        ) : (
          m[1]
        ),
      );
    } else out.push(<strong key={`${key}-${i++}`}>{m[3]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: number) => {
    if (!list.length) return;
    blocks.push(
      <ul key={`l${k}`} className="list-disc space-y-0.5 pl-5">
        {list.map((l, j) => (
          <li key={j}>{inline(l, `l${k}-${j}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  text.split("\n").forEach((line, k) => {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) return void list.push(item[1]);
    flush(k);
    if (line.trim()) blocks.push(<p key={`p${k}`}>{inline(line.replace(/^#+\s*/, ""), `p${k}`)}</p>);
  });
  flush(-1);
  return <div className="space-y-1.5">{blocks}</div>;
}

// ---------------------------------------------------------------------------
// Copilot
// ---------------------------------------------------------------------------
type Citation = { kind: "task" | "site" | "person"; id: string; label: string; href: string };
type Answer = { answer: string; citations: Citation[]; mode: "ai" | "fallback"; steps: number; toolCalls: string[] };
type Turn = { q: string; a: Answer | null; error: string | null; ms: number | null };

type CopilotStatus = { ai: boolean; reason: "no_key" | "daily_cap" | null; tools: string[] };

/** Examples per role: HR has no rollout tool, so no rollout question. */
const EXAMPLES: Partial<Record<Role, string[]>> & { default: string[] } = {
  default: ["Who is at the hospital job and what's blocked?", "Which rollout stores are behind?", "Who hasn't acknowledged urgent tasks today?"],
  hr: ["Which timesheets are flagged this week?", "Who is clocked in right now?", "Who hasn't acknowledged urgent tasks today?"],
};

const AI_OFF: Record<NonNullable<CopilotStatus["reason"]>, string> = {
  no_key: "AI is not configured on this server (no Anthropic API key). The copilot still answers with a rule-based lookup (one tool, picked by keywords), labelled \u201cFallback (AI unavailable)\u201d.",
  daily_cap: "Today's AI budget is used up. Until it resets, the copilot answers with a rule-based lookup, labelled \u201cFallback (AI unavailable)\u201d.",
};

export function CopilotButton({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-2 text-sm text-violet-950 hover:bg-violet-100 dark:bg-violet-950 dark:text-violet-100"
        data-testid="copilot-open"
      >
        <Bot className="size-4" /> Ask ops copilot
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Ops copilot">
        <CopilotChat role={role} />
      </Drawer>
    </>
  );
}

function CopilotChat({ role }: { role: Role }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const examples = EXAMPLES[role] ?? EXAMPLES.default;

  useEffect(() => {
    let live = true;
    fetch("/api/office/copilot", { cache: "no-store" })
      .then(async (res) => {
        if (!live) return;
        if (res.ok) return setStatus((await res.json()) as CopilotStatus);
        setStatusError(res.status === 401 ? "Access code needed: reload the page." : res.status === 503 ? "The database didn't answer. Questions may fail; try again in a few seconds." : `Copilot status: HTTP ${res.status}`);
      })
      .catch(() => live && setStatusError("No connection. The copilot needs to be online."));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [turns]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ("");
    setTurns((t) => [...t, { q: question, a: null, error: null, ms: null }]);
    const [r, ms] = await timed(() => postJson<Answer>("/api/office/copilot", { question }));
    setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a: r.ok ? r.data : null, error: r.ok ? null : r.error, ms } : x)));
    setBusy(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-sm" data-testid="copilot">
      <p className="text-xs text-muted-foreground">
        Read-only: it looks things up with fixed queries scoped to your role and cites the records it used. It cannot assign, change or send anything.
        {status && <> Your tools: {status.tools.join(", ")}.</>}
      </p>
      {status && !status.ai && status.reason && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100" data-testid="copilot-ai-off">
          {AI_OFF[status.reason]}
        </p>
      )}
      <ErrorLine error={statusError} />
      <div className="flex flex-wrap gap-1.5">
        {examples.map((e) => (
          <button key={e} disabled={busy} onClick={() => ask(e)} className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50">
            {e}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-3" data-testid="copilot-messages">
        {turns.length === 0 && <p className="text-xs text-muted-foreground">Ask a question below, or tap an example.</p>}
        {turns.map((t, i) => (
          <Fragment key={i}>
            <div className="ml-8 rounded-lg bg-muted px-3 py-2">{t.q}</div>
            <div className="mr-4 space-y-2 rounded-lg border px-3 py-2" data-testid="copilot-answer">
              {!t.a && !t.error && <p className="text-muted-foreground">Looking it up…</p>}
              <ErrorLine error={t.error} />
              {t.a && (
                <>
                  <MiniMarkdown text={t.a.answer} />
                  {t.a.citations.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Records used ({t.a.citations.length})</summary>
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {t.a.citations.map((c) => (
                          <li key={`${c.kind}:${c.id}`}>
                            <Link href={c.href} className="rounded border px-1.5 py-0.5 hover:bg-muted">
                              {c.kind}: {c.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ModeBadge mode={t.a.mode} />
                    {t.a.toolCalls.length > 0 && <span>tools: {t.a.toolCalls.join(", ")}</span>}
                    {t.ms !== null && <span>{(t.ms / 1000).toFixed(1)} s</span>}
                  </div>
                </>
              )}
            </div>
          </Fragment>
        ))}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
        className={cn("sticky bottom-0 -mb-4 flex gap-2 border-t bg-background py-3")}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about sites, tasks, workers, rollouts…"
          maxLength={500}
          className="h-9 flex-1 rounded-md border bg-background px-2"
          data-testid="copilot-input"
        />
        <button disabled={busy || q.trim().length < 3} className="flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">
          <Send className="size-4" /> Ask
        </button>
      </form>
    </div>
  );
}
