import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  ESCALATION_CHANNELS,
  ESCALATION_STATUSES,
  NOTE_KINDS,
  ROLES,
  ROLLOUT_STAGES,
  SITE_KINDS,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  TRADES,
  WORKER_STATUSES,
  type EscalationRule,
  type MaterialStatus,
  type SmsStatus,
  type RevocableEntity,
  type TaskLwwField,
  type TimeReviewStatus,
} from "../domain";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const roleEnum = pgEnum("role", ROLES);
export const tradeEnum = pgEnum("trade", TRADES);
export const siteKindEnum = pgEnum("site_kind", SITE_KINDS);
export const rolloutStageEnum = pgEnum("rollout_stage", ROLLOUT_STAGES);
export const taskKindEnum = pgEnum("task_kind", TASK_KINDS);
export const taskPriorityEnum = pgEnum("task_priority", TASK_PRIORITIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const taskSourceEnum = pgEnum("task_source", TASK_SOURCES);
export const workerStatusEnum = pgEnum("worker_status", WORKER_STATUSES);
export const noteKindEnum = pgEnum("note_kind", NOTE_KINDS);
export const escalationChannelEnum = pgEnum("escalation_channel", ESCALATION_CHANNELS);
export const escalationStatusEnum = pgEnum("escalation_status", ESCALATION_STATUSES);

// ---------------------------------------------------------------------------
// Sync cursor
// ---------------------------------------------------------------------------
/**
 * One shared sequence for every projection row. Each write sets
 * `seq = nextval('sync_seq')`, so a client can pull "everything with
 * seq > cursor" across all tables with a single number.
 */
export const syncSeq = pgSequence("sync_seq");

const seq = () =>
  bigint("seq", { mode: "number" })
    .notNull()
    .default(sql`nextval('sync_seq')`);

const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Per-field last-write-wins bookkeeping: the winning event for each field. */
export type FieldStamp = { ts: string; ev: string };
export type TaskFieldStamps = Partial<Record<TaskLwwField | "status", FieldStamp>>;

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
export const branches = pgTable("branches", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
});

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    role: roleEnum("role").notNull(),
    trade: tradeEnum("trade").notNull(),
    phone: text("phone"),
    active: boolean("active").notNull().default(true),
    seq: seq(),
  },
  (t) => [index("people_seq_idx").on(t.seq)],
);

export const rollouts = pgTable(
  "rollouts",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    customerName: text("customer_name").notNull(),
    scope: text("scope").notNull(),
    targetEndDate: date("target_end_date", { mode: "string" }),
    seq: seq(),
  },
  (t) => [index("rollouts_seq_idx").on(t.seq)],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    kind: siteKindEnum("kind").notNull(),
    address: text("address").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(150),
    rolloutId: uuid("rollout_id").references(() => rollouts.id),
    rolloutStage: rolloutStageEnum("rollout_stage"),
    /** When the store entered its current stage (site.stage_changed); drives "behind schedule". */
    stageChangedAt: tsz("stage_changed_at"),
    seq: seq(),
  },
  (t) => [index("sites_seq_idx").on(t.seq), index("sites_rollout_idx").on(t.rolloutId)],
);

// ---------------------------------------------------------------------------
// Projections (derived from events by lib/sync/reducers.ts)
// ---------------------------------------------------------------------------
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    assigneeId: uuid("assignee_id")
      .notNull()
      .references(() => people.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => people.id),
    kind: taskKindEnum("kind").notNull().default("task"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    status: taskStatusEnum("status").notNull().default("open"),
    dueAt: tsz("due_at"),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id),
    source: taskSourceEnum("source").notNull().default("manual"),
    createdAt: tsz("created_at").notNull(),
    updatedAt: tsz("updated_at").notNull(),
    /** Winning (clientTs, eventId) per field, for last-write-wins merges. */
    fieldTs: jsonb("field_ts").$type<TaskFieldStamps>().notNull().default({}),
    /** material_request only: progress after it was raised (null = requested). */
    materialStatus: text("material_status").$type<MaterialStatus>(),
    materialStatusAt: tsz("material_status_at"),
    seq: seq(),
  },
  (t) => [
    index("tasks_seq_idx").on(t.seq),
    index("tasks_assignee_idx").on(t.assigneeId),
    index("tasks_created_by_idx").on(t.createdBy),
    index("tasks_site_idx").on(t.siteId),
  ],
);

export const taskReceipts = pgTable(
  "task_receipts",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    sentAt: tsz("sent_at").notNull(),
    deliveredAt: tsz("delivered_at"),
    seenAt: tsz("seen_at"),
    acknowledgedAt: tsz("acknowledged_at"),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.personId] }),
    index("task_receipts_seq_idx").on(t.seq),
    index("task_receipts_person_idx").on(t.personId),
  ],
);

