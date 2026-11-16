export const APP_NAME = "SiteSync";
export const COMPANY_NAME = "Demo Electrical Co.";
export const THEME_COLOR = "#0f172a";
/** Branch timezone used for Today / This Week grouping (single branch on Day 1). */
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
