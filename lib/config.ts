export const APP_NAME = "SiteSync";
export const COMPANY_NAME = "Demo Electrical Co.";
export const THEME_COLOR = "#0f172a";
/** Branch timezone used for Overdue / Today / Next 7 days grouping (single branch on Day 1). */
/** Demo-mode identity cookie (no real login). Read by GET /api/media/[noteId]. */
export const ACTOR_COOKIE = "sitesync_actor";
export const BRANCH_TIMEZONE = "America/New_York";
/** Routes that must load with no network after the first visit. */
export const OFFLINE_ROUTES = [
  "/",
  "/field",
  "/field/task",
  "/field/clock",
  "/field/notes",
  "/field/me",
  "/field/request",
  "/debug",
  "/~offline",
] as const;

/** Reported by devices to /api/sync (shown in the office as the app version per device). */
export const APP_VERSION = "0.3.0";
/** Office cookie (demo mode): who is using /office in this browser. Separate from the field actor. */
export const OFFICE_ACTOR_COOKIE = "sitesync_office_actor";
/** Tasks sent longer ago than this without "Got it" are highlighted (Day 4 escalates them). */
export const ACK_WARN_MINUTES = 30;
/** Office dashboard polling interval (paused while the tab is hidden). */
export const OFFICE_POLL_MS = 5_000;
/**
 * Expected days a rollout store spends in each stage. A store in its stage for
 * longer is "behind schedule" (rule-based; no AI). `done` has no limit.
 */
export const ROLLOUT_STAGE_EXPECTED_DAYS = {
  survey: 3,
  materials_shipped: 5,
  install: 7,
  punch_list: 4,
  closeout: 5,
  done: null,
} as const;
