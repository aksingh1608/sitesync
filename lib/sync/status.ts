// One source of truth for "how is sync doing", used by the top sync bar and the
// Me page. Pure, so it is unit tested.
//
// No signal is not an error: changes are safe in the outbox and will go out by
// themselves. Real errors are shown only when the device is online AND the
// failure is not a network failure.
import type { LastSyncResult, Meta } from "../db/local";

export type SyncTone = "loading" | "offline" | "error" | "waiting" | "ok";

export type SyncView = {
  tone: SyncTone;
  /** Short text for the top bar. */
  headline: string;
  /** Calm sentence for the Me page / screen readers. */
  detail: string;
  /** "8:39 PM"-style label of the last successful sync, or null if never / unknown. */
  lastSyncAt: string | null;
  /** A real error to show (online, not a network failure), else null. */
  error: string | null;
  pending: number;
  /** "3 waiting to sync · 1 upload" or "All saved". */
  waiting: string;
};

export const NO_SIGNAL_TEXT = "No signal. Changes are saved and will sync automatically.";

/** Errors that mean "couldn't reach the server", across Chrome, Safari and Firefox. */
export function isNetworkError(message: string): boolean {
  return /failed to fetch|load failed|networkerror|network request failed|the network connection was lost|timed? ?out|aborted|err_internet_disconnected|err_network/i.test(
    message,
  );
}

export function describeSync(input: {
  meta: Pick<Meta, "lastSyncAt" | "lastSyncResult" | "simulateOffline"> | undefined;
  online: boolean;
  pending: number;
  uploads: number;
  formatClock: (iso: string) => string;
  busy?: boolean;
}): SyncView {
  const { meta, online, pending, uploads } = input;
  const waiting = pending + uploads;
  const waitingText = waiting
    ? `${pending} waiting to sync${uploads ? ` · ${uploads} upload${uploads > 1 ? "s" : ""}` : ""}`
    : "All saved";
  if (!meta) {
    return { tone: "loading", headline: "Loading…", detail: "Loading…", lastSyncAt: null, error: null, pending, waiting: "" };
  }
  const lastSyncAt = meta.lastSyncAt ? input.formatClock(meta.lastSyncAt) : null;
  const last: LastSyncResult | null = meta.lastSyncResult;
  const offline = !online || meta.simulateOffline;
  const networkFailure = last?.status === "error" && isNetworkError(last.error);

  if (offline || networkFailure) {
    return {
      tone: "offline",
      headline: meta.simulateOffline ? "Offline (simulated)" : "No signal",
      detail: waiting ? `${NO_SIGNAL_TEXT} ${waitingText}.` : NO_SIGNAL_TEXT,
      lastSyncAt,
      error: null,
      pending,
      waiting: waitingText,
    };
  }
  if (input.busy) {
    return { tone: waiting ? "waiting" : "ok", headline: "Syncing…", detail: waitingText, lastSyncAt, error: null, pending, waiting: waitingText };
  }
  if (last?.status === "error") {
    return {
      tone: "error",
      headline: `Sync failed · retry ${input.formatClock(last.retryAt)}`,
      detail: "Sync failed. Changes are saved on this device and will be retried.",
      lastSyncAt,
      error: last.error,
      pending,
      waiting: waitingText,
    };
  }
  return {
    tone: waiting ? "waiting" : "ok",
    headline: lastSyncAt ? `Synced ${lastSyncAt}` : "Not synced yet",
    detail: waitingText,
    lastSyncAt,
    error: null,
    pending,
    waiting: waitingText,
  };
}
