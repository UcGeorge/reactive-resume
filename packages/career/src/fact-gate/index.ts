/**
 * Anti-fabrication fact gate: verifies a tailored resume's claims against the user's source
 * texts plus a per-user allowlist, blocking render on violations.
 *
 * Ported from career-ops' `verify-cv-facts.mjs` (MIT), files→data: sources and the allowlist
 * arrive as values instead of paths, and the verdict is a `FactGateReport` instead of a CLI
 * exit code. The extraction logic is ported faithfully — it encodes years of regressions
 * (multilingual count shapes, delegated-authorship detection, metric-noun windows), and the
 * original issue numbers are kept in the comments so the cases stay traceable.
 *
 * Claim classes, mapped from the original result shape:
 *   invented metrics       → violations kind "metric"
 *   unsupported facts      → violations kind "employer" / "title" / "tool"
 *   authorship escalation  → violations kind "delegated-authorship"
 *   forbidden phrases      → violations kind "forbidden-phrase"
 *   warn phrases           → warnings kind "warn-phrase"
 *   coverage diagnosis     → warnings kind "coverage" (the gate could not read the counts)
 */

import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type {
	FactClaim,
	FactCoverageDiagnosis,
	FactGateAllowlist,
	FactGateInput,
	FactGateReport,
	FactViolation,
	FactWarning,
} from "./types";
import { resumeSkillGapTexts } from "../skill-gap";

export type {
	FactClaim,
	FactCoverageDiagnosis,
	FactGateAllowlist,
	FactGateInput,
	FactGateReport,
	FactGateSource,
	FactViolation,
	FactViolationKind,
	FactWarning,
	FactWarningKind,
} from "./types";

// --- Vocabulary ---------------------------------------------------------------------

// Exact words observed as prose false positives after a "using"/"with" trigger (#3639).
// Morphological suffixes are deliberately not used: Spring, Unity and Processing share them.
const TOOL_PROSE_WORDS = new Set([
	"a",
	"an",
	"and",
	"at",
	"built",
	"by",
	"containerized",
	"deployment",
	"deployments",
	"delivery",
	"diagnosing",
	"efficiency",
	"feedback",
	"for",
	"from",
	"improve",
	"improving",
	"in",
	"of",
	"on",
	"on-time",
	"operations",
	"production",
	"project",
	"recurring",
	"resolving",
	"submission",
	"team",
	"the",
	"to",
	"using",
	"with",
]);

// A leading determiner marks ordinary reference, not a product list: "using that campaign",
// "using our playbook". The class is closed, so unlike TOOL_PROSE_WORDS it cannot turn into a
// list that grows by one word per bug report (#4004).
const DETERMINER_LEAD_RE = /^(?:the|that|this|these|those|our|your|their|its|his|her|my)(?:\s+|$)/i;
const DECLARED_TOOL_TRIGGER_RE = /^(?:technologies?|tech stack)\s*:/i;
const TOOL_PHRASE_PATTERN = /^(?=.{1,80}$)[\p{L}\p{N}.][\p{L}\p{N}+#./-]*(?:\s+[\p{L}\p{N}.][\p{L}\p{N}+#./-]*){0,2}$/u;

const DELEGATED_PARTY_RE =
	/\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b/i;
const DELEGATION_RE =
	/\b(?:commissioned|coordinated|directed|engaged|hired|managed|oversaw|partnered with|supervised)\b/i;
const DIRECT_AUTHORSHIP_SIGNAL_RE = /\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const THIRD_PARTY_EXECUTION_RE =
	/\b(?:vendors?|agenc(?:y|ies)|contractors?|consultanc(?:y|ies)|consultants?|external teams?|outsourc(?:ed|ing)|implementation partners?)\b[^.;!?]{0,120}\b(?:which|who|that)\b[^.;!?]{0,120}\b(?:authored|built|coded|developed|engineered|implemented|programmed|wrote)\b/i;
const DIRECT_AUTHORSHIP_CLAIM_RE =
	/\b(authored|built|coded|developed|engineered|implemented|programmed|wrote)\b\s+(?:the\s+|an?\s+|my\s+|our\s+)?([^.;!?]{1,160})/giu;
const ATTRIBUTION_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"authored",
	"build",
	"built",
	"by",
	"coded",
	"commissioned",
	"coordinated",
	"created",
	"developed",
	"directed",
	"engineered",
	"engaged",
	"for",
	"from",
	"hired",
	"implemented",
	"in",
	"managed",
	"my",
	"of",
	"on",
	"our",
	"oversaw",
	"partnered",
	"programmed",
	"supervised",
	"the",
	"through",
	"to",
	"vendor",
	"vendors",
	"with",
	"wrote",
]);

