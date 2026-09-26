import type { JobName } from "./registry";
import { PgBoss } from "pg-boss";
import { env } from "@reactive-resume/env/server";

/**
 * The background-job queue: pg-boss, in-process, on the same Postgres the app already
 * migrates at boot.
 *
 * Chosen over a Redis-backed queue deliberately: `REDIS_URL` is optional in this app (only
 * the agent workspace needs it), and background evaluations, scans and follow-up reminders
 * must not add a hard infrastructure dependency to the minimal self-host path. pg-boss gives
 * cron scheduling, retries with backoff, `singletonKey` dedup and persistence across
 * restarts, all inside the single Node process the Docker image runs.
 *
 * pg-boss manages its own `pgboss` schema with internal migrations — outside Drizzle's
 * migration flow on purpose, in the same auto-migrate-at-boot spirit.
 *
 * This module is the only file that touches the pg-boss API directly, so a future queue swap
 * stays a one-file change.
 */

let bossPromise: Promise<PgBoss> | null = null;

async function createBoss(): Promise<PgBoss> {
	const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" });
	// An unhandled 'error' event would crash the process; queue errors must never take the
	// web server down with them.
	boss.on("error", (error) => {
		console.error("Background job queue error", { error });
	});
	await boss.start();
	return boss;
}

/** Whether a long-lived worker exists to consume queued jobs. On Vercel the serverless
 * entry never runs the startup hook, so anything enqueued there would wait forever —
 * callers use this to fall back to inline execution instead. */
export function backgroundJobsAvailable(): boolean {
	return !env.FLAG_DISABLE_BACKGROUND_JOBS && process.env.VERCEL !== "1";
}

/** The running queue instance, started lazily on first use. */
export function getBoss(): Promise<PgBoss> {
	bossPromise ??= createBoss();
	return bossPromise;
}

export type EnqueueOptions = {
	/** Only one queued/active job per key — e.g. one scan per user in flight. */
	singletonKey?: string | undefined;
	retryLimit?: number | undefined;
	/** Seconds before the first retry; doubles per attempt when backoff is on. */
	retryDelay?: number | undefined;
	retryBackoff?: boolean | undefined;
};

/** Enqueue a job. The queue itself is created by the boot pass (see boot.ts). */
export async function enqueueJob(name: JobName, data: object, options: EnqueueOptions = {}): Promise<string | null> {
	const boss = await getBoss();
	return boss.send(name, data, {
		retryLimit: options.retryLimit ?? 2,
		retryDelay: options.retryDelay ?? 30,
		retryBackoff: options.retryBackoff ?? true,
		...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
	});
}

/** Register a worker for a job name. Handlers receive one job at a time. */
export async function registerWorker<Data>(
	name: JobName,
	handler: (data: Data, jobId: string) => Promise<void>,
): Promise<void> {
	const boss = await getBoss();
	await boss.createQueue(name).catch(() => {
		// Queue already exists — createQueue is idempotent in intent, not in error surface.
	});
	await boss.work(name, async (jobs) => {
		for (const job of jobs) {
			await handler(job.data as Data, job.id);
		}
	});
}

/** Register a cron schedule for a job. pg-boss persists schedules in Postgres, so this is
 * idempotent across restarts — re-scheduling the same name replaces the previous cron. */
export async function scheduleCron(name: JobName, cron: string, data: object = {}): Promise<void> {
	const boss = await getBoss();
	await boss.createQueue(name).catch(() => {
		// Queue already exists.
	});
	await boss.schedule(name, cron, data);
}

/** Stop the queue (used by tests and graceful shutdown; the web process normally never stops it). */
export async function stopBoss(): Promise<void> {
	if (!bossPromise) return;
	const boss = await bossPromise;
	bossPromise = null;
	await boss.stop({ graceful: true });
}
