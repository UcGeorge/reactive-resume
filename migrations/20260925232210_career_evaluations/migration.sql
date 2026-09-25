CREATE TABLE "career_profile" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL UNIQUE,
	"work_auth" jsonb,
	"facts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"resume_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"score" real,
	"archetype" text,
	"legitimacy" text,
	"work_auth" text,
	"advertised_comp" text,
	"requirements" jsonb,
	"blocks" jsonb,
	"skill_gap" jsonb,
	"jd_archived" text NOT NULL,
	"jd_fingerprint" text,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "resume_user_id_index";--> statement-breakpoint
CREATE INDEX "career_profile_user_id_index" ON "career_profile" ("user_id");--> statement-breakpoint
CREATE INDEX "evaluation_user_id_index" ON "evaluation" ("user_id");--> statement-breakpoint
CREATE INDEX "evaluation_user_id_application_id_created_at_index" ON "evaluation" ("user_id","application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "career_profile" ADD CONSTRAINT "career_profile_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "evaluation" ADD CONSTRAINT "evaluation_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "evaluation" ADD CONSTRAINT "evaluation_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "evaluation" ADD CONSTRAINT "evaluation_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;