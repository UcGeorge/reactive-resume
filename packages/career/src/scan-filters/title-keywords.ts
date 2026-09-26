/**
 * Title/content keyword matching, ported from career-ops' `title-keywords.mjs` (MIT) plus the
 * `title_filter` AND-group and per-company override semantics from `scan.mjs`.
 *
 * The original module exists because two scan paths filter titles and must not drift; this port
 * keeps it a single definition for the same reason, and folds scan.mjs's AND-group handling in so
 * the module is self-contained. Original issue numbers are preserved in the comments.
 */

// Opt-in whole-word matching for a keyword too long to get it automatically. Chosen over widening
// the 2-3 char rule to every single-word keyword, because the right-hand boundary is exactly what a
// NEGATIVE usually wants to keep: "crypto" is meant to catch "Cryptocurrency" and "fellows" to
// catch "Fellowship", and anchoring the whole list would silently stop both. The prefix cannot
// collide with a real keyword: a job title never contains a colon-suffixed "word".
export const WORD_PREFIX = "word:";

// `stem:` is the other half of the same question, and the two halves are NOT one setting seen from
// two sides:
//
//   `word:agent` says "agent, and nothing longer" — it rejects Agentforce.
//   `stem:agent` says "a word that STARTS with agent" — it keeps Agentforce and Agentic, and drops
//   Reagents, where the keyword lands mid-word.
//   A bare `agent`, the default, keeps all three.
//
// A plain substring is two loosenesses at once, and only one of them is usually wanted; `stem:`
// lets an entry ask for the one it means — what separates Agentforce from Reagents (#3103).
export const STEM_PREFIX = "stem:";

function escapeForRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One definition of "inside a word", used by BOTH branches below. Anything else reintroduces
// exactly the drift this module exists to prevent: the acronym branch used ASCII \b while the
// `word:` branch had been made Unicode-aware, so `vp` still matched inside an accented word.
//
// String.raw, not a plain template literal: `\p` is not a recognised string escape, so an ordinary
// template drops the backslash and the class degenerates to the literal characters p, {, L, } —
// no error, and the anchor is simply off.
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;
const anchoredPattern = (body: string) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, "u");
// Same left boundary, no right one: the keyword must start a word, and the word may continue.
const stemPattern = (body: string) => new RegExp(`(?<!${WORD_CHAR})${body}`, "u");

/** A compiled keyword: tests an already lowercased (and, for titles, accent-folded) text. */
export type KeywordMatcher = (lower: string) => boolean;

// `word:` and `stem:` mean the same thing wherever a keyword list is matched against text, so their
// handling lives here once rather than being copied into each compiler. Returns a matcher when `kw`
// carries a recognised prefix, or null when it is an ordinary keyword the caller compiles its own
// way (the title filter auto-anchors short acronyms and falls back to substring; the content filter
// goes straight to substring — see #3103, #3274).
//
// Explicit alphanumeric lookarounds rather than \b, because \b's meaning depends on the characters
// at the keyword's own edges: for `word:c++` a trailing \b would sit after "+" and assert the
// opposite of the intent. WORD_CHAR rather than [a-z0-9_]: an ASCII-only lookaround treats every
// accented letter as a separator, so `word:intern` matched inside "preintern" spelled with an
// accent and vetoed exactly the international titles this prefix exists to protect. \p{M} covers
// combining marks, so a decomposed "é" does not split a word either.
function compilePrefixedKeyword(kw: string): KeywordMatcher | null {
	if (kw.startsWith(WORD_PREFIX)) {
		const bare = kw.slice(WORD_PREFIX.length).trim();
		// A bare `word:` is a config typo. Matching NOTHING is the safe reading: as a positive it
		// simply contributes no match, while an empty pattern matching everything would veto an
		// entire scan from one stray colon. Prefer a silent drop of one entry over a silent flood.
		if (!bare) return () => false;
		const re = anchoredPattern(escapeForRegExp(bare));
		return (lower) => re.test(lower);
	}
	if (kw.startsWith(STEM_PREFIX)) {
		const bare = kw.slice(STEM_PREFIX.length).trim();
		// Same reading as a bare `word:`: matching nothing is the safe half of that trade.
		if (!bare) return () => false;
		const re = stemPattern(escapeForRegExp(bare));
		return (lower) => re.test(lower);
	}
	return null;
}

