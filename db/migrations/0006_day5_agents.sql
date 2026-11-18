CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"trigger" text NOT NULL,
	"actor_id" uuid,
	"subject_id" text,
	"input_summary" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"cost_usd" double precision,
	"error" text,
	"notes" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dispatch_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_text" text NOT NULL,
	"site_hint_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"draft" jsonb NOT NULL,
	"mode" text NOT NULL,
	"run_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"task_id" uuid
);
--> statement-breakpoint
ALTER TABLE "field_notes" ADD COLUMN "report" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_drafts" ADD CONSTRAINT "dispatch_drafts_site_hint_id_sites_id_fk" FOREIGN KEY ("site_hint_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_drafts" ADD CONSTRAINT "dispatch_drafts_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_drafts" ADD CONSTRAINT "dispatch_drafts_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_created_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_subject_idx" ON "agent_runs" USING btree ("agent","subject_id") WHERE "agent_runs"."subject_id" is not null;--> statement-breakpoint
CREATE INDEX "dispatch_drafts_status_idx" ON "dispatch_drafts" USING btree ("status","created_at");