// Nouns a number can count. Deliberately broad across domains: the original grew a headcount
// block ("Managed 45 staff" against a source saying 20 passed silently — the exact fabrication
// class this gate exists to catch), then physical assets, then education/training nouns
// ("Trained 900+ candidates across 60 schools" against 250 and 20).
const METRIC_NOUNS = [
	"users",
	"customers",
	"clients",
	"employees",
	"engineers",
	"teams",
	"companies",
	"partners",
	"organizations",
	"organisations",
	"brands",
	"countries",
	"hours",
	"days",
	"weeks",
	"months",
	"years",
	"minutes",
	"seconds",
	"requests",
	"tokens",
	"documents",
	"workflows",
	"pipelines",
	"agents",
	"interviews",
	"applications",
	"offers",
	"reports",
	"cvs",
	"resumes",
	"enrollments",
	"enrolments",
	"completions",
	"courses",
	"certifications",
	"certificates",
	"sessions",
	"responses",
	"surveys",
	"cohorts",
	"commits",
	"contributions",
	"repositories",
	"repos",
	"modules",
	"tools",
	"servers",
	"guides",
	"articles",
	"datasets",
	"examples",
	"deployments",
	"services",
	"downloads",
	"stars",
	"lines",
	"projects",
	"integrations",
	"tests",
	// Headcount outside software.
	"staff",
	"personnel",
	"people",
	"technicians",
	"operators",
	"contractors",
	"vendors",
	"scientists",
	"researchers",
	"volunteers",
	"students",
	"patients",
	"crew",
	// Physical assets and scale.
	"facilities",
	"sites",
	"buildings",
	"rooms",
	"labs",
	"laboratories",
	"plants",
	"machines",
	"devices",
	"instruments",
	"vehicles",
	"units",
	"locations",
	"acres",
	"hectares",
	"shifts",
	"rounds",
	"inspections",
	"audits",
	"incidents",
	"alarms",
	"tickets",
	// Education and training.
	"candidates",
	"trainees",
	"learners",
	"participants",
	"attendees",
	"graduates",
	"alumni",
	"teachers",
	"instructors",
	"educators",
	"faculty",
	"schools",
	"districts",
	"campuses",
	"classrooms",
	"programs",
	"programmes",
	"workshops",
	"assessments",
	"exams",
];

// How many words may sit between a number and the noun it counts. At {0,2}, "~5 live Cloud Run
// deployments" (three modifiers) yielded no claim while "~5 Cloud Run deployments" (two) did,
// which broke the gate in both directions (#2279): a truthful CV failed, and a CHANGED number
// hid behind the 3-modifier phrasing. Widening cannot hide an invented number — it only ever
// extracts MORE claims, on both sides — and a number is a hard barrier for the chain, so a
// wider window still cannot jump across an intervening figure to bind an unrelated noun.
const MODIFIER_WINDOW = 4;

// The quantifier is LAZY (`{0,N}?`) so the number binds to the NEAREST noun in the window.
// Greedy, "15+ years scaling teams and platforms" read as "15 platforms" while its plainer
// paraphrase read "15 years" — the same fact extracted as two different claims (#3414).
// The number capture takes an immediately-adjacent magnitude suffix (50k, 1.5M) as part of
// the number, or "50k users" normalized to "50 users" and a 1000x inflation passed the gate.
// `[kKmMbB]\b` requires the suffix to END the token, so "50 million users" and "50kg users"
// keep their behaviour and still normalize to "50".
const COUNT_CLAIM_RE = new RegExp(
	String.raw`\b(\d[\d,.]*(?:[kKmMbB]\b)?)\s*\+?\s*(?:[A-Za-z][A-Za-z-]*\s+){0,${MODIFIER_WINDOW}}?(${METRIC_NOUNS.join("|")})\b`,
	"gi",
);

// A CV and its source rarely word a fact identically; restating "20 staff" as "20 personnel"
// is a paraphrase, not a fabrication.
const NOUN_SYNONYMS = new Map([
	["repos", "repositories"],
	["enrolments", "enrollments"],
	["organisations", "organizations"],
	["cvs", "resumes"],
	["certificates", "certifications"],
	["articles", "guides"],
	["personnel", "staff"],
	["labs", "laboratories"],
]);

// Language-neutral claim shapes: percentages, currency, multipliers.
const SIMPLE_CLAIM_PATTERNS = [
	/\b\d+(?:\.\d+)?\s?%/g,
	/(?<![\w$€£])[$€£]\s?\d[\d,.]*(?:\s?[kKmMbB])?/g,
	/\b\d+(?:\.\d+)?\s?x\b/gi,
];

// --- Digit folding ------------------------------------------------------------------

// Unicode decimal-digit blocks, by the code point of their zero. Every claim pattern here is
// written with ASCII `\d`, so a CV spelling its numbers in another script produced ZERO claims
// and the gate reported a pass without having checked anything. NFKC alone is not enough: it
// folds full-width digits (ja/zh) but leaves Arabic-Indic, Persian and Devanagari untouched.
const DIGIT_ZEROS = [
	0x0660, // Arabic-Indic (ar)
	0x06f0, // Extended Arabic-Indic (fa, ur)
	0x0966, // Devanagari (hi)
	0x09e6, // Bengali
	0x0a66, // Gurmukhi
	0x0ae6, // Gujarati
	0x0b66, // Oriya
	0x0be6, // Tamil
	0x0c66, // Telugu
	0x0ce6, // Kannada
	0x0d66, // Malayalam
	0x0e50, // Thai
	0x0ed0, // Lao
	0x0f20, // Tibetan
	0x1040, // Myanmar
	0x17e0, // Khmer
	0x1810, // Mongolian
];

