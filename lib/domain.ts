// Shared enum values. Used by the Drizzle schema (pgEnum), the Zod event
// schemas and the client. Keep this file free of runtime dependencies.

export const ROLES = ["technician", "foreman", "coordinator", "hr", "manager"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may create tasks for others, reassign, and edit title / due date / priority. */
export const TASK_MANAGER_ROLES: readonly Role[] = ["coordinator", "manager"];
export const canManageTasks = (role: Role) => TASK_MANAGER_ROLES.includes(role);
/** Task kinds anyone may create when they assign them to a coordinator. */
export const REQUEST_TASK_KINDS: readonly TaskKind[] = ["material_request", "follow_up"];

/** Roles that see everything. Field roles see only their own work. */
export const OFFICE_ROLES: readonly Role[] = ["coordinator", "hr", "manager"];
export const FIELD_ROLES: readonly Role[] = ["technician", "foreman"];
export const isOfficeRole = (role: Role) => OFFICE_ROLES.includes(role);
export const isFieldRole = (role: Role) => FIELD_ROLES.includes(role);

/** Roles that may approve / reject timesheets (coordinators may only view them). */
export const TIME_REVIEW_ROLES: readonly Role[] = ["hr", "manager"];
export const canReviewTime = (role: Role) => TIME_REVIEW_ROLES.includes(role);
/** Roles that may move rollout stores between stages and progress material requests. */
export const canManageRollouts = (role: Role) => canManageTasks(role);

export const TRADES = ["electrical", "lighting", "signs", "ev", "general"] as const;
export type Trade = (typeof TRADES)[number];

export const SITE_KINDS = ["construction", "service", "rollout_store"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export const ROLLOUT_STAGES = [
  "survey",
  "materials_shipped",
  "install",
  "punch_list",
  "closeout",
  "done",
] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];
/** A store cannot enter these stages without at least one uploaded photo note on the site. */
export const PHOTO_REQUIRED_STAGES: readonly RolloutStage[] = ["closeout", "done"];

/** Material request progress after it was raised (null = requested). Forward only. */
export const MATERIAL_STATUSES = ["approved", "ordered", "delivered"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

/** HR decision on a time entry (null = not reviewed yet). */
export const TIME_REVIEW_STATUSES = ["approved", "rejected"] as const;
export type TimeReviewStatus = (typeof TIME_REVIEW_STATUSES)[number];

export const TASK_KINDS = ["task", "follow_up", "service_call", "material_request"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/**
 * Allowed status transitions. Terminal states can only be reopened (-> open),
 * and only by an event that is newer than the one that closed the task.
 */
export const STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["in_progress", "blocked", "done", "cancelled"],
  in_progress: ["open", "blocked", "done", "cancelled"],
  blocked: ["open", "in_progress", "done", "cancelled"],
  done: ["open"],
  cancelled: ["open"],
};

export const TASK_SOURCES = ["manual", "dispatch_agent", "report_agent"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const WORKER_STATUSES = ["on_site", "lunch", "traveling", "off"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const NOTE_KINDS = ["text", "voice", "photo"] as const;

/** Why a clock-in/out has no location. */
export const LOCATION_ERRORS = ["denied", "unavailable", "timeout", "unsupported"] as const;
export type LocationError = (typeof LOCATION_ERRORS)[number];

/** Server uploads on Vercel are capped at 4.5 MB per request. */
export const MAX_MEDIA_BYTES = 4_000_000;
export const MAX_VOICE_SECONDS = 120;

/** Entities a person can lose visibility of (see `revocations`). */
export const REVOCABLE_ENTITIES = ["task"] as const;
export type RevocableEntity = (typeof REVOCABLE_ENTITIES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Day 4 escalation ladder (see lib/escalation). */
export const ESCALATION_CHANNELS = ["push", "sms", "coordinator_alert"] as const;
export type EscalationChannel = (typeof ESCALATION_CHANNELS)[number];
/**
 * pending: claimed, being sent. sent: delivered to the provider. failed: the
 * provider refused. skipped: recorded but not sent (no subscription, stale,
 * superseded by a later step). resolved: a coordinator alert that was handled
 * (by a person or automatically). cancelled: unused (kept for the enum).
 */
export const ESCALATION_STATUSES = ["pending", "sent", "resolved", "cancelled", "failed", "skipped"] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];
/** Which rule produced an escalation row. */
export const ESCALATION_RULES = ["ack", "overdue", "blocked", "changed"] as const;
export type EscalationRule = (typeof ESCALATION_RULES)[number];
export const SMS_STATUSES = ["mocked", "queued", "sent", "delivered", "undelivered", "failed"] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

/** Task fields that use per-field last-write-wins. */
export const TASK_LWW_FIELDS = [
  "title",
  "description",
  "siteId",
  "assigneeId",
  "kind",
  "priority",
  "dueAt",
] as const;
export type TaskLwwField = (typeof TASK_LWW_FIELDS)[number];
