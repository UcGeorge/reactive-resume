CREATE TABLE "discovered_job" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"watched_company_id" text,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"dedup_key" text NOT NULL,
	"location" text,
	"description" text,
	"fingerprint" text,
	"salary" jsonb,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"application_id" text,
	"flags" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovered_job_user_id_dedup_key_unique" UNIQUE("user_id","dedup_key")
);
--> statement-breakpoint
CREATE TABLE "watched_company" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"careers_url" text NOT NULL,
	"provider" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"title_filter_override" jsonb,
	"last_scan_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_profile" ADD COLUMN "scanner" jsonb;--> statement-breakpoint
CREATE INDEX "discovered_job_user_id_status_first_seen_at_index" ON "discovered_job" ("user_id","status","first_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "discovered_job_user_id_last_seen_at_index" ON "discovered_job" ("user_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watched_company_user_id_enabled_index" ON "watched_company" ("user_id","enabled");--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_watched_company_id_watched_company_id_fkey" FOREIGN KEY ("watched_company_id") REFERENCES "watched_company"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "discovered_job" ADD CONSTRAINT "discovered_job_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "watched_company" ADD CONSTRAINT "watched_company_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;