/**
 * Rewrite every Unicode decimal digit as its ASCII counterpart, plus the separators and
 * percent signs that travel with them. Applied to the candidate AND the sources, so it can
 * only ever make MORE claims visible on both sides — it cannot hide one.
 */
export function foldDigits(text: string): string {
	// NFKC first: it maps full-width digits and ％ to ASCII outright.
	let out = text.normalize("NFKC");
	out = out.replace(/\p{Nd}/gu, (char) => {
		const cp = char.codePointAt(0) ?? 0;
		if (cp >= 0x30 && cp <= 0x39) return char;
		for (const zero of DIGIT_ZEROS) {
			const value = cp - zero;
			if (value >= 0 && value <= 9) return String(value);
		}
		return char; // a decimal digit from a block we don't list: left as-is
	});
	// Arabic separators and percent sign, which NFKC does not fold either.
	out = out
		.replace(/٪/g, "%") // ٪ Arabic percent sign
		.replace(/٫/g, ".") // ٫ Arabic decimal separator
		.replace(/٬/g, ","); // ٬ Arabic thousands separator
	// A SPACE-grouped thousand ("16 181", common in fr/ru/sv and as NNBSP in typeset text) is
	// joined here, before extraction: the claim pattern reads a number as `\d[\d,.]*`, so it
	// would stop at the space and extract "181 users" — a claim the sources never contain.
	// The `(?<!\d)\d{1,3}` guard keeps it to real grouping: in "in 2026 100 users" the left
	// part is four digits, so nothing is joined.
	return out.replace(/(?<!\d)(\d{1,3})[\s  ](?=\d{3}(?!\d))/g, "$1");
}

// --- Markup stripping ---------------------------------------------------------------

/**
 * Remove HTML, basic LaTeX commands, markdown emphasis, and excess whitespace.
 *
 * A block boundary becomes a sentence break, not a space: collapsing `</li><li>` to " " glued
 * two bullets into one line and let the title capture chain across them ("Principal Engineer
 * Built"). Markdown emphasis markers touching a number severed the number-noun adjacency the
 * claim patterns require, so a bolded metric quoted verbatim was reported as invented (#4085);
 * only paired markers are stripped (a lone footnote `*` is left alone) and single underscores
 * are load-bearing (snake_case, file paths), so only a DOUBLED underscore is stripped. The
 * markdown pass runs AFTER the LaTeX pass so a star-variant command's leftover `*` cannot
 * pair with an unrelated later italic span.
 */
export function stripMarkup(text: string, { keepLineBreaks = false }: { keepLineBreaks?: boolean } = {}): string {
	return (
		foldDigits(String(text))
			.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
			.replace(/<\/?(?:li|p|div|tr|h[1-6]|section|article|ul|ol|table|br)\b[^>\n]*>/gi, ". ")
			// Only strip things that actually look like tags: a bare `<` is ordinary prose in these
			// sources (`p<0.001`, `<30 min`), and `[^>]` matches newlines — so an unanchored
			// `/<[^>]+>/g` let one stray `<` swallow everything up to the next `>`.
			.replace(/<\/?[a-zA-Z][^>\n]*>/g, " ")
			.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, " $1 ")
			.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, " $1 ")
			.replace(/__(\S(?:[\s\S]*?\S)?)__/g, " $1 ")
			.replace(/\*(\S(?:[^\n*]*\S)?)\*/g, " $1 ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			// keepLineBreaks preserves a newline as a CLAUSE boundary for the plan-horizon scan.
			.replace(keepLineBreaks ? /[^\S\n]+/g : /\s+/g, " ")
			.replace(/ *\n+ */g, keepLineBreaks ? "\n" : " ")
			.trim()
	);
}

// --- Normalization ------------------------------------------------------------------

/**
 * Normalize a claim for case- and whitespace-insensitive comparison.
 *
 * Thousands separators are removed FIRST, so the same number compares equal however it is
 * grouped: "16,181" / "16 181" / "16.181" / "16181". Grouping style is not evidence of a
 * different number — several markets group with a period — and the gate used to report one
 * as invented. Only a separator followed by EXACTLY three digits is removed, so a genuine
 * decimal ("2.5 hours", "1,2 million") is left alone.
 */
export function normalizeClaim(claim: string): string {
	return String(claim)
		.toLowerCase()
		.replace(/(\d)[,.\s  ](?=\d{3}(?!\d))/g, "$1")
		.replace(/[,\s]+/g, " ")
		.trim();
}

/** Normalize a non-metric fact and remove terminal punctuation. */
function normalizeFact(value: string): string {
	return normalizeClaim(value)
		.replace(/[.;:,]+$/g, "")
		.trim();
}

// --- Tool-claim shape checks --------------------------------------------------------

/** Whether a raw tool fragment looks like a real product name: Title Case, or carries a
 * digit/version token (e.g. "n8n", "Python 3.11", "GPT-4"). */
function looksToolShaped(rawValue: string): boolean {
	const trimmed = String(rawValue).trim();
	if (!trimmed) return false;
	if (/\d/.test(trimmed)) return true;
	return trimmed.split(/\s+/).every((word) => /^[\p{Lu}]/u.test(word));
}

