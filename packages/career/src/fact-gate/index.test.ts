import type { FactGateAllowlist, FactGateReport } from "./index";
import { describe, expect, it } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import {
	auditClaims,
	delegatedAuthorshipClaims,
	diagnoseCoverage,
	factClaims,
	metricClaims,
	normalizeClaim,
	resumeDataToFactTexts,
	stripMarkup,
	verifyFacts,
} from "./index";

// Test cases translated from career-ops' `verify-cv-facts.mjs --self-test` and its suite
// (nonmetric-fact-gate, metric-claim-disclosure, fact-gate-language-coverage,
// verify-cv-facts-bold-metrics; MIT) — they encode years of real regressions, and the issue
// numbers are kept so the cases stay traceable to their bugs.

const run = (candidate: string, sourceText: string, allow?: FactGateAllowlist): FactGateReport =>
	verifyFacts({
		candidate,
		sources: [{ label: "source resume", text: sourceText }],
		...(allow ? { allow } : {}),
	});

const bare = (candidate: string): FactGateReport => verifyFacts({ candidate, sources: [] });

const inventedOf = (report: FactGateReport): string[] =>
	report.violations.filter((violation) => violation.kind === "metric").map((violation) => violation.claim);

const factsOf = (report: FactGateReport) =>
	report.violations.filter((violation) => violation.kind !== "metric" && violation.kind !== "forbidden-phrase");

const claimsOf = (text: string): string => [...metricClaims(text)].sort().join(" | ");

const kinds = (text: string): string[] => factClaims(text).map((claim) => `${claim.kind}:${claim.value}`);

describe("metric extraction (self-test port)", () => {
	const source = [
		"Reached 16,181 active users and 289,760 enrollments across 80 courses.",
		"Cut infrastructure cost 60%. Managed a $550K budget.",
		"Certified partners earned 2x more. Authored 80+ open-access technical guides.",
	].join(" ");

	it("passes a truthful modifier restatement", () => {
		expect(auditClaims("Reached 16,181 users", source).invented).toEqual([]);
	});

	it("catches an inflated modifier count", () => {
		expect(auditClaims("Reached 94,772 active users", source).invented).toEqual(["94772 users"]);
	});

	it("catches an invented count on a training noun", () => {
		expect(auditClaims("Drove 900,000 enrollments", source).invented).toEqual(["900000 enrollments"]);
	});

	it("passes truthful currency and catches inflated currency", () => {
		expect(auditClaims("Managed a $550K budget", source).invented).toEqual([]);
		expect(auditClaims("Managed a $900K budget", source).invented).toEqual(["$900k"]);
	});

	it("passes a truthful multiplier", () => {
		expect(auditClaims("Partners earned 2x more", source).invented).toEqual([]);
	});

	it("folds noun synonyms (articles → guides)", () => {
		expect(auditClaims("Authored 80 articles", source).invented).toEqual([]);
	});

	it("ignores an ordinary year", () => {
		expect(auditClaims("Joined the team in 2013", source).invented).toEqual([]);
	});

	// #3414 — the number binds to the NEAREST noun in the window, not the farthest. Greedy,
	// a truthful line copied verbatim out of the source read as a different claim from it.
	it("binds the number to the nearest noun", () => {
		expect(claimsOf("15+ years scaling teams and platforms")).toBe("15 years");
		expect(claimsOf("20+ years leading engineering organizations")).toBe("20 years");
		expect(claimsOf("I have 15+ years of experience.")).toBe("15 years");
	});

	it("does not invent a claim from a verbatim experience line", () => {
		expect(auditClaims("15+ years scaling teams and platforms", "15+ years of experience.").invented).toEqual([]);
	});

	// #2279 — the window is wide for a reason: one noun, several modifiers. Lazy must not
	// shrink the reach, only decide which noun wins when there are two.
	it("still resolves a 3-modifier single-noun phrase", () => {
		expect(claimsOf("~5 live Cloud Run deployments")).toBe("5 deployments");
		expect(claimsOf("~5 Cloud Run deployments")).toBe("5 deployments");
	});

	it("keeps two counts in one sentence distinct (a number is a hard barrier)", () => {
		expect(claimsOf("8 years supporting 40 engineers")).toBe("40 engineers | 8 years");
	});
});

