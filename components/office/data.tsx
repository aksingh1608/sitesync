"use client";
// Office data plumbing: polling reads (every 5 s, paused while the tab is
// hidden) and writes that go through POST /api/sync as events, exactly like a
// phone, from a stable per-browser web device id.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { APP_VERSION, OFFICE_POLL_MS } from "@/lib/config";
import type { EventDraft } from "@/lib/events";
import type { OfficeActor } from "@/lib/office/auth";
import type { Snapshot } from "@/lib/office/queries";
import { uuidv4 } from "@/lib/uuid";

/** JSON over the wire: Dates arrive as strings. */
export type Json<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
export type Snap = Json<Snapshot> & { actor: OfficeActor };

export function usePolling<T>(url: string | null, ms = OFFICE_POLL_MS) {
  // Keyed by url, so switching views never shows the previous view's data.
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null; at: number | null }>({
    url: null,
    data: null,
    error: null,
    at: null,
  });
  const inFlight = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  const load = useCallback(async (u: string) => {
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    try {
      const res = await fetch(u, { cache: "no-store", signal: ctl.signal });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          res.status === 401 && body.error === "access_code_required"
            ? "Access code needed: reload the page"
            : body.error === "pick_a_person"
              ? "Pick a person at the top"
              : `HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`,
        );
      }
      const json = (await res.json()) as T;
      if (urlRef.current !== u) return; // the view changed while this was loading
      setState({ url: u, data: json, error: null, at: Date.now() });
    } catch (e) {
      if ((e as Error).name === "AbortError" || urlRef.current !== u) return;
      const error = navigator.onLine === false ? "Offline: the dashboard needs a connection" : (e as Error).message;
      setState((s) => ({ url: u, data: s.url === u ? s.data : null, at: s.url === u ? s.at : null, error }));
    }
  }, []);

  useEffect(() => {
    urlRef.current = url;
    if (!url) return;
    const first = window.setTimeout(() => void load(url), 0);
    const tick = () => document.visibilityState === "visible" && void load(url);
    const timer = window.setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      inFlight.current?.abort();
    };
  }, [url, ms, load]);

  const refresh = useCallback(async () => {
    if (urlRef.current) await load(urlRef.current);
  }, [load]);
  const current = state.url === url;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    updatedAt: current ? state.at : null,
    refresh,
  };
}

/** Re-renders every second, for "Updated 3s ago". */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function UpdatedAgo({ at, error }: { at: number | null; error: string | null }) {
  const now = useNow();
  if (error) return <span className="text-destructive">{error}</span>;
  if (!at) return <span className="text-muted-foreground">Loading…</span>;
  const s = Math.max(0, Math.round((now - at) / 1000));
  return (
    <span className={s > 20 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"} data-testid="updated-ago">
      Updated {s < 60 ? `${s}s` : `${Math.floor(s / 60)} min`} ago
    </span>
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const DEVICE_KEY = "sitesync_web_device";
let memoryDeviceId: string | null = null;

/** One id per browser profile, so the event history shows "from the office laptop". */
export function webDeviceId(): string {
  try {
    const v = window.localStorage.getItem(DEVICE_KEY);
    if (v) return v;
    const id = `web-${uuidv4()}`;
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    memoryDeviceId ??= `web-${uuidv4()}`;
    return memoryDeviceId;
  }
}

const REASON_TEXT: Record<string, string> = {
  forbidden: "Your role can't do that.",
  stage_conflict: "Someone else moved this store first. The board is refreshed; try again.",
  photo_required: "This store needs at least one photo note before Closeout.",
  entry_open: "This entry has no clock-out yet: reject it, or wait for the clock-out.",
  invalid_transition: "That step isn't allowed from the current state.",
  assignee_inactive: "That person is inactive.",
  task_cancelled: "The request was cancelled.",
};

/** A human sentence for a rejection reason ("photo_required: …" -> text). */
export function reasonText(reason: string): string {
  const code = reason.split(":")[0];
  if (code === "invalid_event") return `Invalid input (${reason.slice(reason.indexOf(":") + 1).trim()}).`;
  return REASON_TEXT[code] ?? reason;
}

export type WriteResult = { ok: true } | { ok: false; error: string };

export async function sendEvents(actorId: string, drafts: EventDraft[]): Promise<WriteResult> {
  const deviceId = webDeviceId();
  const evs = drafts.map((d) => ({ ...d, id: uuidv4(), actorId, deviceId, clientTs: new Date().toISOString() }));
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, actorId, cursor: null, events: evs, appVersion: APP_VERSION, pull: false }),
    });
    const body = (await res.json().catch(() => ({}))) as { rejected?: { reason: string }[]; error?: string };
    if (!res.ok) return { ok: false, error: res.status === 401 ? "Access code needed: reload the page" : `Server error (${body.error ?? res.status})` };
    if (body.rejected?.length) return { ok: false, error: reasonText(body.rejected[0].reason) };
    return { ok: true };
  } catch {
    return { ok: false, error: "No connection. Nothing was changed; try again when online." };
  }
}

// ---------------------------------------------------------------------------
// Shared snapshot context (board, tasks, rollouts, materials)
// ---------------------------------------------------------------------------
type Ctx = ReturnType<typeof usePolling<Snap>> & {
  send: (drafts: EventDraft[]) => Promise<WriteResult>;
};
const SnapshotContext = createContext<Ctx | null>(null);

export function SnapshotProvider({ actorId, children }: { actorId: string; children: ReactNode }) {
  const poll = usePolling<Snap>("/api/office/snapshot");
  const { refresh } = poll;
  const send = useCallback(
    async (drafts: EventDraft[]) => {
      const r = await sendEvents(actorId, drafts);
      await refresh(); // show the result (or the state that caused a rejection) right away
      return r;
    },
    [actorId, refresh],
  );
  return <SnapshotContext.Provider value={{ ...poll, send }}>{children}</SnapshotContext.Provider>;
}

export function useSnapshot(): Ctx {
  const c = useContext(SnapshotContext);
  if (!c) throw new Error("useSnapshot outside SnapshotProvider");
  return c;
}
