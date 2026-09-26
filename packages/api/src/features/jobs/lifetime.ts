/**
 * Lifetime of inline background work on serverless platforms.
 *
 * When no long-lived worker exists (see `backgroundJobsAvailable`), features run their
 * background work detached from the response. On a normal server the process outlives the
 * response, so a floating promise is fine — but a serverless platform may freeze the
 * instance as soon as the response is sent, cutting the work off mid-flight. Platform
 * entries that have a keep-alive primitive (Vercel's `waitUntil`) register it here once at
 * startup, mirroring `configureAgentStreamLifetime` in the agent feature.
 */

type WaitUntil = (promise: Promise<unknown>) => void;

let waitUntil: WaitUntil | null = null;

/** Configure once at platform startup, before any request is handled. */
export function configureBackgroundWorkLifetime(callback: WaitUntil): void {
	waitUntil = callback;
}

/** Run `work` detached from the current response. Callers own error handling and logging;
 * the promise is guarded again here so a rejection can never surface as unhandled. */
export function runDetached(work: Promise<unknown>): void {
	const guarded = work.catch((error) => {
		console.error("Detached background work failed", { error });
	});
	if (waitUntil) waitUntil(guarded);
}