describe("plan horizons are not claims (#3655/#3656)", () => {
	it("does not extract a proposed plan horizon", () => {
		expect(claimsOf("I'd welcome the chance to talk through how I'd approach the first 90 days.")).toBe("");
		expect(claimsOf("I would welcome a conversation about the first 90 days.")).toBe("");
		expect(auditClaims("I'd approach the first 90 days by listening.", "No numbers here.").invented).toEqual([]);
	});

	it("requires both halves — each alone would silence a real claim", () => {
		expect(claimsOf("Revenue grew in the first 12 months.")).toBe("12 months");
		expect(claimsOf("I would bring 20 years of experience.")).toBe("20 years");
		expect(claimsOf("Cut deployment time to 2 days.")).toBe("2 days");
	});

	it("does not let a marker in a neighbouring sentence reach", () => {
		expect(claimsOf("I would be glad to help. Revenue grew in the first 12 months.")).toBe("12 months");
	});

	it("is scoped to time units — a count of anything else is still a count", () => {
		expect(claimsOf("I'd start with the first 3 teams.")).toBe("3 teams");
	});

	it("accepts non-first-person forward markers", () => {
		expect(claimsOf("My first 90 days would centre on the pipeline.")).toBe("");
		expect(claimsOf("How would you approach the first 90 days?")).toBe("");
		expect(claimsOf("Glad to talk through how the first 90 days should go.")).toBe("");
	});

	it("does not treat an ability modal as a forward marker", () => {
		expect(claimsOf("Revenue could be traced to the first 12 months.")).toBe("12 months");
	});

	it("keeps the marker clause-scoped so a fabricated past number cannot hide", () => {
		expect(claimsOf("Revenue grew in the first 99 months, and I would be glad to repeat it.")).toBe("99 months");
		expect(claimsOf("I would be glad to help\nRevenue grew in the first 99 months")).toBe("99 months");
	});

	it("reads 'd as had before a past participle", () => {
		expect(claimsOf("I'd completed the migration in the first 12 months.")).toBe("12 months");
		expect(claimsOf("I'd approach the first 90 days.")).toBe("");
	});

	it("does not split a clause inside a decimal", () => {
		expect(claimsOf("My first 1.5 years would focus on the pipeline.")).toBe("");
	});

	it("does not raise a coverage warning over plan horizons", () => {
		const report = bare("I'd approach the first 90 days by listening, and the first 30 days by shipping.");
		expect(report.passed).toBe(true);
		expect(report.warnings).toEqual([]);
	});
});

describe("allowlist semantics", () => {
	const source = "Reached 16,181 active users. Authored 80+ open-access technical guides.";

	it("honours an allowMetrics override", () => {
		expect(auditClaims("Reached 94,772 users", source, { allowMetrics: ["94,772 users"] }).invented).toEqual([]);
	});

	// #2175 — an exception written in the spelling a human reaches for ("77 repos") must
	// match the canonical claim the extractor produces; a silently inert exception is the
	// same failure class this gate exists to catch.
	it("honours a synonym-spelled exception and the canonical spelling", () => {
		expect(auditClaims("Maintained 77 repositories", source, { allowMetrics: ["77 repos"] }).invented).toEqual([]);
		expect(auditClaims("Maintained 77 repositories", source, { allowMetrics: ["77 repositories"] }).invented).toEqual(
			[],
		);
	});

	it("does not let the folding swallow a currency exception", () => {
		expect(auditClaims("Managed a $900K budget", source, { allowMetrics: ["$900K"] }).invented).toEqual([]);
	});

	it("leaves an unrelated exception ineffective", () => {
		expect(auditClaims("Maintained 77 repositories", source, { allowMetrics: ["12 repos"] }).invented).toEqual([
			"77 repositories",
		]);
	});

	it("blocks a forbidden phrase", () => {
		expect(
			auditClaims("A proven track record", source, { forbiddenPhrases: ["proven track record"] }).forbidden,
		).toEqual(["proven track record"]);
		const report = run("A proven track record of delivery.", source, { forbiddenPhrases: ["proven track record"] });
		expect(report.passed).toBe(false);
		expect(report.violations).toContainEqual(
			expect.objectContaining({ kind: "forbidden-phrase", claim: "proven track record" }),
		);
	});

	it("flags a warn phrase without blocking", () => {
		const report = run("This maybe helped.", source, { warnPhrases: ["maybe"] });
		expect(report.passed).toBe(true);
		expect(report.warnings).toContainEqual(expect.objectContaining({ kind: "warn-phrase", claim: "maybe" }));
	});

	it("accepts a fact through allowFacts", () => {
		const blocked = run("I worked at Invented Labs as an engineer.", source);
		expect(blocked.violations).toContainEqual(expect.objectContaining({ kind: "employer", claim: "invented labs" }));
		const allowed = run("I worked at Invented Labs as an engineer.", source, { allowFacts: ["Invented Labs"] });
		expect(allowed.violations.filter((violation) => violation.kind === "employer")).toEqual([]);
	});
});

describe("non-software metric nouns", () => {
	// METRIC_NOUNS counted users, engineers and repos but not staff, facilities or sites, so
	// an operations/facilities CV yielded no claim at all for its headcount — the one number
	// such a CV is most likely to inflate.
	const opsSource = [
		"Managed 20 staff across shift coverage: 8 scientists and 12 support personnel.",
		"Built out four facilities and ran a research program across 45 hectares.",
		"Held temperature setpoints across 3 production rooms.",
	].join(" ");

	it("passes truthful headcounts and catches inflated ones", () => {
		expect(auditClaims("Managed 20 staff", opsSource).invented).toEqual([]);
		expect(auditClaims("Managed 45 staff", opsSource).invented).toEqual(["45 staff"]);
		expect(auditClaims("Led 30 scientists", opsSource).invented).toEqual(["30 scientists"]);
	});

	it("treats a headcount paraphrase as a paraphrase, not a fabrication", () => {
		expect(auditClaims("Managed 20 personnel", opsSource).invented).toEqual([]);
	});

	it("covers physical assets and scale", () => {
		expect(auditClaims("Built out 12 facilities", opsSource).invented).toEqual(["12 facilities"]);
		expect(auditClaims("Ran a program across 45 hectares", opsSource).invented).toEqual([]);
		expect(auditClaims("Ran a program across 450 hectares", opsSource).invented).toEqual(["450 hectares"]);
		expect(auditClaims("Setpoints across 3 rooms", opsSource).invented).toEqual([]);
		expect(auditClaims("Setpoints across 30 rooms", opsSource).invented).toEqual(["30 rooms"]);
	});
});

