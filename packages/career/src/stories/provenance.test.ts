import type { ProvenanceState, StoryProvenanceReport, StoryProvenanceStory } from "./provenance";
import { describe, expect, it } from "vitest";
import {
	canAutoTransition,
	canCiteAsQuantifiedClaim,
	checkStoryProvenance,
	DEFAULT_PROVENANCE_STATE,
	isDurableProvenance,
	isUserDecidedProvenance,
	PROVENANCE_STATES,
} from "./provenance";

// Test cases translated from career-ops' `story-provenance-check.mjs --self-test` and its
// suite (story-provenance-non-ascii; MIT). The original's markdown fixtures become story rows,
// its `**Provenance:**` markers become the row's `current` state, and its four buckets map to
// {suggested, verifiedClaims, unverifiedClaims, reasons} — the module header documents the
// mapping and the deviations. Original issue numbers are kept so the cases stay traceable.

const story = (fields: Partial<StoryProvenanceStory>): StoryProvenanceStory => ({
	situation: "",
	task: "",
	action: "",
	result: "",
	reflection: "",
	...fields,
});

const check = (
	fields: Partial<StoryProvenanceStory>,
	sourceText: string | null,
	current: ProvenanceState = "derived-unverified",
): StoryProvenanceReport => checkStoryProvenance({ story: story(fields), sourceText, current });

const supportReasonsOf = (report: StoryProvenanceReport): string[] =>
	report.reasons.filter((reason) => reason.includes("supports the underlying fact"));

// The original's fakeCv, minus markdown the row shape no longer carries.
const fakeCv = [
	"# Experience",
	"",
	"## Instructional Designer — Acme University (2022-2025)",
	"- Reduced onboarding ramp time from 8 hours to 2 hours per cohort by automating manual configuration steps.",
	"- Led a cross-functional team through a full LMS migration with zero data loss.",
	"",
	"# Summary",
	"",
	"Brings 15 years of unrelated professional background in adult education prior to instructional design work.",
].join("\n");