/**
 * Keep likely technology names while dropping ordinary prose fragments.
 *
 * A fragment that is not tool-shaped is kept anyway when it is an exact substring of the
 * sources: a real lowercase tool name ("kubernetes", "n8n") the user genuinely listed must
 * still pass. A fragment whose every word already occurs in the source is dropped: that is
 * the document's own vocabulary reworded, and tailoring rewords "using" sentences by design
 * (#4004). Anything left is retained by default — fail-closed for lowercase names.
 */
function isLikelyTool(value: string, sourceNormalized: string | null): boolean {
	const normalized = normalizeFact(value);
	const words = normalized.split(" ");
	if (!normalized || words.length > 3) return false;
	if (!TOOL_PHRASE_PATTERN.test(value.trim())) return false;
	if (looksToolShaped(value)) return true;
	if (sourceNormalized != null && sourceContainsFact(sourceNormalized, normalized)) return true;
	if (sourceNormalized != null && words.every((word) => sourceContainsFact(sourceNormalized, word))) return false;
	return !words.some((word) => TOOL_PROSE_WORDS.has(word));
}

// --- Non-metric fact claims ---------------------------------------------------------

const FACT_CLAIM_PATTERNS: [Exclude<FactClaim["kind"], "authorship">, RegExp][] = [
	// The TRIGGER is case-insensitive, the CAPTURE is not: a CV is written in capitalised
	// bullets, so lowercase-only triggers made fabricated employers invisible in the spelling
	// CVs use — while making the CAPTURE case-insensitive would read "worked at the office as
	// a manager" as an employer claim. Only the trigger words carry an explicit case class.
	[
		"employer",
		/\b(?:[Ww]orked [Aa]t|[Jj]oined|[Ee]mployer\s*:\s*|[Cc]ompany\s*:\s*)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g,
	],
	// A title may carry a lowercase connector: stopping at it truncated "Head of Data" to
	// "head", indistinguishable from "Head of Engineering" — an inflated title passed. The
	// connector list is closed and each connector must be followed by another Capitalised
	// word. The first token requires 2+ characters (#3907): ordinary prose like "role: I do
	// not have…" read the pronoun "I" as a one-letter job title, while real 2-letter acronym
	// titles (VP, PM) still match.
	[
		"title",
		/\b(?:[Ss]erved [Aa]s|[Ww]orked [Aa]s|[Tt]itle\s*:\s*|[Rr]ole\s*:\s*)\s*(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})|\b(?:[Ww]orked [Aa]t|[Jj]oined)\s+[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}\s+[Aa]s\s+(?:an?\s+|the\s+)?([A-Z][\w/-]+(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})/g,
	],
	[
		"tool",
		/\b(?:using|built with|worked with|technologies?\s*:\s*|tech stack\s*:\s*)([^.;\n]+?)(?=\s+\bfor\b|[.;\n]|$)/gi,
	],
];

/**
 * Extract explicitly asserted employer, title, and tool claims from text.
 *
 * `sourceNormalized` (from `normalizeFact(stripMarkup(sourceText))`, as `verifyFacts` builds
 * it) is optional and used only to let a lowercase-but-genuine tool fragment through
 * `isLikelyTool` when it is already backed by a source. Callers that omit it get the same
 * conservative shape-only behaviour.
 */
export function factClaims(text: string, sourceNormalized: string | null = null): FactClaim[] {
	const clean = stripMarkup(text);
	const claims: FactClaim[] = [];
	for (const [kind, pattern] of FACT_CLAIM_PATTERNS) {
		for (const match of clean.matchAll(pattern)) {
			const rawText = kind === "tool" ? (match[1] ?? "").trim() : "";
			// "Technologies:" and "tech stack:" declare a list whatever follows them. The prose
			// triggers do not: a determiner straight after "using" means the trigger is ordinary
			// English, so the whole clause is prose and "worked with the team in London" must not
			// yield London. A determiner LATER in a list taints only its own fragment (#4004).
			const declaredList = kind === "tool" && DECLARED_TOOL_TRIGGER_RE.test(match[0]);
			const rawValues =
				kind === "tool"
					? !declaredList && DETERMINER_LEAD_RE.test(rawText)
						? []
						: rawText.split(/,|\band\b|\bwith\b|\bin\b/i).filter((raw) => !DETERMINER_LEAD_RE.test(raw.trim()))
					: [match[1] ?? match[2] ?? ""];
			for (const raw of rawValues) {
				const value = normalizeFact(raw);
				if (value && (kind !== "tool" || isLikelyTool(raw, sourceNormalized))) claims.push({ kind, value });
			}
		}
	}
	return claims;
}

// --- Delegated authorship -----------------------------------------------------------

