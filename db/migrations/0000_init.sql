CREATE TYPE "public"."escalation_channel" AS ENUM('push', 'sms', 'coordinator_alert');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('pending', 'sent', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."note_kind" AS ENUM('text', 'voice', 'photo');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('technician', 'foreman', 'coordinator', 'hr', 'manager');--> statement-breakpoint
CREATE TYPE "public"."rollout_stage" AS ENUM('survey', 'materials_shipped', 'install', 'punch_list', 'closeout', 'done');--> statement-breakpoint
CREATE TYPE "public"."site_kind" AS ENUM('construction', 'service', 'rollout_store');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('task', 'follow_up', 'service_call', 'material_request');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('manual', 'dispatch_agent', 'report_agent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trade" AS ENUM('electrical', 'lighting', 'signs', 'ev', 'general');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('on_site', 'lunch', 'traveling', 'off');--> statement-breakpoint
CREATE SEQUENCE "public"."sync_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"person_id" uuid,
	"kind" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"channel" "escalation_channel" NOT NULL,
	"status" "escalation_status" DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"client_ts" timestamp with time zone NOT NULL,
	"server_ts" timestamp with time zone DEFAULT now() NOT NULL,
	"server_seq" bigserial NOT NULL,
	"payload" jsonb NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"reject_reason" text
);
--> statement-breakpoint
CREATE TABLE "field_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"task_id" uuid,
	"kind" "note_kind" NOT NULL,
	"text" text,
	"blob_url" text,
	"transcript" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" "role" NOT NULL,
	"trade" "trade" NOT NULL,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rollouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"customer_name" text NOT NULL,
	"scope" text NOT NULL,
	"target_end_date" date,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "site_kind" NOT NULL,
	"address" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"geofence_radius_m" integer DEFAULT 150 NOT NULL,
	"rollout_id" uuid,
	"rollout_stage" "rollout_stage",
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "worker_status" NOT NULL,
	"note" text,
	"at" timestamp with time zone NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_receipts" (
	"task_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "task_receipts_task_id_person_id_pk" PRIMARY KEY("task_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"site_id" uuid NOT NULL,
	"assignee_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" "task_kind" DEFAULT 'task' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"parent_task_id" uuid,
	"source" "task_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"field_ts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"clock_in_at" timestamp with time zone NOT NULL,
	"clock_in_lat" double precision,
	"clock_in_lng" double precision,
	"clock_in_accuracy_m" double precision,
	"clock_in_distance_m" double precision,
	"clock_out_at" timestamp with time zone,
	"clock_out_lat" double precision,
	"clock_out_lng" double precision,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"safety_check_done" boolean DEFAULT false NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_notes" ADD CONSTRAINT "field_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_notes" ADD CONSTRAINT "field_notes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_notes" ADD CONSTRAINT "field_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_rollout_id_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."rollouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_updates" ADD CONSTRAINT "status_updates_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_people_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digests_period_idx" ON "digests" USING btree ("branch_id","period_start");--> statement-breakpoint
CREATE INDEX "escalations_seq_idx" ON "escalations" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "escalations_task_idx" ON "escalations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "escalations_due_idx" ON "escalations" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "events_server_seq_idx" ON "events" USING btree ("server_seq");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "field_notes_seq_idx" ON "field_notes" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "field_notes_person_idx" ON "field_notes" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "people_seq_idx" ON "people" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "rollouts_seq_idx" ON "rollouts" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "sites_seq_idx" ON "sites" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "sites_rollout_idx" ON "sites" USING btree ("rollout_id");--> statement-breakpoint
CREATE INDEX "status_updates_seq_idx" ON "status_updates" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "status_updates_person_idx" ON "status_updates" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "task_receipts_seq_idx" ON "task_receipts" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "task_receipts_person_idx" ON "task_receipts" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_seq_idx" ON "tasks" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "tasks_site_idx" ON "tasks" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "time_entries_seq_idx" ON "time_entries" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "time_entries_person_idx" ON "time_entries" USING btree ("person_id");