import type { TailoringOperation } from "@reactive-resume/schema/career/data";
import { describe, expect, it } from "vitest";
import { applyResumePatches } from "@reactive-resume/resume/patch";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { compileTailoringPlan, sixSecondLint } from "./compile";

function baseData() {
	const data = structuredClone(defaultResumeData);
	data.sections.experience.items = [
		{
			id: "exp-1",
			hidden: false,
			company: "Fabrikam",
			position: "Engineer",
			location: "",
			period: "",
			website: { url: "", label: "", inlineLink: false },
			description: "<ul><li>Built data pipelines</li></ul>",
			roles: [],
		},
	];
	data.sections.projects.items = [
		{
			id: "p-1",
			hidden: false,
			name: "Alpha",
			period: "",
			website: { url: "", label: "", inlineLink: false },
			description: "<p>First</p>",
			keywords: [],
		},
		{
			id: "p-2",
			hidden: false,
			name: "Beta",
			period: "",
			website: { url: "", label: "", inlineLink: false },
			description: "<p>Second</p>",
			keywords: [],
		},
	] as never;
	data.sections.skills.items = [
		{
			id: "s-1",
			hidden: false,
			icon: "",
			iconColor: "",
			name: "Python",
			proficiency: "",
			level: 0,
			keywords: [],
		},
	] as never;
	return data;
}

describe("compileTailoringPlan", () => {
	it("compiles allowed set/move/hide operations to JSON Patch and applies cleanly", () => {
		const data = baseData();
		const plan: TailoringOperation[] = [
			{ kind: "set", path: "/summary/content", value: "<p>Targeted summary</p>", rationale: "r" },
			{
				kind: "set",
				path: "/sections/experience/items/0/description",
				value: "<ul><li>Reordered bullet</li></ul>",
				rationale: "r",
			},
			{ kind: "move", arrayPath: "/sections/projects/items", from: 1, to: 0, rationale: "r" },
			{ kind: "hide", path: "/sections/projects/items/1", rationale: "r" },
		];
		const compiled = compileTailoringPlan(data, plan, []);
		expect(compiled.dropped).toHaveLength(0);
		const result = applyResumePatches(structuredClone(data), compiled.operations);
		expect(result.summary.content).toBe("<p>Targeted summary</p>");
		expect(result.sections.projects.items[0]?.name).toBe("Beta");
		expect(result.sections.projects.items[1]?.hidden).toBe(true);
	});

	it("drops set operations outside the prose allowlist (facts are not tailorable)", () => {
		const data = baseData();
		const plan: TailoringOperation[] = [
			{ kind: "set", path: "/sections/experience/items/0/company", value: "Google", rationale: "r" },
			{ kind: "set", path: "/basics/name", value: "Someone Else", rationale: "r" },
			{ kind: "set", path: "/sections/experience/items/0/period", value: "2010-2030", rationale: "r" },
		];
		const compiled = compileTailoringPlan(data, plan, []);
		expect(compiled.operations).toHaveLength(0);
		expect(compiled.dropped).toHaveLength(3);
	});

	it("rejects add-skill for anything outside existing∪supported — a gap skill can never be added", () => {
		const data = baseData();
		const plan: TailoringOperation[] = [
			{ kind: "add-skill", name: "Rust", keywords: [], rationale: "r" },
			{ kind: "add-skill", name: "Kubernetes", keywords: ["Helm"], rationale: "r" },
		];
		const compiled = compileTailoringPlan(data, plan, ["Kubernetes"]);
		expect(compiled.dropped).toHaveLength(1);
		expect(compiled.dropped[0]?.operation).toMatchObject({ name: "Rust" });
		const result = applyResumePatches(structuredClone(data), compiled.operations);
		expect(result.sections.skills.items.map((item) => item.name)).toContain("Kubernetes");
	});

	it("matches allowed skills through the alias table (k8s allows Kubernetes)", () => {
		const data = baseData();
		const plan: TailoringOperation[] = [{ kind: "add-skill", name: "Kubernetes", keywords: [], rationale: "r" }];
		const compiled = compileTailoringPlan(data, plan, ["k8s"]);
		expect(compiled.dropped).toHaveLength(0);
	});

	it("drops a duplicate add-skill and out-of-range moves", () => {
		const data = baseData();
		const plan: TailoringOperation[] = [
			{ kind: "add-skill", name: "Python", keywords: [], rationale: "r" },
			{ kind: "move", arrayPath: "/sections/projects/items", from: 5, to: 0, rationale: "r" },
		];
		const compiled = compileTailoringPlan(data, plan, ["Python"]);
		expect(compiled.operations).toHaveLength(0);
		expect(compiled.dropped).toHaveLength(2);
	});
});

describe("sixSecondLint", () => {
	it("warns on an empty summary", () => {
		const data = baseData();
		data.summary.content = "";
		const warnings = sixSecondLint(data, null);
		expect(warnings.some((warning) => warning.change.includes("summary is empty"))).toBe(true);
	});

	it("warns when the top third ignores every critical requirement", () => {
		const data = baseData();
		data.summary.content = "<p>Generalist engineer.</p>";
		const warnings = sixSecondLint(data, [
			{
				requirement: "Kubernetes platform operations",
				importance: "critical",
				evidenceTier: "stated",
				jdSignal: "must have Kubernetes",
				match: "missing",
				evidence: null,
			},
		]);
		expect(warnings.some((warning) => warning.change.includes("top third"))).toBe(true);
	});

	it("stays quiet when the top third addresses a critical requirement", () => {
		const data = baseData();
		data.summary.content = "<p>Kubernetes platform engineer shipping reliable infrastructure.</p>";
		const warnings = sixSecondLint(data, [
			{
				requirement: "Kubernetes platform operations",
				importance: "critical",
				evidenceTier: "stated",
				jdSignal: "must have Kubernetes",
				match: "strong",
				evidence: null,
			},
		]);
		expect(warnings.some((warning) => warning.change.includes("top third"))).toBe(false);
	});
});
