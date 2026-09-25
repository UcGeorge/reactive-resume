/**
 * Zero-LLM JD skill-gap checker.
 *
 * Extracts an explicit skill/requirement list from a job description (regex-based, no LLM
 * call), then classifies each one against the resume into three buckets so tailoring can be
 * honest instead of guessed at:
 *
 *   existing          — already a named skill in the resume's Skills section
 *   supportedByResume — not a named skill, but appears in prose elsewhere in the resume
 *   gap               — the JD requires it, the resume has no trace of it at all
 *
 * Nothing is ever auto-added — this module only classifies and reports. Ported from
 * career-ops' `jd-skill-gap.mjs` (MIT), with canonicalization routed through this repo's own
 * deterministic JD toolkit (`@reactive-resume/resume/ats-pdf/jd`) so one alias table serves
 * the ATS checker, quick match and this classifier alike.
 *
 * Deliberately conservative: under-extracting (missing a skill) is recoverable by the user
 * reading the JD themselves; over-extracting noise into "required skills" is not — it would
 * misreport gaps that aren't real.
 */

import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { SkillGapLowConfidence, SkillGapResult } from "./types";
import {
	buildNgrams,
	canonicalize,
	isKnownSkillForm,
	normalizeForMatching,
	splitIntoRuns,
	tokenize,
} from "@reactive-resume/resume/ats-pdf/jd";
import { htmlToMarkdown } from "@reactive-resume/resume/markdown";

export type { SkillGapLowConfidence, SkillGapResult } from "./types";

// --- JD requirement-section detection -----------------------------------------------
//
// Real postings rarely use the word "Requirements", so the header list covers the phrasings
// modern ATS boards actually ship ("What we're looking for", "Who you are", "You have") — a
// JD yielding zero skills reads identically to "no gaps found", the more dangerous failure.
//
// CJK characters are \W (non-word), so the `s?\b` suffix that works for ASCII terms would
// always fail after a Chinese heading; the CJK terms get their own alternation arm without it.
//
// The `#{0,6}` prefix is NOT widened to also swallow `*`/`_`. A bolded heading with no
// markdown hash ("**What We're Looking For**") is handled by stripping `**`/`__` pairs from
// the line before testing (see stripBoldMarkers). Widening the prefix regressed a real shape:
// an asterisk-bullet whose text starts with a keyword — "* Required: Python and Kubernetes" —
// would have its leading `*` consumed as a heading marker and its skills dropped.

const REQUIREMENT_HEADER_RE = new RegExp(
	"^#{0,6}\\s*(?:(?:" +
		[
			"required",
			"requirements",
			"qualifications",
			"must[- ]have",
			"preferred",
			"nice[- ]to[- ]have",
			// Contracted and uncontracted forms: "we're" / "we re" / "we are".
			"what\\s+we(?:(?:'|’)?\\s*re|\\s+are)\\s+looking\\s+for",
			"what\\s+you(?:(?:'|’)ll|\\s+will)?\\s+bring",
			"who\\s+you\\s+are",
			"about\\s+you",
			"your\\s+(?:background|experience|profile)",
			"you\\s+(?:may|might|could)\\s+be\\s+a\\s+good\\s+fit",
			// Ashby's default template ships a bare "YOU HAVE:" heading.
			"you(?:(?:'|’)ll|\\s+will)?\\s+have",
			// Postings that phrase must-have / nice-to-have as full sentences.
			"it(?:'|’)?s\\s+important\\s+to\\s+us\\s+that\\s+you\\s+have",
			"it\\s+would\\s+be\\s+great\\s+if\\s+you\\s+ha(?:ve|d)",
			"ideal\\s+candidate",
			"skills\\s+(?:and|&)\\s+experience",
		].join("|") +
		")s?\\b|(?:" +
		[
			// zh-TW / zh-CN requirement headers (104 / 1111 / CakeResume / Yourator variants).
			"應徵條件", // 應徵條件
			"資格條件", // 資格條件
			"職務需求", // 職務需求
			"條件要求", // 條件要求
			"任職資格", // 任職資格
			"必要條件", // 必要條件
			"基本要求", // 基本要求
			"職位要求", // 職位要求
			"加分項目", // 加分項目
			"加分條件", // 加分條件
		].join("|") +
		")).*$",
	"im",
);

