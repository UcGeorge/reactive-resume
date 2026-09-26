import type { ScanJob } from "@reactive-resume/scanner/types";
import type { ScannerScanUserPayload } from "../jobs/registry";
import {
	CROSSLIST_WINDOW_DAYS,
	findCrossListings,
	fingerprintText,
	similarity,
} from "@reactive-resume/career/fingerprint";
import {
	buildContentFilter,
	buildLocationFilter,
	buildTitleFilterWithOverride,
	cooldownBlocked,
} from "@reactive-resume/career/scan-filters";
import { env } from "@reactive-resume/env/server";
import { createFetchContext } from "@reactive-resume/scanner/context";
import { detectProvider } from "@reactive-resume/scanner/detect";
import { evaluationsService } from "../evaluations/service";
import { discoveryService, resolveScannerSettings } from "./service";

/**
 * The zero-token scan pass: fetch each watched company's board through its provider,
 * filter deterministically (title / location / content / blacklist / re-apply cooldown),
 * fingerprint bodies, flag reposts and cross-listings, and upsert into the discovery inbox.
 * Rows that vanished from a successfully-fetched board are marked expired in the same pass.
 */

/** Reposts compare within the same company; the near-verbatim threshold matches the
 * cross-listing one. */
const REPOST_THRESHOLD = 0.92;

/** Watches failing this many consecutive scans are skipped by the cron pass (a manual
 * "Scan now" still tries them — that is the user's own retry). */
const FAIL_SKIP_THRESHOLD = 5;

function normalizeUrlKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.search = "";
		return parsed.toString().replace(/\/$/, "").toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

