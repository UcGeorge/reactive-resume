/**
 * Shared HTML → plain-text pipeline for providers whose payloads embed description markup.
 *
 * Ported from career-ops' `_html-to-text.mjs` + `_html-entities.mjs` (MIT), merged into one
 * module. Upstream, the entity decoder drifted into four divergent private copies before it was
 * centralized — each with a subtly different numeric-entity guard, one of which let
 * `String.fromCodePoint` throw on `&#99999999;` and crash a whole parse over one malformed
 * entity. Kept as a single module here so a fifth copy cannot appear.
 */

// Capped like full-text Greenhouse JDs: a 10 KB/posting body is normal on these boards, and
// scan payloads must stay sane. Exported so consumers can tell "truncated" from "short".
export const DESCRIPTION_CAP = 4000;

/**
 * The XML five plus nbsp, then the Latin-1 letter entities. The letters are not decoration: a
 * European board writes `D&eacute;veloppeur` in its HTML, and leaving that literal puts it in a
 * job title and every document generated from it. Unknown names pass through untouched (see
 * decodeEntities), so this table is a floor, not a closed set.
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	// French / Portuguese / Spanish / German / Nordic letters, lower and upper.
	agrave: "à",
	aacute: "á",
	acirc: "â",
	atilde: "ã",
	auml: "ä",
	aring: "å",
	aelig: "æ",
	ccedil: "ç",
	egrave: "è",
	eacute: "é",
	ecirc: "ê",
	euml: "ë",
	igrave: "ì",
	iacute: "í",
	icirc: "î",
	iuml: "ï",
	ntilde: "ñ",
	ograve: "ò",
	oacute: "ó",
	ocirc: "ô",
	otilde: "õ",
	ouml: "ö",
	oslash: "ø",
	ugrave: "ù",
	uacute: "ú",
	ucirc: "û",
	uuml: "ü",
	yacute: "ý",
	yuml: "ÿ",
	szlig: "ß",
	Agrave: "À",
	Aacute: "Á",
	Acirc: "Â",
	Atilde: "Ã",
	Auml: "Ä",
	Aring: "Å",
	AElig: "Æ",
	Ccedil: "Ç",
	Egrave: "È",
	Eacute: "É",
	Ecirc: "Ê",
	Euml: "Ë",
	Igrave: "Ì",
	Iacute: "Í",
	Icirc: "Î",
	Iuml: "Ï",
	Ntilde: "Ñ",
	Ograve: "Ò",
	Oacute: "Ó",
	Ocirc: "Ô",
	Otilde: "Õ",
	Ouml: "Ö",
	Oslash: "Ø",
	Ugrave: "Ù",
	Uacute: "Ú",
	Ucirc: "Û",
	Uuml: "Ü",
	Yacute: "Ý",
	// Punctuation these same pages emit around titles.
	deg: "°",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	ndash: "–",
	mdash: "—",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	middot: "·",
	euro: "€",
};

const CASE_INSENSITIVE_NAMES = new Set(["amp", "lt", "gt", "quot", "apos", "nbsp"]);

/**
 * Whether a numeric reference names a code point this decoder will emit — XML 1.0 §2.2 Char.
 * A bare `code <= 0x10FFFF` bound only prevents fromCodePoint from throwing; it still admits
 * NUL, the C0 controls and the noncharacters U+FFFE/U+FFFF, none of which belong in a job title
 * that flows into history files and generated documents (a decoded NUL truncates
 * C-string-backed consumers and serializes to ill-formed UTF-8). Tab, LF and CR are kept: legal
 * per §2.2, present in real postings, and callers normalize whitespace anyway. NaN fails every
 * comparison, so this one predicate subsumes the usual isFinite/range/surrogate checks.
 */
function isEmittableCodePoint(code: number): boolean {
	return (
		code === 0x9 ||
		code === 0xa ||
		code === 0xd ||
		(code >= 0x20 && code <= 0xd7_ff) ||
		(code >= 0xe0_00 && code <= 0xff_fd) ||
		(code >= 0x1_00_00 && code <= 0x10_ff_ff)
	);
}

/**
 * Decode named (&amp;, &eacute;) and numeric (&#252; / &#xfc;) entities. The hex/decimal
 * alternatives are matched separately so a decimal entity can never absorb trailing hex letters
 * — `&#1a2;` fails to match and passes through untouched rather than silently parsing as code
 * point 1. Anything outside the emittable set is left exactly as written: a raw `&#0;` in a
 * title is visible and inert; a decoded NUL is neither.
 */
export function decodeEntities(text: string): string {
	return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body.startsWith("#")) {
			const isHex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			return isEmittableCodePoint(code) ? String.fromCodePoint(code) : match;
		}
		// Letter entities are CASE-SENSITIVE: `&Eacute;` is É, not é. A lowercased lookup would
		// make every uppercase entry unreachable. Only the XML five and nbsp match
		// case-insensitively, which is where legacy pages really do write `&AMP;`. Object.hasOwn
		// (not a bare index) keeps prototype keys like `constructor` from resolving to functions.
		if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body] ?? match;
		const lower = body.toLowerCase();
		return CASE_INSENSITIVE_NAMES.has(lower) ? (NAMED_ENTITIES[lower] ?? match) : match;
	});
}

// A tag ends at an unquoted `>`. Attribute values may contain angle brackets, so the common
// `<[^>]+>` shortcut can stop midway through a tag and expose the remaining attributes as
// description text. Requiring content between the brackets preserves a literal `<>`.
const HTML_TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')+>/g;
const HTML_MEDIA_RE = /<(script|style)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;

function stripMarkup(content: string): string {
	return content.replace(HTML_MEDIA_RE, " ").replace(HTML_TAG_RE, " ");
}

/**
 * Entity-decoded markup → stripped plain text.
 *
 * Double-decode: ATS payloads (Greenhouse with `content=true` is the canonical case) often
 * carry entity-escaped tags (`&lt;p&gt;`), so the first pass reveals real tags, and text-level
 * entities (`&amp;`, `&#39;`) only become decodable once those tags are gone. Plain text is
 * what description-consuming filters match against — substring matching over raw HTML misses
 * keywords split by a tag and pads matches into attribute soup.
 *
 * Markup is stripped BEFORE each decode: quote entities inside a quoted attribute are data, and
 * decoding them first would turn them into false delimiters. Each decode is followed by a strip
 * so double-encoded active markup cannot become the final plain-text output. A final incomplete
 * tag opener has no closing `>` for stripMarkup to consume, so only its leading angle bracket
 * is dropped — the text stays visible while becoming inert.
 */
export function htmlToText(content: unknown): string {
	if (typeof content !== "string" || !content) return "";
	const decoded = decodeEntities(stripMarkup(content));
	const decodedTwice = decodeEntities(stripMarkup(decoded));
	return stripMarkup(decodedTwice)
		.replace(/<(?=\/?[a-z!?])/gi, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, DESCRIPTION_CAP);
}
