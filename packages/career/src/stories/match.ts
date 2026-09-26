/**
 * Deterministic story <-> behavioural-question matcher, ported from career-ops'
 * `match-star.mjs` (MIT). Zero-LLM: parses nothing here (stories arrive as rows, not
 * markdown), scores each STAR story against the question text (and optional JD terms), and
 * returns a ranked list plus an answer formatted to ATS paste length (250-500 words).
 *
 * Scoring (the original's weights, unchanged):
 *   +3 per stopword-filtered question token found in the tokenized tag set — tags are explicit
 *      "best for questions about" labels, so they carry the highest weight. Tokenized EXACT
 *      membership, not a substring test, so short query tokens (ai, ml, go, qa...) cannot
 *      spuriously collide inside longer tag words ("ai" inside "maintainability").
 *   +2 per question token found in the title/theme tokens.
 *   +1 per question token found in the action+result tokens (the most substantive parts).
 *   +2 per tag sharing a token with the stopword-filtered JD terms (the JD boost).
 *
 * A repeated question token scores on each occurrence, as in the original. Ties keep input
 * order (Array.prototype.sort is stable).
 *
 * Deviations from the original: the markdown parser (parseStories) and CLI are not ported —
 * stories are structured rows, so its skip-empty-blocks rule is a parser concern that does not
 * apply; the JD arrives as a term list (`jdTerms`) rather than a file, tokenized the same way
 * the original tokenized the JD file's text; `formatStoryForAnswer` drops the original's
 * `Source:` line (the row links a resume instead of carrying a source label), omits empty
 * optional lines, and words its under-250 notice without the original's emoji.
 */

// --- Tokenizing ---------------------------------------------------------------------

/**
 * Tokenize text into lowercase words, stripping punctuation. Letters, marks and digits of ANY
 * script: the original's `[^a-z0-9\s]` deleted every non-Latin character, so a story bank
 * written in Russian, Hindi, Greek or Ukrainian tokenized to [] and scored 0 against a
 * question in the same language — the matcher was inert, not degraded, for anyone whose
 * output language is not English (#2847). `\p{M}` is included deliberately: without it
 * Devanagari matras become spaces and shatter a word into fragments that match nothing
 * (the mistake caught in #2781's review of the sibling role tokenizer).
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/** The original's question/JD stopword list, unchanged. */
export const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"you",
	"me",
	"my",
	"your",
	"i",
	"we",
	"they",
	"it",
	"is",
	"was",
	"were",
	"are",
	"be",
	"been",
	"have",
	"had",
	"has",
	"do",
	"did",
	"does",
	"tell",
	"about",
	"time",
	"when",
	"how",
	"give",
	"example",
	"describe",
	"situation",
	"where",
	"what",
]);

// --- Scoring ------------------------------------------------------------------------

/** The original's weights, by name. */
export const TAG_MATCH_WEIGHT = 3;
export const TITLE_THEME_WEIGHT = 2;
export const BODY_MATCH_WEIGHT = 1;
export const JD_TAG_BOOST = 2;

export type MatchableStory = {
	id: string;
	title: string;
	theme: string;
	/** The row's "best for questions about" labels. */
	tags: readonly string[];
	situation: string;
	task: string;
	action: string;
	result: string;
	reflection: string;
};

export type MatchStoriesInput = {
	question: string;
	stories: readonly MatchableStory[];
	/** Key terms from the job description, tokenized like the original tokenized the JD file. */
	jdTerms?: readonly string[];
};

export type StoryMatch = {
	id: string;
	score: number;
	reasons: string[];
};

export type StoryScore = {
	score: number;
	reasons: string[];
};

/** Score one story against tokenized question + JD tokens — the original's score(), with each
 * scoring event also recorded as a reason. Higher = better match. */
export function scoreStory(
	story: Omit<MatchableStory, "id">,
	queryTokens: readonly string[],
	jdTokens: readonly string[],
): StoryScore {
	const signal = queryTokens.filter((token) => !STOPWORDS.has(token));
	let score = 0;
	const reasons: string[] = [];

	// Tag match: highest weight (tags are explicit "best for" labels). Tokenized exact
	// membership (mirrors the JD-boost path below) so short query tokens can't spuriously
	// collide inside longer tag words.
	const tagTokens = new Set(story.tags.flatMap((tag) => tokenize(tag)));
	for (const token of signal) {
		if (tagTokens.has(token)) {
			score += TAG_MATCH_WEIGHT;
			reasons.push(`tag match: "${token}" (+${TAG_MATCH_WEIGHT})`);
		}
	}

	// Title/theme match.
	const titleTokens = tokenize(`${story.title} ${story.theme}`);
	for (const token of signal) {
		if (titleTokens.includes(token)) {
			score += TITLE_THEME_WEIGHT;
			reasons.push(`title/theme match: "${token}" (+${TITLE_THEME_WEIGHT})`);
		}
	}

	// Action + result match (the most substantive parts).
	const bodyTokens = tokenize(`${story.action} ${story.result}`);
	for (const token of signal) {
		if (bodyTokens.includes(token)) {
			score += BODY_MATCH_WEIGHT;
			reasons.push(`action/result match: "${token}" (+${BODY_MATCH_WEIGHT})`);
		}
	}

	// JD boost: stopword-filtered JD tokens matched against tokenized tags (exact overlap).
	if (jdTokens.length > 0) {
		const jdSignal = new Set(jdTokens.filter((token) => !STOPWORDS.has(token)));
		for (const tag of story.tags) {
			if (tokenize(tag).some((token) => jdSignal.has(token))) {
				score += JD_TAG_BOOST;
				reasons.push(`jd-term boost: tag "${tag}" (+${JD_TAG_BOOST})`);
			}
		}
	}

	return { score, reasons };
}

/** Rank every story against the question, best first. An empty story list yields []. */
export function matchStories(input: MatchStoriesInput): StoryMatch[] {
	const queryTokens = tokenize(input.question);
	const jdTokens = (input.jdTerms ?? []).flatMap((term) => tokenize(term));
	return input.stories
		.map((story) => {
			const { score, reasons } = scoreStory(story, queryTokens, jdTokens);
			return { id: story.id, score, reasons };
		})
		.sort((a, b) => b.score - a.score);
}

// --- Answer formatting --------------------------------------------------------------

/** The original's ATS paste-length band: a hard 500-word ceiling, a 250-word advisory floor. */
export const ANSWER_WORD_CEILING = 500;
export const ANSWER_WORD_FLOOR = 250;

/**
 * Format a STAR story as ATS-ready prose (250-500 words) — the original's formatAts().
 * Enforces the 500-word ceiling; prose below 250 words gets an advisory notice.
 */
export function formatStoryForAnswer(story: Omit<MatchableStory, "id">): string {
	const parts = [story.situation, story.task, story.action, story.result, story.reflection];
	const wordArr = parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
	const prose = wordArr.slice(0, ANSWER_WORD_CEILING).join(" ");
	const words = Math.min(wordArr.length, ANSWER_WORD_CEILING);
	const notice =
		wordArr.length < ANSWER_WORD_FLOOR
			? `\n   Under ${ANSWER_WORD_FLOOR} words — consider expanding this story in your story bank.`
			: "";

	return [
		`— ${story.title}${story.theme ? ` [${story.theme}]` : ""}`,
		...(story.tags.length > 0 ? [`   Tags: ${story.tags.join(", ")}`] : []),
		"",
		prose,
		"",
		`   (~${words} words)${notice}`,
	].join("\n");
}
