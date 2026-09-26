-- Runs still marked in flight at migration time were orphaned (their request died before the
-- pipeline could record the failure); fail them first so the index below cannot collide.
UPDATE "tailoring_run" SET "status" = 'failed', "error" = 'Tailoring stopped before finishing — the AI provider was likely too slow. Run it again.' WHERE "status" in ('pending', 'planned', 'gated');--> statement-breakpoint
CREATE UNIQUE INDEX "tailoring_run_in_flight_unique" ON "tailoring_run" ("application_id") WHERE "status" in ('pending', 'planned', 'gated');