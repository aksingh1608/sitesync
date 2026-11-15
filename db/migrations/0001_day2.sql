CREATE TABLE "revocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"seq" bigint DEFAULT nextval('sync_seq') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_updates" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "field_notes" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "field_notes" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "field_notes" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "field_notes" ADD COLUMN "duration_sec" double precision;--> statement-breakpoint
ALTER TABLE "revocations" ADD CONSTRAINT "revocations_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revocations_actor_entity_idx" ON "revocations" USING btree ("actor_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "revocations_seq_idx" ON "revocations" USING btree ("seq");