describe("checkStoryProvenance — self-test port", () => {
	// Fixture 1: numeric claims present in the linked resume -> upgrade to resume-verified.
	it("suggests resume-verified when every claim is backed (hour-range story)", () => {
		const report = check(
			{
				situation: "New hires spent too long configuring onboarding tools manually.",
				task: "Cut ramp time without losing quality.",
				action: "Built an automated workflow using a custom LMS integration.",
				result: "Ramp time dropped from 8 hours to 2 hours per cohort.",
			},
			fakeCv,
		);
		expect(report.suggested).toBe("resume-verified");
		expect(report.verifiedClaims).toEqual(expect.arrayContaining(["8 hours", "2 hours"]));
		expect(report.unverifiedClaims).toEqual([]);
		expect(report.reasons.join("\n")).toContain('upgrade suggested: "derived-unverified" -> "resume-verified"');
	});

	// Fixture 3: a claim only in the story, no resume trace -> stays derived-unverified,
	// with the claim listed for the confirmation workflow.
	it("keeps an unbacked claim derived-unverified and lists it", () => {
		const report = check(
			{
				situation: "Leadership wanted a large-scale training rollout.",
				action: "Built self-paced modules and distributed them broadly.",
				result: "500+ employees completed the rollout within the quarter.",
			},
			fakeCv,
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.unverifiedClaims).toEqual(["500 employees"]);
		expect(report.verifiedClaims).toEqual([]);
	});

	// Fixture 2b (regression, #2947 CodeRabbit finding — unscoped number matching): the resume
	// contains the bare number in an unrelated sentence ("15 years of unrelated professional
	// background"). A story counting 15 of something else must NOT be promoted just because the
	// digit string coincidentally appears. (Here the noun already scopes the claim: "15
	// instructors" is not "15 years".)
	it("does not verify a claim off a bare digit-string coincidence", () => {
		const report = check({ action: "Coordinated 15 instructors across the program." }, fakeCv);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.unverifiedClaims).toEqual(["15 instructors"]);
	});

	// The scoped-context half of the same finding, on a claim whose normalized form DOES appear
	// in the source: an identical "40%" with disjoint context must not count as backed.
	it("requires shared context even when the identical normalized claim exists in the source", () => {
		const report = check(
			{ result: "Cut licensing costs by 40% after renegotiating the vendor contract." },
			"Improved learner retention by 40% across the mentorship cohort program.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.unverifiedClaims).toEqual(["40%"]);
		expect(supportReasonsOf(report)).toEqual([]);
	});

	it("verifies the same claim once the source occurrence shares its context", () => {
		const report = check(
			{ result: "Cut licensing costs by 40% after renegotiating the vendor contract." },
			"Cut licensing costs by 40% in the vendor contract renegotiation.",
		);
		expect(report.suggested).toBe("resume-verified");
		expect(report.verifiedClaims).toEqual(["40%"]);
	});

	// Fixture 4: the explicit user-cannot-confirm state overrides the heuristic — checked
	// first, wins over everything, never itself overridden.
	it("user-cannot-confirm is a hard override for an unbacked claim", () => {
		const report = check(
			{
				task: "Cut licensing costs without losing seats.",
				result: "Estimated 40% savings on licensing costs, though the original invoice could not be located.",
			},
			fakeCv,
			"user-cannot-confirm",
		);
		expect(report.suggested).toBe("user-cannot-confirm");
		expect(report.verifiedClaims).toEqual([]);
		expect(report.unverifiedClaims).toEqual(["40%"]);
		expect(report.reasons.join("\n")).toMatch(/durable, never reclassified/);
	});

	// #2947's core invariant: an explicit "I don't know" must never decay into "verified"
	// through repetition or a later re-scan — even when the text now appears fully backed.
	it("user-cannot-confirm never changes, whatever the text says", () => {
		const report = check(
			{ result: "Ramp time dropped from 8 hours to 2 hours per cohort." },
			fakeCv,
			"user-cannot-confirm",
		);
		expect(report.suggested).toBe("user-cannot-confirm");
		expect(report.verifiedClaims).toEqual([]);
	});

	// Fixture 5: stability across repeated runs — a fresh re-check must classify identically.
	it("is idempotent across repeated runs", () => {
		const input = {
			story: story({ result: "Estimated 40% savings on licensing costs." }),
			sourceText: fakeCv,
			current: "user-cannot-confirm" as const,
		};
		expect(checkStoryProvenance(input)).toEqual(checkStoryProvenance(input));
		expect(checkStoryProvenance(input).suggested).toBe("user-cannot-confirm");
	});

	// Fixtures 6/7: an explicit user confirmation (the original's `user-stated YYYY-MM-DD`
	// marker) counts as confirmed even though the resume doesn't carry the figure — and it is
	// evaluated BEFORE the context-overlap heuristic, so overlapping resume context must not
	// redirect the claim into an unverified bucket.
	it("user-confirmed wins over the heuristic, not as a fallback after it", () => {
		const report = check(
			{
				action: "Delivered training to 275 employees across each cohort rotation.",
				result: "All participants passed the certification assessment.",
			},
			fakeCv,
			"user-confirmed",
		);
		expect(report.suggested).toBe("user-confirmed");
		expect(report.verifiedClaims).toEqual(["275 employees"]);
		expect(report.unverifiedClaims).toEqual([]);
	});

	// Fixture 7's control case (CodeRabbit follow-up, PR #2948): the assertion above passes
	// vacuously if the heuristic stops producing overlap at all. The identical story WITHOUT
	// the confirmation must land unverified WITH the supported-by-resume annotation — proving
	// the user's confirmation is what wins the ordering race, not an absence of overlap.
	it("control: the same story without user confirmation is unverified with context support", () => {
		const report = check(
			{
				action: "Delivered training to 275 employees across each cohort rotation.",
				result: "All participants passed the certification assessment.",
			},
			fakeCv,
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.unverifiedClaims).toEqual(["275 employees"]);
		expect(supportReasonsOf(report)).toHaveLength(1);
	});

	// Never a silent downgrade: an unbacked claim under resume-verified is flagged as
	// downgrade-worthy, but the suggestion stays put — the caller/user decides.
	it("flags but never downgrades a resume-verified story with unbacked claims", () => {
		const report = check({ result: "500+ employees completed the rollout." }, fakeCv, "resume-verified");
		expect(report.suggested).toBe("resume-verified");
		expect(report.unverifiedClaims).toEqual(["500 employees"]);
		expect(report.reasons.join("\n")).toContain("downgrade-worthy");
		expect(report.reasons.join("\n")).toContain("never automatic");
	});

	it("keeps resume-verified when every claim is still backed", () => {
		const report = check(
			{ result: "Ramp time dropped from 8 hours to 2 hours per cohort." },
			fakeCv,
			"resume-verified",
		);
		expect(report.suggested).toBe("resume-verified");
		expect(report.reasons.join("\n")).not.toContain("upgrade suggested");
	});

	// Deviation, documented: fact-gate's extractor has no `scale-hyphen` pattern, so the
	// original's "15-person team" shape yields no claim here — reported as the
	// no-numeric-claims diagnosis rather than classified.
	it("a scale-hyphen shape yields no claim (fact-gate reuse deviation)", () => {
		const report = check({ action: "Led a 15-person team through the full migration." }, fakeCv);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.verifiedClaims).toEqual([]);
		expect(report.unverifiedClaims).toEqual([]);
		expect(report.reasons.join("\n")).toContain("no numeric claims matched the covered patterns");
	});
});

