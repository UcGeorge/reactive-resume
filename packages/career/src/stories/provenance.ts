/**
 * Story-bank provenance discipline, ported from career-ops' `story-provenance-check.mjs`
 * (MIT, issue #2947).
 *
 * A story bank is *accumulated* — commonly extracted from AI-written interview-prep documents
 * that map the user's experience onto a specific posting's language. Nothing guarantees a
 * story's numbers trace back to a user-authored source, and that is the unguarded channel this
 * module exists to catch: JD-shaped phrasing absorbed into a story, treated as a
 * resume-equivalent fact, surfacing in CV bullets and talk tracks, drifting further on reuse.
 *
 * Four states, mapped from the original's four buckets and `**Provenance:**` markers onto this
 * repo's story rows (the DB field replaces the markdown marker):
 *
 *   resume-verified     — the original's `existing` via a cv.md trace, or its literal
 *                          `source: cv.md` marker: every numeric claim traces to the linked
 *                          resume's text.
 *   user-confirmed      — the original's `user-stated YYYY-MM-DD` marker: the user explicitly
 *                          confirmed the figures. Wins over the heuristic (checked FIRST, never
 *                          as a fallback — the original's #2947 CodeRabbit regression was
 *                          evaluating markers after the context-overlap heuristic).
 *   derived-unverified  — the safe default: the claim exists only in the story and has not
 *                          been confirmed. Unmarked numeric claims get no special trust.
 *   user-cannot-confirm — the user was asked and genuinely could not confirm ("a scale figure
 *                          from a job years ago may simply be unknowable"). A DURABLE state,
 *                          distinct from derived-unverified: it must never decay back into
 *                          "verified" or "not yet checked" through repetition, a later re-scan,
 *                          or a leading confirmation prompt — a confirmed guess is worse than
 *                          an honest unknown, because it launders the guess into a "verified"
 *                          fact. Consumers must treat such a story as narrative texture only,
 *                          never as a quantified claim in interview-facing output.
 *
 * Decay semantics: `resume-verified` can become downgrade-worthy (the linked resume changes and
 * a claim loses its backing) but is only ever FLAGGED here — this module never silently
 * downgrades; the caller/user decides. `derived-unverified` is the one state the checker may
 * auto-upgrade (to `resume-verified`, when every numeric claim is backed). The two user-decided
 * states are report-only.
 *
 * Deviations from the original (the original is otherwise authoritative):
 *   - Claim detection reuses this package's fact-gate extractors (`metricClaims`, ported from
 *     verify-cv-facts.mjs) instead of re-porting the original's five patterns. Consequences:
 *     currency and multiplier claims ARE checked here (the original deliberately left currency
 *     to verify-cv-facts.mjs — fact-gate IS that gate, so there is no duplication to avoid),
 *     while the original's `scale-hyphen` shape ("15-person team") and nouns outside fact-gate's
 *     METRIC_NOUNS list are NOT extracted. Under-extraction is the recoverable direction, per
 *     the original's own design stance.
 *   - Backing is stricter: a claim must reappear as the SAME normalized claim (number + noun or
 *     unit) in the source text, and then still pass the original's shared-context scoping
 *     (issue #2947, CodeRabbit finding — unscoped number matching). The original required only
 *     the bare number plus shared context.
 *   - fact-gate claims carry no offsets, so a claim's context window is the union over every
 *     occurrence of its number in the story text, not the single extraction index.
 *   - `supportedByResume` has no state here (the DB has four states, not five); it survives as
 *     a per-claim reason on an unverified claim.
 *   - The markdown parser, CLI, path resolution, and summary printer are not ported; the
 *     original's `diagnose()` low-confidence signals (no-cv, no-numeric-claims-found) become
 *     entries in `reasons`.
 */

import { metricClaims, stripMarkup } from "../fact-gate";

// --- States and state-machine helpers -----------------------------------------------

export const PROVENANCE_STATES = [
	"resume-verified",
	"user-confirmed",
	"derived-unverified",
	"user-cannot-confirm",
] as const;

export type ProvenanceState = (typeof PROVENANCE_STATES)[number];

/** Absent/unmarked == derived-unverified: unmarked numeric claims get no special trust. */
export const DEFAULT_PROVENANCE_STATE: ProvenanceState = "derived-unverified";

