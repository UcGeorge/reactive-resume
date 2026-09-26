CREATE TABLE "follow_up" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"completed_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"email_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_profile" ADD COLUMN "cadence" jsonb;--> statement-breakpoint
ALTER TABLE "career_profile" ADD COLUMN "voice_notes" text;--> statement-breakpoint
ALTER TABLE "career_profile" ADD COLUMN "email_digest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "follow_up_user_id_status_due_at_index" ON "follow_up" ("user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "follow_up_application_id_index" ON "follow_up" ("application_id");--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE;