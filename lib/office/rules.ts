// Pure rules for the office dashboard. No I/O, so they are unit tested and run
// the same on the server (API routes) and in the browser.
import { ACK_WARN_MINUTES, ROLLOUT_STAGE_EXPECTED_DAYS } from "../config";
import { isFieldRole, TERMINAL_STATUSES, type Role, type RolloutStage, type TaskStatus, type Trade } from "../domain";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------
export const RECEIPT_STAGES = ["sent", "delivered", "seen", "acknowledged"] as const;
export type ReceiptStage = (typeof RECEIPT_STAGES)[number];

type ReceiptLike = {
  sentAt: Date | string;
  deliveredAt: Date | string | null;
  seenAt: Date | string | null;
  acknowledgedAt: Date | string | null;
};

/** The furthest stage reached (later stages imply earlier ones). */
export function receiptStage(r: ReceiptLike | null | undefined): ReceiptStage {
  if (!r) return "sent";
  if (r.acknowledgedAt) return "acknowledged";
  if (r.seenAt) return "seen";
  if (r.deliveredAt) return "delivered";
  return "sent";
}

/** Sent more than ACK_WARN_MINUTES ago, still open, and nobody tapped "Got it". */
export function ackOverdue(
  task: { status: TaskStatus },
  r: ReceiptLike | null | undefined,
  now: Date,
  minutes = ACK_WARN_MINUTES,
): boolean {
  if (!r || r.acknowledgedAt || TERMINAL_STATUSES.includes(task.status)) return false;
  return now.getTime() - time(r.sentAt)! > minutes * MIN;
}

// ---------------------------------------------------------------------------
// Freshness ("last synced X ago", never a guessed online dot)
// ---------------------------------------------------------------------------
export function agoLabel(at: Date | string | null | undefined, now: Date): string {
  const t = time(at);
  if (t === null) return "never synced";
  const ms = Math.max(0, now.getTime() - t);
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const d = Math.floor(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** How stale a device is: fresh < 15 min, stale < 2 h, else old. Drives the colour only. */
export function freshness(at: Date | string | null | undefined, now: Date): "fresh" | "stale" | "old" {
  const t = time(at);
  if (t === null) return "old";
  const ms = now.getTime() - t;
  return ms < 15 * MIN ? "fresh" : ms < 2 * HOUR ? "stale" : "old";
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------
export const STAGE_LABEL: Record<RolloutStage, string> = {
  survey: "Survey",
  materials_shipped: "Materials shipped",
  install: "Install",
  punch_list: "Punch list",
  closeout: "Closeout",
  done: "Done",
};

export function stageAgeDays(stageChangedAt: Date | string | null | undefined, now: Date): number | null {
  const t = time(stageChangedAt);
  return t === null ? null : Math.floor((now.getTime() - t) / DAY);
}

/** In its stage longer than ROLLOUT_STAGE_EXPECTED_DAYS (rule-based). */
export function behindSchedule(
  site: { rolloutStage: RolloutStage | null; stageChangedAt: Date | string | null },
  now: Date,
): { behind: boolean; days: number | null; expected: number | null } {
  const expected = site.rolloutStage ? ROLLOUT_STAGE_EXPECTED_DAYS[site.rolloutStage] : null;
  const t = time(site.stageChangedAt);
  if (expected === null || t === null) return { behind: false, days: stageAgeDays(site.stageChangedAt, now), expected };
  const days = (now.getTime() - t) / DAY;
  return { behind: days > expected, days: Math.floor(days), expected };
}

/** Share of stores done, plus a weighted progress over all stages (0..1). */
export function rolloutProgress(stages: (RolloutStage | null)[], order: readonly RolloutStage[]) {
  const n = stages.length;
  if (!n) return { done: 0, total: 0, weighted: 0 };
  const last = order.length - 1;
  const weighted = stages.reduce((sum, s) => sum + (s ? order.indexOf(s) / last : 0), 0) / n;
  return { done: stages.filter((s) => s === "done").length, total: n, weighted };
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------
/** An open entry older than this is a forgotten clock-out. */
export const MISSING_CLOCK_OUT_HOURS = 14;

type EntryLike = {
  clockInAt: Date | string;
  clockOutAt: Date | string | null;
  flagged: boolean;
  flagReason: string | null;
  reviewStatus: "approved" | "rejected" | null;
};

export function entryHours(e: EntryLike, now: Date): number {
  const end = time(e.clockOutAt) ?? now.getTime();
  return Math.max(0, end - time(e.clockInAt)!) / HOUR;
}

export type EntryFlag = "outside_geofence" | "no_location" | "missing_clock_out";
export const FLAG_LABEL: Record<EntryFlag, string> = {
  outside_geofence: "Too far from site",
  no_location: "Location unavailable",
  missing_clock_out: "Missing clock-out",
};

export function entryFlags(e: EntryLike, now: Date): EntryFlag[] {
  const flags: EntryFlag[] = [];
  if (e.flagged && e.flagReason?.startsWith("outside_geofence")) flags.push("outside_geofence");
  if (e.flagged && e.flagReason?.startsWith("no_location")) flags.push("no_location");
  if (!e.clockOutAt && now.getTime() - time(e.clockInAt)! > MISSING_CLOCK_OUT_HOURS * HOUR) flags.push("missing_clock_out");
  return flags;
}

/** Flagged and not yet decided by HR: listed first, under "Needs review". */
export const needsReview = (e: EntryLike, now: Date) => e.reviewStatus === null && entryFlags(e, now).length > 0;

/** RFC 4180 CSV (quotes, commas, newlines), CRLF line endings, as Excel expects. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Task creation: who should get it?
// ---------------------------------------------------------------------------
type PersonLike = { id: string; name: string; role: Role; trade: Trade; active: boolean };

/** Default trade filter for a site: rollout stores are lighting work, the rest electrical. */
export const defaultTradeFor = (siteKind: string | undefined): Trade | "any" =>
  siteKind === "rollout_store" ? "lighting" : siteKind ? "electrical" : "any";

/**
 * Active field workers whose trade fits ("general" fits everything), people
 * already working at the site first (open tasks there, or clocked in there),
 * then fewest open tasks, then name.
 */
export function suggestAssignees<P extends PersonLike>(input: {
  people: P[];
  trade: Trade | "any";
  siteId: string | null;
  openTasks: { assigneeId: string; siteId: string }[];
  clockedInAt: Map<string, string>; // personId -> siteId
}): (P & { atSite: boolean; openCount: number })[] {
  const fits = (p: P) => input.trade === "any" || p.trade === input.trade || p.trade === "general";
  return input.people
    .filter((p) => p.active && isFieldRole(p.role) && fits(p))
    .map((p) => {
      const mine = input.openTasks.filter((t) => t.assigneeId === p.id);
      const atSite = !!input.siteId && (input.clockedInAt.get(p.id) === input.siteId || mine.some((t) => t.siteId === input.siteId));
      return { ...p, atSite, openCount: mine.length };
    })
    .sort((a, b) => Number(b.atSite) - Number(a.atSite) || a.openCount - b.openCount || a.name.localeCompare(b.name));
}

/** Median of a list (null when empty). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
