/**
 * Tiered location filter, ported from career-ops' `scan.mjs` (MIT) `location_filter` section:
 * keyword compilation with Unicode word boundaries, the block_hard / always_allow / block / allow
 * tiers, opt-in strict mode (#3276), the USPS state expansion for US-targeted configs, the Workday
 * URL location hint, and the remote-title rescue. Original issue numbers preserved.
 *
 * Semantics (case-insensitive, in this order):
 *   - Absent config → everything passes.
 *   - Empty / whitespace-only / non-string location AND no URL hint → pass (don't penalize
 *     missing or malformed provider data), UNLESS `strict: true` and a restricting tier is
 *     configured — then reject, because a location-restricted sweep against a provider that does
 *     not return locations (iCIMS) otherwise silently inverts into "everything, plus matches from
 *     everywhere else" (#3276).
 *   - `blockHard` matches → reject (the only tier alwaysAllow cannot override).
 *   - `alwaysAllow` matches → pass (beats block — lets a multi-location string like
 *     "Remote, Belgium or France" through because the home region is an option). When alwaysAllow
 *     names the US as a country, USPS state names and 2-letter codes are additional alwaysAllow
 *     matches, so block: [Dublin] does not drop "Dublin, OH".
 *   - `block` matches → reject.
 *   - `allow` empty → pass (already cleared block).
 *   - `allow` non-empty → must match at least one keyword, OR the TITLE carries an explicit
 *     remote marker (see titleSignalsRemote).
 */

import type { KeywordMatcher } from "./title-keywords";

// Normalize a keyword list: tolerates a bare string (wrapped to a 1-item array), null/undefined
// (→ []), and non-string entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise match every location via
// String.includes(""), silently bypassing the other tiers.
function normalizeKeywordList(value: unknown): string[] {
	if (value == null) return [];
	const arr = Array.isArray(value) ? value : [value];
	return arr
		.filter((k): k is string => typeof k === "string")
		.map((k) => k.toLowerCase().trim())
		.filter(Boolean);
}

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compile a location keyword into a word-boundary matcher.
//
// Plain String.includes() is wrong for location keywords because country and city names are
// prefixes of unrelated US place names. The motivating bug: blocking "india" also rejected
// "Indian Head, MD", "Indiana", and "Indianapolis" — real US locations, silently dropped from
// every scan. Likewise "china" would swallow "Chinatown" and "uk -" would swallow "Truck -".
//
// Lookarounds rather than \b so keywords that begin or end with punctuation (", IND", "UK -")
// still anchor correctly — \b behaves surprisingly at a punctuation edge. Letters, combining marks
// and numbers form words in every script; ASCII-only boundaries let "al," match inside
// "Montréal," including decomposed accents (#3431). Distinct from the title filter's
// compileKeyword, which only boundary-anchors 2-3 letter acronyms: location keywords need
// boundaries on every keyword, so they get their own compiler.
// Whether a single code point is a word character. Checked per code point (spread, then a
// ^-anchored test) rather than with the original's `/[\p{L}\p{M}\p{N}]$/u` end-anchor: V8
// mis-evaluates a `$` right after a character class against an astral letter (it steps back one
// code UNIT, landing mid-surrogate), so `endsWord` read false for "𐐀" and the right boundary was
// silently dropped — exactly the class of quiet Unicode-edge bug #3431 fixed.
const isWordCodePoint = (cp: string | undefined) => cp !== undefined && /^[\p{L}\p{M}\p{N}]/u.test(cp);

function compileLocationKeyword(keyword: string): KeywordMatcher {
	const escaped = escapeForRegExp(keyword);
	const codePoints = [...keyword];
	const startsWord = isWordCodePoint(codePoints[0]);
	const endsWord = isWordCodePoint(codePoints[codePoints.length - 1]);
	const prefix = startsWord ? "(?<![\\p{L}\\p{M}\\p{N}])" : "";
	const suffix = endsWord ? "(?![\\p{L}\\p{M}\\p{N}])" : "";
	const re = new RegExp(`${prefix}${escaped}${suffix}`, "u");
	return (lower) => re.test(lower);
}

function compileLocationKeywordList(value: unknown): KeywordMatcher[] {
	return normalizeKeywordList(value).map(compileLocationKeyword);
}

// Frozen USPS state-name + abbreviation table. Not a world gazetteer: only consulted when
// alwaysAllow already names the United States as a country, so EU-targeted configs (no US token)
// keep their previous semantics.
const US_COUNTRY_ALWAYS_ALLOW = new Set(["united states", "usa", "u.s.", "u.s.a."]);