// Headers that end a requirements block even when the posting uses no markdown heading
// levels. Without this the block stays open to end-of-file and sweeps the benefits list into
// "required skills" — turning perks like "401k" and "Equity" into reported skill gaps.
const NON_REQUIREMENT_HEADER_RE = new RegExp(
	"^#{0,6}\\s*(?:(?:" +
		[
			// Responsibilities. The negative lookahead keeps "You will have" on the requirements
			// side — this list is tested BEFORE REQUIREMENT_HEADER_RE, so without it that heading
			// would close a block instead of opening one. A bare "YOU WILL" must close: the
			// fallback that ends a block on a new heading only fires for markdown headings.
			"you\\s+will(?!\\s+have)",
			"benefits?",
			"perks?",
			"benefits\\s+and\\s+perks",
			"compensation",
			"salary",
			"pay\\s+range",
			"what\\s+we\\s+offer",
			"why\\s+(?:join|work|this\\s+role)",
			"about\\s+(?:us|the\\s+company|the\\s+team|the\\s+role)",
			"how\\s+(?:and\\s+where\\s+)?we\\s+work",
			"equal\\s+opportunity",
			"eeo",
			"diversity",
			"interview\\s+process",
			"how\\s+to\\s+apply",
			"to\\s+apply",
			"our\\s+(?:stack|process|values|mission)",
		].join("|") +
		")\\b|(?:" +
		[
			// zh-TW / zh-CN closing headers — no \b for the same CJK reason.
			"工作內容", // 工作內容
			"工作職責", // 工作職責
			"職責範疊", // 職責範疇
			"福利", // 福利
			"薪資", // 薪資
			"薪酬", // 薪酬
			"公司介紹", // 公司介紹
			"關於我們", // 關於我們
			"應徵方式", // 應徵方式
			"如何應徵", // 如何應徵
		].join("|") +
		")).*$",
	"im",
);

// `\r?$` is required, not cosmetic: JS treats \r as a line terminator, so `.` cannot consume
// it and a bare `$` never matches on a CRLF-split line.
const BULLET_LINE_RE = /^\s*[-*•]\s*(.+)\r?$/;

// A conservative skill-token extractor: pulls capitalized technical-looking tokens out of a
// requirement bullet rather than treating the whole bullet as one skill string. The trailing
// (?!\w) instead of \b is what lets C++/C#/F# match standalone (\b needs a word char AFTER
// the symbol); the last token char is additionally pinned to a word char / # / + so a
// sentence-ending period is never swallowed ("Docker." still extracts as "Docker").
const SKILL_TOKEN_RE = /\b([A-Z][A-Za-z0-9+.#]{0,29}[A-Za-z0-9+#](?:\.[a-z]{2,4})?)(?!\w)/g;

// Deliberately broad: stops generic capitalized nouns from JD bullets ("Bachelor's degree
// required", "3+ years of experience") from being misreported as missing "skills".
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"you",
	"your",
	"our",
	"this",
	"that",
	"these",
	"those",
	"must",
	"able",
	"ability",
	"strong",
	"excellent",
	"proven",
	"a",
	"an",
	"or",
	"in",
	"of",
	"to",
	"as",
	"is",
	"are",
	// degree / education boilerplate
	"bachelor",
	"bachelors",
	"master",
	"masters",
	"degree",
	"diploma",
	"certification",
	"certificate",
	// experience / seniority boilerplate
	"experience",
	"years",
	"year",
	"senior",
	"junior",
	"entry",
	"level",
	"minimum",
	"preferred",
	"required",
	// generic sentence-starters that show up capitalized at the start of a bullet
	"candidates",
	"candidate",
	"applicants",
	"applicant",
	"ideal",
	"successful",
	"knowledge",
	"understanding",
	"familiarity",
	"exposure",
	"background",
	"skills",
	"skill",
	"communication",
	"team",
	"teams",
	"work",
	"working",
	// Capitalized bullet-openers that describe the candidate's disposition, not a technology.
	"deep",
	"interest",
	"genuine",
	"solid",
	"comfortable",
	"passion",
	"passionate",
	"track",
	"record",
	"real",
	"bonus",
	"plus",
	"hands",
	"proficiency",
	"fluency",
	"expertise",
	"demonstrated",
	"extensive",
	"practical",
	"good",
	"great",
	"clear",
]);

// Strip markdown STRONG-emphasis markers (`**text**` / `__text__`) so a bolded heading with
// no `#` at all still reaches the header regexes as if the bold wrapper were never there.
// Only doubled markers: a single `*`/`_` is left alone on purpose — `*` is also how a plain
// markdown bullet starts, and a bullet whose text starts with a keyword must stay a bullet.
function stripBoldMarkers(line: string): string {
	return line.replace(/\*\*|__/g, "");
}

type ScanResult = { skills: string[]; sawRequirementSection: boolean };

