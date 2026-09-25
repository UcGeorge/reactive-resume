/**
 * Ashby provider — the public posting-api endpoint.
 *
 * Ported from career-ops' `providers/ashby.mjs` (MIT). Auto-detects from careers URLs shaped
 * `https://jobs.ashbyhq.com/<slug>`. Ashby's posting-api carries a ~10s+ server-side latency
 * floor (independent of board size) and rate-limits repeated unauthenticated hits, so this
 * provider pins a longer per-request timeout than the context default — a 15s default sits
 * close enough to that floor for requests to race the timeout and abort.
 */
import type { PortalEntry, ScanProvider, ScanSalary } from "../types";
import type { JsonRecord } from "./shared";
import { assertProviderUrl, isRecord, stringOr, toEpochMs, trimmedString } from "./shared";

const ASHBY_TIMEOUT_MS = 30_000;

/** Annualization multipliers for the compensation intervals the posting-api emits. */
const INTERVAL_MULTIPLIERS: Record<string, number> = {
	"1 HOUR": 2080,
	"1 DAY": 260,
	"1 WEEK": 52,
	"2 WEEK": 26,
	"0.5 MONTH": 24,
	"1 MONTH": 12,
	"2 MONTH": 6,
	"3 MONTH": 4,
	"6 MONTH": 2,
	"1 YEAR": 1,
};

/**
 * Parse compensation from an Ashby job object into an annualized {min, max, currency}, or null
 * when no valid figures exist — salary is attached only when the source exposes real numbers.
 *
 * The posting-api does not put min/max on the compensation object itself. A real payload
 * carries tiers, and each tier carries components:
 *
 *   compensationTiers[].components[] = { compensationType: 'Salary', interval: '1 YEAR',
 *                                        minValue, maxValue, currencyCode, summary }
 *
 * Only a Salary component carries the role's range — `EquityPercentage` and bonus components
 * hold `summary` text or unrelated numbers and must not be read as a range. The flat shape
 * (fields directly on `compensation`) is still accepted for hand-built payloads.
 */
export function parseCompensation(job: unknown): ScanSalary | null {
	if (!isRecord(job) || !isRecord(job.compensation)) return null;
	const comp = job.compensation;

	const normalizeNum = (value: unknown): number | null => {
		if (value === null || value === undefined) return null;
		if (typeof value === "string" && value.trim() === "") return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	};

	let source: JsonRecord = comp;
	let nested = false;
	const tiers = Array.isArray(comp.compensationTiers) ? comp.compensationTiers : [];
	const components = tiers.flatMap((tier): unknown[] =>
		isRecord(tier) && Array.isArray(tier.components) ? tier.components : [],
	);
	if (components.length > 0) {
		const salaryComponents = components.filter(
			(component): component is JsonRecord =>
				isRecord(component) && trimmedString(component.compensationType).toLowerCase() === "salary",
		);
		if (salaryComponents.length === 0) return null;
		const withRange = salaryComponents.filter(
			(component) => normalizeNum(component.minValue) !== null || normalizeNum(component.maxValue) !== null,
		);
		if (withRange.length === 0) return null;
		// Choose among the components that can actually be READ, then take the widest range as
		// the role's band. Picking the widest first and validating its interval afterwards made
		// a wider component with an unusable interval fatal: the function returned null with a
		// readable narrower component sitting right there. A component with no interval of its
		// own is unusable here, not merely unvalidated — annualizing it would silently guess.
		const readable = (component: JsonRecord): boolean => {
			const raw = component.interval;
			return typeof raw === "string" && raw.trim() !== "" && Object.hasOwn(INTERVAL_MULTIPLIERS, raw);
		};
		const candidates = withRange.filter(readable);
		const first = candidates[0];
		if (first === undefined) return null;
		const span = (component: JsonRecord): number =>
			(normalizeNum(component.maxValue) ?? normalizeNum(component.minValue) ?? 0) -
			(normalizeNum(component.minValue) ?? normalizeNum(component.maxValue) ?? 0);
		source = candidates.reduce((best, component) => (span(component) > span(best) ? component : best), first);
		nested = true;
	}

	// A component states its own interval, so a nested component with none is not the same as a
	// flat object with none. The `1 YEAR` default is a convenience for the legacy flat shape;
	// applying it to a nested component would annualize a monthly figure silently.
	const flatInterval =
		typeof source.interval === "string" && source.interval
			? source.interval
			: typeof comp.interval === "string" && comp.interval
				? comp.interval
				: "1 YEAR";
	const rawInterval = nested ? source.interval : flatInterval;
	if (typeof rawInterval !== "string" || !rawInterval.trim()) return null;
	// hasOwn, not a bare truthiness test: an adversarial interval like "constructor" would
	// otherwise resolve through the prototype to a (truthy) function and poison the math.
	if (!Object.hasOwn(INTERVAL_MULTIPLIERS, rawInterval)) return null;
	const multiplier = INTERVAL_MULTIPLIERS[rawInterval];
	if (multiplier === undefined) return null;

	const minValue = normalizeNum(source.minValue ?? comp.minValue);
	const maxValue = normalizeNum(source.maxValue ?? comp.maxValue);
	const rawCurrency = source.currencyCode ?? source.currency ?? comp.currency;
	const currency = typeof rawCurrency === "string" ? rawCurrency.trim() : "";
	if (minValue === null && maxValue === null) return null;

	const min = minValue !== null ? minValue * multiplier : null;
	const max = maxValue !== null ? maxValue * multiplier : null;
	const resolvedMin = min ?? max;
	const resolvedMax = max ?? min;
	if (resolvedMin === null || resolvedMax === null) return null;
	return {
		min: Math.min(resolvedMin, resolvedMax),
		max: Math.max(resolvedMin, resolvedMax),
		currency: currency.toUpperCase(),
	};
}

