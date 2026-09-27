CREATE TABLE "ai_provider_routes" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"feature" text NOT NULL,
	"ai_provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"ai_provider_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"kind" text DEFAULT 'generate' NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_routes_user_id_feature_index" ON "ai_provider_routes" ("user_id","feature");--> statement-breakpoint
CREATE INDEX "ai_requests_user_id_status_created_at_index" ON "ai_requests" ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_requests_ai_provider_id_status_index" ON "ai_requests" ("ai_provider_id","status");--> statement-breakpoint
ALTER TABLE "ai_provider_routes" ADD CONSTRAINT "ai_provider_routes_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_provider_routes" ADD CONSTRAINT "ai_provider_routes_ai_provider_id_ai_providers_id_fkey" FOREIGN KEY ("ai_provider_id") REFERENCES "ai_providers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_ai_provider_id_ai_providers_id_fkey" FOREIGN KEY ("ai_provider_id") REFERENCES "ai_providers"("id") ON DELETE CASCADE;