describe("digit folding and number grouping", () => {
	const foldSource = "Reached 16,181 active users across 80 courses. Cut cost 60%.";

	it("catches fabricated metrics written in non-ASCII digits", () => {
		expect(auditClaims("Reached ９４，７７２ users", foldSource).invented).toEqual(["94772 users"]);
		expect(auditClaims("Reached ٩٤٧٧٢ users", foldSource).invented).toEqual(["94772 users"]);
		expect(auditClaims("Reached ९४७७२ users", foldSource).invented).toEqual(["94772 users"]);
		expect(auditClaims("Cut cost ٩٩٪", foldSource).invented).toEqual(["99%"]);
	});

	it("does not turn a truthful localized CV red", () => {
		expect(auditClaims("Reached ١٦١٨١ users", foldSource).invented).toEqual([]);
		expect(auditClaims("Reached １６，１８１ users", foldSource).invented).toEqual([]);
	});

	it("compares thousands groupings as the same number", () => {
		expect(auditClaims("Reached 16 181 users", foldSource).invented).toEqual([]);
		expect(auditClaims("Reached 16181 users", foldSource).invented).toEqual([]);
		expect(auditClaims("Reached 94 772 users", foldSource).invented).toEqual(["94772 users"]);
	});

	it("folds multi-group numbers completely", () => {
		expect(auditClaims("Reached 1 234 567 users", "Reached 1234567 active users.").invented).toEqual([]);
		expect(auditClaims("Reached 12 345 678 users", "Reached 12345678 active users.").invented).toEqual([]);
	});

	it("treats period grouping and comma grouping as the same number, both directions", () => {
		expect(auditClaims("Reached 16.181 users", foldSource).invented).toEqual([]);
		expect(auditClaims("Reached 16,181 users", "Reached 16.181 active users.").invented).toEqual([]);
		expect(auditClaims("Reached 94.772 users", foldSource).invented).toEqual(["94772 users"]);
	});

	it("does not read a decimal as grouping", () => {
		expect(auditClaims("Cut build time to 2.5 hours", "Cut build time to 2.5 hours.").invented).toEqual([]);
		// Pinned directly: identical text on both sides above would stay green even if
		// normalization silently folded 2.5 into 25.
		expect(normalizeClaim("2.5 hours")).toBe("2.5 hours");
	});

	it("does not glue a year to the next number", () => {
		expect(auditClaims("Joined in 2026 100 users", foldSource).invented).toEqual(["100 users"]);
	});
});

describe("employer and title claims", () => {
	// The triggers used to be lowercase-only, so the phrasing a CV actually uses — a
	// capitalised bullet — produced NO claim, and a fabricated employer shipped unflagged.
	it("extracts employer + title from a capitalised CV bullet and the lowercase phrasing", () => {
		expect(kinds("- Worked at Initech as a Principal Engineer")).toEqual([
			"employer:initech",
			"title:principal engineer",
		]);
		expect(kinds("he worked at Initech as a Principal Engineer")).toEqual([
			"employer:initech",
			"title:principal engineer",
		]);
	});

	it("extracts capitalised Joined and Employer: labels", () => {
		expect(kinds("Joined Globex in 2024")).toEqual(["employer:globex"]);
		expect(kinds("Employer: Initech")).toEqual(["employer:initech"]);
	});

	it("keeps a lowercase connector inside the title", () => {
		// Truncating at "of" made "Head of Data" and "Head of Engineering" the same claim.
		expect(kinds("Served as Head of Data")).toEqual(["title:head of data"]);
		expect(kinds("Served as Head of Engineering")).toEqual(["title:head of engineering"]);
		expect(kinds("Served as Vice President of Sales")).toEqual(["title:vice president of sales"]);
		expect(kinds("Worked at Initech as Head of Data")).toEqual(["employer:initech", "title:head of data"]);
	});

	it("does not read ordinary prose as a claim (the capture stays case-sensitive)", () => {
		expect(kinds("Worked at the office as a manager")).toEqual([]);
		expect(kinds("joined the team as a contractor")).toEqual([]);
	});

	it("does not chain a title across a list-item boundary", () => {
		expect(kinds("<ul><li>Worked at Initech as a Principal Engineer</li><li>Built pipelines</li></ul>")).toEqual([
			"employer:initech",
			"title:principal engineer",
		]);
	});
});