/** States only an explicit user decision can set; the checker reports on them, never moves them. */
export function isUserDecidedProvenance(state: ProvenanceState): boolean {
	return state === "user-confirmed" || state === "user-cannot-confirm";
}

/**
 * Durable means "must never decay through repetition or a later re-scan". Only
 * `user-cannot-confirm` is durable in the original's sense: the user may later revise a
 * `user-confirmed` figure themselves, but an explicit "I don't know" must never be re-prompted
 * into a guess, and no heuristic outcome ever reclassifies it.
 */
export function isDurableProvenance(state: ProvenanceState): boolean {
	return state === "user-cannot-confirm";
}

/**
 * The read-side half of the original's "Confirmation UX invariant": only these states may back
 * a quantified claim in interview-facing output. A `user-cannot-confirm` (or still-unverified)
 * story is narrative texture only — a follow-up question would probe a figure nobody can stand
 * behind.
 */
export function canCiteAsQuantifiedClaim(state: ProvenanceState): boolean {
	return state === "resume-verified" || state === "user-confirmed";
}

/**
 * Whether the checker itself may move a story from `from` to `to` without the user. The only
 * non-identity transition allowed is the upgrade `derived-unverified` -> `resume-verified`
 * (every numeric claim backed). Downgrades and both user-decided states always require the
 * caller/user.
 */
export function canAutoTransition(from: ProvenanceState, to: ProvenanceState): boolean {
	if (from === to) return true;
	return from === "derived-unverified" && to === "resume-verified";
}

// --- Input/output shapes ------------------------------------------------------------

export type StoryProvenanceStory = {
	situation: string;
	task: string;
	action: string;
	result: string;
	reflection: string;
};

export type StoryProvenanceInput = {
	story: StoryProvenanceStory;
	/** The linked resume's flattened text (e.g. via fact-gate's resumeDataToFactTexts), or null
	 * when the story has no source resume. */
	sourceText: string | null;
	current: ProvenanceState;
};

export type StoryProvenanceReport = {
	/** Never below `current`: an upgrade may be suggested, a downgrade only ever flagged. */
	suggested: ProvenanceState;
	/** Normalized claims (fact-gate spelling, e.g. "40%", "8 hours") backed by the source. */
	verifiedClaims: string[];
	unverifiedClaims: string[];
	reasons: string[];
};

// --- Context words (ported helpers) -------------------------------------------------

// Filtered out of context-word overlap so common connective words don't manufacture a false
// supported-by-resume match. The original's list, deduplicated.
const CONTEXT_STOPWORDS = new Set([
	"this",
	"that",
	"these",
	"those",
	"with",
	"from",
	"into",
	"onto",
	"over",
	"were",
	"have",
	"while",
	"about",
	"their",
	"there",
	"which",
	"through",
	"across",
	"within",
	"without",
	"after",
	"before",
	"during",
	"being",
	"been",
	"each",
	"every",
	"other",
	"than",
	"then",
	"them",
	"they",
	"when",
	"where",
	"what",
	"more",
	"most",
	"some",
	"such",
	"only",
	"also",
	"just",
	"like",
	"very",
	"used",
	"using",
]);

const CONTEXT_WINDOW_CHARS = 90;

// U+0307 COMBINING DOT ABOVE, built from a string escape so the invisible character never sits
// literally in the source (a `/̇/gu` literal gets normalized to the bare combining mark
// by format-on-save, leaving an unreviewable invisible character in the pattern).
// biome-ignore lint/complexity/useRegexLiterals: see above — the escape must stay visible
const COMBINING_DOT_ABOVE_RE = new RegExp("\\u0307", "gu");

/**
 * NFKC, lowercased, with the combining dot a lowercased Turkish `İ` leaves behind removed.
 * Extracted so both sides of every comparison are folded IDENTICALLY: folding only one of them
 * is a bug that hides — a source written "İstanbul" lowercases to `i` + U+0307 and stops
 * matching a claim word the strip has already reduced to plain "istanbul".
 */
function foldForContext(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(COMBINING_DOT_ABOVE_RE, "");
}

/**
 * Content words (length >= 4, not a stopword, not itself a number) in a window around a
 * claim's position. The strip keeps letters, combining marks and digits of ANY script
 * (`\p{L}\p{M}\p{N}`): the original's `[^a-z0-9\s]` deleted every non-ASCII letter, making the
 * verified buckets unreachable for a non-Latin resume and re-cutting accented words into
 * DIFFERENT real words ("évaluation" -> " valuation") — issues #2393/#2429/#2569/#2666. `\p{M}`
 * is kept so Indic matras survive, and `\p{N}` (not `\d`) filters number tokens of any script.
 */