describe("checkStoryProvenance — diagnose() port", () => {
	// The original's `no-cv` diagnosis: claims cannot be checked against a primary source.
	it("reports a missing linked resume and leaves the state alone", () => {
		const report = check({ result: "Cut costs by 40% in one year." }, null);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.verifiedClaims).toEqual([]);
		expect(report.unverifiedClaims).toEqual(["40%"]);
		expect(report.reasons.join("\n")).toContain("no linked resume text");
	});

	it("flags resume-verified without a linked resume as downgrade-worthy, without downgrading", () => {
		const report = check({ result: "Cut costs by 40% in one year." }, null, "resume-verified");
		expect(report.suggested).toBe("resume-verified");
		expect(report.reasons.join("\n")).toContain("downgrade-worthy");
	});

	// The original's `no-numeric-claims-found` diagnosis: zero claims is not "no risk", so a
	// claim-less story is never auto-upgraded either.
	it("does not upgrade a story with no numeric claims", () => {
		const report = check({ result: "The migration completed on time with zero data loss." }, fakeCv);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.reasons.join("\n")).toContain('not the same as "verified"');
	});

	it("a conclusive run carries no low-confidence diagnosis", () => {
		const report = check({ result: "Ramp time dropped from 8 hours to 2 hours per cohort." }, fakeCv);
		expect(report.reasons.join("\n")).not.toContain("no linked resume text");
		expect(report.reasons.join("\n")).not.toContain("no numeric claims");
	});
});