/**
 * Fold diacritics so a keyword and a title compare equal regardless of accents. Spanish/Portuguese
 * boards routinely publish titles in UPPERCASE WITHOUT accents ("TECNICO CONTROL DE PRODUCCION")
 * while configs are written with them ("Producción"); with toLowerCase() alone they never match,
 * and every such posting is silently counted as filtered by title. BOTH sides are folded, so the
 * comparison stays symmetric. Deliberately NOT a strip to [a-z0-9]: spaces, ".NET" and "L&D" are
 * part of the keyword.
 */
export function foldAccents(s: string | null | undefined): string {
	return String(s ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "");
}

/**
 * Compile a lowercased title keyword into a matcher.
 *
 * Short all-letter acronyms (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on WORD BOUNDARIES so
 * "COO" does not match "Coordinator". A `word:` prefix asks for the same treatment explicitly, at
 * any length: `word:intern` rejects "Operations Intern" and leaves "Internal Tools" and
 * "International Partnerships Manager" alone. Multi-word phrases and keywords containing
 * non-letters (".NET", "SAP ", "L&D") keep fast, permissive substring matching.
 *
 * @param kw already trimmed and lowercased (and accent-folded by the title filter).
 */
export function compileKeyword(kw: string): KeywordMatcher {
	const prefixed = compilePrefixedKeyword(kw);
	if (prefixed) return prefixed;
	if (/^[a-z]{2,3}$/.test(kw)) {
		// The same boundary as above, not \b: \b is ASCII-only, so "vp" matched inside an accented
		// word while `word:vp` did not. Two spellings of one rule in one file is the drift this
		// module was extracted to end.
		const re = anchoredPattern(kw);
		return (lower) => re.test(lower);
	}
	return (lower) => lower.includes(kw);
}

/**
 * Compile a lowercased content (description-text) keyword into a matcher.
 *
 * The content filter matches against the job DESCRIPTION, not the title, and its default has
 * always been a plain case-insensitive substring. That default is why a bare exclude `java`
 * rejects every posting that merely mentions "JavaScript", and `ios` rejects "curiosity" (#3274).
 * Flipping the default is a breaking change for every configured install — the same conclusion
 * #3103 reached for the title filter — so the fix is opt-in: a `word:` or `stem:` prefix asks for
 * boundary-anchored matching on that one entry, and every other entry keeps substring behaviour
 * byte-for-byte.
 *
 * Unlike compileKeyword(), there is no automatic anchoring of short keywords. The title filter
 * anchors 2-3 letter acronyms because "COO" inside "Coordinator" is always wrong; a 2-3 letter run
 * inside a paragraph of description prose is routinely intended ("aws", "gcp", "sql", "go").
 */
export function compileContentKeyword(kw: string): KeywordMatcher {
	return compilePrefixedKeyword(kw) ?? ((lower) => lower.includes(kw));
}

// An AND-group: " + " (whitespace-delimited) between terms means EVERY term must appear in the
// title, in any order. A `positive` entry otherwise expresses one exact spelling and nothing else,
// and real titles vary in separator and word order:
//
//   "Director of Engineering" misses  Director - Software Engineering
//                                     Director Engineering (Mobile Platform)
//                                     Senior Director, Platform Engineering
//
// The combinations are {level} x {, - of none} x {optional domain word}: no hand-maintained list
// of literal spellings converges, and every miss is silent (#2544).
//
// The separator REQUIRES surrounding whitespace on purpose. A bare split('+') would turn the
// perfectly ordinary keyword "C++" into "c", which matches almost every title — trading a silent
// drop for a silent flood. Exported because a caller that must reason about the TERMS of a group
// has to split them exactly as this file does.
export const AND_SEPARATOR = /\s+\+\s+/;

/**
 * Compile one `positive` entry into a matcher. Entries without " + " keep their exact plain
 * behaviour, so existing configs are unaffected.
 *
 * @param keyword already trimmed and lowercased.
 */
export function compilePositiveKeyword(keyword: string): KeywordMatcher {
	if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
	const terms = keyword
		.split(AND_SEPARATOR)
		.map((t) => t.trim())
		.filter(Boolean);
	if (terms.length === 0) return compileKeyword(keyword);
	// Each term keeps compileKeyword's own rule, so a short term like "vp" is still matched on a
	// word boundary and cannot hit "vp" inside another word.
	const matchers = terms.map(compileKeyword);
	return (lower) => matchers.every((m) => m(lower));
}

