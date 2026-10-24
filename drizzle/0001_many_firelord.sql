CREATE TABLE "availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	CONSTRAINT "availability_interval" CHECK (isfinite("availability"."start") AND isfinite("availability"."end") AND "availability"."start" < "availability"."end")
);
--> statement-breakpoint
CREATE TABLE "crew" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"biography" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "crew_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "crew_tenant_user" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "crew_biography_length" CHECK (length("crew"."biography") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "crew_skills" (
	"tenant_id" uuid NOT NULL,
	"crew_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"proficiency" integer NOT NULL,
	CONSTRAINT "crew_skills_tenant_id_crew_id_skill_id_pk" PRIMARY KEY("tenant_id","crew_id","skill_id"),
	CONSTRAINT "crew_skill_proficiency" CHECK ("crew_skills"."proficiency" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "skills_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "skills_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "skill_name_normalised" CHECK ("skills"."name" = lower(trim("skills"."name")) AND length("skills"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_tenant_id_crew_id_crew_tenant_id_id_fk" FOREIGN KEY ("tenant_id","crew_id") REFERENCES "public"."crew"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew" ADD CONSTRAINT "crew_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_skills" ADD CONSTRAINT "crew_skills_tenant_id_crew_id_crew_tenant_id_id_fk" FOREIGN KEY ("tenant_id","crew_id") REFERENCES "public"."crew"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_skills" ADD CONSTRAINT "crew_skills_tenant_id_skill_id_skills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","skill_id") REFERENCES "public"."skills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_tenant_crew_start" ON "availability" USING btree ("tenant_id","crew_id","start");--> statement-breakpoint
CREATE INDEX "crew_skills_tenant_skill" ON "crew_skills" USING btree ("tenant_id","skill_id");