import type { EvaluationRequirement } from "./index";
import { describe, expect, it } from "vitest";
import {
	applyRowBudget,
	eligibleForHardStop,
	mergeRequirementPasses,
	REQUIREMENT_ROW_BUDGET,
	rowsRequiringMitigation,
	sortRequirements,
} from "./index";

function row(overrides: Partial<EvaluationRequirement>): EvaluationRequirement {
	return {
		requirement: "Requirement",
		importance: "meaningful",
		evidenceTier: "structural",
		jdSignal: "under Requirements",
		match: null,
		evidence: null,
		...overrides,
	};
}

describe("mergeRequirementPasses", () => {
	it("keeps pass-1 importance regardless of what pass 2 says", () => {
		const passOne = [
			row({ requirement: "Python", importance: "critical", evidenceTier: "stated", jdSignal: "must have Python" }),
		];
		const merged = mergeRequirementPasses(passOne, [{ match: "strong", evidence: "Python at Fabrikam" }]);
		expect(merged[0]?.importance).toBe("critical");
		expect(merged[0]?.match).toBe("strong");
		expect(merged[0]?.evidence).toBe("Python at Fabrikam");
	});

	it("clamps inferred rows below critical/high", () => {
		const merged = mergeRequirementPasses(
			[
				row({ importance: "critical", evidenceTier: "inferred", jdSignal: null }),
				row({ importance: "high", evidenceTier: "inferred", jdSignal: null }),
				row({ importance: "high", evidenceTier: "structural" }),
			],
			[],
		);
		expect(merged[0]?.importance).toBe("meaningful");
		expect(merged[1]?.importance).toBe("meaningful");
		expect(merged[2]?.importance).toBe("high");
	});

	it("demotes a stated row with no verbatim quote to structural", () => {
		const merged = mergeRequirementPasses([row({ evidenceTier: "stated", jdSignal: null })], []);
		expect(merged[0]?.evidenceTier).toBe("structural");
		const blank = mergeRequirementPasses([row({ evidenceTier: "stated", jdSignal: "  " })], []);
		expect(blank[0]?.evidenceTier).toBe("structural");
	});

	it("nulls the jdSignal on inferred rows", () => {
		const merged = mergeRequirementPasses([row({ evidenceTier: "inferred", jdSignal: "should not be here" })], []);
		expect(merged[0]?.jdSignal).toBeNull();
	});

	it("leaves match null when pass 2 has no row", () => {
		const merged = mergeRequirementPasses([row({}), row({})], [{ match: "missing", evidence: "no trace" }]);
		expect(merged[0]?.match).toBe("missing");
		expect(merged[1]?.match).toBeNull();
	});
});

describe("sortRequirements", () => {
	it("sorts importance descending, unmet before met within a band", () => {
		const rows = [
			row({ requirement: "met-critical", importance: "critical", match: "strong" }),
			row({ requirement: "missing-high", importance: "high", match: "missing" }),
			row({ requirement: "missing-critical", importance: "critical", match: "missing" }),
			row({ requirement: "partial-critical", importance: "critical", match: "partial" }),
			row({ requirement: "na-critical", importance: "critical", match: "na" }),
			row({ requirement: "met-preferred", importance: "preferred", match: "strong" }),
		];
		expect(sortRequirements(rows).map((entry) => entry.requirement)).toEqual([
			"missing-critical",
			"partial-critical",
			"met-critical",
			"na-critical",
			"missing-high",
			"met-preferred",
		]);
	});
});

describe("applyRowBudget", () => {
	it("keeps every critical/high row even beyond the budget", () => {
		const rows = Array.from({ length: 15 }, (_, index) =>
			row({ requirement: `critical-${index}`, importance: index < 14 ? "critical" : "preferred" }),
		);
		const result = applyRowBudget(rows);
		expect(result.rows).toHaveLength(14);
		expect(result.dropped).toBe(1);
		expect(result.rows.every((entry) => entry.importance === "critical")).toBe(true);
	});

	it("trims only meaningful-and-below to fit the budget", () => {
		const rows = sortRequirements([
			...Array.from({ length: 4 }, (_, index) => row({ requirement: `crit-${index}`, importance: "critical" })),
			...Array.from({ length: 12 }, (_, index) => row({ requirement: `pref-${index}`, importance: "preferred" })),
		]);
		const result = applyRowBudget(rows);
		expect(result.rows).toHaveLength(REQUIREMENT_ROW_BUDGET);
		expect(result.dropped).toBe(4);
		expect(result.rows.filter((entry) => entry.importance === "critical")).toHaveLength(4);
	});

	it("returns everything when under budget", () => {
		const rows = [row({}), row({})];
		expect(applyRowBudget(rows)).toEqual({ rows, dropped: 0 });
	});
});

describe("hard-stop and mitigation gates", () => {
	it("an inferred row is never eligible for hard stops", () => {
		expect(eligibleForHardStop(row({ evidenceTier: "inferred" }))).toBe(false);
		expect(eligibleForHardStop(row({ evidenceTier: "stated" }))).toBe(true);
		expect(eligibleForHardStop(row({ evidenceTier: "structural" }))).toBe(true);
	});

	it("mitigations are required exactly for missing/partial at critical/high", () => {
		const rows = [
			row({ requirement: "a", importance: "critical", match: "missing" }),
			row({ requirement: "b", importance: "high", match: "partial" }),
			row({ requirement: "c", importance: "critical", match: "strong" }),
			row({ requirement: "d", importance: "meaningful", match: "missing" }),
			row({ requirement: "e", importance: "high", match: "na" }),
		];
		expect(rowsRequiringMitigation(rows).map((entry) => entry.requirement)).toEqual(["a", "b"]);
	});
});