export type TitleFilterConfig = {
	/** Entries may be AND-groups ("a + b") and may carry `word:` / `stem:` prefixes. */
	positive?: readonly string[];
	/** Vetoes. AND-groups are a positive-side feature only: on the negative side " + " would read
	 * as "reject when both appear", which is a different and much easier thing to write as two
	 * entries. */
	negative?: readonly string[];
};

/** True = the title passes the filter. Accepts unknown so a malformed provider title (a number, an
 * object) is matched as text instead of throwing and dropping a whole company's results. */
export type TitleFilter = (title: unknown) => boolean;

// Normalize defensively: a malformed config (a null, numeric, or otherwise non-string entry in the
// YAML it originally came from) must not crash the scan via k.toLowerCase().
function normalizeTitleKeywordList(list: unknown, compile: (kw: string) => KeywordMatcher): KeywordMatcher[] {
	return (Array.isArray(list) ? list : [])
		.filter((k): k is string => typeof k === "string")
		.map((k) => foldAccents(k.trim().toLowerCase()))
		.filter((k) => k.length > 0)
		.map(compile);
}

/**
 * Compile a whole title filter into one predicate.
 *
 * The original lived beside two callers that had drifted in three separate ways: an empty positive
 * list meant "accept everything" in one and "reject everything" in the other, AND-groups worked
 * only in one, and a non-string YAML entry was dropped in one but coerced into a real keyword in
 * the other. One shared predicate removes the class rather than those three instances.
 */
export function buildTitleFilter(titleFilter?: TitleFilterConfig | null): TitleFilter {
	const positive = normalizeTitleKeywordList(titleFilter?.positive, compilePositiveKeyword);
	const negative = normalizeTitleKeywordList(titleFilter?.negative, compileKeyword);

	return (title) => {
		// String(), not `title || ''`: one of the original paths threw on a truthy non-string,
		// which aborted jobs.filter and dropped a whole company's results for one malformed title.
		const lower = foldAccents(String(title ?? "").toLowerCase());
		// An empty positive list is "no positive constraint", not "match nothing": a negative-only
		// title filter is a legitimate config that rejects a few roles and keeps the rest.
		const hasPositive = positive.length === 0 || positive.some((m) => m(lower));
		const hasNegative = negative.some((m) => m(lower));
		return hasPositive && !hasNegative;
	};
}

/**
 * Wrap buildTitleFilter() with a single company's override, mirroring scan.mjs's
 * `buildTitleFilterWithOverrides` (a slug→positive_extra map) reduced to one company:
 *
 *   - `override.positive` WIDENS the net: the title passes when the global filter already passes,
 *     or when an override positive matches AND no global negative matches — the original's
 *     positive_extra semantics, where the widened net still respects the global vetoes.
 *   - `override.negative` ADDS vetoes: an override negative rejects even a title the global filter
 *     would pass. (The original override map carried no negatives; this is the natural extension —
 *     a negative is a veto everywhere else in the filter, so it is one here too.)
 *   - No override (or an empty one) behaves EXACTLY like buildTitleFilter(global): the mechanism
 *     is a strict no-op for a company that is not explicitly listed.
 *
 * One deliberate deviation from the original override path: keywords and titles are accent-folded
 * here, exactly as buildTitleFilter folds them. The original's override branch used bare
 * toLowerCase() and so disagreed with its own base filter on accented titles.
 */
export function buildTitleFilterWithOverride(
	global: TitleFilterConfig | null | undefined,
	override?: TitleFilterConfig | null,
): TitleFilter {
	const base = buildTitleFilter(global);
	// compilePositiveKeyword (not compileKeyword) so override positives support the same
	// AND-groups / `word:`/`stem:` prefixes as the global positive list — it is an additive
	// positive list, so it behaves like one.
	const overridePositive = normalizeTitleKeywordList(override?.positive, compilePositiveKeyword);
	const overrideNegative = normalizeTitleKeywordList(override?.negative, compileKeyword);
	if (overridePositive.length === 0 && overrideNegative.length === 0) return base;
	const globalNegative = normalizeTitleKeywordList(global?.negative, compileKeyword);

	return (title) => {
		const lower = foldAccents(String(title ?? "").toLowerCase());
		if (overrideNegative.some((m) => m(lower))) return false;
		if (base(title)) return true;
		if (overridePositive.length === 0) return false;
		if (globalNegative.some((m) => m(lower))) return false;
		return overridePositive.some((m) => m(lower));
	};
}
