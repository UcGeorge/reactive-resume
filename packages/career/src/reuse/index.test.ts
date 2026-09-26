import { describe, expect, it } from "vitest";
import {
	decideReuse,
	HIGH_SIMILARITY_THRESHOLD,
	hardMismatch,
	jaccardSimilarity,
	MEDIUM_SIMILARITY_THRESHOLD,
	tokenize,
} from "./index";

// Test cases translated from career-ops' `jd-similarity.test.mjs` and
// `jd-similarity-seniority.test.mjs` (MIT).

describe("tokenize", () => {
	it("is case-insensitive", () => {
		expect(tokenize("React react TypeScript").size).toBe(2);
	});

	it("keeps technical punctuation", () => {
		expect(tokenize("Node.js C++ C# F#").has("node.js")).toBe(true);
	});

	it("preserves plus/hash language suffixes", () => {
		for (const token of ["c++", "c#", "f#"]) {
			expect(tokenize(`Build with ${token}`).has(token)).toBe(true);
		}
	});
});

describe("jaccardSimilarity", () => {
	it("scores identical text 1", () => {
		expect(jaccardSimilarity("Vue React Node", "Vue React Node")).toBe(1);
	});

	it("scores unrelated text 0", () => {
		expect(jaccardSimilarity("Flutter mobile", "法律 财务")).toBe(0);
	});
});

describe("decideReuse", () => {
	it("recommends reuse for an identical JD", () => {
		const jd = "Senior React TypeScript Node.js platform engineer, distributed systems, GraphQL APIs.";
		const result = decideReuse({ previousJd: jd, nextJd: jd });
		expect(result.decision).toBe("reuse");
		expect(result.score).toBe(1);
		expect(result.reason).toBe("high-similarity");
	});

	it("recommends reuse at high similarity", () => {
		expect(
			decideReuse({ previousJd: "React TypeScript Node.js Vue", nextJd: "Vue React TypeScript Node.js" }).decision,
		).toBe("reuse");
	});

	it("recommends edits for a lightly-edited JD", () => {
		const result = decideReuse({
			previousJd: "React TypeScript Python Node.js",
			nextJd: "Vue React TypeScript Node.js",
		});
		expect(result.decision).toBe("reuse-with-edits");
		expect(result.reason).toBe("medium-similarity");
	});

	it("recommends regeneration for a different JD", () => {
		const result = decideReuse({ previousJd: "法律 财务 审计", nextJd: "Flutter Android iOS" });
		expect(result.decision).toBe("regenerate");
		expect(result.reason).toBe("low-similarity");
	});

	it("lets the seniority veto override a high-similarity score", () => {
		const result = decideReuse({
			previousJd: "Junior React TypeScript Node.js platform engineer",
			nextJd: "Senior React TypeScript Node.js platform engineer",
		});
		expect(result.decision).toBe("regenerate");
		expect(result.reason).toBe("level-mismatch");
	});

	it("vetoes reuse of an identical JD when the titles change level (junior → staff)", () => {
		const jd = "React TypeScript Node.js platform engineer, distributed systems.";
		const result = decideReuse({
			previousJd: jd,
			nextJd: jd,
			previousTitle: "Junior Platform Engineer",
			nextTitle: "Staff Platform Engineer",
		});
		expect(result.decision).toBe("regenerate");
		expect(result.reason).toBe("level-mismatch");
		// The veto overrides the score; it does not rewrite it.
		expect(result.score).toBe(1);
	});

	describe("threshold boundaries", () => {
		// Token sets sized so the Jaccard score lands exactly on, or just below, each
		// threshold: shared/union of 18/25 = 0.72 and 9/20 = 0.45.
		const words = (count: number, prefix: string) =>
			Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");

		it("treats a score of exactly 0.72 as reuse", () => {
			const shared = words(18, "shared");
			const previous = `${shared} ${words(4, "prev")}`;
			const next = `${shared} ${words(3, "next")}`;
			expect(jaccardSimilarity(next, previous)).toBe(HIGH_SIMILARITY_THRESHOLD);
			expect(decideReuse({ previousJd: previous, nextJd: next }).decision).toBe("reuse");
		});

		it("treats a score just below 0.72 as reuse-with-edits", () => {
			const shared = words(17, "shared");
			const previous = `${shared} ${words(4, "prev")}`;
			const next = `${shared} ${words(4, "next")}`;
			const score = jaccardSimilarity(next, previous);
			expect(score).toBeLessThan(HIGH_SIMILARITY_THRESHOLD);
			expect(score).toBeGreaterThanOrEqual(MEDIUM_SIMILARITY_THRESHOLD);
			expect(decideReuse({ previousJd: previous, nextJd: next }).decision).toBe("reuse-with-edits");
		});

		it("treats a score of exactly 0.45 as reuse-with-edits", () => {
			const shared = words(9, "shared");
			const previous = `${shared} ${words(5, "prev")}`;
			const next = `${shared} ${words(6, "next")}`;
			expect(jaccardSimilarity(next, previous)).toBe(MEDIUM_SIMILARITY_THRESHOLD);
			expect(decideReuse({ previousJd: previous, nextJd: next }).decision).toBe("reuse-with-edits");
		});

		it("treats a score just below 0.45 as regenerate", () => {
			const shared = words(9, "shared");
			const previous = `${shared} ${words(5, "prev")}`;
			const next = `${shared} ${words(7, "next")}`;
			const score = jaccardSimilarity(next, previous);
			expect(score).toBeLessThan(MEDIUM_SIMILARITY_THRESHOLD);
			expect(decideReuse({ previousJd: previous, nextJd: next }).decision).toBe("regenerate");
		});
	});
});

