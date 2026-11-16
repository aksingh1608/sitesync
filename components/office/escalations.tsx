"use client";
// Day 4 office pieces: the demo clock bar, office push opt-in, the alerts
// panel on the board and the escalation timeline in the task drawer.
import { useEffect, useState } from "react";
import type { ClockAction } from "@/lib/clock";
import { canManageTasks } from "@/lib/domain";
import { disablePush, enablePush, pushSupport, refreshPush, type PushSupport } from "@/lib/push/client";
import { cn } from "@/lib/utils";
import { useSnapshot, webDeviceId, type Json, type Snap } from "./data";
import { ErrorLine, fmtDateTime, fmtTime, Pill } from "./ui";
import type { TaskDetail } from "@/lib/office/queries";

async function post(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: res.status === 503 ? "The database didn't answer; try again." : (data.error ?? `HTTP ${res.status}`) };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "No connection." };
  }
}

export function offsetLabel(ms: number): string {
  if (!ms) return "real time";
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return `+${h ? `${h} h ` : ""}${m % 60 ? `${m % 60} min` : ""}`.trim();
}

// ---------------------------------------------------------------------------
// Demo clock (managers and coordinators)
// ---------------------------------------------------------------------------
const STEPS: { action: ClockAction; label: string }[] = [
  { action: "+15m", label: "+15 min" },
  { action: "+30m", label: "+30 min" },
  { action: "+1h", label: "+1 hour" },
  { action: "reset", label: "Reset clock" },
];

export function DemoClockBar() {
  const { data, refresh } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  if (!data || !canManageTasks(data.actor.role)) return null;
  const offset = data.clock.offsetMs;

  async function move(action: ClockAction) {
    setBusy(true);
    setError(null);
    const r = await post("/api/office/demo-clock", { action });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const run = (r.data as { run: { sent: number; skipped: number; failed: number; resolved: number } }).run;
    setLast(`Rules ran: ${run.sent} sent, ${run.failed} failed, ${run.skipped} skipped, ${run.resolved} closed.`);
    await refresh();
  }

  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        offset ? "border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40" : "bg-muted/30",
      )}
      data-testid="demo-clock"
    >
      <span className="font-semibold">Demo clock</span>
      <span className="tabular-nums" data-testid="demo-clock-now">
        {fmtTime(data.now)} ({offsetLabel(offset)})
      </span>
      <span className="text-xs text-muted-foreground">Fast-forward moves the escalation rules&apos; clock only.</span>
      <div className="ml-auto flex flex-wrap gap-1.5">
        {STEPS.map((s) => (
          <button
            key={s.action}
            disabled={busy || (s.action === "reset" && !offset)}
            onClick={() => move(s.action)}
            className="h-7 rounded-md border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
            data-testid={`clock-${s.action}`}
          >
            {s.label}
          </button>
        ))}
        <OfficePushButton />
      </div>
      {last && <span className="w-full text-xs text-muted-foreground" data-testid="clock-last-run">{last}</span>}
      <ErrorLine error={error} />
    </div>
  );
}

