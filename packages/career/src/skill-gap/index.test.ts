import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import {
	classifySkillGaps,
	computeSkillGap,
	diagnoseExtraction,
	extractJdSkills,
	resumeSkillGapTexts,
	skillMentionedInText,
} from "./index";

// Test cases translated from career-ops' `jd-skill-gap.mjs --self-test` (MIT) — they encode
// years of real-posting regressions (bolded headings, CRLF, CJK, symbol-edge tokens…).

const fakeJd = `
# Senior Engineer — Fabrikam Inc.

## Requirements
- Python, FastAPI, PostgreSQL
- Experience with Kubernetes
- Strong communication skills
`;

const fakeCvTexts = {
	namedSkillsText: "Python, PostgreSQL, Docker",
	proseText: "Deployed services onto Kubernetes clusters and wrote FastAPI endpoints for internal tools.",
};

describe("extractJdSkills", () => {
	it("extracts skills from requirements bullets and filters stopwords", () => {
		const skills = extractJdSkills(fakeJd);
		expect(skills).toContain("Python");
		expect(skills).toContain("Kubernetes");
		expect(skills).not.toContain("Strong");
	});

	it("recognizes sentence-style and bare-uppercase requirement headers", () => {
		const headerVariants = [
			"YOU HAVE:",
			"You'll have:",
			"You Will Have:",
			"You Might Be a Good Fit If You:",
			"You Could Be a Good Fit If You:",
			"## It's Important To Us That You Have",
			"## It Would Be Great if You Had",
			"What we're looking for",
			"What you will bring",
			"Who you are",
			"About you",
			"You may be a good fit if",
		];
		for (const heading of headerVariants) {
			const jd = `# Role\n\n${heading}\n- Hands-on experience with React, TypeScript and AWS\n`;
			expect(extractJdSkills(jd), `header "${heading}"`).toContain("React");
		}
	});

	it("recognizes a bolded heading with no markdown hash (#4273 shape)", () => {
		const jd = `# Role\n\n**What We're Looking For**\n- Experience with Kubernetes\n\n**Benefits**\n- Competitive Equity\n`;
		const skills = extractJdSkills(jd);
		expect(skills).toContain("Kubernetes");
		expect(skills).not.toContain("Equity");
	});

	it("keeps an asterisk-bullet starting with a keyword as a bullet, not a heading", () => {
		const jd = "# Role\n\n## Requirements\n* Required: Python and Kubernetes\n";
		const skills = extractJdSkills(jd);
		expect(skills).toContain("Python");
		expect(skills).toContain("Kubernetes");
	});

	it('does not let a bare "YOU WILL" (responsibilities) open a requirements block', () => {
		const jd = "# Role\n\nYOU WILL\n- Ship Kubernetes manifests for the platform team\n";
		expect(extractJdSkills(jd)).not.toContain("Kubernetes");
	});

	it('closes an open requirements block on a bare "YOU WILL"', () => {
		const jd = [
			"# Role",
			"",
			"YOU HAVE:",
			"- Experience with Python",
			"",
			"YOU WILL",
			"- Ship Kubernetes manifests",
			"- Operate Terraform modules",
			"",
		].join("\n");
		const skills = extractJdSkills(jd);
		expect(skills).toContain("Python");
		expect(skills).not.toContain("Kubernetes");
		expect(skills).not.toContain("Terraform");
	});

	it('"You will have" still opens a block despite the YOU WILL exclusion', () => {
		expect(extractJdSkills("# Role\n\nYou Will Have:\n- Experience with Kubernetes\n")).toContain("Kubernetes");
	});

	it("recognizes h5/h6 headings for both opening and closing blocks", () => {
		const jd = [
			"##### Requirements",
			"- Experience with Python",
			"",
			"##### Benefits",
			"- Equity and a Carrot subscription",
			"",
			"###### About Us",
			"- We use Kubernetes internally for our own platform",
		].join("\n");
		const skills = extractJdSkills(jd);
		expect(skills).toContain("Python");
		expect(skills).not.toContain("Equity");
		expect(skills).not.toContain("Kubernetes");
	});

	it("does not report degree/experience boilerplate as skills", () => {
		const jd = `
# Role

## Requirements
- Bachelor's degree required
- Experience with cross-functional teams (5+ years)
- Communication skills and Ability to self-organize
`;
		const skills = extractJdSkills(jd);
		for (const noise of ["Bachelor", "Experience", "Communication", "Ability"]) {
			expect(skills).not.toContain(noise);
		}
	});

	it("extracts symbol-edge tokens (C#, C++, F#) and keeps sentence-ending tokens clean", () => {
		const jd = `
# Role

## Requirements
- C#, C++ or F# for backend services
- Familiarity with Docker.
`;
		const skills = extractJdSkills(jd);
		expect(skills).toContain("C#");
		expect(skills).toContain("C++");
		expect(skills).toContain("F#");
		expect(skills).toContain("Docker");
		expect(skills).not.toContain("Docker.");
	});

	it("closes the block on a plain-text (non-heading) benefits header", () => {
		const jd = `
# Role

## Requirements
- Experience with Kubernetes

Benefits and Perks (US Only)
- Competitive Equity and Healthcare
- Carrot fertility benefits
`;
		const skills = extractJdSkills(jd);
		expect(skills).toContain("Kubernetes");
		for (const perk of ["Equity", "Healthcare", "Carrot"]) expect(skills).not.toContain(perk);
	});

	it("filters disposition openers while keeping real skills on the same bullets", () => {
		const jd = `
# Role

## Requirements
- Deep fluency in TypeScript
- Interest in documentation as infrastructure
`;
		const skills = extractJdSkills(jd);
		expect(skills).toContain("TypeScript");
		expect(skills).not.toContain("Deep");
		expect(skills).not.toContain("Interest");
	});

	it("extracts the same skills from CRLF and LF texts (#2540)", () => {
		const jd = `
# Role

## Requirements
- Python, FastAPI, PostgreSQL
- Experience with Kubernetes
`;
		const lfSkills = extractJdSkills(jd);
		const crlfSkills = extractJdSkills(jd.replaceAll("\n", "\r\n"));
		expect(crlfSkills).toEqual(lfSkills);
		expect(crlfSkills.length).toBeGreaterThan(0);
	});

	it("recognizes Chinese requirement and closing headers (#3601)", () => {
		const jd = `
# PHP 後端工程師

## 應徵條件
- 熟悉 PHP、MySQL、Git
- 具 Linux 基本指令能力

## 工作內容
- 開發 RESTful API
- 維護既有 專案
`;
		const skills = extractJdSkills(jd);
		expect(skills).toContain("PHP");
		expect(skills).toContain("MySQL");
		expect(skills).toContain("Git");
		expect(skills).toContain("Linux");
		expect(skills).not.toContain("RESTful");
	});
});

