import { env } from "@reactive-resume/env/server";
import { fanOutScans, scanUser } from "../discovery/scan";
import { runEvaluation } from "../evaluations/pipeline";
import { enqueueJob, registerWorker, scheduleCron } from "./queue";
import { evaluationRunPayloadSchema, JOB_NAMES, scannerScanUserPayloadSchema } from "./registry";

/**
 * Starts the in-process background workers. Called once at server boot, after migrations,
 * mirroring the agent-runs reaper: a failure here is logged and never blocks serving
 * traffic, and `FLAG_DISABLE_BACKGROUND_JOBS` turns the whole worker off for operators who
 * do not want background work in the web process.
 *
 * Feature modules register their workers here (one line each) rather than starting workers
 * at import time, so importing a feature router never spins up a queue.
 */
export async function startBackgroundJobs(): Promise<void> {
	if (env.FLAG_DISABLE_BACKGROUND_JOBS) {
		console.info("Background jobs are disabled (FLAG_DISABLE_BACKGROUND_JOBS).");
		return;
	}

	await registerWorker(JOB_NAMES.evaluationRun, async (data) => {
		const payload = evaluationRunPayloadSchema.parse(data);
		await runEvaluation(payload);
	});

	if (!env.FLAG_DISABLE_JOB_SCANNER) {
		await registerWorker(JOB_NAMES.scannerScanUser, async (data) => {
			const payload = scannerScanUserPayloadSchema.parse(data);
			await scanUser(payload);
		});
		// The recurring pass: one lightweight cron job that fans out per-user scan jobs,
		// deduped by singleton key so an already-queued user is never double-scanned.
		await registerWorker(JOB_NAMES.scannerCron, async () => {
			await fanOutScans(async (userId) => {
				await enqueueJob(JOB_NAMES.scannerScanUser, { userId }, { singletonKey: userId });
			});
		});
		await scheduleCron(JOB_NAMES.scannerCron, `0 */${env.SCANNER_INTERVAL_HOURS} * * *`);
	}
}