// Port of story-provenance-non-ascii.test.mjs: the checker must reach the same verdict
// whatever script the resume is written in (#2393/#2429/#2569/#2666 — the ASCII-only strip,
// and the `\b` boundary that is never satisfied for a non-Latin word).
describe("checkStoryProvenance — non-ASCII resumes", () => {
	it("a Cyrillic resume verifies a claim its own prose supports", () => {
		const report = check(
			{ result: "Сократил расходы на инфраструктуру на 40% за год." },
			"# Иван Петров\n\n- Сократил расходы на инфраструктуру на 40% за один год.",
		);
		expect(report.suggested).toBe("resume-verified");
		expect(report.verifiedClaims).toEqual(["40%"]);
	});

	it("a Greek resume verifies a claim its own prose supports", () => {
		const report = check(
			{ result: "Μείωσε το κόστος υποδομής κατά 40%." },
			"# Βιογραφικό\n\n- Μείωσε το κόστος υποδομής κατά 40% σε έναν χρόνο.",
		);
		expect(report.suggested).toBe("resume-verified");
	});

	it("a bare digit coincidence in a Cyrillic resume is NOT verified", () => {
		// 40 appears in the resume, but as a page count in an unrelated sentence — the #2947
		// scoping guard expressed in Cyrillic.
		const report = check(
			{ result: "Сократил расходы на инфраструктуру на 40%." },
			"# Иван Петров\n\n- Опубликовал руководство объёмом 40 страниц.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(supportReasonsOf(report)).toEqual([]);
	});

	it("an accented word is not re-cut into a different real word", () => {
		// The old strip turned "évaluation" into " valuation" — a DIFFERENT English word that
		// then overlapped a finance resume legitimately saying "valuation".
		const report = check(
			{ result: "Réduit les incidents de 40% après une évaluation complète." },
			"# Jane Roe\n\n- Built discounted cash flow valuation models for the M&A desk.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(supportReasonsOf(report)).toEqual([]);
	});

	it("a Cyrillic claim the resume supports but does not quantify gets the context annotation", () => {
		const report = check(
			{ result: "Сократил расходы на инфраструктуру на 40%." },
			"# Иван Петров\n\n- Отвечал за сокращение расходов на инфраструктуру платформы.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(report.unverifiedClaims).toEqual(["40%"]);
		expect(supportReasonsOf(report)).toHaveLength(1);
	});

	it("a Greek claim the resume supports but does not quantify gets the context annotation", () => {
		const report = check(
			{ result: "Μείωσε το κόστος υποδομής κατά 40%." },
			"# Βιογραφικό\n\n- Υπεύθυνος για τη μείωση του κόστους υποδομής.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(supportReasonsOf(report)).toHaveLength(1);
	});

	it("the boundary is still a boundary — a substring does not count as overlap", () => {
		// The claim word "дизайн" sits inside the resume's "редизайн" and nothing else is
		// shared: a whole-word matcher finds no overlap; a bare `includes` would.
		const report = check({ result: "Создал дизайн и сократил расходы на 40%." }, "# CV\n\n- Выполнил редизайн макета.");
		expect(report.suggested).toBe("derived-unverified");
		expect(supportReasonsOf(report)).toEqual([]);
	});

	it("a Turkish dotted capital in the resume still matches a claim word", () => {
		// Both sides must be folded the SAME way: "İstanbul" lowercases to `i` + U+0307, and
		// only "istanbul" can produce the overlap here — every other content word is disjoint.
		const report = check(
			{ result: "Istanbul genelinde 40% tasarruf sağlandı." },
			"# CV\n\n- İstanbul biriminde görev aldı.",
		);
		expect(report.suggested).toBe("derived-unverified");
		expect(supportReasonsOf(report)).toHaveLength(1);
	});

	it("a Turkish dotted capital folds to the same word as its plain i", () => {
		const report = check(
			{ result: "Istanbul ekibinde maliyetleri 40% azalttı." },
			"# CV\n\n- İstanbul ekibinde maliyetleri 40% azalttı.",
		);
		expect(report.suggested).toBe("resume-verified");
	});

	it("the English behaviour is unchanged", () => {
		const result = { result: "Cut infrastructure costs by 40% in one year." };
		expect(check(result, "# Ivan Petrov\n\n- Cut infrastructure costs by 40% in one year.").suggested).toBe(
			"resume-verified",
		);
		expect(check(result, "# Ivan Petrov\n\n- Published a 40 page onboarding guide.").suggested).toBe(
			"derived-unverified",
		);
	});
});

describe("provenance state machine", () => {
	it("declares the four states with derived-unverified as the safe default", () => {
		expect([...PROVENANCE_STATES]).toEqual([
			"resume-verified",
			"user-confirmed",
			"derived-unverified",
			"user-cannot-confirm",
		]);
		expect(DEFAULT_PROVENANCE_STATE).toBe("derived-unverified");
	});

	it("marks the user-decided and durable states", () => {
		expect(isUserDecidedProvenance("user-confirmed")).toBe(true);
		expect(isUserDecidedProvenance("user-cannot-confirm")).toBe(true);
		expect(isUserDecidedProvenance("resume-verified")).toBe(false);
		expect(isUserDecidedProvenance("derived-unverified")).toBe(false);
		expect(isDurableProvenance("user-cannot-confirm")).toBe(true);
		expect(isDurableProvenance("user-confirmed")).toBe(false);
	});

	it("only verified states may back a quantified claim (the read-side invariant)", () => {
		expect(canCiteAsQuantifiedClaim("resume-verified")).toBe(true);
		expect(canCiteAsQuantifiedClaim("user-confirmed")).toBe(true);
		expect(canCiteAsQuantifiedClaim("derived-unverified")).toBe(false);
		expect(canCiteAsQuantifiedClaim("user-cannot-confirm")).toBe(false);
	});

	it("allows only the derived-unverified -> resume-verified auto transition", () => {
		for (const state of PROVENANCE_STATES) expect(canAutoTransition(state, state)).toBe(true);
		expect(canAutoTransition("derived-unverified", "resume-verified")).toBe(true);
		expect(canAutoTransition("resume-verified", "derived-unverified")).toBe(false);
		expect(canAutoTransition("derived-unverified", "user-confirmed")).toBe(false);
		expect(canAutoTransition("derived-unverified", "user-cannot-confirm")).toBe(false);
		expect(canAutoTransition("user-cannot-confirm", "resume-verified")).toBe(false);
		expect(canAutoTransition("user-cannot-confirm", "derived-unverified")).toBe(false);
		expect(canAutoTransition("user-confirmed", "resume-verified")).toBe(false);
	});
});