/** Coordinators get pushes for alerts, blocked tasks and material requests. */
function OfficePushButton() {
  const [s, setS] = useState<PushSupport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushSupport().then(setS);
    void refreshPush("office", webDeviceId());
  }, []);
  if (!s || s.state === "unsupported" || s.state === "ios-not-installed") return null;
  if (s.state === "denied") return <span className="text-xs text-muted-foreground">Notifications blocked in this browser</span>;
  const toggle = async () => {
    setError(null);
    try {
      if (s.subscribed) await disablePush();
      else await enablePush("office", webDeviceId());
    } catch (e) {
      setError((e as Error).message);
    }
    setS(await pushSupport());
  };
  return (
    <>
      <button onClick={toggle} className="h-7 rounded-md border bg-background px-2 text-xs hover:bg-muted" data-testid="office-push">
        {s.subscribed ? "Notifications on (turn off)" : "Enable notifications"}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Alerts panel (board)
// ---------------------------------------------------------------------------
export const LEVEL_LABEL = (rule: string, level: number, channel: string) =>
  rule === "ack"
    ? (["First push", "Push again", "SMS", "Coordinator alert"][level] ?? `Level ${level}`)
    : rule === "overdue"
      ? level === 1
        ? "Overdue reminder"
        : "Overdue: coordinator alert"
      : rule === "blocked"
        ? level === 0
          ? "Blocked: coordinators told"
          : "Blocked > 2 h: coordinator alert"
        : channel === "push"
          ? "Change notice"
          : `Level ${level}`;

export function AlertsPanel({ snap }: { snap: Snap }) {
  const { refresh } = useSnapshot();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canHandle = canManageTasks(snap.actor.role);
  const byTask = new Map<string, Snap["escalations"]>();
  for (const e of snap.escalations) byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), e]);
  const groups = [...byTask.entries()]
    .map(([taskId, rows]) => ({ taskId, rows, top: Math.max(...rows.map((r) => (r.channel === "coordinator_alert" ? 10 : r.level))) }))
    .sort((a, b) => b.top - a.top);
  const task = (id: string) => snap.tasks.find((t) => t.id === id);
  const person = (id: string) => snap.people.find((p) => p.id === id)?.name ?? "?";

  async function handle(taskId: string) {
    setBusy(taskId);
    const r = await post("/api/office/escalations/handle", { taskId });
    setBusy(null);
    setError(r.ok ? null : r.error);
    await refresh();
  }

  return (
    <section className="rounded-lg border p-3" data-testid="alerts-panel">
      <header className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Alerts</h2>
        <span className="text-xs text-muted-foreground">
          Open escalations, highest first. They close themselves when the task is acknowledged, done or unblocked.
        </span>
      </header>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing escalated right now.</p>
      ) : (
        <ul className="divide-y">
          {groups.map(({ taskId, rows }) => {
            const t = task(taskId);
            const alert = rows.find((r) => r.channel === "coordinator_alert");
            return (
              <li key={taskId} className="flex flex-wrap items-start gap-2 py-2 text-sm" data-testid="alert-row">
                <div className="min-w-0 flex-1">
                  <a href={`/office/tasks?task=${taskId}`} className="font-medium hover:underline">
                    {t?.title ?? "Task"}
                  </a>
                  <div className="text-xs text-muted-foreground">
                    {t ? `${person(t.assigneeId)} · ${t.priority}` : ""} · {alert?.reason ?? rows[0].reason}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {rows
                      .slice()
                      .sort((a, b) => a.level - b.level)
                      .map((r) => (
                        <Pill key={r.id} tone={r.channel === "coordinator_alert" ? "red" : r.status === "failed" ? "amber" : "slate"}>
                          {LEVEL_LABEL(r.rule, r.level, r.channel)} {fmtTime(r.sentAt)}
                          {r.status === "failed" ? " (failed)" : ""}
                        </Pill>
                      ))}
                  </div>
                </div>
                {canHandle && (
                  <button
                    disabled={busy === taskId}
                    onClick={() => handle(taskId)}
                    className="h-7 shrink-0 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-50"
                    data-testid="mark-handled"
                  >
                    Mark handled
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Escalation timeline (task drawer)
// ---------------------------------------------------------------------------
type Esc = Json<TaskDetail["escalations"][number]>;
const STATUS_TONE: Record<string, "slate" | "green" | "amber" | "red" | "blue"> = {
  sent: "green",
  resolved: "blue",
  failed: "red",
  skipped: "slate",
  pending: "amber",
};
const SKIP_TEXT: Record<string, string> = {
  stale: "not pushed: older than an hour when first seen",
  superseded: "not sent: a later step was due at the same time",
};

export function EscalationTimeline({ rows, people }: { rows: Esc[]; people: Map<string, { name: string }> }) {
  if (rows.length === 0) return <p className="text-muted-foreground">No notifications or escalations yet.</p>;
  return (
    <ol className="space-y-1 border-l pl-3" data-testid="escalation-timeline">
      {rows.map((e) => {
        const d = (e.detail ?? {}) as { title?: string; body?: string; resolvedBy?: string; why?: string };
        return (
          <li key={e.id}>
            <span className="font-medium">{LEVEL_LABEL(e.rule, e.level, e.channel)}</span>{" "}
            <Pill tone={STATUS_TONE[e.status] ?? "slate"}>{e.status}</Pill>
            {e.sms && <span className="text-xs text-muted-foreground"> · SMS {e.sms.provider} to {e.sms.toMasked} ({e.sms.status})</span>}
            <div className="text-xs text-muted-foreground">
              {fmtDateTime(e.sentAt ?? e.scheduledFor)} (demo clock) · {e.reason}
              {e.channel !== "sms" && e.providerId ? ` · ${e.providerId}` : ""}
              {e.error ? ` · ${SKIP_TEXT[e.error] ?? e.error}` : ""}
            </div>
            {d.title && e.channel !== "sms" && <div className="text-xs">“{d.title}: {d.body}”</div>}
            {e.resolvedAt && (
              <div className="text-xs text-muted-foreground">
                Closed {fmtDateTime(e.resolvedAt)}: {e.handledBy ? `handled by ${people.get(e.handledBy)?.name ?? "?"}` : d.why}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
