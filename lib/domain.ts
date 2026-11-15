// Shared enum values. Used by the Drizzle schema (pgEnum), the Zod event
// schemas and the client. Keep this file free of runtime dependencies.

export const ROLES = ["technician", "foreman", "coordinator", "hr", "manager"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that see everything. Field roles see only their own work. */
export const OFFICE_ROLES: readonly Role[] = ["coordinator", "hr", "manager"];
export const FIELD_ROLES: readonly Role[] = ["technician", "foreman"];
export const isOfficeRole = (role: Role) => OFFICE_ROLES.includes(role);

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
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Day 4+ (escalation ladder). Defined now so the schema is stable. */
export const ESCALATION_CHANNELS = ["push", "sms", "coordinator_alert"] as const;
export const ESCALATION_STATUSES = ["pending", "sent", "resolved", "cancelled"] as const;

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
