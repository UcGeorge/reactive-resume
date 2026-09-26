CREATE TABLE "story" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"theme" text DEFAULT '' NOT NULL,
	"situation" text DEFAULT '' NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"result" text DEFAULT '' NOT NULL,
	"reflection" text DEFAULT '' NOT NULL,
	"provenance" text DEFAULT 'derived-unverified' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_resume_id" text,
	"source_application_id" text,
	"last_used_at" timestamp with time zone,
	"times_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "story_user_id_updated_at_index" ON "story" ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_source_resume_id_resume_id_fkey" FOREIGN KEY ("source_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_source_application_id_application_id_fkey" FOREIGN KEY ("source_application_id") REFERENCES "application"("id") ON DELETE SET NULL;