describe("modifier windows and numeric barriers (#2279)", () => {
	const modifierSource = "Consolidated 25+ services down to ~5 live Cloud Run deployments.";

	it("never lets the modifier count decide whether a claim exists", () => {
		expect(auditClaims("25+ services consolidated to ~5 Cloud Run deployments", modifierSource).invented).toEqual([]);
		expect(auditClaims("Consolidated to ~5 live production Cloud Run deployments", modifierSource).invented).toEqual(
			[],
		);
	});

	it("catches a changed number behind any modifier count", () => {
		expect(auditClaims("Consolidated to ~9 live Cloud Run deployments", modifierSource).invented).toEqual([
			"9 deployments",
		]);
		expect(auditClaims("Consolidated to ~9 Cloud Run deployments", modifierSource).invented).toEqual(["9 deployments"]);
	});

	it("does not jump across an intervening figure to bind an unrelated noun", () => {
		expect(auditClaims("Ran 7 tests over 40 hours", "Ran 7 tests. Logged 40 hours.").invented).toEqual([]);
		expect(auditClaims("Shipped 3 integrations", "Shipped 3 features across 12 integrations").invented).toEqual([
			"3 integrations",
		]);
	});
});

describe("magnitude suffixes", () => {
	it("keeps the suffix with the number so a 1000x inflation cannot pass", () => {
		expect(auditClaims("Grew the product to 50k users", "Reached 50 users.").invented).toEqual(["50k users"]);
		expect(auditClaims("Grew to 50k users", "Reached 50k users.").invented).toEqual([]);
		expect(auditClaims("Drove 1.5M downloads", "Drove 50 downloads.").invented).toEqual(["1.5m downloads"]);
		expect(auditClaims("Reached 2B users", "Reached 1B users.").invented).toEqual(["2b users"]);
	});

	it("requires the suffix to end the token", () => {
		expect([...metricClaims("Reached 50 million users")]).toEqual(["50 users"]);
		expect([...metricClaims("Shipped 50kg servers")]).toEqual(["50 servers"]);
	});
});

describe("bolded metrics are not invisible (#4085)", () => {
	it.each([
		["double-star bold count", "Layer A **2,044** tests", "2044 tests"],
		["double-star bold count, no comma", "**194** automated tests", "194 tests"],
		["double-star bold headcount", "Managed **35** people", "35 people"],
		["double-underscore bold count", "__2,842__ commits", "2842 commits"],
		["single-asterisk italic count", "Managed *35* people", "35 people"],
	])("extracts a bolded metric: %s", (_label, text, expected) => {
		expect(metricClaims(text).has(expected)).toBe(true);
	});

	it("removes emphasis markers while keeping the wrapped text", () => {
		const stripped = stripMarkup("Layer A **2,044** tests and __194__ commits");
		expect(stripped).not.toContain("*");
		expect(stripped).not.toContain("_");
		expect(stripped).toContain("2,044");
		expect(stripped).toContain("194");
	});

	it("leaves a lone footnote asterisk alone", () => {
		expect(metricClaims("Cut latency by 40%* see appendix").has("40%")).toBe(true);
		expect(stripMarkup("shipped 2* tests 3* commits")).toBe("shipped 2* tests 3* commits");
	});

	it("strips doubled underscores but never single-underscore identifiers", () => {
		expect(stripMarkup("shipped __738__ commits to env_keys.json")).toBe("shipped 738 commits to env_keys.json");
	});

	it("removes bold markers that wrap a line break", () => {
		const multiline = stripMarkup("**2,044\nverified** tests", { keepLineBreaks: true });
		expect(multiline).not.toContain("*");
		expect(multiline).toContain("2,044");
		expect(multiline).toContain("verified");
	});

	it("does not let a LaTeX star-variant command collide with a later italic span", () => {
		expect(stripMarkup(String.raw`\section*{Foo}and*emphasis*done`)).toBe("Foo and emphasis done");
	});
});