describe("classifySkillGaps", () => {
	it("classifies named skills, prose support and real gaps", () => {
		const result = classifySkillGaps(["Python", "PostgreSQL", "Kubernetes", "FastAPI", "Rust"], fakeCvTexts);
		expect(result.existing).toContain("Python");
		expect(result.existing).toContain("PostgreSQL");
		expect(result.supportedByResume).toContain("Kubernetes");
		expect(result.supportedByResume).toContain("FastAPI");
		expect(result.gap).toContain("Rust");
	});

	it("resolves aliases: resume 'k8s' satisfies JD 'Kubernetes' (#1896)", () => {
		const texts = {
			namedSkillsText: "Python, k8s, Postgres",
			proseText: "Built data pipelines with golang microservices.",
		};
		const result = classifySkillGaps(["Kubernetes", "PostgreSQL", "Go", "Rust"], texts);
		expect(result.existing).toContain("Kubernetes");
		expect(result.existing).toContain("PostgreSQL");
		expect(result.supportedByResume).toContain("Go");
		expect(result.gap).toContain("Rust");
	});

	it("keeps word-boundary behavior for unknown/free tokens", () => {
		const texts = {
			namedSkillsText: "Python, Fabrikam-SDK",
			proseText: "Maintained the internal Fabrikam-SDK build.",
		};
		const result = classifySkillGaps(["Fabrikam-SDK", "Contoso-Cloud"], texts);
		expect(result.existing).toContain("Fabrikam-SDK");
		expect(result.gap).toContain("Contoso-Cloud");
	});

	it('never matches "Java" inside "JavaScript"', () => {
		expect(skillMentionedInText("Java", "Wrote JavaScript for the storefront")).toBe(false);
		expect(skillMentionedInText("Java", "Wrote Java for the backend")).toBe(true);
	});
});

