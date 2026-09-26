/**
 * Re-apply cooldown rule, RE-EXPRESSED (not line-ported) from career-ops' `scan.mjs` (MIT)
 * `buildCooldownFilter` + `loadReApplyWindows`. The original is entangled with the profile file:
 * it reads per-company `re_apply_windows` blocks (last_apply_date / same_role_days / applied_to /
 * cross_role_bucket) out of profile.yml and matches companies through a corporate-form-stripping
 * matcher. This module re-expresses the RULE as one pure function over data the caller already
 * has: a candidate job plus the list of prior applications.
 *
 * What is ported faithfully:
 *   - The window arithmetic, including the boundary: an application blocks while
 *     `now < appliedDate + cooldownDays` — a job seen EXACTLY cooldownDays later is open again
 *     (the original's `today >= cooldownUntil → continue`, asserted by its boundary-day test).
 *   - Date handling: ISO YYYY-MM-DD day strings compared lexically after UTC day arithmetic
 *     (addDays), the original's deliberate choice so a west-of-Greenwich evening run cannot open
 *     a cooldown a day early (#3070).
 *   - Role matching: a prior role blocks when the job TITLE contains it, case-insensitive
 *     substring — the original's `applied_to` semantics ("Senior Software Engineer" blocks
 *     "Lead Senior Software Engineer").
 *   - Malformed inputs fail open, matching loadReApplyWindows dropping malformed windows: a
 *     non-positive cooldown, an unparseable date, or an empty prior role never blocks.
 *
 * What is re-expressed rather than ported:
 *   - Company matching uses this package's fingerprint-style companyKey normalization (NFKC,
 *     lowercase, keep letters/numbers/marks in every script) with a word-boundary containment
 *     fallback, instead of the original companyMatch's corporate-form table (GmbH/Inc/株式会社
 *     stripping, #2570). Containment still lets "CompanyA Corp" match "CompanyA" while
 *     "CompanyAlpha" does not.
 *   - The original's `cross_role_bucket` keyword matching (bucket names split on "_", generic
 *     words dropped, an "em"/"engineering manager" special case) is NOT carried over: the
 *     re-expressed input is a flat list of prior applications, and a caller wanting a bucket veto
 *     lists the bucket's role names as priors.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `dateStr` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD, in UTC. */
export function addDays(dateStr: string, days: number): string {
	const date = new Date(`${dateStr}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Same normalization idea as fingerprint's companyKey: NFKC + lowercase, keep letters, numbers
// and combining marks in every script (a bare [a-z0-9] strip would delete non-Latin names
// entirely, silently equating genuinely different employers). Two variants: `companyKey` strips
// separators so "Company A" equals "CompanyA"; `companyKeyWords` keeps them as single spaces so
// containment can be word-bounded.
function companyKey(name: unknown): string {
	return String(name ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

function companyKeyWords(name: unknown): string {
	return String(name ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
		.trim();
}

// Lookarounds rather than \b, as everywhere else in these filters: an anchor class without \p{M}
// would treat a combining mark as a boundary, and \b at a non-ASCII edge can never hold.
const bounded = (name: string) =>
	new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeForRegExp(name)}(?![\\p{L}\\p{M}\\p{N}])`, "u");

/** Same employer? Equal after separator-stripping ("Company A" = "CompanyA"), or one name is a
 * word-bounded prefix/suffix/infix of the other ("CompanyA Corp" contains "CompanyA";
 * "CompanyAlpha" does not). */
export function companiesMatch(a: unknown, b: unknown): boolean {
	const keyA = companyKey(a);
	const keyB = companyKey(b);
	if (!keyA || !keyB) return false;
	if (keyA === keyB) return true;
	const wordsA = companyKeyWords(a);
	const wordsB = companyKeyWords(b);
	return bounded(wordsB).test(wordsA) || bounded(wordsA).test(wordsB);
}

export type PriorApplication = {
	company: string;
	/** The role applied to. Blocks a job whose title CONTAINS it (case-insensitive). */
	role: string;
	/** YYYY-MM-DD day the application was made/last updated. Malformed → the prior is ignored. */
	updatedAt: string;
};

export type CooldownInput = {
	company: string;
	title: string;
	priorApplications: readonly PriorApplication[];
	/** Days an application blocks re-applying to the same company+role family. Non-positive or
	 * non-integer → nothing is ever blocked (the original's `same_role_days || 0` default). */
	cooldownDays: number;
	/** Today as YYYY-MM-DD. Passed in rather than read from the clock so callers control the
	 * calendar day — the original defaults to the LOCAL day precisely because the UTC day is
	 * tomorrow for a west-of-Greenwich evening run (#3070). */
	now: string;
};

/** True = the job is inside a cooldown window and should be skipped. */
export function cooldownBlocked(input: CooldownInput): boolean {
	const { company, title, priorApplications, cooldownDays, now } = input;
	if (!Number.isInteger(cooldownDays) || cooldownDays <= 0) return false;
	if (typeof now !== "string" || !ISO_DATE_RE.test(now)) return false;
	const titleLower = String(title ?? "").toLowerCase();

	for (const prior of Array.isArray(priorApplications) ? priorApplications : []) {
		const applied = typeof prior?.updatedAt === "string" ? prior.updatedAt : "";
		if (!ISO_DATE_RE.test(applied)) continue;
		// Round-trip the day rather than only Date.parse-ing it: the legacy parser accepts an
		// impossible "2026-02-31" and rolls it into March, which would silently shift the window.
		const parsed = new Date(`${applied}T00:00:00Z`);
		if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== applied) continue;
		const cooldownUntil = addDays(applied, cooldownDays);
		// `now >= cooldownUntil` → the window has closed; the boundary day itself is open.
		if (now >= cooldownUntil) continue;
		if (!companiesMatch(company, prior.company)) continue;
		const roleLower = String(prior.role ?? "")
			.trim()
			.toLowerCase();
		// An empty prior role would block every title via includes("") — fail open instead.
		if (!roleLower) continue;
		if (titleLower.includes(roleLower)) return true;
	}
	return false;
}
