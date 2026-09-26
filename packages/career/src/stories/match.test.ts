import type { MatchableStory } from "./match";
import { describe, expect, it } from "vitest";
import {
	BODY_MATCH_WEIGHT,
	formatStoryForAnswer,
	JD_TAG_BOOST,
	matchStories,
	scoreStory,
	TAG_MATCH_WEIGHT,
	TITLE_THEME_WEIGHT,
	tokenize,
} from "./match";

// Test cases translated from career-ops' match-star suite in test-all.mjs (MIT): the two-story
// fixture, the scorer weights, the tokenized-tag regression, and the non-Latin tokenizer fix
// (#2847). The markdown fixture becomes structured rows; issue numbers are kept.

const mkStory = (fields: Partial<MatchableStory> & { id: string }): MatchableStory => ({
	title: "",
	theme: "",
	tags: [],
	situation: "",
	task: "",
	action: "",
	result: "",
	reflection: "",
	...fields,
});

const leadership = mkStory({
	id: "s-leadership",
	title: "Led cross-functional rollout under deadline",
	theme: "Leadership",
	tags: ["leadership", "project management", "cross-functional collaboration", "deadline pressure"],
	situation: "Our team had 3 weeks to ship a platform migration affecting 6 departments.",
	task: "I was asked to coordinate across engineering, ops, and comms with no formal authority.",
	action: "I mapped dependencies, ran daily standups, and escalated blockers to leadership.",
	result: "Shipped on time, zero downtime, positive feedback from all department leads.",
	reflection: "Influence without authority is the real skill.",
});

const conflict = mkStory({
	id: "s-conflict",
	title: "Resolved a data pipeline disagreement with a senior engineer",
	theme: "Conflict",
	tags: ["conflict resolution", "disagreement", "data-driven decision making", "stakeholder management"],
	situation: "A senior engineer wanted to rewrite our ETL in Spark; I thought it was premature.",
	task: "Present my case without creating a political problem.",
	action: "I pulled query benchmarks and showed the bottleneck was upstream, not the pipeline itself.",
	result: "Team agreed to a targeted fix; saved 6 weeks of rewrite work.",
	reflection: "Data beats seniority.",
});

const score = (story: MatchableStory, question: string, jdTerms: string[] = []): number =>
	scoreStory(story, tokenize(question), jdTerms.flatMap(tokenize)).score;

describe("matchStories — fixture ranking (test-all.mjs port)", () => {
	it("surfaces the leadership story first for a leadership question", () => {
		// The leadership story is listed second, so the ranking (not input order) must win.
		const ranked = matchStories({
			question: "Tell me about a time you led a project under deadline pressure",
			stories: [conflict, leadership],
		});
		expect(ranked[0]?.id).toBe("s-leadership");
		expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
	});

	it("surfaces the conflict story first for a conflict question", () => {
		const ranked = matchStories({
			question: "Describe a conflict or disagreement with a colleague",
			stories: [leadership, conflict],
		});
		expect(ranked[0]?.id).toBe("s-conflict");
	});

	it("explains the ranking with per-hit reasons", () => {
		const [top] = matchStories({
			question: "Describe a conflict or disagreement with a colleague",
			stories: [leadership, conflict],
		});
		expect(top?.reasons.join("\n")).toContain('tag match: "conflict" (+3)');
		expect(top?.reasons.join("\n")).toContain('title/theme match: "disagreement" (+2)');
	});

	it("returns [] for an empty story list", () => {
		expect(matchStories({ question: "Tell me about a time you led", stories: [] })).toEqual([]);
	});
});

