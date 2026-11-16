CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"last_sync_at" timestamp with time zone NOT NULL,
	"app_version" text
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "stage_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "material_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "material_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_person_idx" ON "devices" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_reviewed_by_people_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;