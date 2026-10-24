CREATE TYPE "public"."assignment_state" AS ENUM('proposed', 'accepted', 'declined', 'confirmed', 'withdrawn', 'released');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"state" "assignment_state" DEFAULT 'proposed' NOT NULL,
	"responded_at" timestamp with time zone,
	"booked_start" timestamp with time zone,
	"booked_end" timestamp with time zone,
	CONSTRAINT "assignment_response" CHECK (
    ("assignments"."state" = 'proposed' AND "assignments"."responded_at" IS NULL) OR
    ("assignments"."state" IN ('accepted', 'declined', 'confirmed') AND "assignments"."responded_at" IS NOT NULL AND isfinite("assignments"."responded_at")) OR
    ("assignments"."state" IN ('withdrawn', 'released') AND ("assignments"."responded_at" IS NULL OR isfinite("assignments"."responded_at")))),
	CONSTRAINT "assignment_booking" CHECK (
    ("assignments"."state" = 'confirmed' AND "assignments"."booked_start" IS NOT NULL AND "assignments"."booked_end" IS NOT NULL
      AND isfinite("assignments"."booked_start") AND isfinite("assignments"."booked_end") AND "assignments"."booked_start" < "assignments"."booked_end") OR
    ("assignments"."state" <> 'confirmed' AND "assignments"."booked_start" IS NULL AND "assignments"."booked_end" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mission_events" DROP CONSTRAINT "event_kind";--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tenant_id_mission_id_position_id_positions_tenant_id_mission_id_id_fk" FOREIGN KEY ("tenant_id","mission_id","position_id") REFERENCES "public"."positions"("tenant_id","mission_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tenant_id_crew_id_crew_tenant_id_id_fk" FOREIGN KEY ("tenant_id","crew_id") REFERENCES "public"."crew"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_current_position" ON "assignments" USING btree ("tenant_id","mission_id","position_id") WHERE "assignments"."state" IN ('proposed', 'accepted', 'confirmed');--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_current_crew" ON "assignments" USING btree ("tenant_id","mission_id","crew_id") WHERE "assignments"."state" IN ('proposed', 'accepted', 'confirmed');--> statement-breakpoint
CREATE INDEX "assignments_tenant_crew_mission" ON "assignments" USING btree ("tenant_id","crew_id","mission_id");--> statement-breakpoint
CREATE INDEX "assignments_tenant_mission_position" ON "assignments" USING btree ("tenant_id","mission_id","position_id");--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "event_kind" CHECK ("mission_events"."kind" IN ('mission_created', 'mission_updated', 'position_added', 'position_updated', 'position_removed', 'proposals_updated', 'assignment_responded'));--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE assignments ADD CONSTRAINT assignments_no_booking_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    crew_id WITH =,
    tstzrange(booked_start, booked_end, '[)') WITH &&
  ) WHERE (state = 'confirmed');