/** Split documents into bounded statements for attribution checks. */
function factStatements(text: string): string[] {
	const withLineBoundaries = String(text ?? "").replace(/\r?\n+/g, ". ");
	return stripMarkup(withLineBoundaries)
		.split(/(?:[.!?]\s+|[.!?]$)/u)
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/** Conservative content tokens used only to link a rewrite to its source statement. */
function attributionTokens(text: string): string[] {
	return normalizeFact(text)
		.split(/[^\p{L}\p{N}+#./-]+/u)
		.filter((token) => token.length >= 3 && !ATTRIBUTION_STOP_WORDS.has(token));
}

/**
 * Detect a narrow authorship escalation: a source explicitly attributes execution to a third
 * party, while the rewrite claims direct implementation and drops that attribution ("used X"
 * in source shown as "built X" in candidate).
 *
 * This deliberately does not guess from generic leadership prose. It requires a delegation
 * verb, a named third-party role, and at least two shared content tokens between the source
 * and generated statements. Ambiguous source statements that also contain a direct
 * implementation verb are left alone; an explicit relative clause such as "vendor X, which
 * built Y" is treated as third-party execution evidence rather than direct-work evidence.
 */
export function delegatedAuthorshipClaims(targetText: string, sourceText: string): FactClaim[] {
	const sourceStatements = factStatements(sourceText);
	const directSources = sourceStatements
		.filter((statement) => DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement))
		.filter((statement) => !THIRD_PARTY_EXECUTION_RE.test(statement))
		.map((statement) => new Set(attributionTokens(statement)));
	const delegatedSources = sourceStatements
		.filter((statement) => DELEGATED_PARTY_RE.test(statement) && DELEGATION_RE.test(statement))
		.filter((statement) => !DIRECT_AUTHORSHIP_SIGNAL_RE.test(statement) || THIRD_PARTY_EXECUTION_RE.test(statement))
		.map((statement) => ({ statement, tokens: new Set(attributionTokens(statement)) }));
	if (delegatedSources.length === 0) return [];

	const claims: FactClaim[] = [];
	for (const statement of factStatements(targetText)) {
		// Keeping the third-party attribution is not an authorship escalation.
		if (DELEGATED_PARTY_RE.test(statement)) continue;
		for (const match of statement.matchAll(DIRECT_AUTHORSHIP_CLAIM_RE)) {
			const value = normalizeFact(`${match[1] ?? ""} ${match[2] ?? ""}`);
			const tokens = [...new Set(attributionTokens(match[2] ?? ""))];
			if (tokens.length < 2) continue;
			// Explicit direct-work evidence wins over a nearby delegated project that happens to
			// use the same technology or artifact vocabulary.
			if (directSources.some((source) => tokens.filter((token) => source.has(token)).length >= 2)) {
				continue;
			}
			const delegatedSource = delegatedSources.find(
				(source) => tokens.filter((token) => source.tokens.has(token)).length >= 2,
			);
			if (delegatedSource) claims.push({ kind: "authorship", value });
		}
	}
	return claims.filter((claim, index, all) => all.findIndex((other) => other.value === claim.value) === index);
}

// --- Plan horizons and disclosed requirements ---------------------------------------

// A PLAN HORIZON asserts nothing about the past: "how I'd approach the first 90 days" was
// extracted as the claim "90 days" and no source can ever evidence a proposal (#3655). Two
// signals are required together, and each alone would silence a real claim: a horizon LEAD
// adjacent to the number (alone it would swallow "revenue grew in the first 12 months"), and
// a FORWARD marker in the same clause (alone it would swallow "I would bring 20 years of
// experience"). Ability modals (can/could/may/might) are deliberately out — they frame what
// is possible, not what is planned. CLAUSE-scoped: a marker in a later clause must not
// silence a fabricated PAST number, and a newline ends a clause.
const TIME_NOUNS = new Set(["days", "weeks", "months", "years", "hours", "minutes", "seconds"]);
const HORIZON_LEAD_RE = /\b(?:the|my|our|your)?\s*(?:first|next)\s+$/i;
// `'d` is "had" as often as "would", so it only counts when the verb after it is not a past
// participle. The -ed test is a heuristic; the clause scope carries the weight.
const FORWARD_MARKER_RE =
	/\b(?:would|will|shall|should)\b|['’]d\b(?!\s+[A-Za-z]+ed\b)|['’]ll\b|\b(?:plan|plans|planning|intend|intends)\s+to\b|\bgoing to\b|\blooking forward\b/i;

// A DISCLOSED REQUIREMENT is a number the candidate cites from the POSTING itself, to
// disclaim a gap against it: "without the 7+ years … this role's scope calls for" (#3915).
// Two signals, EITHER sufficient alone, because each already names a THIRD PARTY's threshold:
// a requirement citation in the number's clause, or a negation lead immediately before it.
// A genuine personal claim carries NEITHER — "I bring 7+ years of L&D leadership" is left
// alone and still checked against the sources.
const REQUIREMENT_CITATION_RE =
	/\b(?:role|posting|position|job)\b[^.,;:!?\n]{0,30}\b(?:calls?\s+for|requires?|asks?\s+for|wants?)\b/gi;
const NEGATION_LEAD_RE =
	/\b(?:without(?:\s+the)?|lack(?:ing)?(?:\s+the)?|don['’]?t\s+have(?:\s+the)?|doesn['’]?t\s+have(?:\s+the)?|do\s+not\s+have(?:\s+the)?)\s*$/i;

/**
 * The bounds of the clause of `text` containing `index`, bounded by `. ! ? , ; :` and by a
 * newline. A separator BETWEEN DIGITS is not a boundary, or the clause around "1.5 years"
 * would end inside the number and lose its own marker. A clause opened by a coordinator
 * continues the one before it ("…the first 90 days by listening, and the first 30 days by
 * shipping"); the lookback stops at a SENTENCE end.
 */
function clauseBounds(text: string, index: number): { start: number; end: number } {
	const isBoundary = (i: number): boolean => {
		const c = text[i];
		if (c === "\n") return true;
		if (c !== "." && c !== "!" && c !== "?" && c !== "," && c !== ";" && c !== ":") return false;
		return !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""));
	};
	const isSentenceEnd = (i: number): boolean => {
		const c = text[i];
		if (c === "\n") return true;
		if (c !== "." && c !== "!" && c !== "?") return false;
		return !(/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? ""));
	};
	let start = 0;
	for (let i = index - 1; i >= 0; i--) {
		if (isBoundary(i)) {
			start = i + 1;
			break;
		}
	}
	let end = text.length;
	for (let i = index; i < text.length; i++) {
		if (isBoundary(i)) {
			end = i;
			break;
		}
	}
	if (/^\s*(?:and|or|then|plus)\b/i.test(text.slice(start, end))) {
		let sentenceStart = 0;
		for (let i = start - 1; i >= 0; i--) {
			if (isSentenceEnd(i)) {
				sentenceStart = i + 1;
				break;
			}
		}
		return { start: sentenceStart, end };
	}
	return { start, end };
}