describe("diagnoseExtraction", () => {
	it("is conclusive (null) when skills were classified", () => {
		expect(diagnoseExtraction(fakeJd, extractJdSkills(fakeJd))).toBeNull();
	});

	it("reports no-requirements-section when no header was recognized", () => {
		const unreadableJd = `
# Enablement Content Manager

## What you'll do
- Own the ADDIE and SAM design lifecycle for field-facing curriculum
- Build role-based learning paths, certifications and accreditation programs
`;
		expect(extractJdSkills(unreadableJd)).toHaveLength(0);
		expect(diagnoseExtraction(unreadableJd, [])?.reason).toBe("no-requirements-section");
	});

	it("reports no-skill-candidates when a scanned section yields nothing", () => {
		const parserEmptyJd = `
# Enablement Content Manager

## Requirements
- adult learning principles and instructional design
- blended and scenario-based learning
`;
		expect(extractJdSkills(parserEmptyJd)).toHaveLength(0);
		expect(diagnoseExtraction(parserEmptyJd, [])?.reason).toBe("no-skill-candidates");
	});

	it("reports a lowercase bullet of known skills as no-skill-candidates, not a vocabulary gap", () => {
		const lowercaseJd = `
# Role

## Requirements
- python and kubernetes experience
`;
		expect(extractJdSkills(lowercaseJd)).toHaveLength(0);
		const diagnosis = diagnoseExtraction(lowercaseJd, []);
		expect(diagnosis?.reason).toBe("no-skill-candidates");
		expect(/vocabulary/i.test(diagnosis?.message ?? "")).toBe(false);
	});

	it("reports an empty JD as empty-jd", () => {
		expect(diagnoseExtraction("   \n  \n", [])?.reason).toBe("empty-jd");
	});
});

describe("computeSkillGap over ResumeData", () => {
	function resumeWith(overrides: {
		skills?: { name: string; keywords?: string[] }[];
		experienceHtml?: string;
	}): typeof defaultResumeData {
		const data = structuredClone(defaultResumeData);
		if (overrides.skills) {
			data.sections.skills.items = overrides.skills.map((skill, index) => ({
				...data.sections.skills.items[0],
				id: `skill-${index}`,
				hidden: false,
				icon: "",
				iconColor: "",
				name: skill.name,
				proficiency: "",
				level: 0,
				keywords: skill.keywords ?? [],
			}));
		}
		if (overrides.experienceHtml) {
			data.sections.experience.items = [
				{
					id: "exp-1",
					hidden: false,
					company: "Fabrikam",
					position: "Engineer",
					location: "",
					period: "",
					website: { url: "", label: "", inlineLink: false },
					description: overrides.experienceHtml,
					roles: [],
				},
			];
		}
		return data;
	}

	it("classifies against a real ResumeData shape", () => {
		const resume = resumeWith({
			skills: [{ name: "Python", keywords: ["PostgreSQL"] }],
			experienceHtml: "<p>Deployed services onto Kubernetes clusters and wrote FastAPI endpoints.</p>",
		});
		const result = computeSkillGap({ jobDescription: fakeJd, resume });
		expect(result.existing).toContain("Python");
		expect(result.existing).toContain("PostgreSQL");
		expect(result.supportedByResume).toContain("Kubernetes");
		expect(result.supportedByResume).toContain("FastAPI");
		expect(result.lowConfidence).toBeNull();
	});

	it("reads skill keywords into the named-skills region", () => {
		const texts = resumeSkillGapTexts(resumeWith({ skills: [{ name: "Cloud", keywords: ["AWS", "Terraform"] }] }));
		expect(texts.namedSkillsText).toContain("AWS");
		expect(texts.namedSkillsText).toContain("Terraform");
	});

	it("surfaces the low-confidence diagnosis instead of a silent clean result", () => {
		const resume = resumeWith({ skills: [{ name: "Python" }] });
		const result = computeSkillGap({ jobDescription: "# Role\n\n## What you'll do\n- Ship things\n", resume });
		expect(result.existing).toHaveLength(0);
		expect(result.gap).toHaveLength(0);
		expect(result.lowConfidence?.reason).toBe("no-requirements-section");
	});
});
