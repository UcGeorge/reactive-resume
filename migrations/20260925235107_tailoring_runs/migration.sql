CREATE TABLE "tailoring_run" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"evaluation_id" text,
	"source_resume_id" text,
	"tailored_resume_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"reuse_decision" jsonb,
	"plan" jsonb,
	"operations" jsonb,
	"changes" jsonb,
	"fact_gate_report" jsonb,
	"audit_report" jsonb,
	"jd_archived" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tailoring_run_user_id_index" ON "tailoring_run" ("user_id");--> statement-breakpoint
CREATE INDEX "tailoring_run_user_id_application_id_created_at_index" ON "tailoring_run" ("user_id","application_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "tailoring_run" ADD CONSTRAINT "tailoring_run_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tailoring_run" ADD CONSTRAINT "tailoring_run_application_id_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tailoring_run" ADD CONSTRAINT "tailoring_run_evaluation_id_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluation"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tailoring_run" ADD CONSTRAINT "tailoring_run_source_resume_id_resume_id_fkey" FOREIGN KEY ("source_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tailoring_run" ADD CONSTRAINT "tailoring_run_tailored_resume_id_resume_id_fkey" FOREIGN KEY ("tailored_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;