/**
 * Scan a JD once, returning both the extracted skills and whether a requirement-style
 * section was ever opened. `sawRequirementSection` is what tells apart the two very different
 * reasons an extraction can come back empty: "I never found a requirements section, so I
 * checked nothing" versus "I checked one and recognized none of its terms".
 */
function scanJd(jdText: string): ScanResult {
	const lines = jdText.split("\n");
	const skills = new Set<string>();
	let inRequirementsBlock = false;
	let sawRequirementSection = false;

	for (const line of lines) {
		// Header-classification only, never bullet extraction below: a bolded SKILL inside a
		// bullet ("- **Docker**") already extracts fine as-is — SKILL_TOKEN_RE skips over `*`.
		const headerLine = stripBoldMarkers(line);
		// Checked before the requirement test so a heading that satisfies both (e.g. "Why this
		// role") closes the block rather than reopening it.
		if (NON_REQUIREMENT_HEADER_RE.test(headerLine)) {
			inRequirementsBlock = false;
			continue;
		}
		if (REQUIREMENT_HEADER_RE.test(headerLine)) {
			inRequirementsBlock = true;
			sawRequirementSection = true;
			continue;
		}
		if (inRequirementsBlock && line.trim() === "") continue;
		if (inRequirementsBlock && /^#{1,6}\s/.test(line) && !REQUIREMENT_HEADER_RE.test(headerLine)) {
			inRequirementsBlock = false;
		}

		const bulletMatch = BULLET_LINE_RE.exec(line);
		if (inRequirementsBlock && bulletMatch) {
			const bulletText = bulletMatch[1] ?? "";
			SKILL_TOKEN_RE.lastIndex = 0;
			let match: RegExpExecArray | null = SKILL_TOKEN_RE.exec(bulletText);
			while (match !== null) {
				const token = (match[1] ?? "").trim();
				if (!STOPWORDS.has(token.toLowerCase()) && token.length > 1) skills.add(token);
				match = SKILL_TOKEN_RE.exec(bulletText);
			}
		}
	}
	return { skills: [...skills], sawRequirementSection };
}

/** Extract candidate skill tokens from a JD's requirement-style sections. */
export function extractJdSkills(jdText: string): string[] {
	return scanJd(jdText).skills;
}

/**
 * Explain an empty extraction, so "found nothing to check" stops reading as "checked and
 * found no gaps". Returns null when the run is conclusive (at least one skill classified).
 */
export function diagnoseExtraction(jdText: string, jdSkills: readonly string[]): SkillGapLowConfidence | null {
	if (jdSkills.length > 0) return null;

	if (jdText.trim() === "") {
		return { reason: "empty-jd", message: "The job description is empty, so nothing was checked." };
	}

	if (!scanJd(jdText).sawRequirementSection) {
		return {
			reason: "no-requirements-section",
			message:
				"No requirements section was recognized in this job description, so no text was scanned for skills. " +
				'This is not the same as "no gaps": the check did not run. Read the posting yourself before tailoring.',
		};
	}

	return {
		reason: "no-skill-candidates",
		message:
			"A requirements section was found and scanned, but no skill candidates were extracted from it. " +
			'This is not the same as "no gaps": nothing was classified. Read the posting yourself before tailoring.',
	};
}

// --- Word-boundary text matching -------------------------------------------------
// Prevents "Java" matching inside "JavaScript".

/** Word-boundary, case-insensitive check for whether a skill token appears in text. */
export function skillMentionedInText(skill: string, text: string): boolean {
	const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "i");
	return re.test(text);
}

// --- Canonical skill sets ---------------------------------------------------------

/** Every canonical form of a known skill present in `text`, via the shared JD toolkit. */
function extractKnownSkills(text: string): Set<string> {
	const found = new Set<string>();
	for (const run of splitIntoRuns(normalizeForMatching(text))) {
		for (const ngram of buildNgrams(tokenize(run))) {
			if (isKnownSkillForm(ngram)) found.add(canonicalize(ngram));
		}
	}
	return found;
}

// --- Resume text extraction -------------------------------------------------------

export type SkillGapTexts = {
	/** The resume's named skills, one "Name: keyword, keyword" line per item. */
	namedSkillsText: string;
	/** The whole resume as prose (summary, experience bullets, projects…). */
	proseText: string;
};

function stripHtml(html: string): string {
	// Rich-text fields store HTML; fold them to plain text for word-boundary matching.
	return htmlToMarkdown(html);
}

