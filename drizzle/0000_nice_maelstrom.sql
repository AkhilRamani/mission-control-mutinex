CREATE TYPE "public"."role" AS ENUM('director', 'lead', 'crew');--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organisation_slug" CHECK ("organisations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("organisations"."slug") <= 64),
	CONSTRAINT "organisation_name" CHECK (length(trim("organisations"."name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_hash_format" CHECK ("sessions"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "session_expiry_finite" CHECK (isfinite("sessions"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	CONSTRAINT "users_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "users_tenant_username" UNIQUE("tenant_id","username"),
	CONSTRAINT "username_normalised" CHECK ("users"."username" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "user_display_name" CHECK (length(trim("users"."display_name")) BETWEEN 1 AND 120),
	CONSTRAINT "password_hash_present" CHECK (length("users"."password_hash") > 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_organisations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_tenant_user" ON "sessions" USING btree ("tenant_id","user_id");