function contextWords(body: string, matchIndex: number, matchLength: number): string[] {
	const start = Math.max(0, matchIndex - CONTEXT_WINDOW_CHARS);
	const end = Math.min(body.length, matchIndex + matchLength + CONTEXT_WINDOW_CHARS);
	const snippet = foldForContext(body.slice(start, end)).replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ");
	const words = snippet.split(/\s+/).filter(Boolean);
	return [...new Set(words.filter((w) => w.length >= 4 && !CONTEXT_STOPWORDS.has(w) && !/^\p{N}+$/u.test(w)))];
}

/**
 * Whether any context word appears, on a word boundary, in the source prose. The boundary is a
 * lookaround pair, not `\b`: `\b` is defined against `[A-Za-z0-9_]`, so for a Cyrillic, Greek,
 * Hebrew, Arabic or CJK word the assertion is never satisfied and this check stayed
 * unreachable for a non-Latin resume (`/\bсократил\b/.test("сократил расходы") -> false`).
 * Both operands are folded the same way (see foldForContext).
 */
function hasContextOverlap(words: readonly string[], sourceText: string): boolean {
	const haystack = foldForContext(sourceText);
	const bounded = (word: string): RegExp =>
		new RegExp(
			String.raw`(?<![\p{L}\p{M}\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![\p{L}\p{M}\p{N}])`,
			"u",
		);
	return words.some((word) => bounded(word).test(haystack));
}

// --- Claim positioning --------------------------------------------------------------

// fact-gate's normalized claims carry no offsets, so a claim's occurrences are found again by
// scanning for its number. Grouping separators are canonicalized the same way normalizeClaim
// does (only a separator followed by EXACTLY three digits is removed, so "2.5" stays a decimal)
// and trailing sentence punctuation is dropped, so "16,181" in prose matches the claim's "16181".
const NUMBER_TOKEN_RE = /\d[\d,.]*/g;

function canonicalNumberToken(token: string): string {
	return token.replace(/(\d)[,.](?=\d{3}(?!\d))/g, "$1").replace(/[,.]+$/, "");
}

/** The first number in a normalized claim ("8 hours" -> "8", "$550k" -> "550"). */
function claimNumber(claim: string): string | null {
	return /\d+(?:\.\d+)?/.exec(claim)?.[0] ?? null;
}

/** Context-word lists, one per occurrence of `num` in `clean` — the original's
 * buildCvNumberContexts, keyed to a single number. */
function numberWindows(clean: string, num: string): string[][] {
	const windows: string[][] = [];
	for (const match of clean.matchAll(NUMBER_TOKEN_RE)) {
		if (canonicalNumberToken(match[0]) !== num) continue;
		windows.push(contextWords(clean, match.index, match[0].length));
	}
	return windows;
}

/** Union of the story-side context words over every occurrence of the claim's number. */
function claimContextWords(clean: string, claim: string): string[] {
	const num = claimNumber(claim);
	if (num == null) return [];
	const words = new Set<string>();
	for (const window of numberWindows(clean, num)) {
		for (const word of window) words.add(word);
	}
	return [...words];
}

/**
 * The original's scoped number match: the claim's number must appear in the source with a
 * context that shares a term with the claim's own context — a bare digit-string coincidence
 * elsewhere in the source ("15 years of experience" against "a 15-person team") must not count
 * as verified. When either side yields no window (a claim with no surrounding prose, or a
 * number the rescan cannot place), the already-passed exact-claim match stands on its own —
 * for count claims the noun scoped it, and erring toward "verified" on an exact normalized
 * match is the original's stated safe direction for the source side.
 */
function hasScopedBacking(claimWords: readonly string[], sourceClean: string, claim: string): boolean {
	const num = claimNumber(claim);
	if (num == null) return true;
	const sourceWindows = numberWindows(sourceClean, num);
	if (claimWords.length === 0 || sourceWindows.length === 0) return true;
	return sourceWindows.some((window) => window.some((word) => claimWords.includes(word)));
}

// --- The checker --------------------------------------------------------------------

