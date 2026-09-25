/**
 * Greenhouse provider — the public boards-api JSON endpoint.
 *
 * Ported from career-ops' `providers/greenhouse.mjs` (MIT). Handles both explicit `api:` URLs
 * and auto-detection from the entry's careers URL. The board is requested with `content=true`
 * so each posting carries its full body as plain-text `description` in ONE request — without
 * it, every description-reading filter downstream evaluates Greenhouse boards blind.
 */

import type { PortalEntry, ScanJob, ScanProvider } from "../types";
import { htmlToText } from "../html-to-text";
import { assertProviderUrl, isRecord, stringOr, toEpochMs, trimmedString } from "./shared";

const ALLOWED_GREENHOUSE_HOSTS: ReadonlySet<string> = new Set([
	"boards-api.greenhouse.io",
	"boards.greenhouse.io",
	"job-boards.greenhouse.io",
	"job-boards.eu.greenhouse.io",
]);
const ALLOWED_GREENHOUSE_HOSTS_LIST = [...ALLOWED_GREENHOUSE_HOSTS];

function assertGreenhouseUrl(url: string): string {
	return assertProviderUrl("greenhouse", url, ALLOWED_GREENHOUSE_HOSTS);
}

/** Board slug from a public board URL — host-anchored so a lookalike path on a foreign domain never matches. */
function boardSlugFrom(rawUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	if (!/^(?:job-)?boards(?:\.eu)?\.greenhouse\.io$/.test(parsed.hostname)) return null;
	return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
}

function resolveApiUrl(entry: PortalEntry): string | null {
	// Explicit api: wins — lets an entry keep a human-facing corporate careers page as `url`
	// while still pinning the boards-api board.
	if (entry.api) {
		assertGreenhouseUrl(entry.api);
		return entry.api;
	}
	const slug = boardSlugFrom(entry.url);
	return slug ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` : null;
}

// ── Office enrichment ─────────────────────────────────────────────────────────────────────────
// Some Greenhouse boards put the *work model* ("Hybrid", "In-Office", "Distributed") in
// location.name and keep the actual city in the separate offices[] array — which the /jobs list
// endpoint does not return. For those boards a location filter never sees a city, so every role
// is evaluated against the string "Hybrid" and silently dropped. The city is recoverable from
// /v1/boards/{slug}/offices (offices → departments → jobs) at the cost of one extra request —
// only worth making for boards that actually exhibit the pattern, since a big board's /offices
// payload runs to megabytes.

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

/**
 * True when a location string carries a work model but no geography at all ("Hybrid",
 * "Distributed; Hybrid"). Anything with a place in it ("Hybrid - London", "Remote (Canada)") is
 * already filterable and is left alone, so enrichment can never rewrite a location that worked.
 */
export function isWorkModelOnly(name: unknown): boolean {
	if (typeof name !== "string") return false;
	const parts = name
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.length > 0 && parts.every((part) => WORK_MODEL.test(part));
}

/**
 * boards/{slug}/jobs → boards/{slug}/offices. Returns null for any other shape (e.g. a
 * single-job URL), which disables enrichment rather than guessing at an endpoint.
 */
export function officesUrlFor(apiUrl: string): string | null {
	const match = /^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/.exec(apiUrl);
	return match?.[1] ? `${match[1]}/offices` : null;
}

/**
 * Build jobId → Set(office names) by walking offices → departments → jobs. A job listed under
 * several offices collects all of them — how a genuinely multi-site role keeps every city.
 */
export function buildOfficeMap(json: unknown): Map<unknown, Set<string>> {
	const map = new Map<unknown, Set<string>>();
	const walk = (offices: unknown): void => {
		if (!Array.isArray(offices)) return;
		for (const office of offices) {
			if (!isRecord(office)) continue;
			const name = trimmedString(office.name);
			if (name) {
				const departments = Array.isArray(office.departments) ? office.departments : [];
				for (const department of departments) {
					const jobs = isRecord(department) && Array.isArray(department.jobs) ? department.jobs : [];
					for (const job of jobs) {
						if (!isRecord(job) || job.id === null || job.id === undefined) continue;
						const existing = map.get(job.id) ?? new Set<string>();
						existing.add(name);
						map.set(job.id, existing);
					}
				}
			}
			walk(office.children);
		}
	};
	if (isRecord(json)) walk(json.offices);
	return map;
}

/**
 * Posting body → plain text. With content=true the list response embeds each body as
 * DOUBLE-encoded HTML (the JSON string carries entity-escaped markup); the shared pipeline in
 * html-to-text.ts owns the two-pass decode. This wrapper keeps greenhouse's tested export name.
 */
export function contentToText(content: unknown): string {
	return htmlToText(content);
}

type GreenhouseJob = Record<string, unknown> & { absolute_url: string };

export const greenhouse: ScanProvider = {
	id: "greenhouse",

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
		if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.company}`);
		assertGreenhouseUrl(apiUrl);
		// content=true embeds each posting's body in the list response (one request, no per-job
		// detail fetches). searchParams.set is idempotent, so an entry.api that already pins the
		// param can't end up with a duplicate. Re-validate the final href: the guard chain runs
		// on the exact string that goes over the wire, not just the pre-param base.
		const listUrl = new URL(apiUrl);
		listUrl.searchParams.set("content", "true");
		const listHref = assertGreenhouseUrl(listUrl.href);
		const json = await ctx.fetchJson(listHref, { allowedHosts: ALLOWED_GREENHOUSE_HOSTS_LIST });
		const jobs = isRecord(json) && Array.isArray(json.jobs) ? json.jobs : [];
		const usable = jobs.filter(
			(job): job is GreenhouseJob =>
				isRecord(job) && typeof job.absolute_url === "string" && job.absolute_url.length > 0,
		);

		// Only pay for /offices when this board actually hides its cities there.
		let officeMap: Map<unknown, Set<string>> | null = null;
		if (usable.some((job) => isWorkModelOnly(isRecord(job.location) ? job.location.name : undefined))) {
			const officesUrl = officesUrlFor(apiUrl);
			if (officesUrl) {
				try {
					assertGreenhouseUrl(officesUrl);
					officeMap = buildOfficeMap(await ctx.fetchJson(officesUrl, { allowedHosts: ALLOWED_GREENHOUSE_HOSTS_LIST }));
				} catch {
					// No /offices on this board, or it failed — fall back to the bare work-model
					// string. Enrichment is best-effort; a scan must never fail because the
					// secondary lookup did.
					officeMap = null;
				}
			}
		}

		return usable.map((job): ScanJob => {
			let location = trimmedString(isRecord(job.location) ? job.location.name : undefined);
			if (officeMap && isWorkModelOnly(location)) {
				const offices = officeMap.get(job.id);
				// Sorted, not in /offices traversal order: the traversal order is Greenhouse's and
				// not promised stable between responses, and an unstable join would change the
				// location string — and with it the posting's dedup identity — for a posting
				// nothing changed about.
				if (offices && offices.size > 0) location = [location, ...[...offices].sort()].join(" · ");
			}
			const description = contentToText(job.content);
			const postedAt = toEpochMs(job.first_published);
			return {
				title: stringOr(job.title),
				url: job.absolute_url,
				company: entry.company,
				location,
				// Omitted entirely when the board ships no body, so "no signal" stays
				// distinguishable from an empty string downstream.
				...(description ? { description } : {}),
				...(postedAt === undefined ? {} : { postedAt }),
			};
		});
	},
};