describe("hardMismatch — the seniority gate only fires on real level differences", () => {
	it("blocks a genuine level difference, including in Chinese", () => {
		expect(hardMismatch("高级 React 工程师", "实习生 React 开发")).toBe(true);
		expect(
			decideReuse({
				previousJd: "Junior Backend Engineer. Django, PostgreSQL, Redis.",
				nextJd: "Senior Backend Engineer. Django, PostgreSQL, Redis.",
			}).reason,
		).toBe("level-mismatch");
		expect(hardMismatch("Engineering Intern, summer programme.", "Staff Engineer, platform group.")).toBe(true);
	});

	it("does not block a level match", () => {
		expect(hardMismatch("远程 React 实习生", "Flutter 实习生")).toBe(false);
	});

	it("matches whole words only", () => {
		expect(hardMismatch("International React Engineer", "Intermediate React Engineer")).toBe(false);
	});

	it("does not read leadership as lead seniority", () => {
		expect(hardMismatch("Leadership platform role", "Senior platform role")).toBe(false);
	});

	// Ordinary English that happens to contain a level word: "Principal responsibilities"
	// means "main duties", "lead" here is a verb, "mid-market" is a customer segment.
	it("stands down on JD boilerplate level words, and the score decides", () => {
		const boilerplateJd =
			"Backend Engineer. Principal responsibilities: build payment infrastructure with " +
			"Django, PostgreSQL and Redis, design REST APIs, improve reliability, and lead " +
			"mentoring for teammates. Remote friendly.";
		const seniorJd =
			"Senior Backend Engineer. We build payment infrastructure with Django, PostgreSQL " +
			"and Redis. You will design REST APIs, improve reliability and mentor teammates. " +
			"Remote friendly.";
		expect(hardMismatch(seniorJd, boilerplateJd)).toBe(false);
		// Guard the fixture: if it drifts below the medium threshold this assertion would
		// pass for the wrong reason.
		const score = jaccardSimilarity(seniorJd, boilerplateJd);
		expect(score).toBeGreaterThanOrEqual(MEDIUM_SIMILARITY_THRESHOLD);
		expect(score).toBeLessThan(HIGH_SIMILARITY_THRESHOLD);
		expect(decideReuse({ previousJd: boilerplateJd, nextJd: seniorJd }).decision).toBe("reuse-with-edits");
	});

	it('reads "mid-market" as a segment, not a seniority level', () => {
		expect(
			hardMismatch(
				"Backend Engineer for our mid-market segment. Django, PostgreSQL.",
				"Senior Backend Engineer. Django, PostgreSQL.",
			),
		).toBe(false);
	});

	it("keeps titles built from the excluded words as levels", () => {
		expect(hardMismatch("Lead Engineer, platform.", "Junior Engineer, platform.")).toBe(true);
		expect(hardMismatch("Principal Engineer, platform.", "Junior Engineer, platform.")).toBe(true);
		expect(hardMismatch("Mid-level Engineer, platform.", "Intern Engineer, platform.")).toBe(true);
	});

	it("treats a document naming several levels as ambiguous, never the lowest", () => {
		const progressionCv =
			"Experience: Junior Developer 2019-2021. Senior Developer 2021-2026. Django, PostgreSQL, React.";
		expect(hardMismatch("Senior Developer. Django, PostgreSQL, React.", progressionCv)).toBe(false);
		expect(jaccardSimilarity("Senior Developer. Django, PostgreSQL, React.", progressionCv)).toBeGreaterThanOrEqual(
			MEDIUM_SIMILARITY_THRESHOLD,
		);
		expect(
			decideReuse({ previousJd: progressionCv, nextJd: "Senior Developer. Django, PostgreSQL, React." }).decision,
		).toBe("reuse-with-edits");
		// Ambiguity on EITHER side is enough to stand down.
		expect(hardMismatch(progressionCv, "Intern Developer. Django.")).toBe(false);
	});
});