/**
 * Deterministically re-check a story's numeric claims against its linked resume text.
 *
 * Read-only in the original's sense: it reports and suggests, it never writes. The suggestion
 * can UPGRADE `derived-unverified` to `resume-verified` when every numeric claim is backed; an
 * unbacked claim under `resume-verified` is flagged as downgrade-worthy but the state is never
 * silently downgraded (the caller/user decides); the two user-decided states are report-only —
 * `user-cannot-confirm` is the hard override, checked first and never itself overridden,
 * whatever the heuristic would conclude this time.
 */
export function checkStoryProvenance(input: StoryProvenanceInput): StoryProvenanceReport {
	const text = [input.story.situation, input.story.task, input.story.action, input.story.result, input.story.reflection]
		.filter(Boolean)
		.join("\n");
	const claims = [...metricClaims(text)];

	// HARD override — checked first, wins over every heuristic below, and is never itself
	// overridden. An explicit "I don't know" must not decay into "verified" (or back into
	// "unverified-but-maybe") just because a re-check would reach a different conclusion.
	if (input.current === "user-cannot-confirm") {
		return {
			suggested: "user-cannot-confirm",
			verifiedClaims: [],
			unverifiedClaims: claims,
			reasons: ['explicit "user-cannot-confirm" state — durable, never reclassified (report-only)'],
		};
	}

	// Explicit user confirmation — evaluated before the heuristics, not as a fallback after
	// them, or partial context overlap could redirect a confirmed claim into an unverified
	// bucket (the original's marker-ordering regression).
	if (input.current === "user-confirmed") {
		return {
			suggested: "user-confirmed",
			verifiedClaims: claims,
			unverifiedClaims: [],
			reasons: [
				'explicit "user-confirmed" state — the user already confirmed these figures; the heuristic never re-decides (report-only)',
			],
		};
	}

	if (input.sourceText == null) {
		const reasons = ["no linked resume text — claims cannot be checked against a primary source"];
		if (input.current === "resume-verified") {
			reasons.push(
				'downgrade-worthy: "resume-verified" without a linked resume — downgrading is the caller\'s decision, never automatic',
			);
		}
		return { suggested: input.current, verifiedClaims: [], unverifiedClaims: claims, reasons };
	}

	if (claims.length === 0) {
		// The original's no-numeric-claims-found diagnosis: not the same as "no risk" (see the
		// pattern-coverage notes in fact-gate for what is not scanned), so no upgrade either.
		return {
			suggested: input.current,
			verifiedClaims: [],
			unverifiedClaims: [],
			reasons: ['no numeric claims matched the covered patterns — this is not the same as "verified"'],
		};
	}

	const clean = stripMarkup(text, { keepLineBreaks: true });
	const sourceClean = stripMarkup(input.sourceText, { keepLineBreaks: true });
	const sourceClaims = metricClaims(input.sourceText);

	const verifiedClaims: string[] = [];
	const unverifiedClaims: string[] = [];
	const contextReasons: string[] = [];
	for (const claim of claims) {
		const claimWords = claimContextWords(clean, claim);
		if (sourceClaims.has(claim) && hasScopedBacking(claimWords, sourceClean, claim)) {
			verifiedClaims.push(claim);
			continue;
		}
		unverifiedClaims.push(claim);
		if (claimWords.length > 0 && hasContextOverlap(claimWords, sourceClean)) {
			contextReasons.push(
				`"${claim}" — the linked resume text supports the underlying fact, not this precision (the original's supportedByResume bucket)`,
			);
		}
	}

	if (unverifiedClaims.length === 0) {
		const reasons = [`every numeric claim (${claims.length}) is backed by the linked resume text`];
		if (input.current === "derived-unverified") {
			reasons.push('upgrade suggested: "derived-unverified" -> "resume-verified"');
		}
		return { suggested: "resume-verified", verifiedClaims, unverifiedClaims, reasons };
	}

	const reasons = [
		`${unverifiedClaims.length} of ${claims.length} numeric claims are not backed by the linked resume text`,
		...contextReasons,
	];
	if (input.current === "resume-verified") {
		reasons.push(
			'downgrade-worthy: state is "resume-verified" but the claims above are unbacked — downgrading is the caller\'s decision, never automatic',
		);
	}
	return { suggested: input.current, verifiedClaims, unverifiedClaims, reasons };
}