describe("scoreStory — the original's weights", () => {
	it("keeps the original constants", () => {
		expect(TAG_MATCH_WEIGHT).toBe(3);
		expect(TITLE_THEME_WEIGHT).toBe(2);
		expect(BODY_MATCH_WEIGHT).toBe(1);
		expect(JD_TAG_BOOST).toBe(2);
	});

	it("a tag-exact query yields at least 6 points (3 per token, 2 tokens)", () => {
		expect(score(conflict, "stakeholder management")).toBeGreaterThanOrEqual(6);
	});

	// Regression: tag scoring must use tokenized exact membership, not a substring test —
	// otherwise short query tokens (ai, ml, go, qa...) spuriously collide inside longer tag
	// words for a false +3, inflating irrelevant stories above genuinely relevant ones.
	it('short token "ai" does not substring-match tag "maintainability"', () => {
		expect(score(mkStory({ id: "x", tags: ["maintainability"] }), "ai")).toBe(0);
	});

	it('exact tag token "leadership" still scores +3', () => {
		expect(score(mkStory({ id: "x", tags: ["leadership"] }), "leadership")).toBe(3);
	});

	it("ranks a tag-matching story above a token-overlap-only story", () => {
		const tagged = mkStory({ id: "tagged", tags: ["leadership"] });
		const bodyOnly = mkStory({ id: "body-only", action: "Showed leadership during the outage." });
		const ranked = matchStories({ question: "Tell me about leadership", stories: [bodyOnly, tagged] });
		expect(ranked.map(({ id }) => id)).toEqual(["tagged", "body-only"]);
		expect(ranked[0]?.score).toBe(3);
		expect(ranked[1]?.score).toBe(1);
	});

	it("the JD boost changes the order", () => {
		const generalist = mkStory({ id: "generalist", tags: ["delivery"] });
		const platform = mkStory({ id: "platform", tags: ["delivery", "kubernetes migrations"] });
		const stories = [generalist, platform];

		// Tied on the question alone: stable sort keeps input order.
		const withoutJd = matchStories({ question: "Tell me about delivery", stories });
		expect(withoutJd.map(({ id }) => id)).toEqual(["generalist", "platform"]);

		const withJd = matchStories({ question: "Tell me about delivery", stories, jdTerms: ["Kubernetes"] });
		expect(withJd.map(({ id }) => id)).toEqual(["platform", "generalist"]);
		expect(withJd[0]?.score).toBe((withJd[1]?.score ?? 0) + JD_TAG_BOOST);
		expect(withJd[0]?.reasons.join("\n")).toContain('jd-term boost: tag "kubernetes migrations" (+2)');
	});
});

// Non-Latin story banks (#2847): tokenize() stripped [^a-z0-9\s], so a story written in
// Russian or Hindi produced [] and scored 0 against a question in the SAME language — the
// matcher was inert, not degraded, for anyone whose output language is not English.
describe("tokenize — non-Latin scripts (#2847)", () => {
	const ru = mkStory({
		id: "ru",
		title: "Миграция платежей",
		theme: "платежи",
		action: "Возглавил миграцию платёжной платформы",
		result: "Снизил отказы",
		tags: ["платежи"],
	});
	const hi = mkStory({
		id: "hi",
		title: "भुगतान माइग्रेशन",
		theme: "भुगतान",
		action: "भुगतान माइग्रेशन का नेतृत्व",
		result: "विफलताएं घटाईं",
		tags: ["भुगतान"],
	});

	it("non-Latin text produces tokens", () => {
		expect(tokenize("Миграция").length).toBeGreaterThan(0);
		expect(tokenize("भुगतान").length).toBeGreaterThan(0);
	});

	it("a story matches a question in its own language", () => {
		expect(score(ru, "Расскажите о миграции платежей")).toBeGreaterThan(0);
		expect(score(hi, "मुझे भुगतान माइग्रेशन के बारे में बताएं")).toBeGreaterThan(0);
	});

	it("an unrelated same-language question still scores 0", () => {
		// The widening must not make everything match everything.
		expect(score(ru, "Расскажите о найме команды")).toBe(0);
	});

	it("Devanagari matras survive tokenization", () => {
		// Without \p{M} the matras become spaces and shatter the word into fragments.
		expect(tokenize("भुगतान")[0]).toBe("भुगतान");
	});
});

describe("formatStoryForAnswer — ATS paste sizing (formatAts port)", () => {
	it("renders the header, tags, prose, and word count", () => {
		const answer = formatStoryForAnswer(leadership);
		expect(answer).toContain("— Led cross-functional rollout under deadline [Leadership]");
		expect(answer).toContain("Tags: leadership, project management");
		expect(answer).toContain("Our team had 3 weeks");
		expect(answer).toContain("Influence without authority is the real skill.");
		expect(answer).toMatch(/\(~\d+ words\)/);
	});

	it("advises expanding a story under 250 words", () => {
		expect(formatStoryForAnswer(leadership)).toContain("Under 250 words — consider expanding this story");
	});

	it("enforces the 500-word ceiling and drops the notice at length", () => {
		const long = mkStory({ id: "long", title: "Long", action: Array.from({ length: 620 }, () => "word").join(" ") });
		const answer = formatStoryForAnswer(long);
		expect(answer).toContain("(~500 words)");
		expect(answer).not.toContain("Under 250 words");
		const prose = answer.split("\n\n")[1] ?? "";
		expect(prose.split(/\s+/).filter(Boolean)).toHaveLength(500);
	});
});