/** The clause of `text` containing `index`. */
function clauseAround(text: string, index: number): string {
	const { start, end } = clauseBounds(text, index);
	return text.slice(start, end);
}

/** A count-claim match, with the offsets the disclosure logic needs. */
type CountMatch = {
	index: number;
	text: string;
	count: string;
	noun: string;
};

/**
 * Whether `match` is a number the candidate cites from the posting's own stated requirement,
 * rather than a personal claim. `allMatches` is every count hit in the document: a citation
 * names ONE requirement, and when two numbers share an undivided clause ("I have 12 years of
 * experience but this role requires 7 years"), testing the citation against the whole clause
 * would suppress BOTH — waving through a fabricated "12 years" (review of #3917). Each
 * citation is bound directionally: an immediately preceding count belongs to the citation;
 * otherwise the first count after it, falling back to the nearest preceding one.
 */
function isDisclosedRequirement(clean: string, match: CountMatch, allMatches: CountMatch[]): boolean {
	const lead = clean.slice(Math.max(0, match.index - 40), match.index);
	if (NEGATION_LEAD_RE.test(lead)) return true;

	const { start, end } = clauseBounds(clean, match.index);
	const clause = clean.slice(start, end);
	REQUIREMENT_CITATION_RE.lastIndex = 0;
	const citations = [...clause.matchAll(REQUIREMENT_CITATION_RE)];
	if (citations.length === 0) return false;

	const numbersInClause = allMatches.filter((m) => m.index >= start && m.index < end);
	if (numbersInClause.length === 0) return false;

	return citations.some((citation) => {
		const citationStart = start + citation.index;
		const citationEnd = citationStart + citation[0].length;
		const preceding = numbersInClause.filter((m) => m.index < citationStart).at(-1);
		const precedingEnd = preceding ? preceding.index + preceding.text.length : citationStart;
		const precedingGap = clean.slice(precedingEnd, citationStart);
		const precedesCitation =
			preceding !== undefined &&
			(/^\s*(?:this|that|the)?\s*$/i.test(precedingGap) ||
				(/\b(?:this|that)\s*$/i.test(precedingGap) && !/[,;:]|\b(?:and|but)\b/i.test(precedingGap)));
		const following = numbersInClause.find((m) => m.index >= citationEnd);
		const cited = precedesCitation ? preceding : (following ?? preceding);
		return cited?.index === match.index;
	});
}

/** Every raw count-claim match in `clean`, as structured spans. */
function rawCountMatches(clean: string): CountMatch[] {
	COUNT_CLAIM_RE.lastIndex = 0;
	const matches: CountMatch[] = [];
	for (const match of clean.matchAll(COUNT_CLAIM_RE)) {
		matches.push({ index: match.index, text: match[0], count: match[1] ?? "", noun: match[2] ?? "" });
	}
	return matches;
}

/**
 * Count-claim matches in `clean`, minus the ones that assert nothing (plan horizons and
 * disclosed requirements). Shared by metricClaims and diagnoseCoverage so the two cannot
 * disagree about whether a document contained a readable count.
 */
function countMatches(clean: string): CountMatch[] {
	const allMatches = rawCountMatches(clean);
	return allMatches.filter((match) => {
		if (isDisclosedRequirement(clean, match, allMatches)) return false;
		if (!TIME_NOUNS.has(match.noun.toLowerCase())) return true;
		const lead = clean.slice(Math.max(0, match.index - 40), match.index);
		if (!HORIZON_LEAD_RE.test(lead)) return true;
		return !FORWARD_MARKER_RE.test(clauseAround(clean, match.index));
	});
}

// --- Metric claims ------------------------------------------------------------------