/**
 * Split a resume into its named-skills text and its prose. Classification checks the named
 * region first, so the prose may legitimately contain the skills again — order does the work.
 */
export function resumeSkillGapTexts(data: ResumeData): SkillGapTexts {
	const skillLines: string[] = [];
	const collectSkillItems = (items: readonly { name?: string; keywords?: readonly string[] }[]) => {
		for (const item of items) {
			const keywords = (item.keywords ?? []).join(", ");
			skillLines.push(keywords ? `${item.name ?? ""}: ${keywords}` : (item.name ?? ""));
		}
	};

	collectSkillItems(data.sections.skills.items);
	for (const section of data.customSections) {
		if (section.type === "skills") {
			collectSkillItems(section.items as readonly { name?: string; keywords?: readonly string[] }[]);
		}
	}

	const proseParts: string[] = [
		data.basics.headline,
		stripHtml(data.summary.content),
		...data.sections.experience.items.flatMap((item) => [
			item.company,
			item.position,
			stripHtml(item.description),
			...item.roles.flatMap((role) => [role.position, stripHtml(role.description)]),
		]),
		...data.sections.education.items.flatMap((item) => [
			item.school,
			item.degree,
			item.area,
			stripHtml(item.description),
		]),
		...data.sections.projects.items.flatMap((item) => [item.name, stripHtml(item.description)]),
		...data.sections.certifications.items.flatMap((item) => [item.title, item.issuer, stripHtml(item.description)]),
		...data.sections.awards.items.flatMap((item) => [item.title, stripHtml(item.description)]),
		...data.sections.publications.items.flatMap((item) => [item.title, stripHtml(item.description)]),
		...data.sections.volunteer.items.flatMap((item) => [item.organization, stripHtml(item.description)]),
		...data.sections.interests.items.flatMap((item) => [item.name, ...(item.keywords ?? [])]),
	];

	for (const section of data.customSections) {
		if (section.type === "skills") continue;
		for (const item of section.items) {
			for (const value of Object.values(item)) {
				if (typeof value === "string") proseParts.push(stripHtml(value));
			}
		}
	}

	return {
		namedSkillsText: skillLines.join("\n"),
		proseText: proseParts.filter(Boolean).join("\n"),
	};
}

// --- Classification ----------------------------------------------------------------

/** Classify each JD skill against the resume texts into existing / supportedByResume / gap. */
export function classifySkillGaps(
	jdSkills: readonly string[],
	texts: SkillGapTexts,
): Pick<SkillGapResult, "existing" | "supportedByResume" | "gap"> {
	const { namedSkillsText, proseText } = texts;

	// Canonical skill sets present in each resume region. Folding BOTH the JD token and the
	// resume text through the shared toolkit is what closes the alias gap: a resume that
	// writes "k8s" and a JD that says "Kubernetes" resolve to the same canonical name instead
	// of being reported as a false gap.
	const namedCanonical = extractKnownSkills(namedSkillsText);
	const proseCanonical = extractKnownSkills(proseText);

	const existing: string[] = [];
	const supportedByResume: string[] = [];
	const gap: string[] = [];

	for (const skill of jdSkills) {
		const lowered = normalizeForMatching(skill).trim();
		const canonical = canonicalize(lowered);
		// "Known" = the shared toolkit recognizes this token. For known skills the
		// canonical-set lookup is authoritative and alias-safe. Unknown/free tokens fall
		// through to the word-boundary heuristic, byte-for-byte the conservative behavior.
		const known = canonical !== lowered || isKnownSkillForm(lowered);

		if (known && namedCanonical.has(canonical)) {
			existing.push(skill);
		} else if (known && proseCanonical.has(canonical)) {
			supportedByResume.push(skill);
		} else if (skillMentionedInText(skill, namedSkillsText)) {
			existing.push(skill);
		} else if (skillMentionedInText(skill, proseText)) {
			supportedByResume.push(skill);
		} else {
			gap.push(skill);
		}
	}

	return { existing, supportedByResume, gap };
}

export type ComputeSkillGapOptions = {
	jobDescription: string;
	resume: ResumeData;
};

/** The full deterministic pipeline: extract JD skills, classify against the resume, and
 * diagnose an inconclusive run so it can never masquerade as a clean result. */
export function computeSkillGap(options: ComputeSkillGapOptions): SkillGapResult {
	const jdSkills = extractJdSkills(options.jobDescription);
	const texts = resumeSkillGapTexts(options.resume);
	const buckets = classifySkillGaps(jdSkills, texts);
	return { ...buckets, lowConfidence: diagnoseExtraction(options.jobDescription, jdSkills) };
}