const ALLOWED_ASHBY_HOSTS: ReadonlySet<string> = new Set(["api.ashbyhq.com"]);
const ALLOWED_ASHBY_HOSTS_LIST = [...ALLOWED_ASHBY_HOSTS];

function assertAshbyUrl(url: string): string {
	return assertProviderUrl("ashby", url, ALLOWED_ASHBY_HOSTS);
}

function resolveApiUrl(entry: PortalEntry): string | null {
	// Explicit api: wins — lets an entry keep a human-facing corporate careers page as `url`
	// while still pinning the posting-api board (mirrors greenhouse's api: precedence).
	if (entry.api) {
		assertAshbyUrl(entry.api);
		return entry.api;
	}
	let parsed: URL;
	try {
		parsed = new URL(entry.url);
	} catch {
		return null;
	}
	if (parsed.hostname !== "jobs.ashbyhq.com") return null;
	const slug = parsed.pathname.split("/").filter(Boolean)[0];
	if (!slug) return null;
	return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
}

/**
 * Full location string from primary + secondary locations. The posting-api puts extra hiring
 * regions in `secondaryLocations[]` (region label + postalAddress); reading only `location`
 * hides every other eligible region from location filtering. The work model lives in fields
 * SEPARATE from `location` — `workplaceType` ("Remote"|"Hybrid"|"Onsite") and the boolean
 * `isRemote` — while `location` keeps naming the office/HQ city even for fully remote roles,
 * so "Remote" is appended to make the work model visible without discarding the city.
 * `workplaceType` wins when present: boards in the wild carry `isRemote: true` together with
 * `workplaceType: "Hybrid"` for office-anchored roles, and trusting `isRemote` alone would
 * defeat a remote-only filter. Deduped, joined with " · ".
 */
function formatLocation(job: JsonRecord): string {
	const parts: string[] = [];
	const primary = trimmedString(job.location);
	if (primary) parts.push(primary);
	if (Array.isArray(job.secondaryLocations)) {
		for (const secondary of job.secondaryLocations) {
			if (!isRecord(secondary)) continue;
			const label = trimmedString(secondary.location);
			if (label) parts.push(label);
			const postal = isRecord(secondary.address) ? secondary.address.postalAddress : undefined;
			if (isRecord(postal)) {
				for (const key of ["addressLocality", "addressCountry"]) {
					const value = trimmedString(postal[key]);
					if (value) parts.push(value);
				}
			}
		}
	}
	const workplaceType = trimmedString(job.workplaceType).toLowerCase();
	const isRemote = workplaceType ? workplaceType === "remote" : job.isRemote === true;
	if (isRemote && !parts.some((part) => /remote/i.test(part))) parts.push("Remote");
	return [...new Set(parts)].join(" · ");
}

export const ashby: ScanProvider = {
	id: "ashby",

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
		if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.company}`);
		assertAshbyUrl(apiUrl);
		const json = await ctx.fetchJson(apiUrl, {
			allowedHosts: ALLOWED_ASHBY_HOSTS_LIST,
			timeoutMs: ASHBY_TIMEOUT_MS,
		});
		const jobs = isRecord(json) && Array.isArray(json.jobs) ? json.jobs : [];
		return jobs.map((rawJob) => {
			const job: JsonRecord = isRecord(rawJob) ? rawJob : {};
			const salary = parseCompensation(job);
			const postedAt = toEpochMs(job.publishedAt);
			return {
				title: stringOr(job.title),
				url: stringOr(job.jobUrl),
				company: entry.company,
				location: formatLocation(job),
				// The posting-api list ships `descriptionPlain` for free (same payload, no
				// per-job request) — mirrors lever.
				description: stringOr(job.descriptionPlain),
				...(salary ? { salary } : {}),
				...(postedAt === undefined ? {} : { postedAt }),
			};
		});
	},
};
