ALTER TYPE "public"."escalation_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TYPE "public"."escalation_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TABLE "demo_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"clock_offset_ms" bigint DEFAULT 0 NOT NULL,
	"last_escalation_run_at" timestamp with time zone,
	"sms_demo_person_id" uuid,
	"updated_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"escalation_id" uuid,
	"person_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"to_masked" text NOT NULL,
	"body" text NOT NULL,
	"sent_body" text,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "push_subscriptions_endpoint_idx";--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "rule" text DEFAULT 'ack' NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "episode" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "handled_by" uuid;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_escalation_id_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."escalations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_messages_created_idx" ON "sms_messages" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_handled_by_people_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_step_idx" ON "escalations" USING btree ("task_id","rule","episode","level");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_person_idx" ON "push_subscriptions" USING btree ("endpoint","person_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_person_idx" ON "push_subscriptions" USING btree ("person_id");--> statement-breakpoint
INSERT INTO "demo_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;