function normalizeCompanyKey(name: string): string {
	return name
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

export type ScanCompanyResult = {
	watchedCompanyId: string;
	status: "ok" | "error" | "unsupported";
	fetched: number;
	matched: number;
	added: number;
	expired: number;
	error?: string;
};

export async function scanCompany(input: {
	userId: string;
	watchedCompanyId: string;
	manual?: boolean;
}): Promise<ScanCompanyResult> {
	const { userId, watchedCompanyId } = input;
	const watch = await discoveryService.getWatchedCompany({ id: watchedCompanyId, userId });
	const base: ScanCompanyResult = { watchedCompanyId, status: "ok", fetched: 0, matched: 0, added: 0, expired: 0 };

	const profile = await evaluationsService.getCareerProfile({ userId });
	const settings = resolveScannerSettings(profile?.scanner);

	const match = detectProvider({
		company: watch.name,
		url: watch.careersUrl,
		...(watch.provider ? { provider: watch.provider } : {}),
	});
	if (!match) {
		await discoveryService.recordScanOutcome({
			id: watch.id,
			userId,
			status: "unsupported",
			error: "No provider recognizes this board yet.",
		});
		return { ...base, status: "unsupported", error: "No provider recognizes this board yet." };
	}

	let jobs: ScanJob[];
	try {
		const context = createFetchContext();
		jobs = await match.provider.fetch(
			{ company: watch.name, url: watch.careersUrl, ...(watch.provider ? { provider: watch.provider } : {}) },
			context,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Fetch failed.";
		await discoveryService.recordScanOutcome({ id: watch.id, userId, status: "error", error: message });
		return { ...base, status: "error", error: message };
	}

	const titleFilter = buildTitleFilterWithOverride(settings.titleFilter, watch.titleFilterOverride);
	const locationFilter = buildLocationFilter(settings.locationFilter);
	const contentFilter = buildContentFilter(settings.contentExclude);
	const blacklist = new Set(settings.blacklist.map(normalizeCompanyKey));
	const [recentRows, recentApplications] = await Promise.all([
		discoveryService.recentFingerprinted({ userId, windowDays: CROSSLIST_WINDOW_DAYS }),
		discoveryService.recentApplications({ userId, windowDays: settings.cooldownDays }),
	]);
	const history = recentRows.map((row) => ({
		url: row.url,
		company: row.company,
		title: row.title,
		fingerprint: row.fingerprint ?? "",
		dateStr: row.firstSeenAt.toISOString(),
	}));

	const seenDedupKeys: string[] = [];
	let matched = 0;
	let added = 0;

	for (const job of jobs) {
		const company = job.company || watch.name;
		if (!titleFilter(job.title)) continue;
		// The location predicate also reads the URL (Workday location hints) and the title
		// (the remote-in-title rescue), so pass everything we have.
		if (!locationFilter(job.location, job.url, job.title)) continue;
		if (job.description && !contentFilter(job.description)) continue;
		if (blacklist.has(normalizeCompanyKey(company))) continue;
		if (
			settings.cooldownDays > 0 &&
			cooldownBlocked({
				company,
				title: job.title,
				// The cooldown rule works in UTC day strings, matching career-ops' #3070 arithmetic.
				priorApplications: recentApplications.map((application) => ({
					company: application.company,
					role: application.role,
					updatedAt: application.updatedAt.toISOString().slice(0, 10),
				})),
				cooldownDays: settings.cooldownDays,
				now: new Date().toISOString().slice(0, 10),
			})
		) {
			continue;
		}

		matched += 1;
		const dedupKey = match.provider.dedupKey?.(job) ?? normalizeUrlKey(job.url);
		seenDedupKeys.push(dedupKey);

		const fingerprint = job.description ? fingerprintText(job.description) : "";
		let repost = false;
		let crosslist = false;
		let note: string | null = null;
		if (fingerprint) {
			const offer = { url: job.url, company, title: job.title, fingerprint };
			// Same company, near-verbatim body, different URL within the window → repost.
			repost = history.some(
				(row) =>
					normalizeCompanyKey(row.company) === normalizeCompanyKey(company) &&
					row.url !== job.url &&
					similarity(row.fingerprint, fingerprint) >= REPOST_THRESHOLD,
			);
			const crossings = findCrossListings([offer], history);
			if (crossings.length > 0) {
				crosslist = true;
				const best = crossings[0];
				note = best
					? `Near-identical body also listed by ${best.row.company} (${(best.score * 100).toFixed(0)}% similar).`
					: null;
			}
		}

		const { isNew } = await discoveryService.upsertJob({
			userId,
			watchedCompanyId: watch.id,
			company,
			title: job.title,
			url: job.url,
			dedupKey,
			location: job.location || null,
			description: job.description ?? null,
			fingerprint: fingerprint || null,
			salary: job.salary ?? null,
			postedAt: job.postedAt ? new Date(job.postedAt) : null,
			flags: repost || crosslist ? { repost, crosslist, note } : null,
		});
		if (isNew) added += 1;
	}

	// Only a successful fetch may expire rows: an error pass proves nothing about the board.
	const expired = await discoveryService.expireVanished({ userId, watchedCompanyId: watch.id, seenDedupKeys });
	await discoveryService.recordScanOutcome({ id: watch.id, userId, status: "ok" });

	return { ...base, fetched: jobs.length, matched, added, expired };
}

export async function scanUser(payload: ScannerScanUserPayload & { manual?: boolean }): Promise<ScanCompanyResult[]> {
	if (env.FLAG_DISABLE_JOB_SCANNER) return [];

	const watches = payload.watchedCompanyId
		? [await discoveryService.getWatchedCompany({ id: payload.watchedCompanyId, userId: payload.userId })]
		: await discoveryService.listEnabledWatchedCompanies({ userId: payload.userId });

	const results: ScanCompanyResult[] = [];
	for (const watch of watches) {
		if (!watch.enabled && !payload.watchedCompanyId) continue;
		// The cron pass backs off persistently-broken boards; a targeted manual scan is the
		// user's own retry and always runs.
		if (!payload.manual && !payload.watchedCompanyId && watch.failCount >= FAIL_SKIP_THRESHOLD) continue;
		results.push(await scanCompany({ userId: payload.userId, watchedCompanyId: watch.id }));
		// Providers pace per-host internally; a small jitter between companies keeps a
		// many-watch account from bursting anyway.
		await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 500));
	}
	return results;
}

/** The cron pass: one scan-user job per user with enabled watches, deduped by singleton key. */
export async function fanOutScans(enqueue: (userId: string) => Promise<void>): Promise<number> {
	if (env.FLAG_DISABLE_JOB_SCANNER) return 0;
	const userIds = await discoveryService.listUsersWithWatches();
	for (const userId of userIds) await enqueue(userId);
	return userIds.length;
}
