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
  type TaskLwwField,
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
    status: workerStatusEnum("status").notNull(),
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
    blobUrl: text("blob_url"),
    transcript: text("transcript"),
    /** Set by the field report agent (Day 4) once it has read the note. */
    processedAt: tsz("processed_at"),
    createdAt: tsz("created_at").notNull(),
    seq: seq(),
  },
  (t) => [index("field_notes_seq_idx").on(t.seq), index("field_notes_person_idx").on(t.personId)],
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
/** Day 4: Web Push subscriptions. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    lastSuccessAt: tsz("last_success_at"),
    lastFailureAt: tsz("last_failure_at"),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint)],
);

/** Day 4: escalation ladder push -> SMS -> coordinator alert. */
export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    level: integer("level").notNull(),
    channel: escalationChannelEnum("channel").notNull(),
    status: escalationStatusEnum("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    scheduledFor: tsz("scheduled_for").notNull(),
    sentAt: tsz("sent_at"),
    resolvedAt: tsz("resolved_at"),
    detail: jsonb("detail"),
    createdAt: tsz("created_at").notNull().defaultNow(),
    seq: seq(),
  },
  (t) => [
    index("escalations_seq_idx").on(t.seq),
    index("escalations_task_idx").on(t.taskId),
    index("escalations_due_idx").on(t.status, t.scheduledFor),
  ],
);

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