/** Extract metric-like claims that require source evidence, normalized for comparison. */
export function metricClaims(text: string): Set<string> {
	const clean = stripMarkup(text, { keepLineBreaks: true });
	const claims = new Set<string>();
	for (const pattern of SIMPLE_CLAIM_PATTERNS) {
		for (const match of clean.matchAll(pattern)) claims.add(normalizeClaim(match[0]));
	}
	for (const match of countMatches(clean)) {
		const noun = match.noun.toLowerCase();
		claims.add(normalizeClaim(`${match.count} ${NOUN_SYNONYMS.get(noun) ?? noun}`));
	}
	return claims;
}

// --- Coverage diagnosis -------------------------------------------------------------

// A number counting a word, in ANY script — the language-agnostic SHAPE of the claims
// COUNT_CLAIM_RE recognises only when the noun happens to be English. Used solely to answer
// "were there count claims this gate could not read?", never to build a claim.
const GENERIC_COUNT_RE = new RegExp(
	String.raw`(?<![\p{L}\p{N}])(\d[\d,.]*)\s*\+?\s*(?:[\p{L}][\p{L}\p{M}-]*[\s]+){0,${MODIFIER_WINDOW}}([\p{L}][\p{L}\p{M}]{2,})`,
	"giu",
);
// A year is not a count. "Led the 2024 migration" is the shape above and none of its meaning.
const YEAR_LIKE = /^(?:19|20)\d{2}$/;

/** Count-shaped spans in `text`, whatever language it is written in. */
function countShapedSpans(text: string): string[] {
	const clean = stripMarkup(String(text ?? ""));

	// Ranges the language-neutral patterns already own: "$120k and closed a $90,000 deal" is
	// currency followed by prose, and reads as two counts to a detector that only knows
	// "digits, then a word" — but those amounts ARE checked, in every language. Derived from
	// SIMPLE_CLAIM_PATTERNS rather than re-guessed, so the two cannot drift.
	const covered: [number, number][] = [];
	for (const pattern of SIMPLE_CLAIM_PATTERNS) {
		for (const m of clean.matchAll(pattern)) covered.push([m.index, m.index + m[0].length]);
	}
	const alreadyChecked = (i: number) => covered.some(([from, to]) => i >= from && i < to);

	const out: string[] = [];
	for (const m of clean.matchAll(GENERIC_COUNT_RE)) {
		const digits = m[1] ?? "";
		if (YEAR_LIKE.test(digits.replace(/[,.]/g, ""))) continue;
		// The digits are what a simple pattern would have claimed, so test their position, not
		// the span's — a currency match starts one character earlier, at the symbol.
		if (alreadyChecked(m.index) || alreadyChecked(m.index + m[0].indexOf(digits))) continue;
		out.push(m[0].trim());
	}
	return out;
}

/**
 * Whether this document contains count claims the extractor could not read.
 *
 * METRIC_NOUNS is an English word list, so for a CV written in another space-delimited
 * language every count went unchecked while the gate reported a pass. Reporting rather than
 * blocking is deliberate: blocking would fail every non-English document, trading a silent
 * gap for a wall. DELIBERATELY CONSERVATIVE: fires only when the document has two or more
 * count-shaped spans and the extractor produced NO count claim at all. Two known blind spots,
 * stated rather than implied: coincidental coverage (French "3 sites" matches the English
 * noun and silences the warning) and CJK (digits sit flush against the text, so the
 * whitespace-keyed detector does not see them — that needs script-aware segmentation).
 */
export function diagnoseCoverage(targetText: string): FactCoverageDiagnosis | null {
	const spans = countShapedSpans(targetText);
	if (spans.length < 2) return null;
	// RAW matches on purpose: this asks "could the extractor read any count here?", which is
	// about the noun lexicon, not about whether a count was later judged a proposal. Reading
	// the filtered set made a letter whose only counts were plan horizons blame the lexicon
	// for counts it had read fine.
	const recognized = rawCountMatches(stripMarkup(String(targetText ?? "")));
	if (recognized.length > 0) return null;
	return {
		reason: "no-count-claims-recognized",
		message:
			`${spans.length} count-like claims are present but none matched the metric extractor, whose noun ` +
			"list is English-only — so no count in this document was checked against your sources. " +
			"Percentages, currency and multipliers were still checked. Verify the counts by hand, or add " +
			"them to the allowMetrics list once confirmed.",
		spans,
	};
}

// --- Allowlist and comparison -------------------------------------------------------

/**
 * Build the allow-set a metric claim is checked against.
 *
 * Claims extracted from text are folded through NOUN_SYNONYMS; an allowMetrics entry written
 * in the spelling a human reaches for ("77 repos") must match the canonical "77 repositories"
 * the extractor produces, or the entry is silently inert (#2175). Both spellings are added:
 * metricClaims() yields nothing for an entry no pattern recognizes (a bare "$900k"), so
 * replacing normalizeClaim outright would drop those exceptions. The union can only ever
 * allow more, never less.
 */
function allowedMetricSet(sourceText: string, allowMetrics: readonly string[] | undefined): Set<string> {
	const allowed = new Set(metricClaims(sourceText));
	for (const entry of allowMetrics ?? []) {
		allowed.add(normalizeClaim(entry));
		for (const canonical of metricClaims(String(entry))) allowed.add(canonical);
	}
	return allowed;
}