describe("non-metric fact gate", () => {
	const source =
		"Senior Platform Engineer at Acme Labs. Built using React and Docker. Cut spend to $120k and closed a €90,000 deal.";

	it("extracts employer, title, and tool claims", () => {
		const claims = factClaims("I worked at Acme Labs as a Senior Platform Engineer, using React and Docker.");
		expect(claims).toContainEqual({ kind: "employer", value: "acme labs" });
		expect(claims).toContainEqual({ kind: "title", value: "senior platform engineer" });
		expect(claims).toContainEqual({ kind: "tool", value: "react" });
	});

	it("passes source-backed non-metric facts and currency metrics", () => {
		const supported = run("I worked at Acme Labs as a Senior Platform Engineer, using React and Docker.", source);
		expect(supported.passed).toBe(true);
		expect(factsOf(supported)).toEqual([]);
		expect(run("Cut spend to $120k and closed a €90,000 deal.", source).passed).toBe(true);
	});

	it("blocks unsupported currency metrics", () => {
		const report = run("Generated $5M and saved £2.5M.", source);
		expect(report.passed).toBe(false);
		expect(inventedOf(report)).toContain("$5m");
		expect(inventedOf(report)).toContain("£2.5m");
	});

	it("blocks unsupported employer, title, and tool claims", () => {
		const report = run(
			"I worked at Invented Labs as a Principal Platform Engineer, using React and Terraform.",
			source,
		);
		expect(report.passed).toBe(false);
		expect(factsOf(report).map((violation) => violation.claim)).toEqual(
			expect.arrayContaining(["invented labs", "principal platform engineer", "terraform"]),
		);
	});

	it("fails closed on explicit lowercase tool claims without a whitelist entry", () => {
		const report = run("built using react with kubernetes and google cloud.", source);
		expect(report.passed).toBe(false);
		expect(factsOf(report).map((violation) => violation.claim)).toEqual(
			expect.arrayContaining(["kubernetes", "google cloud"]),
		);
	});

	it("stops tool claims before trailing prepositional prose", () => {
		const claims = factClaims("I built this using React and Docker for containerized deployments.");
		expect(claims).toContainEqual({ kind: "tool", value: "react" });
		expect(claims).toContainEqual({ kind: "tool", value: "docker" });
		expect(claims.some((claim) => claim.value.includes("containerized deployments"))).toBe(false);
	});

	it("splits tool claims across with/in connectors", () => {
		const claims = factClaims("I built this using React with Redux in Dify.");
		for (const value of ["react", "redux", "dify"]) {
			expect(claims).toContainEqual({ kind: "tool", value });
		}
	});

	it("filters ordinary prose around technology names", () => {
		expect(factClaims("I worked with the team in London.")).toEqual([]);
		expect(factClaims("I built using React in production.")).toContainEqual({ kind: "tool", value: "react" });
	});

	it("does not treat ordinary 'as' prose as a title claim", () => {
		expect(factClaims("The company was recognized as a Top Employer.").some((claim) => claim.kind === "title")).toBe(
			false,
		);
	});

	// #3907 — "role: I" satisfied the old first-token class and ordinary prose was misread
	// as a one-letter job title, blocking a render that asserted nothing false.
	it('#3907: "role: I" and "role: A" are not one-letter title claims', () => {
		expect(
			factClaims(
				"I want to be direct about something important to this role: I do not have functional knowledge in X.",
			).some((claim) => claim.kind === "title"),
		).toBe(false);
		expect(
			factClaims("Please review the role: A candidate should have strong communication skills.").some(
				(claim) => claim.kind === "title",
			),
		).toBe(false);
	});

	it("#3907: still flags fabricated acronym and real titles", () => {
		const acronym = run("Title: VP of Sales, previously unrelated experience.", source);
		expect(acronym.passed).toBe(false);
		expect(acronym.violations).toContainEqual(expect.objectContaining({ kind: "title", claim: "vp of sales" }));
		const real = run("Title: Principal Engineer, previously unrelated experience.", source);
		expect(real.passed).toBe(false);
		expect(real.violations).toContainEqual(expect.objectContaining({ kind: "title", claim: "principal engineer" }));
	});

	it("does not accept embedded substrings as fact matches", () => {
		// "Go" must not match inside "Google" — whole tokens only.
		const report = run("I am using Go and Google Cloud.", source);
		expect(report.violations).toContainEqual(expect.objectContaining({ kind: "tool", claim: "go" }));
	});

	// #3639 — gerund/abstract-noun prose after a trigger word was extracted as a tool claim.
	it.each([
		["gerund alone", "Built this using diagnosing and resolving workflow friction."],
		["gerund + abstract-noun-suffix phrase", "Built this using recurring HR and operations tasks."],
		["bare abstract noun", "Built this using efficiency."],
		["stoplisted noun + abstract-noun-suffix phrase", "Built this using feedback and improve delivery."],
		["three-word gerund-led phrase", "Built this using improving on-time submission."],
	])("#3639 prose false positive stays fixed: %s", (_label, text) => {
		expect(factClaims(text).filter((claim) => claim.kind === "tool")).toEqual([]);
	});

	it("keeps prose-suffixed real technologies fail-closed (spring, unity, processing)", () => {
		for (const tool of ["spring", "unity", "processing"]) {
			expect(factClaims(`Built this using ${tool}.`)).toContainEqual({ kind: "tool", value: tool });
			const report = run(`Built this using ${tool}.`, source);
			expect(report.passed).toBe(false);
			expect(report.violations).toContainEqual(expect.objectContaining({ kind: "tool", claim: tool }));
		}
	});

	it("lets source evidence override an exact prose-word collision", () => {
		expect(run("Built the workflow using delivery.", "Built the workflow using delivery.").passed).toBe(true);
	});

	it("#3639 fix does not open a lowercase-evasion bypass", () => {
		const report = run("Shipped it using kubernetes and google cloud.", "Built the workflow using delivery.");
		expect(report.passed).toBe(false);
		expect(factsOf(report).map((violation) => violation.claim)).toEqual(
			expect.arrayContaining(["kubernetes", "google cloud"]),
		);
	});

	it("still blocks a fabricated Title-Cased tool with no source backing", () => {
		const report = run("Shipped it using Kubernetes and Terraform.", "Built the workflow using delivery.");
		expect(report.passed).toBe(false);
		expect(factsOf(report).map((violation) => violation.claim)).toEqual(
			expect.arrayContaining(["kubernetes", "terraform"]),
		);
	});

	it("does not penalize a source-backed lowercase tool name for casing", () => {
		const backed =
			"Senior Platform Engineer at Acme Labs. Built using React and Docker on kubernetes with n8n. Cut spend to $120k and closed a €90,000 deal.";
		expect(run("Deployed the service using kubernetes and n8n.", backed).passed).toBe(true);
	});

	// #4004 — a tailoring run that rewords a "using" sentence out of the source's own
	// vocabulary must not block a document that asserts nothing false.
	describe("#4004 source-vocabulary rewording", () => {
		const salesSource = [
			"Regional Sales Manager at Northwind Supply.",
			"Reported on campaign performance and on coverage of the pipeline every week.",
			"Advised clients on solutions for print and digital channels.",
			"Grew the account through a consultative approach to selling.",
		].join("\n");

		it.each([
			["a reworded source phrase", "Reported weekly using campaign performance and pipeline coverage."],
			["a noun phrase reassembled from the source", "Advised clients using digital solutions."],
			["a gerund phrase from the source", "Grew the account using consultative selling."],
		])("prose built from the source's own words is not a tool claim: %s", (_label, candidate) => {
			const report = run(candidate, salesSource);
			expect(report.passed).toBe(true);
			expect(report.violations.filter((violation) => violation.kind === "tool")).toEqual([]);
		});

		it("still blocks a lowercase name absent from the source", () => {
			const report = run("Reported weekly using kubernetes.", salesSource);
			expect(report.passed).toBe(false);
			expect(report.violations).toContainEqual(expect.objectContaining({ kind: "tool", claim: "kubernetes" }));
		});

		it.each([
			["a demonstrative", "Rebuilt the funnel using that campaign."],
			["a possessive", "Ran the quarterly review using our playbook."],
		])("a determiner-led fragment is not a tool claim: %s", (_label, text) => {
			expect(factClaims(text).filter((claim) => claim.kind === "tool")).toEqual([]);
		});

		it("a determiner in one fragment does not discard its siblings", () => {
			const mixed = factClaims("Built with React and our playbook.").filter((claim) => claim.kind === "tool");
			expect(mixed).toContainEqual({ kind: "tool", value: "react" });
			expect(mixed.some((claim) => claim.value.includes("playbook"))).toBe(false);
			expect(
				factClaims("Shipped it using kubernetes and our stack.").filter((claim) => claim.kind === "tool"),
			).toContainEqual({ kind: "tool", value: "kubernetes" });
		});

		it("a determiner standing alone is not a tool claim", () => {
			expect(factClaims("Built this using that for the migration.").filter((claim) => claim.kind === "tool")).toEqual(
				[],
			);
		});

		it("a declared list keeps its siblings past a determiner and stays extracted", () => {
			const declared = factClaims("Technologies: our playbook and React").filter((claim) => claim.kind === "tool");
			expect(declared).toContainEqual({ kind: "tool", value: "react" });
			expect(declared.some((claim) => claim.value.includes("playbook"))).toBe(false);
			expect(
				factClaims("Tech stack: our stack and kubernetes").filter((claim) => claim.kind === "tool"),
			).toContainEqual({ kind: "tool", value: "kubernetes" });
			const list = factClaims("Technologies: React, Postgres");
			expect(list).toContainEqual({ kind: "tool", value: "react" });
			expect(list).toContainEqual({ kind: "tool", value: "postgres" });
			const builtWith = factClaims("Built with Django and Redis.");
			expect(builtWith).toContainEqual({ kind: "tool", value: "django" });
			expect(builtWith).toContainEqual({ kind: "tool", value: "redis" });
		});
	});
});

