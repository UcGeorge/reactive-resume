import z from "zod";

/**
 * Typed background-job names and payload schemas. Every enqueue and every worker goes
 * through these, so a payload-shape drift between sender and handler is a compile-time
 * error, not a stuck job.
 */

export const JOB_NAMES = {
	evaluationRun: "evaluation.run",
	scannerScanUser: "scanner.scan-user",
	scannerCron: "scanner.cron",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const evaluationRunPayloadSchema = z.object({
	evaluationId: z.string(),
	userId: z.string(),
	/** BCP-47 tag for generated prose, captured at enqueue time from the request context. */
	locale: z.string().optional(),
});

export type EvaluationRunPayload = z.infer<typeof evaluationRunPayloadSchema>;

export const scannerScanUserPayloadSchema = z.object({
	userId: z.string(),
	/** Restrict the pass to one company (the "Scan now" on a single row / the `test` call). */
	watchedCompanyId: z.string().optional(),
});

export type ScannerScanUserPayload = z.infer<typeof scannerScanUserPayloadSchema>;

/** All queues the boot pass must create before any send or work call runs. */
export const ALL_JOB_NAMES: readonly JobName[] = Object.values(JOB_NAMES);
