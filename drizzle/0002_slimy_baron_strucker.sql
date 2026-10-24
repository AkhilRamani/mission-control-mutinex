CREATE TYPE "public"."mission_state" AS ENUM('draft', 'submitted', 'approved', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "mission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_version" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "events_tenant_mission_version" UNIQUE("tenant_id","mission_id","mission_version"),
	CONSTRAINT "event_version" CHECK ("mission_events"."mission_version" >= 1),
	CONSTRAINT "event_time_finite" CHECK (isfinite("mission_events"."occurred_at")),
	CONSTRAINT "event_payload_object" CHECK (jsonb_typeof("mission_events"."payload") = 'object'),
	CONSTRAINT "event_kind" CHECK ("mission_events"."kind" IN ('mission_created', 'mission_updated', 'position_added', 'position_updated', 'position_removed'))
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"state" "mission_state" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "missions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "mission_title" CHECK (length(trim("missions"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "mission_brief" CHECK (length("missions"."brief") <= 4000),
	CONSTRAINT "mission_interval" CHECK (isfinite("missions"."start") AND isfinite("missions"."end") AND "missions"."start" < "missions"."end"),
	CONSTRAINT "mission_version" CHECK ("missions"."version" >= 1),
	CONSTRAINT "mission_created_finite" CHECK (isfinite("missions"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "position_skills" (
	"tenant_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"min_proficiency" integer NOT NULL,
	CONSTRAINT "position_skills_tenant_id_mission_id_position_id_skill_id_pk" PRIMARY KEY("tenant_id","mission_id","position_id","skill_id"),
	CONSTRAINT "position_skill_proficiency" CHECK ("position_skills"."min_proficiency" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "positions_tenant_mission_id" UNIQUE("tenant_id","mission_id","id"),
	CONSTRAINT "positions_tenant_mission_ordinal" UNIQUE("tenant_id","mission_id","ordinal"),
	CONSTRAINT "position_ordinal" CHECK ("positions"."ordinal" >= 1),
	CONSTRAINT "position_label" CHECK (length(trim("positions"."label")) BETWEEN 1 AND 120),
	CONSTRAINT "position_removed_finite" CHECK ("positions"."removed_at" IS NULL OR isfinite("positions"."removed_at"))
);
--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_tenant_id_mission_id_missions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","mission_id") REFERENCES "public"."missions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_tenant_id_actor_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_tenant_id_owner_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_skills" ADD CONSTRAINT "position_skills_tenant_id_mission_id_position_id_positions_tenant_id_mission_id_id_fk" FOREIGN KEY ("tenant_id","mission_id","position_id") REFERENCES "public"."positions"("tenant_id","mission_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_skills" ADD CONSTRAINT "position_skills_tenant_id_skill_id_skills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","skill_id") REFERENCES "public"."skills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_mission_id_missions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","mission_id") REFERENCES "public"."missions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "missions_tenant_state" ON "missions" USING btree ("tenant_id","state","id");--> statement-breakpoint
CREATE INDEX "position_skills_tenant_skill" ON "position_skills" USING btree ("tenant_id","skill_id");
--> statement-breakpoint
-- Default table grants allow writes; mission history is append-only for runtime roles.
REVOKE UPDATE, DELETE ON "mission_events" FROM mc_app, mc_test_app;