export const USPS_STATES = [
	["alabama", "al"],
	["alaska", "ak"],
	["arizona", "az"],
	["arkansas", "ar"],
	["california", "ca"],
	["colorado", "co"],
	["connecticut", "ct"],
	["delaware", "de"],
	["florida", "fl"],
	["georgia", "ga"],
	["hawaii", "hi"],
	["idaho", "id"],
	["illinois", "il"],
	["indiana", "in"],
	["iowa", "ia"],
	["kansas", "ks"],
	["kentucky", "ky"],
	["louisiana", "la"],
	["maine", "me"],
	["maryland", "md"],
	["massachusetts", "ma"],
	["michigan", "mi"],
	["minnesota", "mn"],
	["mississippi", "ms"],
	["missouri", "mo"],
	["montana", "mt"],
	["nebraska", "ne"],
	["nevada", "nv"],
	["new hampshire", "nh"],
	["new jersey", "nj"],
	["new mexico", "nm"],
	["new york", "ny"],
	["north carolina", "nc"],
	["north dakota", "nd"],
	["ohio", "oh"],
	["oklahoma", "ok"],
	["oregon", "or"],
	["pennsylvania", "pa"],
	["rhode island", "ri"],
	["south carolina", "sc"],
	["south dakota", "sd"],
	["tennessee", "tn"],
	["texas", "tx"],
	["utah", "ut"],
	["vermont", "vt"],
	["virginia", "va"],
	["washington", "wa"],
	["west virginia", "wv"],
	["wisconsin", "wi"],
	["wyoming", "wy"],
] as const;

// 2-letter codes: comma-state (", OH" / ",OH, USA") or a trailing token ("Dublin OH", Workday URL
// hint "dublin oh"). Not a generic word-boundary — English "in"/"or"/"me" in "Remote, Belgium or
// France" must not impersonate Indiana/Oregon/Maine. State *names* still use
// compileLocationKeyword. Unicode letters and marks are part of the token: "Montréal" is not "AL".
function compileUsStateAbbrev(abbr: string): KeywordMatcher {
	const escaped = escapeForRegExp(abbr);
	const re = new RegExp(
		`(?:,\\s*${escaped}(?![\\p{L}\\p{M}\\p{N}])|(?:^|[^\\p{L}\\p{M}\\p{N}])${escaped}[^\\p{L}\\p{M}\\p{N}]*$)`,
		"u",
	);
	return (lower) => re.test(lower);
}

const US_STATE_ALWAYS_ALLOW_MATCHERS: readonly KeywordMatcher[] = USPS_STATES.flatMap(([name, abbr]) => [
	compileLocationKeyword(name),
	compileUsStateAbbrev(abbr),
]);

/**
 * Some providers report a rolled-up display string ("5 Locations") while the canonical URL still
 * names the real primary location. Workday is the common case:
 * .../job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1 shows up as "5 Locations", so no
 * `block` keyword can ever match the location field. Recover that signal by reading the path
 * segment right after `/job/`.
 *
 * Deliberately narrow: only the post-`/job/` segment of a *.myworkdayjobs.com URL is inspected,
 * never the whole URL. Scanning the full URL would match company slugs and ATS subdomains by
 * accident. Providers without the Workday hostname convention yield no hint and keep their
 * behaviour exactly, even if their own routes also contain `/job/{id}`.
 */