describe("delegated authorship", () => {
	const delegatedSource = [
		"Sourced and directed vendor Acme Interactive through the WebGL build of an in-store kiosk.",
		"Built the internal deployment pipeline using Node.js.",
	].join("\n");

	it("blocks third-party implementation rewritten as direct authorship", () => {
		const escalatedText = "Designed the interaction model and wrote the WebGL implementation for an in-store kiosk.";
		const claims = delegatedAuthorshipClaims(escalatedText, delegatedSource);
		expect(
			claims.some((claim) => claim.kind === "authorship" && claim.value.includes("wrote webgl implementation")),
		).toBe(true);
		const report = run(escalatedText, delegatedSource);
		expect(report.passed).toBe(false);
		expect(report.violations.some((violation) => violation.kind === "delegated-authorship")).toBe(true);
	});

	it("treats a vendor/contractor relative clause as delegated execution", () => {
		const relativeClauseSource = [
			"Managed vendor Acme Interactive, which built the WebGL implementation for an in-store kiosk.",
			"Oversaw contractors who developed the onboarding automation in Node.js.",
		].join("\n");
		for (const target of [
			"Wrote the WebGL implementation for an in-store kiosk.",
			"Developed the onboarding automation in Node.js.",
		]) {
			expect(delegatedAuthorshipClaims(target, relativeClauseSource).some((claim) => claim.kind === "authorship")).toBe(
				true,
			);
			expect(run(target, relativeClauseSource).passed).toBe(false);
		}
	});

	it("passes a rewrite that keeps third-party attribution", () => {
		const report = run(
			"Directed vendor Acme Interactive through the WebGL build of an in-store kiosk.",
			delegatedSource,
		);
		expect(report.passed).toBe(true);
		expect(report.violations.some((violation) => violation.kind === "delegated-authorship")).toBe(false);
	});

	it("does not match unrelated source-backed direct work to delegated work", () => {
		const report = run("Built the internal deployment pipeline using Node.js.", delegatedSource);
		expect(report.passed).toBe(true);
	});

	it("fails open on mixed direct and delegated source statements", () => {
		const ambiguousSource =
			"Directed vendor Acme Interactive through the WebGL build and wrote the kiosk integration layer.";
		expect(delegatedAuthorshipClaims("Wrote the kiosk integration layer.", ambiguousSource)).toEqual([]);
	});

	it("lets separate direct-work evidence win over overlapping delegated work", () => {
		const separateDirectEvidence = [
			"Directed vendor Acme Interactive through the WebGL build of an in-store kiosk.",
			"Wrote the WebGL implementation for an in-store kiosk prototype.",
		].join("\n");
		expect(
			delegatedAuthorshipClaims(
				"Wrote the WebGL implementation for an in-store kiosk prototype.",
				separateDirectEvidence,
			),
		).toEqual([]);
	});
});