/** Check a normalized fact as a complete token or phrase, not a substring. */
function sourceContainsFact(sourceText: string, value: string): boolean {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`).replace(/\s+/g, String.raw`\s+`);
	return new RegExp(`(?:^|[^\\p{L}\\p{N}+#/-])${escaped}(?=$|[^\\p{L}\\p{N}+#/-])`, "iu").test(sourceText);
}

/** Compare generated metric claims against source text directly, without a full report. */
export function auditClaims(
	targetText: string,
	sourceText: string,
	allow: Pick<FactGateAllowlist, "allowMetrics" | "forbiddenPhrases"> = {},
): { invented: string[]; forbidden: string[] } {
	const allowed = allowedMetricSet(sourceText, allow.allowMetrics);
	const invented = [...metricClaims(targetText)].filter((claim) => !allowed.has(claim));
	const targetPlain = stripMarkup(targetText).toLowerCase();
	const forbidden = (allow.forbiddenPhrases ?? [])
		.filter(Boolean)
		.filter((phrase) => targetPlain.includes(String(phrase).toLowerCase()));
	return { invented, forbidden };
}

// --- The gate -----------------------------------------------------------------------

/**
 * Verify a tailored candidate text against the source texts and the per-user allowlist.
 * Any violation means `passed: false` — the caller blocks render. Warnings never block:
 * an advisory phrase, or a coverage gap that says "these counts were not checked".
 */
export function verifyFacts(input: FactGateInput): FactGateReport {
	const allow = input.allow ?? {};
	const sourceText = input.sources.map((source) => source.text).join("\n");
	const sourceLabels =
		input.sources
			.map((source) => source.label)
			.filter(Boolean)
			.join(", ") || "the provided sources";

	const allowed = allowedMetricSet(sourceText, allow.allowMetrics);
	const invented = [...metricClaims(input.candidate)].filter((claim) => !allowed.has(claim));

	const sourceNormalized = normalizeFact(stripMarkup(sourceText));
	const allowedFacts = new Set((allow.allowFacts ?? []).map(normalizeFact));
	const unsupportedFacts = [
		...factClaims(input.candidate, sourceNormalized),
		...delegatedAuthorshipClaims(input.candidate, sourceText),
	]
		.filter(({ value }) => !sourceContainsFact(sourceNormalized, value) && !allowedFacts.has(value))
		.filter(
			(claim, index, claims) =>
				claims.findIndex((other) => other.kind === claim.kind && other.value === claim.value) === index,
		);

	const candidatePlain = stripMarkup(input.candidate).toLowerCase();
	const matchedPhrases = (phrases: readonly string[] | undefined) =>
		(phrases ?? []).filter(Boolean).filter((phrase) => candidatePlain.includes(String(phrase).toLowerCase()));
	const forbidden = matchedPhrases(allow.forbiddenPhrases);
	const advisories = matchedPhrases(allow.warnPhrases);

	// Never downgrades a block and never creates one: a coverage gap only adds a warning so
	// the caller is told the gate could not read the document's counts.
	const coverage = diagnoseCoverage(input.candidate);

	const violations: FactViolation[] = [
		...invented.map((claim) => ({
			kind: "metric" as const,
			claim,
			detail: `Metric-like claim absent from ${sourceLabels} and not covered by allowMetrics.`,
		})),
		...unsupportedFacts.map(
			(claim): FactViolation =>
				claim.kind === "authorship"
					? {
							kind: "delegated-authorship",
							claim: claim.value,
							detail: `${sourceLabels} attribute this work to a third party; the tailored text claims direct authorship.`,
						}
					: {
							kind: claim.kind,
							claim: claim.value,
							detail: `Explicitly asserted ${claim.kind} absent from ${sourceLabels} and not covered by allowFacts.`,
						},
		),
		...forbidden.map((phrase) => ({
			kind: "forbidden-phrase" as const,
			claim: phrase,
			detail: "Phrase is on the forbiddenPhrases blocklist.",
		})),
	];

	const warnings: FactWarning[] = [
		...advisories.map((phrase) => ({
			kind: "warn-phrase" as const,
			claim: phrase,
			detail: "Phrase is on the warnPhrases advisory list.",
		})),
		...(coverage
			? [
					{
						kind: "coverage" as const,
						claim: coverage.spans.slice(0, 8).join(" | "),
						detail: coverage.message,
					},
				]
			: []),
	];

	return { passed: violations.length === 0, violations, warnings };
}

// --- ResumeData flattening ----------------------------------------------------------

/**
 * Flatten a ResumeData into checkable text for the gate, on either side: as the candidate
 * (the tailored resume under verification) or as a source (the user's untouched resume the
 * claims must be backed by). Reuses the skill-gap flattening so the two modules read the
 * same fields the same way, HTML folded to markdown included.
 */
export function resumeDataToFactTexts(data: ResumeData): string {
	const { namedSkillsText, proseText } = resumeSkillGapTexts(data);
	return [proseText, namedSkillsText].filter(Boolean).join("\n");
}