export function locationHintFromUrl(url: unknown): string {
	if (typeof url !== "string" || url.trim() === "") return "";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "";
	}
	if (!parsed.hostname.toLowerCase().endsWith(".myworkdayjobs.com")) return "";
	const segments = parsed.pathname.split("/").filter(Boolean);
	const jobIdx = segments.lastIndexOf("job");
	// Workday also emits /job/{Title}_{ReqId}; a location needs a title after it.
	if (jobIdx === -1 || segments.length - jobIdx - 1 < 2) return "";
	let segment = segments[jobIdx + 1] ?? "";
	try {
		segment = decodeURIComponent(segment);
	} catch {
		// Malformed percent-encoding — fall back to the raw segment.
	}
	// "Hyderabad-Telangana-India" → "hyderabad telangana india" so multi-word block keywords like
	// "united arab emirates" can still match.
	return segment
		.replace(/[-_+]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

// Some ATSs report the hiring office as the location even when the role is remote, and state the
// remoteness in the TITLE instead: Radancy/TalentBrew tenants return bare "City, State" strings,
// so "Program Manager - Remote" → location "Las Vegas, Nevada". An `allow` list written in
// country/region terms then rejects a genuinely remote US role.
//
// Only an unambiguous work-arrangement marker counts. A bare /remote/ test would admit domain
// compounds — "Remote Sensing Program Manager" is an on-site GIS role. So "remote" must be
// followed by end-of-string, a non-letter (")", ",", "-"), or " in …" as in "Remote in MO" —
// never by another word.
export const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;

// …and a negation before the word has to lose, which the marker regex alone cannot see: in
// "Non-Remote" / "Not Remote" the delimiter clears the lookbehind and the trailing position clears
// the lookahead, so an explicitly on-site role would bypass a non-empty `allow` list. The
// separator class must be at least as broad as the marker's own delimiter lookahead: an ASCII-only
// `[\s-]*` let every non-ASCII dash through (en dash, non-breaking hyphen, em dash, figure dash,
// minus). `[^a-z]*` spans any run of non-letters, and cannot over-reach because it never crosses a
// letter: in "Nonprofit Program Manager - Remote" the run after "non" starts with "profit".
// Over-rejecting here is the safe direction: this tier only ever *rescues* a posting.
export const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

/** Whether the title marks the role remote (an unambiguous, un-negated work-arrangement marker). */
export function titleSignalsRemote(title: unknown): boolean {
	if (typeof title !== "string" || title.trim() === "") return false;
	const lower = title.toLowerCase();
	if (REMOTE_NEGATED_RE.test(lower)) return false;
	return REMOTE_TITLE_RE.test(lower);
}

export type LocationFilterConfig = {
	/** When non-empty, a location must match one of these (or the title must signal remote). */
	allow?: string | readonly string[];
	/** Rejects, unless alwaysAllow matches. */
	block?: string | readonly string[];
	/** Rejects always — the one tier alwaysAllow cannot override. For country-level terms that
	 * are never a false rejection: "Porto Alegre, …, Brazil" must not survive on an always-allowed
	 * "Porto" (#650 added alwaysAllow so a multi-location posting survives one blocked city; this
	 * tier is the opt-in counterweight for entries that are country-level). */
	blockHard?: string | readonly string[];
	/** Passes, beating block. A US country token here also enables the USPS state expansion. */
	alwaysAllow?: string | readonly string[];
	/** Opt-in: fail closed when there is nothing to judge on. Only meaningful when a restricting
	 * tier is configured — `{ strict: true }` alone restricts nothing and must not reject every
	 * location-less posting (#3276). */
	strict?: boolean;
};

/** True = the location passes. `url` and `title` are optional; callers that omit them get the
 * original location-only semantics. */
export type LocationFilter = (location: unknown, url?: unknown, title?: unknown) => boolean;

export function buildLocationFilter(locationFilter: LocationFilterConfig | null | undefined): LocationFilter {
	if (!locationFilter) return () => true;
	const alwaysAllowKeywords = normalizeKeywordList(locationFilter.alwaysAllow);
	const alwaysAllow = alwaysAllowKeywords.map(compileLocationKeyword);
	// US-targeted configs list the country in alwaysAllow and foreign cities in block. "Dublin,
	// OH" does not contain "United States", so without this expansion block: [Dublin] rejects a
	// real US job. Opt-in on the country token — configs with no US entry are unchanged.
	if (alwaysAllowKeywords.some((k) => US_COUNTRY_ALWAYS_ALLOW.has(k))) {
		alwaysAllow.push(...US_STATE_ALWAYS_ALLOW_MATCHERS);
	}
	const allow = compileLocationKeywordList(locationFilter.allow);
	const block = compileLocationKeywordList(locationFilter.block);
	const blockHard = compileLocationKeywordList(locationFilter.blockHard);
	const strict = locationFilter.strict === true && (allow.length > 0 || block.length > 0 || blockHard.length > 0);

	return (location, url, title) => {
		const lower = typeof location === "string" ? location.trim().toLowerCase() : "";
		const hint = locationHintFromUrl(url);
		// Nothing to judge on either field → pass (don't penalize missing data), unless the config
		// opted into strict mode (#3276).
		if (lower === "" && hint === "") return !strict;
		const matches = (m: KeywordMatcher) => (lower !== "" && m(lower)) || (hint !== "" && m(hint));
		// blockHard is the ONE tier alwaysAllow cannot override: a European city name can be a
		// whole word inside a non-European location, so word-boundary matching (#2087) does not
		// catch it and alwaysAllow's unconditional win would silently discard the user's own block
		// entry ("Porto Alegre, Rio Grande do Sul, Brazil"; "USA - New York - Malta").
		if (blockHard.length > 0 && blockHard.some(matches)) return false;
		// alwaysAllow still wins over block, and may be satisfied by either field: a genuinely US
		// role whose display string says "United States" is never rejected because of what its URL
		// happens to contain.
		if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
		if (block.length > 0 && block.some(matches)) return false;
		if (allow.length === 0) return true;
		if (allow.some(matches)) return true;
		// Last resort only. Deliberately placed AFTER block so a remote title can never rescue a
		// blocked location — "Program Manager - Remote" in Bengaluru stays rejected. This widens
		// allow, never block.
		return titleSignalsRemote(title);
	};
}