export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    clockInAt: tsz("clock_in_at").notNull(),
    clockInLat: doublePrecision("clock_in_lat"),
    clockInLng: doublePrecision("clock_in_lng"),
    clockInAccuracyM: doublePrecision("clock_in_accuracy_m"),
    /** Server-computed haversine distance to the site, in metres. */
    clockInDistanceM: doublePrecision("clock_in_distance_m"),
    clockOutAt: tsz("clock_out_at"),
    clockOutLat: doublePrecision("clock_out_lat"),
    clockOutLng: doublePrecision("clock_out_lng"),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    safetyCheckDone: boolean("safety_check_done").notNull().default(false),
    /** HR review (time.approved / time.rejected). Null = not reviewed yet. */
    reviewStatus: text("review_status").$type<TimeReviewStatus>(),
    reviewedBy: uuid("reviewed_by").references(() => people.id),
    reviewedAt: tsz("reviewed_at"),
    reviewReason: text("review_reason"),
    seq: seq(),
  },
  (t) => [index("time_entries_seq_idx").on(t.seq), index("time_entries_person_idx").on(t.personId)],
);

export const statusUpdates = pgTable(
  "status_updates",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    /** Null means the worker cleared their (optional) status. */
    status: workerStatusEnum("status"),
    note: text("note"),
    at: tsz("at").notNull(),
    seq: seq(),
  },
  (t) => [index("status_updates_seq_idx").on(t.seq), index("status_updates_person_idx").on(t.personId)],
);

export const fieldNotes = pgTable(
  "field_notes",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    taskId: uuid("task_id").references(() => tasks.id),
    kind: noteKindEnum("kind").notNull(),
    text: text("text"),
    /** Client-side media id; the blob is uploaded after the note syncs. */
    mediaId: uuid("media_id"),
    /**
     * Pathname in the PRIVATE Blob store, recorded by the server after upload.
     * Server-only: the pull never sends it; clients get `/api/media/<noteId>`.
     */
    blobPath: text("blob_path"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    durationSec: doublePrecision("duration_sec"),
    transcript: text("transcript"),
    /** Set by the field report agent (Day 4) once it has read the note. */
    processedAt: tsz("processed_at"),
    createdAt: tsz("created_at").notNull(),
    seq: seq(),
  },
  (t) => [index("field_notes_seq_idx").on(t.seq), index("field_notes_person_idx").on(t.personId)],
);

/**
 * "This person can no longer see this row": e.g. a task reassigned away from
 * them. Pulled like any other change (seq > cursor); the client deletes the row.
 * One row per (actor, entity, entity id); a repeat revocation bumps its seq.
 */
export const revocations = pgTable(
  "revocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => people.id),
    entity: text("entity").$type<RevocableEntity>().notNull(),
    entityId: uuid("entity_id").notNull(),
    seq: seq(),
  },
  (t) => [
    uniqueIndex("revocations_actor_entity_idx").on(t.actorId, t.entity, t.entityId),
    index("revocations_seq_idx").on(t.seq),
  ],
);

/**
 * One row per device (browser profile) that synced: written by POST /api/sync.
 * The office shows "last synced X min ago" from it, never a guessed online dot.
 * Not a projection (office reads it on the server), so no seq.
 */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    lastSyncAt: tsz("last_sync_at").notNull(),
    appVersion: text("app_version"),
  },
  (t) => [index("devices_person_idx").on(t.personId)],
);

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    /** Client-generated UUID. ON CONFLICT DO NOTHING makes resends harmless. */
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => people.id),
    deviceId: text("device_id").notNull(),
    clientTs: tsz("client_ts").notNull(),
    serverTs: tsz("server_ts").notNull().defaultNow(),
    serverSeq: bigserial("server_seq", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    applied: boolean("applied").notNull().default(false),
    rejectReason: text("reject_reason"),
  },
  (t) => [
    uniqueIndex("events_server_seq_idx").on(t.serverSeq),
    index("events_actor_idx").on(t.actorId),
    index("events_type_idx").on(t.type),
  ],
);

// ---------------------------------------------------------------------------
// Later days (tables exist now so the schema is stable; unused on Day 1)
// ---------------------------------------------------------------------------
/**
 * Day 4: Web Push subscriptions. One browser (endpoint) may carry several
 * people in demo mode (field technician + office coordinator in one browser),
 * so the key is (endpoint, person). Rows whose push service answers 404/410
 * are deleted by the sender.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    /** The app's device id (field: Dexie meta; office: web-<uuid>). Informational. */
    deviceId: text("device_id"),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    lastSuccessAt: tsz("last_success_at"),
    lastFailureAt: tsz("last_failure_at"),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_person_idx").on(t.endpoint, t.personId),
    index("push_subscriptions_person_idx").on(t.personId),
  ],
);