describe("disclosed posting requirements (#3915/#3917)", () => {
	// A sentence that CITES a posting's numeric requirement to disclaim a gap against it is
	// not the candidate personally claiming that number.
	it.each([
		[
			"issue example: negation lead + trailing requirement citation",
			"I want to be direct: my background is at the individual-contributor level, without the 7+ years of progressive L&D leadership this role's scope calls for.",
		],
		[
			'negation lead + "posting requires" citation',
			"I don't want to overstate my fit -- without the 7+ years the posting requires, I'd still bring strong adjacent skills.",
		],
		[
			'"don\'t have" negation + "position calls for" citation',
			"I don't have the 5 years this position calls for, but I have related experience.",
		],
		['"lacking" negation + "job wants" citation', "Honestly, I'm lacking the 10 years this job wants."],
		[
			'"doesn\'t have" negation, third person',
			"The ideal candidate doesn't have the 8 years this role requires, based on my read of the posting.",
		],
		[
			"negation lead alone, no citation phrase in clause",
			"Without the 6 years of experience, I would still contribute immediately.",
		],
	])("produces no false metric claim: %s", (_label, text) => {
		expect([...metricClaims(text)].filter((claim) => /year/.test(claim))).toEqual([]);
	});

	it("still extracts genuine personal claims", () => {
		expect([...metricClaims("I have 12 years of experience in this field.")]).toContain("12 years");
		expect([...metricClaims("I bring 7+ years of L&D leadership to every team I join.")]).toContain("7 years");
	});

	// A personal claim and a cited requirement can share one undivided clause; a citation
	// test scoped to the whole clause would suppress BOTH (review of #3917).
	it.each([
		['comma + "and"', "I have 12 years of experience, and this role requires 7 years.", "12 years", "7 years"],
		["citation first", "This role requires 7 years, but I have 12 years of experience.", "12 years", "7 years"],
		["no comma at all", "I have 12 years of experience but this role requires 7 years.", "12 years", "7 years"],
		[
			"personal count before citation, requirement count after",
			"Managed 15 engineers in a role that requires 3 direct reports.",
			"15 engineers",
			"3 reports",
		],
		[
			"personal count before a posting citation",
			"I bring 8 years to a posting that calls for 5 years.",
			"8 years",
			"5 years",
		],
	])("mixed clause keeps the personal claim, suppresses the cited requirement: %s", (_label, text, personal, cited) => {
		const claims = [...metricClaims(text)];
		expect(claims).toContain(personal);
		expect(claims).not.toContain(cited);
	});

	it("binds a requirement count sitting directly before its citation phrase", () => {
		const claims = [...metricClaims("The 7 years this role requires is more than my 4 years.")];
		expect(claims).toContain("4 years");
		expect(claims).not.toContain("7 years");
	});

	it("keeps descriptive requirement counts bound to their citation", () => {
		const claims = [
			...metricClaims("The 7 years of leadership this role requires is more than my 4 years of experience."),
		];
		expect(claims).toContain("4 years");
		expect(claims).not.toContain("7 years");
	});

	it("still blocks a fabricated personal claim beside a correctly-cited requirement", () => {
		const source = "Instructional Designer with 5 years of L&D experience.";
		const mixed = run("I have 12 years of experience but this role requires 7 years.", source);
		expect(mixed.passed).toBe(false);
		expect(inventedOf(mixed)).toContain("12 years");
		expect(inventedOf(mixed)).not.toContain("7 years");

		const directional = run("Managed 15 engineers in a role that requires 3 direct reports.", source);
		expect(directional.passed).toBe(false);
		expect(inventedOf(directional)).toContain("15 engineers");
		expect(inventedOf(directional)).not.toContain("3 reports");
	});

	it("end to end: fabrication blocks, source-backed passes, the disclosure itself passes", () => {
		const source = "Instructional Designer with 5 years of L&D experience.";
		const fabricated = run("I have 12 years of experience in this field.", source);
		expect(fabricated.passed).toBe(false);
		expect(inventedOf(fabricated)).toContain("12 years");
		expect(run("I bring 5 years of L&D experience to this role.", source).passed).toBe(true);
		expect(
			run(
				"I want to be direct: my background is at the individual-contributor level, without the 7+ years of progressive L&D leadership this role's scope calls for.",
				source,
			).passed,
		).toBe(true);
	});
});

