import { env } from "@reactive-resume/env/server";

/**
 * HTTP cron endpoints for serverless deploys. Docker deploys schedule this work in-process
 * (see @reactive-resume/api/features/jobs boot); on Vercel no worker exists, so vercel.json
 * crons hit these paths instead. Vercel sends `Authorization: Bearer ${CRON_SECRET}` with
 * every invocation — without a configured CRON_SECRET the endpoints refuse outright, so
 * they are never publicly triggerable.
 *
 * Only /api/cron/follow-ups is scheduled in vercel.json. The scanner endpoint is
 * deliberately unscheduled on Vercel: per-host pacing and fail-skip state are in-memory
 * (cold per invocation), fetches leave from shared egress IPs, and a whole sweep must fit
 * one Function window — manual "Scan now" remains, and an operator who accepts those
 * trade-offs can schedule this path externally.
 */

function authorized(request: Request): boolean {
	if (!env.CRON_SECRET) return false;
	return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

export async function handleCronScanner(request: Request): Promise<Response> {
	if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
	const { runScheduledScans } = await import("@reactive-resume/api/features/jobs/scheduled");
	const result = await runScheduledScans();
	return Response.json({ ok: true, users: result.users });
}

export async function handleCronFollowUps(request: Request): Promise<Response> {
	if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
	const { runFollowUpsDaily } = await import("@reactive-resume/api/features/jobs/scheduled");
	await runFollowUpsDaily();
	return Response.json({ ok: true });
}
