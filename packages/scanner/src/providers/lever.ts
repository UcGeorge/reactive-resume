/**
 * Lever provider — the public v0 postings endpoint.
 *
 * Ported from career-ops' `providers/lever.mjs` (MIT). Auto-detects from careers URLs on
 * jobs.(eu.)?lever.co; handles both explicit `api:` URLs and auto-detection. The v0 endpoint
 * returns the WHOLE board in one response with every description inlined, so a large board
 * outgrows the context's default timeout (a 42.8 MB board was observed aborting at 10s) — the
 * provider pins the same longer timeout Ashby uses, the other one-response board-wide feed.
 */
import type { PortalEntry, ScanProvider } from "../types";
import { assertProviderUrl, isRecord, stringOr } from "./shared";

const ALLOWED_LEVER_HOSTS: ReadonlySet<string> = new Set(["api.lever.co", "api.eu.lever.co"]);
const ALLOWED_LEVER_HOSTS_LIST = [...ALLOWED_LEVER_HOSTS];
const LEVER_TIMEOUT_MS = 30_000;

function assertLeverUrl(url: string): string {
	return assertProviderUrl("lever", url, ALLOWED_LEVER_HOSTS);
}

function resolveApiUrl(entry: PortalEntry): string | null {
	// Explicit api: wins — lets an entry keep a human-facing corporate careers page as `url`
	// while still pinning the postings board (mirrors greenhouse's api: precedence).
	if (entry.api) {
		assertLeverUrl(entry.api);
		return entry.api;
	}
	let url: URL;
	try {
		url = new URL(entry.url);
	} catch {
		return null;
	}
	// The captured group carries the region: jobs.eu.lever.co postings live on api.eu.lever.co.
	const host = /^jobs\.((?:eu\.)?lever\.co)$/.exec(url.hostname);
	if (!host?.[1]) return null;
	const slug = url.pathname.split("/").filter(Boolean)[0];
	if (!slug) return null;
	return `https://api.${host[1]}/v0/postings/${slug}`;
}

/**
 * Fold `categories.location` together with any `categories.allLocations` into one string.
 * Lever puts a SINGLE primary city in `location` and exposes the full set on multi-location
 * postings in `allLocations` — reading only the former silently hides every other eligible
 * location (a req open in Barcelona AND Montevideo would read Barcelona-only). Deduped
 * case-insensitively, joined with "; ".
 */
function resolveLocation(categories: unknown): string {
	const primary = isRecord(categories) && typeof categories.location === "string" ? categories.location.trim() : "";
	const all =
		isRecord(categories) && Array.isArray(categories.allLocations)
			? categories.allLocations
					.filter((value): value is string => typeof value === "string" && value.trim() !== "")
					.map((value) => value.trim())
			: [];
	const merged: string[] = [];
	for (const location of [primary, ...all]) {
		if (location && !merged.some((existing) => existing.toLowerCase() === location.toLowerCase())) {
			merged.push(location);
		}
	}
	return merged.join("; ");
}

export const lever: ScanProvider = {
	id: "lever",

	detect(entry) {
		try {
			const apiUrl = resolveApiUrl(entry);
			return apiUrl ? { url: apiUrl } : null;
		} catch {
			return null;
		}
	},

	async fetch(entry, ctx) {
		const apiUrl = resolveApiUrl(entry);
		if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.company}`);
		assertLeverUrl(apiUrl);
		const json = await ctx.fetchJson(apiUrl, {
			allowedHosts: ALLOWED_LEVER_HOSTS_LIST,
			timeoutMs: LEVER_TIMEOUT_MS,
		});
		if (!Array.isArray(json)) return [];
		return json.map((rawJob) => {
			const job = isRecord(rawJob) ? rawJob : {};
			return {
				title: stringOr(job.text),
				url: stringOr(job.hostedUrl),
				company: entry.company,
				location: resolveLocation(job.categories),
				// The v0 postings list ships the full plain-text description for free (same
				// payload, no per-job request).
				description: stringOr(job.descriptionPlain),
				...(typeof job.createdAt === "number" ? { postedAt: job.createdAt } : {}),
			};
		});
	},
};