describe("language coverage — the gate must not report a confident pass on a document it could not read", () => {
	it("catches an English count inflation with no coverage noise", () => {
		const report = bare("Managed 45 staff across 3 facilities.");
		expect(report.passed).toBe(false);
		expect(inventedOf(report).sort()).toEqual(["3 facilities", "45 staff"]);
		expect(report.warnings.filter((warning) => warning.kind === "coverage")).toEqual([]);
	});

	it("reports the same inflation in a space-delimited language as unchecked", () => {
		for (const [lang, text] of [
			["es", "Gestioné 45 empleados en 3 instalaciones."],
			["de", "Leitete 45 Mitarbeiter an 3 Standorten."],
			["tr", "3 tesiste 45 çalışanı yönetti."],
			["pt", "Geri 45 funcionários em 3 unidades."],
		] as const) {
			const diagnosis = diagnoseCoverage(text);
			expect(diagnosis?.reason, lang).toBe("no-count-claims-recognized");
			expect(diagnosis?.spans.length, lang).toBeGreaterThanOrEqual(2);
			const report = bare(text);
			expect(report.passed, lang).toBe(true);
			expect(
				report.warnings.some((warning) => warning.kind === "coverage"),
				lang,
			).toBe(true);
		}
	});

	it("stays silent on clean English documents — no new noise", () => {
		for (const text of [
			"Senior Engineer at Acme since 2019. Led the 2024 platform migration.",
			"Cut p99 latency by 30% and infrastructure spend by $1.2M.",
			"Mentored 6 engineers and ran 4 hiring loops.",
			"Managed 20 staff across 2 facilities.",
			"Raised $120k and closed a $90,000 deal.",
			"Cut spend by $1.2M and latency by 30%.",
			"",
		]) {
			expect(diagnoseCoverage(text), JSON.stringify(text)).toBeNull();
		}
	});

	it("does not read a year as a count", () => {
		expect(diagnoseCoverage("Led the 2024 migration and the 2019 rollout.")).toBeNull();
	});

	it("never creates or masks a block", () => {
		const both = bare("Gestioné 45 empleados en 3 instalaciones y aumenté ingresos un 30%.");
		expect(both.passed).toBe(false); // the language-neutral 30% claim must still block
		expect(both.warnings.some((warning) => warning.kind === "coverage")).toBe(true);
	});

	it("one recognised count silences the warning — the documented under-report", () => {
		// French "sites" collides with the English noun. Pinned so the limitation is a
		// decision on record, and a future lexicon change shows up here.
		const report = bare("Encadré 45 collaborateurs sur 3 sites.");
		expect(report.warnings.filter((warning) => warning.kind === "coverage")).toEqual([]);
		expect(inventedOf(report)).toEqual(["3 sites"]);
	});

	it("does not cover CJK, and that is recorded", () => {
		// Digits sit flush against the text, so the whitespace-keyed detector cannot see
		// them. If a later change makes this fire, update deliberately — it is not a
		// regression.
		expect(diagnoseCoverage("3拠点で45名のスタッフを管理。")).toBeNull();
		expect(diagnoseCoverage("管理3个站点的45名员工。")).toBeNull();
	});
});

describe("verifyFacts over ResumeData", () => {
	function sourceResume(): typeof defaultResumeData {
		const data = structuredClone(defaultResumeData);
		data.basics.headline = "Senior Platform Engineer";
		data.summary.content = "<p>Cut infrastructure cost 60% and managed a <strong>$550K</strong> budget.</p>";
		data.sections.experience.items = [
			{
				id: "exp-1",
				hidden: false,
				company: "Acme Labs",
				position: "Senior Platform Engineer",
				location: "",
				period: "",
				website: { url: "", label: "", inlineLink: false },
				description: "<ul><li>Reached 16,181 active users across 80 courses using React and Docker.</li></ul>",
				roles: [],
			},
		];
		return data;
	}

	it("flattens a ResumeData into checkable text, HTML folded", () => {
		const text = resumeDataToFactTexts(sourceResume());
		expect(text).toContain("Reached 16,181 active users");
		expect(text).toContain("Acme Labs");
		expect(text).not.toContain("<li>");
	});

	it("passes a clean tailored resume whose claims the source resume backs", () => {
		const report = verifyFacts({
			candidate:
				"Worked at Acme Labs as a Senior Platform Engineer. Reached 16,181 users across 80 courses using React and Docker. Cut infrastructure cost 60% and managed a $550K budget.",
			sources: [{ label: "source resume", text: resumeDataToFactTexts(sourceResume()) }],
		});
		expect(report.violations).toEqual([]);
		expect(report.passed).toBe(true);
	});

	it("fails a tailored resume with a planted invented metric", () => {
		const report = verifyFacts({
			candidate: "Worked at Acme Labs as a Senior Platform Engineer. Reached 94,772 users and grew revenue 300%.",
			sources: [{ label: "source resume", text: resumeDataToFactTexts(sourceResume()) }],
		});
		expect(report.passed).toBe(false);
		expect(inventedOf(report)).toEqual(expect.arrayContaining(["94772 users", "300%"]));
		// The violation names the source it checked against.
		expect(report.violations[0]?.detail).toContain("source resume");
	});

	it("checks claims against every source, not just the first", () => {
		const report = verifyFacts({
			candidate: "Reached 16,181 users. Authored 80 guides.",
			sources: [
				{ label: "source resume", text: "Reached 16,181 active users." },
				{ label: "portfolio digest", text: "Authored 80+ open-access technical guides." },
			],
		});
		expect(report.passed).toBe(true);
	});
});
