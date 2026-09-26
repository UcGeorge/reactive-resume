/**
 * JD-vs-JD similarity for the reuse decision, taken before any tokens are spent: when a new
 * posting is close enough to one already tailored for, reuse that work instead of paying for
 * a regeneration. Ported from career-ops' `jd-similarity.mjs` (MIT).
 *
 * Deliberately a recommendation layer: it never evaluates a JD and never deletes or
 * overwrites an existing tailored resume.
 */

import type { ReuseDecision } from "@reactive-resume/schema/career/data";

export type { ReuseDecision } from "@reactive-resume/schema/career/data";

// Token-set Jaccard over the two JDs. At or above HIGH the previous tailored resume is
// reused as-is; between the two it is reused with edits; below MEDIUM it is regenerated.
export const HIGH_SIMILARITY_THRESHOLD = 0.72;
export const MEDIUM_SIMILARITY_THRESHOLD = 0.45;

const STOP_WORDS = new Set([
	"and",
	"the",
	"for",
	"with",
	"from",
	"that",
	"this",
	"have",
	"will",
	"you",
	"your",
	"our",
	"are",
	"not",
	"to",
	"of",
	"in",
	"on",
	"or",
	"a",
	"an",
	"负责",
	"岗位",
	"工作",
	"相关",
	"具备",
	"以及",
	"能够",
	"进行",
	"通过",
	"需要",
]);

const LEVELS = [
	["intern", "实习", "实习生", "应届"],
	["junior", "初级"],
	["mid", "中级"],
	["senior", "高级", "资深"],
	["staff", "principal", "lead", "负责人"],
];

/** Tokenize JD/CV text into normalized, stop-word-filtered terms. Keeps technical
 * punctuation (node.js, c++, c#) and single-character tokens only when they carry a digit. */
export function tokenize(text: string | null | undefined): Set<string> {
	return new Set(
		String(text ?? "")
			.toLowerCase()
			.match(/[\p{L}\p{N}+#./-]+/gu)
			?.map((token) => token.replace(/^[./-]+|[./-]+$/g, ""))
			.filter((token) => token && (token.length > 1 || /\d/.test(token)) && !STOP_WORDS.has(token)) ?? [],
	);
}

/** Jaccard similarity between two texts or token sets. */
export function jaccardSimilarity(left: string | Set<string>, right: string | Set<string>): number {
	const a = left instanceof Set ? left : tokenize(left);
	const b = right instanceof Set ? right : tokenize(right);
	if (!a.size && !b.size) return 1;
	if (!a.size || !b.size) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection++;
	return intersection / (a.size + b.size - intersection);
}

// Level words that are also ordinary English, mapped to the words that follow them in their
// NON-seniority sense. JD boilerplate is full of these: "Principal responsibilities" means
// "main duties", "mid-market" is a customer segment, and "lead" is usually a verb. Matching
// them as job levels made the gate below fire on postings of identical seniority. Only the
// trailing word is inspected: "Principal Engineer" and "Lead Engineer" stay levels because
// `engineer` is not in any of these lists.
const NON_LEVEL_FOLLOWERS: Record<string, string[]> = {
	principal: [
		"responsibilities",
		"responsibility",
		"duties",
		"accountabilities",
		"objectives",
		"purpose",
		"tasks",
		"activities",
	],
	lead: ["to", "the", "a", "an", "our", "and", "or", "by", "on", "in", "for", "with", "from", "mentoring", "projects"],
	mid: ["market", "size", "sized", "cap", "tier", "funnel", "term", "sized-company"],
};

/** Whether a level word at `index` reads as a job level rather than plain English. */
function readsAsLevel(word: string, normalized: string, index: number): boolean {
	const followers = NON_LEVEL_FOLLOWERS[word];
	if (!followers) return true;
	const after = normalized.slice(index + word.length).match(/^[^a-z0-9]*([a-z0-9-]+)/);
	return !after || !followers.includes(after[1] ?? "");
}

/**
 * Every distinct seniority level named in the text, as LEVELS indices. Returns ALL of them
 * rather than the first: a CV showing career progression names each rank it held, and
 * collapsing to whichever appeared earliest in the LEVELS table read a junior-to-senior CV
 * as junior.
 */
function levelsIn(text: string): Set<number> {
	const normalized = String(text ?? "").toLowerCase();
	const found = new Set<number>();
	LEVELS.forEach((words, level) => {
		for (const word of words) {
			if (/^[\p{Script=Han}]+$/u.test(word)) {
				if (normalized.includes(word)) {
					found.add(level);
					break;
				}
				continue;
			}
			const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
			const pattern = new RegExp(`(?:^|[^a-z0-9])(${escaped})(?=$|[^a-z0-9])`, "gi");
			let match = pattern.exec(normalized);
			while (match !== null) {
				if (readsAsLevel(word, normalized, match.index + match[0].length - word.length)) {
					found.add(level);
					break;
				}
				match = pattern.exec(normalized);
			}
			if (found.has(level)) break;
		}
	});
	return found;
}

/**
 * The seniority level of a document, or -1 when it has no single unambiguous one. Naming
 * several levels counts as ambiguous, NOT as the lowest one: the gate exists to catch a
 * clear level difference, and a guess is worse than standing down and letting the
 * similarity score decide.
 */
function levelOf(text: string): number {
	const levels = levelsIn(text);
	const only = [...levels];
	return levels.size === 1 ? (only[0] ?? -1) : -1;
}

/** Whether the new JD and the previous document name different seniority levels. */
export function hardMismatch(newJd: string, previousText: string): boolean {
	const newLevel = levelOf(newJd);
	const previousLevel = levelOf(previousText);
	return newLevel >= 0 && previousLevel >= 0 && newLevel !== previousLevel;
}

export type DecideReuseInput = {
	/** The JD the existing tailored resume was made for. */
	previousJd: string;
	/** The new posting's JD. */
	nextJd: string;
	previousTitle?: string;
	nextTitle?: string;
};

/**
 * Recommend reusing the previous tailored resume, reusing it with edits, or regenerating.
 *
 * The similarity score is computed over the two JDs alone; the titles (when given) join
 * their JDs only for the seniority check, so a junior→staff title change on an otherwise
 * identical posting still forces a regeneration — the hard-mismatch veto overrides any
 * similarity score.
 */
export function decideReuse(input: DecideReuseInput): ReuseDecision {
	const score = jaccardSimilarity(input.nextJd, input.previousJd);
	const next = [input.nextTitle, input.nextJd].filter(Boolean).join("\n");
	const previous = [input.previousTitle, input.previousJd].filter(Boolean).join("\n");
	if (hardMismatch(next, previous)) {
		return { decision: "regenerate", score, reason: "level-mismatch" };
	}
	if (score >= HIGH_SIMILARITY_THRESHOLD) return { decision: "reuse", score, reason: "high-similarity" };
	if (score >= MEDIUM_SIMILARITY_THRESHOLD) return { decision: "reuse-with-edits", score, reason: "medium-similarity" };
	return { decision: "regenerate", score, reason: "low-similarity" };
}