/**
 * Day 4: every notification and escalation step, recorded once. The unique key
 * (task, rule, episode, level) is what makes concurrent rule runs safe: a run
 * claims a step by inserting its row (ON CONFLICT DO NOTHING) and only the
 * claimer sends. `episode` scopes a ladder: the assignee + sent time for
 * "ack", the due date for "overdue", the status event for "blocked", the
 * change event for "changed"; a new episode starts a fresh ladder.
 */
export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    /** Main recipient (assignee, or the coordinator for an alert). */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    rule: text("rule").$type<EscalationRule>().notNull().default("ack"),
    episode: text("episode").notNull().default(""),
    level: integer("level").notNull(),
    channel: escalationChannelEnum("channel").notNull(),
    status: escalationStatusEnum("status").notNull().default("pending"),
    /** Human sentence: why this step happened ("Urgent task not acknowledged for 30 min"). */
    reason: text("reason").notNull(),
    /** Demo-clock time at which the step became due. */
    scheduledFor: tsz("scheduled_for").notNull(),
    /** Demo-clock time the step was sent (or skipped). */
    sentAt: tsz("sent_at"),
    /** Twilio message SID, or the number of push deliveries. */
    providerId: text("provider_id"),
    error: text("error"),
    /** Coordinator alerts: when it was handled (by a person, or automatically). */
    resolvedAt: tsz("resolved_at"),
    handledBy: uuid("handled_by").references(() => people.id),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    seq: seq(),
  },
  (t) => [
    index("escalations_seq_idx").on(t.seq),
    index("escalations_task_idx").on(t.taskId),
    index("escalations_due_idx").on(t.status, t.scheduledFor),
    uniqueIndex("escalations_step_idx").on(t.taskId, t.rule, t.episode, t.level),
  ],
);

/**
 * Day 4: every SMS, mock or real (the "SMS log"). Real numbers are never
 * stored: `toMasked` keeps the last 2 digits only.
 */
export const smsMessages = pgTable(
  "sms_messages",
  {
    id: uuid("id").primaryKey(),
    escalationId: uuid("escalation_id").references(() => escalations.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    provider: text("provider").$type<"mock" | "twilio">().notNull(),
    toMasked: text("to_masked").notNull(),
    /** What we wanted to say. */
    body: text("body").notNull(),
    /** What the provider actually sent (a Twilio trial replaces custom text with a template). */
    sentBody: text("sent_body"),
    status: text("status").$type<SmsStatus>().notNull(),
    providerId: text("provider_id"),
    error: text("error"),
    createdAt: tsz("created_at").notNull(),
    updatedAt: tsz("updated_at").notNull(),
  },
  (t) => [index("sms_messages_created_idx").on(t.createdAt)],
);

/**
 * Day 4: demo-only settings, one row (id = 1). `clockOffsetMs` moves the
 * server-side rule clock (lib/clock.ts) for the "Fast-forward" control.
 */
export const demoSettings = pgTable("demo_settings", {
  id: integer("id").primaryKey(),
  clockOffsetMs: bigint("clock_offset_ms", { mode: "number" }).notNull().default(0),
  /** Throttle for dashboard-poll escalation runs (shared by all server instances). */
  lastEscalationRunAt: tsz("last_escalation_run_at"),
  /** The seeded person whose SMS really goes to SMS_DEMO_TO_NUMBER (no FK: survives reseeds). */
  smsDemoPersonId: uuid("sms_demo_person_id"),
  updatedAt: tsz("updated_at"),
  updatedBy: uuid("updated_by"),
});

/** Day 5: AI digests (daily/weekly summaries). */
export const digests = pgTable(
  "digests",
  {
    id: uuid("id").primaryKey(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    /** Null for branch-wide digests. */
    personId: uuid("person_id").references(() => people.id),
    kind: text("kind").notNull(),
    periodStart: tsz("period_start").notNull(),
    periodEnd: tsz("period_end").notNull(),
    summary: text("summary").notNull(),
    content: jsonb("content").notNull(),
    model: text("model"),
    createdAt: tsz("created_at").notNull().defaultNow(),
  },
  (t) => [index("digests_period_idx").on(t.branchId, t.periodStart)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export type Branch = typeof branches.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Rollout = typeof rollouts.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskReceipt = typeof taskReceipts.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type StatusUpdate = typeof statusUpdates.$inferSelect;
export type FieldNote = typeof fieldNotes.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Revocation = typeof revocations.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type Escalation = typeof escalations.$inferSelect;
export type SmsMessage = typeof smsMessages.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
