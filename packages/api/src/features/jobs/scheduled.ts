import { env } from "@reactive-resume/env/server";
import { fanOutScans, scanUser } from "../discovery/scan";
import { materializeAllFollowUps, sendFollowUpDigests } from "../follow-ups/jobs";

/**
 * The daily background work, runnable inline over HTTP. Deploys with the in-process
 * pg-boss worker (Docker) schedule this work themselves in boot.ts; serverless deploys
 * have no worker, so a platform scheduler (Vercel Cron) triggers the same work through
 * the /api/cron/* endpoints instead.
 */

/** One scanner pass over every user with enabled watches, run inline (no queue).
 * A failing user never aborts the sweep. */
export async function runScheduledScans(): Promise<{ users: number }> {
	if (env.FLAG_DISABLE_JOB_SCANNER) return { users: 0 };
	const users = await fanOutScans(async (userId) => {
		await scanUser({ userId }).catch((error) => {
			console.error("Scheduled scan failed for a user", { userId, error });
		});
	});
	return { users };
}

/** Materialize cadence follow-ups for every user, then send the opt-in email digest
 * (a no-op without SMTP). Same order boot.ts schedules: materialize before digest. */
export async function runFollowUpsDaily(): Promise<void> {
	await materializeAllFollowUps();
	await sendFollowUpDigests();
}
