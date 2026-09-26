import type { LocationFilterConfig, TitleFilterConfig } from "./index";
import { describe, expect, it } from "vitest";
import {
	addDays,
	buildContentFilter,
	buildLocationFilter,
	buildTitleFilter,
	buildTitleFilterWithOverride,
	companiesMatch,
	compileContentKeyword,
	compileKeyword,
	cooldownBlocked,
	foldAccents,
	locationHintFromUrl,
	titleSignalsRemote,
} from "./index";

// Test cases translated from career-ops (MIT): tests/title-filter-word-prefix.test.mjs,
// tests/title-stem-prefix.test.mjs, tests/title-filter-accent-folding.test.mjs,
// tests/content-filter-word-prefix.test.mjs, tests/location-filter-strict.test.mjs,
// tests/location-filter-unicode.test.mjs, and test-all.mjs sections 44 (location/content filters)
// and 45 (cooldown). Cases tied to career-ops' own shipped config files or its second scan path
// (openrouter-runner parity, dead-positive guard over portals.example.yml) are not portable and
// stay behind.

describe("compileKeyword — word: prefix (#2970)", () => {
	const intern = compileKeyword("word:intern");

	it("matches the standalone word at the end, start and alone", () => {
		expect(intern("operations intern")).toBe(true);
		expect(intern("intern, platform")).toBe(true);
		expect(intern("intern")).toBe(true);
	});

	it("does not match inside 'internal' or 'international'", () => {
		expect(intern("internal tools engineer")).toBe(false);
		expect(intern("international partnerships manager")).toBe(false);
	});

	it("treats '/' and '-' as boundaries", () => {
		expect(intern("intern/graduate programme")).toBe(true);
		expect(intern("summer-intern")).toBe(true);
	});

	it("is not glued to an adjacent digit or underscore", () => {
		expect(intern("intern2026")).toBe(false);
		expect(intern("x_intern")).toBe(false);
	});

	it("keeps plain substring behaviour for a keyword WITHOUT the prefix", () => {
		expect(compileKeyword("intern")("internal tools")).toBe(true);
	});

	it("escapes regex metacharacters ('.net' is not 'any char + net')", () => {
		const dotnet = compileKeyword("word:.net");
		expect(dotnet("senior .net developer")).toBe(true);
		expect(dotnet("anet developer")).toBe(false);
	});

	it("matches nothing rather than everything on a bare 'word:'", () => {
		expect(compileKeyword("word:")("customer success manager")).toBe(false);
	});

	it("holds word boundaries against adjacent non-ASCII letters", () => {
		// An ASCII-only lookaround treats every accented letter as a separator, so `word:intern`
		// matched inside an accented word — vetoing exactly the class of international title the
		// prefix exists to protect.
		for (const title of ["préintern", "internée", "überintern"]) {
			expect(intern(title), title).toBe(false);
		}
		for (const title of ["operations intern", "intern"]) {
			expect(intern(title), title).toBe(true);
		}
	});

	it("uses the same Unicode boundary for a 2-3 letter acronym as for a word: entry", () => {
		// The acronym branch used ASCII \b, so `vp` matched inside an accented word while
		// `word:vp` did not — two spellings of one rule inside the module that exists to have one.
		const vp = compileKeyword("vp");
		for (const title of ["prévp", "vpn gateway", "révpn"]) {
			expect(vp(title), title).toBe(false);
		}
		for (const title of ["vp engineering", "senior vp", "vp, platform"]) {
			expect(vp(title), title).toBe(true);
		}
	});
});

describe("compileKeyword — stem: prefix (#3103)", () => {
	// keyword, title, plain, stem, word — TRIPLES, because the interesting property is not
	// "stem: matches" but that stem: sits strictly between the other two settings.
	const TRIPLES: [string, string, boolean, boolean, boolean][] = [
		["agent", "Agentforce Developer", true, true, false],
		["agent", "Agentic Workflows Engineer", true, true, false],
		["agent", "AI Agents Manager", true, true, false],
		["agent", "Account Manager Instrumentation & Reagents", true, false, false],
		["crypto", "Cryptocurrency Analyst", true, true, false],
		["crypto", "Encrypto Systems Lead", true, false, false],
		["fellows", "Fellowship Programme Lead", true, true, false],
		["rust engineer", "Rust Engineering Lead", true, true, false],
		["rust engineer", "Sr. Zero Trust Engineer III (6794)", true, false, false],
	];

	it("sits strictly between a plain keyword and word: on every case", () => {
		for (const [kw, title, wantPlain, wantStem, wantWord] of TRIPLES) {
			const lower = title.toLowerCase();
			expect(compileKeyword(kw)(lower), `plain "${kw}" vs "${title}"`).toBe(wantPlain);
			expect(compileKeyword(`stem:${kw}`)(lower), `stem:${kw} vs "${title}"`).toBe(wantStem);
			expect(compileKeyword(`word:${kw}`)(lower), `word:${kw} vs "${title}"`).toBe(wantWord);
		}
	});

	it("is neither word: nor the default — it differs from both, in the right directions", () => {
		expect(TRIPLES.some(([, , , s, w]) => s && !w)).toBe(true);
		expect(TRIPLES.some(([, , p, s]) => p && !s)).toBe(true);
	});

	it("does not reach a keyword that ends a compound — the plain form still does", () => {
		const compound = "Gebäudeautomation Ingenieur (m/w/d)".toLowerCase();
		expect(compileKeyword("automation")(compound)).toBe(true);
		expect(compileKeyword("stem:automation")(compound)).toBe(false);
	});

	it("does not close a keyword that STARTS the unwanted word — only word: does", () => {
		// stem: asks for the LEFT boundary only, so it matches these by design. Asserting both
		// halves is what makes this discriminating: an implementation that anchored both sides
		// would pass the first half and fail the second. Both titles are observed corpus entries.
		for (const [kw, title] of [
			["solana", "Genomic Breeder (Solanaceae)"],
			["neutron", "Senior Neutronics Engineer - Isotope Production"],
		] as const) {
			const lower = title.toLowerCase();
			expect(compileKeyword(`stem:${kw}`)(lower), `stem:${kw} vs "${title}"`).toBe(true);
			expect(compileKeyword(`word:${kw}`)(lower), `word:${kw} vs "${title}"`).toBe(false);
		}
	});

	it("matches nothing rather than everything on a bare 'stem:'", () => {
		expect(compileKeyword("stem:")("customer success manager")).toBe(false);
	});

	it("escapes regex metacharacters under stem: too", () => {
		const dotnet = compileKeyword("stem:.net");
		expect(dotnet("safety .netting specialist")).toBe(true);
		expect(dotnet("anet developer")).toBe(false);
	});

	it("keeps its boundary inside an AND-group", () => {
		const group = buildTitleFilter({ positive: ["stem:crypto + engineer"] });
		expect(group("Cryptocurrency Engineer")).toBe(true);
		expect(group("Encrypto Engineer")).toBe(false);
	});

	it("behaves as documented for the six negative cases the recall corpus is blind to", () => {
		// #3103: none of the corpus's titles contains Internal, International or Internship, so a
		// corpus diff reports zero for exactly the strings that motivated the substring default.
		const CASES: [string, string, boolean, boolean, boolean][] = [
			["intern", "Internal Tools Engineer", true, true, false],
			["intern", "International Sales Manager", true, true, false],
			["intern", "Software Engineering Internship", true, true, false],
			["crypto", "Cryptocurrency Analyst", true, true, false],
			["agent", "Agentforce Developer", true, true, false],
			["automation", "Gebäudeautomation Ingenieur", true, false, false],
		];
		for (const [kw, title, plain, stemRejects, wordRejects] of CASES) {
			const rejects = (entry: string) => buildTitleFilter({ positive: [], negative: [entry] })(title) === false;
			expect(rejects(kw), `plain "${kw}" vs "${title}"`).toBe(plain);
			expect(rejects(`stem:${kw}`), `stem:${kw} vs "${title}"`).toBe(stemRejects);
			expect(rejects(`word:${kw}`), `word:${kw} vs "${title}"`).toBe(wordRejects);
		}
	});
});

describe("buildTitleFilter", () => {
	it("no longer lets an anchored negative kill the 'internal tools' positive", () => {
		const neg = buildTitleFilter({ positive: ["internal tools", "operations"], negative: ["word:intern"] });
		expect(neg("Internal Tools Engineer")).toBe(true);
		expect(neg("Operations Intern")).toBe(false);
	});

	it("keeps word: anchoring inside an AND-group, since terms keep compileKeyword", () => {
		const group = buildTitleFilter({ positive: ["word:intern + operations"] });
		expect(group("Operations Intern")).toBe(true);
		expect(group("Internal Operations")).toBe(false);
	});

	it("requires every AND-group term, in any order", () => {
		const group = buildTitleFilter({ positive: ["director + engineering"] });
		expect(group("Director of Engineering")).toBe(true);
		expect(group("Senior Director, Platform Engineering")).toBe(true);
		expect(group("Director of Sales")).toBe(false);
		expect(group("Engineering Lead")).toBe(false);
	});

	it("treats an empty positive list as 'no positive constraint', not 'match nothing'", () => {
		const negOnly = buildTitleFilter({ negative: ["word:intern"] });
		expect(negOnly("Operations Manager")).toBe(true);
		expect(negOnly("Warehouse Associate")).toBe(true);
		expect(negOnly("Operations Intern")).toBe(false);
	});

	it("drops malformed entries instead of coercing them into keywords", () => {
		const filter = buildTitleFilter({
			positive: ["operations", null, 123, "   "],
			negative: [],
		} as unknown as TitleFilterConfig);
		expect(filter("Operations Manager")).toBe(true);
		expect(filter("123 Widgets Coordinator")).toBe(false);
		expect(filter("Warehouse Associate")).toBe(false);
	});

	it("passes everything with no config at all", () => {
		const filter = buildTitleFilter(undefined);
		expect(filter("Operations Manager")).toBe(true);
		expect(filter("Anything At All")).toBe(true);
	});

	it("matches a malformed title as text instead of throwing", () => {
		// A truthy non-string title must not throw: a throw would abort jobs.filter and drop a
		// whole company's results for one malformed title.
		const filter = buildTitleFilter({ positive: ["engineer"] });
		for (const value of [123, { a: 1 }, ["x"], true, null, undefined, ""]) {
			expect(() => filter(value), JSON.stringify(value)).not.toThrow();
		}
	});

	it("still admits 'Directorship Programme' with a plain positive and an anchored negative", () => {
		// An anchored negative does not kill a plain positive: the positive can still be
		// satisfied inside a longer word.
		const filter = buildTitleFilter({ positive: ["director"], negative: ["word:director"] });
		expect(filter("Directorship Programme")).toBe(true);
	});
});

describe("buildTitleFilter — accent folding", () => {
	it("matches an unaccented title with an accented keyword", () => {
		expect(buildTitleFilter({ positive: ["Producción"] })("TECNICO CONTROL DE PRODUCCION")).toBe(true);
	});

	it("matches an accented title with an unaccented keyword", () => {
		expect(buildTitleFilter({ positive: ["Produccion"] })("Jefe de Producción")).toBe(true);
	});

	it("lets an accented negative veto an unaccented title", () => {
		const filter = buildTitleFilter({ positive: ["Analista"], negative: ["Bioquímic"] });
		expect(filter("ANALISTA BIOQUIMICO DE PLANTA")).toBe(false);
	});

	it("keeps plain matching and negatives unchanged", () => {
		const filter = buildTitleFilter({ positive: ["Calidad"], negative: ["Software"] });
		expect(filter("Analista de Calidad")).toBe(true);
		expect(filter("Software Quality Analyst")).toBe(false);
	});

	it("keeps short-acronym word-boundary matching", () => {
		const filter = buildTitleFilter({ positive: ["it"] });
		expect(filter("IT Communications Network Engineer")).toBe(true);
		expect(filter("Digital Transformation Lead")).toBe(false);
	});

	it("folds precomposed and decomposed accents alike", () => {
		expect(foldAccents("Producción")).toBe("Produccion");
		expect(foldAccents("Producción")).toBe("Produccion");
		expect(foldAccents(null)).toBe("");
		// Deliberately not an ASCII strip: spaces, ".NET" and "L&D" are part of the keyword.
		expect(foldAccents(".NET & L&D")).toBe(".NET & L&D");
	});
});

describe("buildTitleFilterWithOverride", () => {
	const global: TitleFilterConfig = { positive: ["engineer"], negative: ["word:intern"] };

	it("behaves exactly like buildTitleFilter with no override", () => {
		const base = buildTitleFilter(global);
		const wrapped = buildTitleFilterWithOverride(global, null);
		for (const title of ["Software Engineer", "Operations Intern", "Engineering Intern", "Warehouse Associate"]) {
			expect(wrapped(title), title).toBe(base(title));
		}
	});

	it("passes when the global filter already matches", () => {
		const filter = buildTitleFilterWithOverride(global, { positive: ["administrator"] });
		expect(filter("Software Engineer")).toBe(true);
	});

	it("widens via override.positive without loosening for unlisted titles", () => {
		const filter = buildTitleFilterWithOverride(global, { positive: ["administrator", "coordinator"] });
		expect(filter("Payroll Administrator")).toBe(true);
		expect(filter("Events Coordinator")).toBe(true);
		expect(filter("Warehouse Associate")).toBe(false);
	});

	it("keeps the global negative as a veto over override positives", () => {
		const filter = buildTitleFilterWithOverride(global, { positive: ["administrator"] });
		expect(filter("Administrator Intern")).toBe(false);
	});

	it("supports AND-groups and word:/stem: prefixes in override positives", () => {
		// compilePositiveKeyword, not compileKeyword: an additive positive list behaves like one.
		const filter = buildTitleFilterWithOverride(global, { positive: ["word:admin + systems"] });
		expect(filter("Systems Admin")).toBe(true);
		expect(filter("Systems Administrator")).toBe(false);
	});

	it("adds override.negative as a veto even over a global pass", () => {
		const filter = buildTitleFilterWithOverride({ positive: ["engineer"] }, { negative: ["staff"] });
		expect(filter("Staff Engineer")).toBe(false);
		expect(filter("Senior Engineer")).toBe(true);
	});

	it("folds accents in the override path exactly as the base filter does", () => {
		const filter = buildTitleFilterWithOverride({ positive: ["nothing-matches"] }, { positive: ["producción"] });
		expect(filter("JEFE DE PRODUCCION")).toBe(true);
	});
});

describe("buildContentFilter — exclude semantics (#734, #3274)", () => {
	// keyword, description, plainRejects, stemRejects, wordRejects — same TRIPLE discipline as the
	// title-filter stem: tests.
	const TRIPLES: [string, string, boolean, boolean, boolean][] = [
		// "java" STARTS "javascript", so it is the #3103 "Solanaceae" class: stem: anchors the
		// left edge only and still rejects it — only word: closes it.
		["java", "We ship TypeScript and JavaScript", true, true, false],
		["java", "A Kotlin and Java 21 backend", true, true, true],
		["java", "Migrating our Javadoc tooling", true, true, false],
		// "ios" lands MID-word in "curiosity" — the case stem: does close.
		["ios", "We value curiosity and rigor", true, false, false],
		["ios", "Build our iOS app in Swift", true, true, true],
		["go", "A Django and Mongo shop", true, false, false],
		["go", "Everything is written in Go", true, true, true],
	];

	it("rejects with plain ⊇ stem: ⊇ word:, each anchoring one more edge", () => {
		for (const [kw, desc, wantPlain, wantStem, wantWord] of TRIPLES) {
			const rejects = (entry: string) => buildContentFilter([entry])(desc) === false;
			expect(rejects(kw), `plain "${kw}" vs "${desc}"`).toBe(wantPlain);
			expect(rejects(`stem:${kw}`), `stem:${kw} vs "${desc}"`).toBe(wantStem);
			expect(rejects(`word:${kw}`), `word:${kw} vs "${desc}"`).toBe(wantWord);
		}
	});

	it("keeps stem: strictly between word: and the plain default on the content filter too", () => {
		expect(TRIPLES.some(([, , , s, w]) => s && !w)).toBe(true);
		expect(TRIPLES.some(([, , p, s]) => p && !s)).toBe(true);
	});

	it("keeps the plain-substring default for an unprefixed keyword", () => {
		const bareJava = buildContentFilter(["java"]);
		expect(bareJava("We ship TypeScript and JavaScript")).toBe(false);
		expect(bareJava("A pure Rust team")).toBe(true);
	});

	it("keeps exact-substring semantics for a multi-word exclude phrase", () => {
		const phrase = buildContentFilter(["security clearance"]);
		expect(phrase("Requires an active security clearance")).toBe(false);
		expect(phrase("Remote, no clearance needed")).toBe(true);
	});

	it("does not auto-anchor a bare 2-3 letter keyword (no title-style acronym rule)", () => {
		// compileKeyword anchors "go"/"aws"/"sql" because "COO" inside "Coordinator" is always
		// wrong in a title. In description prose it is not.
		const short = buildContentFilter(["go"]);
		expect(short("We use MongoDB heavily")).toBe(false);
		expect(short("A pure Ruby shop")).toBe(true);
	});

	it("still anchors a short keyword when the entry opts in with word:", () => {
		expect(compileContentKeyword("word:go")("everything in go")).toBe(true);
		expect(compileContentKeyword("word:go")("mongo and django")).toBe(false);
	});

	it("treats a bare word:/stem: entry as a no-op, not a veto", () => {
		expect(buildContentFilter(["word:", "stem:"])("any description text at all")).toBe(true);
	});

	it("escapes regex metacharacters under word:", () => {
		const dotnet = compileContentKeyword("word:.net");
		expect(dotnet("our stack is .net 8")).toBe(true);
		expect(dotnet("anet internal tool")).toBe(false);
	});

	it("passes empty/missing/non-string texts (providers without descriptions are never dropped)", () => {
		const filter = buildContentFilter(["php"]);
		for (const value of ["", "   ", undefined, null, 42]) {
			expect(filter(value), JSON.stringify(value)).toBe(true);
		}
	});

	it("passes everything with no exclude list configured", () => {
		expect(buildContentFilter(null)("any description")).toBe(true);
		expect(buildContentFilter(undefined)("")).toBe(true);
		expect(buildContentFilter([])("Legacy PHP shop")).toBe(true);
	});

	it("matches case-insensitively and drops empty/non-string entries", () => {
		expect(buildContentFilter(["WordPress"])("wordpress maintenance")).toBe(false);
		expect(buildContentFilter(["", "  ", null, 42] as unknown as string[])("anything")).toBe(true);
	});
});

describe("buildLocationFilter — tiers", () => {
	const filter = buildLocationFilter({
		alwaysAllow: ["belgium", "brussels"],
		allow: ["europe", "emea", "remote"],
		block: ["france", "germany", "united states"],
	});

	it("passes an alwaysAllow hit regardless of other text", () => {
		expect(filter("Brussels, Belgium")).toBe(true);
	});

	it("lets alwaysAllow win over block (the motivating case for the tier)", () => {
		expect(filter("Remote, Belgium or France")).toBe(true);
	});

	it("still rejects a plain block hit", () => {
		expect(filter("Paris, France")).toBe(false);
	});

	it("passes an empty location", () => {
		expect(filter("")).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(filter("BRUSSELS, BELGIUM")).toBe(true);
	});

	it("keeps block winning without an alwaysAllow key (backward compatible)", () => {
		const stock = buildLocationFilter({ allow: ["europe", "remote"], block: ["france"] });
		expect(stock("Remote, Belgium or France")).toBe(false);
	});

	it("returns a pass-all filter for a null config", () => {
		const nullFilter = buildLocationFilter(null);
		expect(nullFilter("Anywhere on Earth")).toBe(true);
		expect(nullFilter("")).toBe(true);
	});

	it("wraps a bare-string keyword list to one item", () => {
		expect(buildLocationFilter({ alwaysAllow: "belgium", block: ["france"] })("Remote, Belgium or France")).toBe(true);
		expect(buildLocationFilter({ allow: " Montréal " })("Montréal")).toBe(true);
	});

	it("filters out non-string entries without crashing or false matches", () => {
		const messy = buildLocationFilter({
			alwaysAllow: [null, "belgium", 42, undefined],
			block: ["france", null, 7],
		} as unknown as LocationFilterConfig);
		expect(messy("Brussels, Belgium")).toBe(true);
		expect(messy("Paris, France")).toBe(false);
		const allBad = buildLocationFilter({
			block: [null, 42, undefined],
			allow: ["remote"],
		} as unknown as LocationFilterConfig);
		expect(allBad("Remote")).toBe(true);
	});

	it("drops empty/whitespace keywords (no pass-all via includes(''))", () => {
		const filter2 = buildLocationFilter({ alwaysAllow: ["", "  "], allow: ["remote"], block: ["france"] });
		expect(filter2("Paris, France")).toBe(false);
	});

	it("trims whitespace-padded keywords", () => {
		const padded = buildLocationFilter({ alwaysAllow: ["  Belgium  ", "\tBrussels\n"], block: ["france"] });
		expect(padded("Remote, Belgium or France")).toBe(true);
	});

	it("treats a whitespace-only location as missing", () => {
		expect(filter("   \t  ")).toBe(true);
	});

	it("passes non-string locations through to downstream evaluation without throwing", () => {
		expect(filter(42)).toBe(true);
		expect(filter({ city: "Brussels" })).toBe(true);
		expect(filter(null)).toBe(true);
		expect(filter(undefined)).toBe(true);
	});
});

describe("buildLocationFilter — block_hard tier", () => {
	const hard = buildLocationFilter({
		alwaysAllow: ["porto", "malta", "amsterdam"],
		allow: ["europe", "remote"],
		block: ["brazil", "usa"],
		blockHard: ["brazil", "usa"],
	});

	it("rejects a non-European location whose city name matches alwaysAllow", () => {
		expect(hard("Porto Alegre, Rio Grande do Sul, Brazil")).toBe(false);
		expect(hard("USA - Example State - Malta")).toBe(false);
	});

	it("leaves a genuine alwaysAllow hit untouched", () => {
		expect(hard("Amsterdam, Netherlands")).toBe(true);
	});

	it("is additive: the same config with no blockHard keeps alwaysAllow winning over block", () => {
		const noHard = buildLocationFilter({
			alwaysAllow: ["porto", "malta", "amsterdam"],
			allow: ["europe", "remote"],
			block: ["brazil", "usa"],
		});
		expect(noHard("Porto Alegre, Rio Grande do Sul, Brazil")).toBe(true);
	});
});

describe("buildLocationFilter — US state expansion", () => {
	const usHomonym = buildLocationFilter({
		alwaysAllow: ["United States", "USA"],
		allow: [],
		block: ["Dublin", "Paris", "London", "Berlin", "Manchester", "Cambridge"],
	});

	it("treats City, ST homonyms as US via state names and 2-letter codes", () => {
		for (const location of ["Dublin, OH", "Dublin, Ohio", "Paris, TX", "London, KY", "Berlin, NH", "Cambridge, MA"]) {
			expect(usHomonym(location), location).toBe(true);
		}
	});

	it("still blocks the foreign counterpart", () => {
		for (const location of [
			"Dublin, Ireland",
			"Paris, France",
			"London, United Kingdom",
			"Berlin, Germany",
			"Cambridge, UK",
		]) {
			expect(usHomonym(location), location).toBe(false);
		}
	});

	it("applies the expansion to the Workday URL hint (Dublin-OH)", () => {
		expect(usHomonym("5 Locations", "https://x.wd1.myworkdayjobs.com/c/job/Dublin-OH/Eng_R1")).toBe(true);
	});

	it("keeps a genuine alwaysAllow city passing, and blockHard winning over the expansion", () => {
		const combo = buildLocationFilter({
			alwaysAllow: ["united states", "amsterdam"],
			allow: [],
			block: ["Dublin", "Paris", "London", "Berlin"],
			blockHard: ["ireland", "brazil", "usa"],
		});
		expect(combo("Amsterdam, Netherlands")).toBe(true);
		expect(combo("Dublin, Ireland")).toBe(false);
		expect(combo("USA - New York - Malta")).toBe(false);
		expect(combo("Porto Alegre, Rio Grande do Sul, Brazil")).toBe(false);
	});

	it("stays off without a US country token (EU-targeted installs unchanged)", () => {
		const eu = buildLocationFilter({
			alwaysAllow: ["belgium", "brussels", "amsterdam"],
			allow: [],
			block: ["Dublin", "Paris", "London"],
		});
		expect(eu("Dublin, OH")).toBe(false);
		expect(eu("Paris, TX")).toBe(false);
		expect(eu("Amsterdam, Netherlands")).toBe(true);
	});

	it("also triggers on the u.s. / u.s.a. country spellings", () => {
		expect(buildLocationFilter({ alwaysAllow: ["U.S."], block: ["Dublin"] })("Dublin, OH")).toBe(true);
		expect(buildLocationFilter({ alwaysAllow: ["U.S.A."], block: ["Dublin"] })("Dublin, Ohio")).toBe(true);
	});

	it("does not let 2-letter codes match inside other words or English or/in conjunctions", () => {
		const leak = buildLocationFilter({
			alwaysAllow: ["united states"],
			allow: ["united states", "usa"],
			block: ["france", "belgium", "dublin", "india"],
		});
		expect(leak("Remote, Belgium or France")).toBe(false);
		expect(leak("Hyderabad, India")).toBe(false);
		expect(leak("Dublin, India")).toBe(false);
		expect(leak("Portland, OR")).toBe(true);
		expect(leak("Dublin, IN")).toBe(true);
	});

	it("keeps Unicode boundaries on the abbreviation matcher (#3431)", () => {
		for (const location of [
			"Dublin, OH",
			"Dublin,OH, USA",
			"Dublin OH.",
			"Dublin Ohio",
			"Rome, NY",
			"Indian Head, MD",
		]) {
			const rescued = buildLocationFilter({
				alwaysAllow: ["United States"],
				block: ["Dublin", "Rome", "Indian Head"],
			});
			expect(rescued(location), location).toBe(true);
		}
		for (const location of [
			"Montréal",
			"Montréal",
			"𐐀al",
			"al𐐀",
			"٢al",
			"al٢",
			"Canada, CAé",
			"Canada, CÁ",
			"Canada, CA𐐀",
			"Canada, CA٢",
			"Remote, Belgium or France",
		]) {
			const filter = buildLocationFilter({ alwaysAllow: ["United States"], block: [location] });
			expect(filter(location), location).toBe(false);
		}
	});
});

describe("buildLocationFilter — Unicode keyword boundaries (#3431)", () => {
	const issueFilter = buildLocationFilter({ allow: ["United States", "al,"] });

	it("does not let 'al,' admit Montréal while the real controls behave", () => {
		expect(issueFilter("Montréal, Quebec, CAN")).toBe(false);
		expect(issueFilter("Austin, TX, United States")).toBe(true);
		expect(issueFilter("Paris, France")).toBe(false);
	});

	// Each row pairs a real standalone match with an embedded match that must fail. Non-Latin
	// keyword edges need boundaries too; astral letters must be read as code points.
	const boundaryCases: [string, string, string][] = [
		["al,", "Huntsville, AL, United States", "Montréal, Quebec, Canada"],
		["montr", "Montr", "Montréal"],
		["al,", "AL, United States", "Montréal, Quebec, Canada"],
		["́al", "(́al)", "éal"],
		["cafe", "Cafe", "Café"],
		["café", "(Café)", "Caféteria"],
		["é", "(É)", "Pré"],
		["é", "(É)", "Évry"],
		["東京", "(東京)", "新東京"],
		["東京", "(東京)", "東京都"],
		["𐐀", "(𐐀)", "x𐐀"],
		["𐐀", "(𐐀)", "𐐀x"],
		["al,", "AL, United States", "𐐀al,"],
		["al", "(AL)", "al𐐀"],
		["al,", "AL, United States", "٢al,"],
		["al", "(AL)", "al٢"],
		["٢", "(٢)", "x٢"],
		["٢", "(٢)", "٢x"],
	];
	const tiers: [string, (kw: string) => LocationFilterConfig, boolean][] = [
		["blockHard", (kw) => ({ allow: [], blockHard: [kw] }), false],
		["alwaysAllow", (kw) => ({ allow: ["Neverland"], alwaysAllow: [kw] }), true],
		["block", (kw) => ({ allow: [], block: [kw] }), false],
		["allow", (kw) => ({ allow: [kw] }), true],
	];

	it("respects Unicode keyword edges and adjacent letters, marks and numbers on every tier", () => {
		for (const [tier, config, admits] of tiers) {
			for (const [keyword, standalone, embedded] of boundaryCases) {
				const filter = buildLocationFilter(config(keyword));
				expect(filter(standalone), `${tier} "${keyword}" standalone "${standalone}"`).toBe(admits);
				expect(filter(embedded), `${tier} "${keyword}" embedded "${embedded}"`).toBe(!admits);
			}
		}
	});

	it("keeps literal semantics at punctuation edges (a dot is not a wildcard)", () => {
		for (const [keyword, match, miss] of [
			["UK -", "UK - London", "Truck - Depot"],
			[", IND", "Hyderabad, IND", "Hyderabad, Indiana"],
			["U.S.", "Boston, U.S.", "Boston, UxSx"],
			["U.S.A.", "Boston, U.S.A.", "Boston, UxSxAx"],
			["(India)", "Remote (India)", "Remote India"],
		] as const) {
			const filter = buildLocationFilter({ allow: [keyword] });
			expect(filter(match), `${keyword} vs ${match}`).toBe(true);
			expect(filter(miss), `${keyword} vs ${miss}`).toBe(false);
		}
	});

	it("does not introduce Unicode normalization or accent folding", () => {
		expect(buildLocationFilter({ allow: ["Montréal"] })("Montréal")).toBe(false);
	});

	it("keeps the open right edge of punctuation-ended aliases", () => {
		expect(buildLocationFilter({ allow: ["U.S."] })("U.S.A.")).toBe(true);
	});

	it("orders the tiers on a mixed multi-location string", () => {
		const mixed = "Montréal, Canada / 東京, Japan";
		const cases: [LocationFilterConfig, boolean, string][] = [
			[{ blockHard: ["東京"], alwaysAllow: ["Montréal"], allow: ["Canada"] }, false, "block_hard beats always_allow"],
			[{ alwaysAllow: ["東京"], block: ["Montréal"], allow: ["Neverland"] }, true, "always_allow beats block"],
			[{ block: ["東京"], allow: ["Canada"] }, false, "block beats allow and a remote title"],
			[{ blockHard: ["al,"], alwaysAllow: ["東京"] }, true, "a mid-word block_hard alias does not veto always_allow"],
			[{ alwaysAllow: ["al,"], block: ["東京"] }, false, "a mid-word always_allow alias does not bypass block"],
		];
		for (const [config, expected, label] of cases) {
			expect(buildLocationFilter(config)(mixed, "", "Engineer - Remote"), label).toBe(expected);
		}
		expect(buildLocationFilter({ allow: ["東京"] })("Montréal", "", "Engineer - Remote")).toBe(true);
	});
});

describe("buildLocationFilter — Workday URL hint", () => {
	const workday = "https://acme.wd12.myworkdayjobs.com/careers/job/";

	it("rejects a rolled-up '5 Locations' row whose canonical URL is a blocked location", () => {
		const filter = buildLocationFilter({ alwaysAllow: ["united states"], block: ["india", "hyderabad", "germany"] });
		expect(
			filter(
				"5 Locations",
				"https://kyndryl.wd5.myworkdayjobs.com/careers/job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1",
			),
		).toBe(false);
	});

	it("lets alwaysAllow on the display string beat a blocked URL hint", () => {
		const filter = buildLocationFilter({ alwaysAllow: ["united states"], block: ["india", "hyderabad", "germany"] });
		expect(
			filter("New York, United States", "https://x.wd5.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1"),
		).toBe(true);
	});

	it("keeps location-only semantics when the url argument is omitted", () => {
		const filter = buildLocationFilter({ alwaysAllow: ["united states"], block: ["india", "hyderabad", "germany"] });
		expect(filter("Bengaluru, India")).toBe(false);
		expect(filter("Austin, TX")).toBe(true);
	});

	it("normalizes separators to spaces and lowercases the hint", () => {
		const cases: [string, string][] = [
			["Hyderabad-Telangana-India/Eng_R1", "hyderabad telangana india"],
			["USA---El-Segundo-CA/Eng_R1/", "usa el segundo ca"],
			["United_Arab+Emirates/Eng_R1", "united arab emirates"],
			["Montr%C3%A9al-Qu%C3%A9bec/Eng_R1", "montréal québec"],
			["%E6%9D%B1%E4%BA%AC/Eng_R1", "東京"],
			["%E0%A4%A/Eng_R1", "%e0%a4%a"],
			["ignored/job/Tokyo/Eng_R1", "tokyo"],
		];
		for (const [path, hint] of cases) {
			expect(locationHintFromUrl(workday + path), path).toBe(hint);
		}
	});

	it("yields no hint for non-Workday, title-only, malformed and empty URLs", () => {
		for (const url of [
			`${workday}ignored/job/Eng_R1/`,
			workday,
			workday.replace("/job/", "/jobs/"),
			"https://boards.greenhouse.io/acme/job/India/Eng_R1",
			"https://acme.myworkdayjobs.com.evil.example/c/job/India/Eng_R1",
			"https://notmyworkdayjobs.com/c/job/India/Eng_R1",
			"https://jobs.ashbyhq.com/snowflake/4fe8d816",
			"https://boards.greenhouse.io/acme/jobs/12345",
			"https://app.mokahr.com/social-recruitment/acme/123#/job/4fe8d816",
			"https://acme.jobs.personio.com/job/12345",
			"not a URL",
			"",
			null,
			42,
		]) {
			expect(locationHintFromUrl(url), JSON.stringify(url)).toBe("");
		}
	});

	it("preserves the missing-location escape hatch for a title-only Workday URL", () => {
		const issueFilter = buildLocationFilter({ allow: ["United States", "al,"] });
		const titleOnly = `${workday}Scrum-Master---Technical-Project-Manager_R0073509`;
		for (const suffix of ["", "/", "?source=India", "/?source=India#Paris", "//"]) {
			expect(locationHintFromUrl(titleOnly + suffix), suffix || "(bare)").toBe("");
			expect(issueFilter("", titleOnly + suffix), suffix || "(bare)").toBe(true);
		}
		for (const location of [undefined, null, 42, {}, " \t "]) {
			expect(issueFilter(location, titleOnly), JSON.stringify(location)).toBe(true);
		}
		expect(buildLocationFilter({ block: ["India"], allow: ["United States"] })("India", titleOnly)).toBe(false);
	});

	it("cannot let a Unicode URL location impersonate a US state abbreviation", () => {
		const filter = buildLocationFilter({ alwaysAllow: ["United States"], block: ["Canada"] });
		expect(filter("5 Locations", `${workday}Canada---Montr%C3%A9al/Eng_R1`)).toBe(false);
		const rescued = buildLocationFilter({ alwaysAllow: ["United States"], block: ["Dublin", "Rome", "Indian Head"] });
		expect(rescued("5 Locations", `${workday}Dublin-OH/Eng_R1`)).toBe(true);
	});

	it("boundary-matches the URL hint like the location string", () => {
		const boundary = buildLocationFilter({ block: ["india", "china", "uk -"] });
		expect(boundary("5 Locations", "https://x.wd1.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1")).toBe(
			false,
		);
		expect(boundary("5 Locations", "https://x.wd1.myworkdayjobs.com/c/job/Indianapolis-Indiana/Eng_R1")).toBe(true);
		expect(buildLocationFilter({ block: ["India"] })("5 Locations", `${workday}Hyderabad-India/Eng_R1`)).toBe(false);
		expect(buildLocationFilter({ allow: ["al,"] })("5 Locations", `${workday}Montr%C3%A9al,-Quebec/Eng_R1`)).toBe(
			false,
		);
		expect(buildLocationFilter({ allow: ["東京"] })("", `${workday}%E6%9D%B1%E4%BA%AC/Eng_R1`)).toBe(true);
	});
});

describe("buildLocationFilter — word boundaries on block keywords (#2087)", () => {
	const boundary = buildLocationFilter({ block: ["india", "china", "uk -"] });

	it("does not reject US places that merely contain a blocked country as a prefix", () => {
		expect(boundary("Indian Head, MD")).toBe(true);
		expect(boundary("Indianapolis, IN")).toBe(true);
		expect(boundary("West Lafayette, Indiana")).toBe(true);
		expect(boundary("Chinatown, San Francisco")).toBe(true);
		expect(boundary("Truck - Depot")).toBe(true);
	});

	it("still blocks the real country/region hits", () => {
		expect(boundary("Hyderabad, India")).toBe(false);
		expect(boundary("India")).toBe(false);
		expect(boundary("Beijing, China")).toBe(false);
		expect(boundary("UK - London")).toBe(false);
	});
});

describe("buildLocationFilter — remote-title rescue", () => {
	const filter = buildLocationFilter({
		allow: ["remote", "united states", "usa", "us", "new york"],
		block: ["india", "united kingdom", "london"],
	});

	it("lets a remote marker in the title satisfy allow when the location is city-only", () => {
		expect(filter("Costa Mesa, California", undefined, "Sr. PBM Client Implementation Project Manager - Remote")).toBe(
			true,
		);
		expect(filter("Las Vegas, Nevada", undefined, "Program Manager - Remote")).toBe(true);
		expect(filter("St Louis, Missouri", undefined, "Clinical Program Manager (Case Management) - Remote in MO")).toBe(
			true,
		);
		expect(filter("Phoenix, Arizona", undefined, "Project Manager (Remote)")).toBe(true);
		expect(filter("Dallas, Texas", undefined, "IT Program Manager, Remote - US")).toBe(true);
	});

	it("never rescues a blocked location (block still wins, URL hint included)", () => {
		expect(filter("Bengaluru, Karnataka, India", undefined, "Program Manager - Remote")).toBe(false);
		expect(filter("London, United Kingdom", undefined, "Project Manager - Remote")).toBe(false);
		expect(
			filter(
				"5 Locations",
				"https://x.wd1.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/PM_R1",
				"Program Manager - Remote",
			),
		).toBe(false);
	});

	it("ignores domain compounds (Remote Sensing/Monitoring) and mid-word hits", () => {
		expect(filter("Redlands, California", undefined, "Remote Sensing Program Manager")).toBe(false);
		expect(filter("Austin, Texas", undefined, "Remote Monitoring Project Manager")).toBe(false);
		expect(titleSignalsRemote("Remote Sensing Analyst")).toBe(false);
		expect(titleSignalsRemote("Program Manager - Remote")).toBe(true);
		expect(titleSignalsRemote("Telremote Engineer")).toBe(false);
	});

	it("never counts an explicit negation as a remote marker", () => {
		expect(titleSignalsRemote("Project Manager - Non-Remote")).toBe(false);
		expect(titleSignalsRemote("Project Manager - Not Remote")).toBe(false);
		expect(titleSignalsRemote("Office Manager (Non-Remote)")).toBe(false);
		expect(titleSignalsRemote("Program Manager - NonRemote")).toBe(false);
		expect(titleSignalsRemote("Program Manager - No Remote")).toBe(false);
		expect(filter("Eden Prairie, Minnesota", undefined, "Project Manager - Non-Remote")).toBe(false);
		expect(filter("Eden Prairie, Minnesota", undefined, "Project Manager - Not Remote")).toBe(false);
	});

	it("does not let the negation guard misfire on Nonprofit/Not-for-Profit/Nordic/Notary titles", () => {
		expect(titleSignalsRemote("Nonprofit Program Manager - Remote")).toBe(true);
		expect(titleSignalsRemote("Not-for-Profit Program Manager - Remote")).toBe(true);
		expect(titleSignalsRemote("Nordic Program Manager - Remote")).toBe(true);
		expect(titleSignalsRemote("Notary Operations Manager - Remote")).toBe(true);
	});

	it("survives Unicode dash variants between the negation and the word", () => {
		for (const dash of ["-", "–", "—", "‑", "‒", "−", "", " ", "/"]) {
			expect(titleSignalsRemote(`Project Manager - Non${dash}Remote`), JSON.stringify(dash)).toBe(false);
		}
	});

	it("keeps on-site city-only roles rejected and malformed/absent titles inert", () => {
		expect(filter("Eden Prairie, Minnesota", undefined, "Senior Project Manager I")).toBe(false);
		expect(filter("Eden Prairie, Minnesota", undefined, undefined)).toBe(false);
		expect(filter("Eden Prairie, Minnesota", undefined, 42)).toBe(false);
		expect(filter("Eden Prairie, Minnesota", undefined, "   ")).toBe(false);
		expect(filter("United States", undefined, "Program Manager")).toBe(true);
	});
});

describe("buildLocationFilter — strict mode (#3276)", () => {
	it("fails closed on empty locations without changing the default", () => {
		const lenient = buildLocationFilter({ allow: ["puerto rico", "san juan"] });
		const strict = buildLocationFilter({ allow: ["puerto rico", "san juan"], strict: true });
		const icimsUrl = "https://careers-peraton.icims.com/jobs/168257/data-architect/job";

		expect(lenient("", icimsUrl), "default: empty-location iCIMS posting still passes").toBe(true);
		expect(strict("", icimsUrl), "strict: empty-location iCIMS posting is rejected").toBe(false);
		expect(strict("", undefined)).toBe(false);
		expect(strict(null, null)).toBe(false);
		expect(strict("San Juan, PR", undefined), "strict preserves matching locations").toBe(true);
		expect(strict("Boston, MA", undefined), "strict still rejects real out-of-region locations").toBe(false);
	});

	it("is inert with no restricting tier; block-only strict fails closed", () => {
		const strictNoTiers = buildLocationFilter({ strict: true });
		const strictBlockOnly = buildLocationFilter({ block: ["india"], strict: true });

		expect(strictNoTiers("", undefined)).toBe(true);
		expect(strictNoTiers("Anywhere", undefined)).toBe(true);
		expect(strictBlockOnly("", undefined), "block-only strict cannot confirm an empty location is safe").toBe(false);
		expect(strictBlockOnly("Berlin, Germany", undefined)).toBe(true);
	});

	it("fails closed with a blockHard-only restricting tier too (#4033)", () => {
		const strictBlockHardOnly = buildLocationFilter({ blockHard: ["india"], strict: true });

		expect(strictBlockHardOnly("", undefined)).toBe(false);
		expect(strictBlockHardOnly("Berlin, Germany", undefined)).toBe(true);
		expect(strictBlockHardOnly("Mumbai, India", undefined)).toBe(false);
	});
});

describe("cooldown — addDays and companiesMatch", () => {
	it("computes UTC day arithmetic (180 days)", () => {
		expect(addDays("2026-06-24", 180)).toBe("2026-12-21");
	});

	it("matches employer names across separators and containment, not lookalikes", () => {
		expect(companiesMatch("Company A", "CompanyA")).toBe(true);
		expect(companiesMatch("CompanyA Corp", "CompanyA")).toBe(true);
		expect(companiesMatch("CompanyAlpha", "CompanyA")).toBe(false);
		// Unicode names keep their letters: an ASCII-only key would delete them and equate
		// genuinely different employers (the fingerprint companyKey rationale).
		expect(companiesMatch("Nestlé", "Nestlé Deutschland")).toBe(true);
		expect(companiesMatch("Nestlé", "Nest")).toBe(false);
		expect(companiesMatch("", "CompanyA")).toBe(false);
	});
});

describe("cooldownBlocked", () => {
	// Re-expressed from test-all.mjs section 45: window CompanyA, same_role_days 180,
	// applied_to ["Senior Software Engineer"], last_apply_date 2026-06-01 → cooldownUntil
	// 2026-11-28. The original's cross_role_bucket ("all_EM_roles") mechanism is not ported, so
	// its Engineering Manager case does not appear here; a caller expresses that veto by listing
	// the bucket's roles as priors.
	const priorApplications = [{ company: "CompanyA", role: "Senior Software Engineer", updatedAt: "2026-06-01" }];
	const base = { priorApplications, cooldownDays: 180 };

	it("blocks the same role and a title containing the prior role while the window is open", () => {
		expect(
			cooldownBlocked({ ...base, company: "Company A", title: "Senior Software Engineer", now: "2026-06-15" }),
		).toBe(true);
		expect(
			cooldownBlocked({ ...base, company: "CompanyA Corp", title: "Lead Senior Software Engineer", now: "2026-06-15" }),
		).toBe(true);
	});

	it("does not block a different role at the same company", () => {
		expect(cooldownBlocked({ ...base, company: "Company A", title: "Staff QA Engineer", now: "2026-06-15" })).toBe(
			false,
		);
	});

	it("does not block after the window has expired", () => {
		expect(
			cooldownBlocked({ ...base, company: "Company A", title: "Senior Software Engineer", now: "2026-12-01" }),
		).toBe(false);
	});

	it("does not block on the boundary day (now === updatedAt + cooldownDays)", () => {
		expect(
			cooldownBlocked({ ...base, company: "Company A", title: "Senior Software Engineer", now: "2026-11-28" }),
		).toBe(false);
	});

	it("does not match a lookalike company (CompanyAlpha vs CompanyA)", () => {
		expect(
			cooldownBlocked({ ...base, company: "CompanyAlpha", title: "Senior Software Engineer", now: "2026-06-15" }),
		).toBe(false);
	});

	it("never blocks with a non-positive or non-integer cooldown", () => {
		for (const cooldownDays of [0, -5, 1.5, Number.NaN]) {
			expect(
				cooldownBlocked({
					...base,
					cooldownDays,
					company: "Company A",
					title: "Senior Software Engineer",
					now: "2026-06-15",
				}),
				String(cooldownDays),
			).toBe(false);
		}
	});

	it("ignores priors with malformed dates and empty roles (fails open, like the original's window validation)", () => {
		const malformed = [
			{ company: "CompanyA", role: "Senior Software Engineer", updatedAt: "not-a-date" },
			{ company: "CompanyA", role: "Senior Software Engineer", updatedAt: "2026-02-31" },
			{ company: "CompanyA", role: "  ", updatedAt: "2026-06-01" },
		];
		expect(
			cooldownBlocked({
				company: "Company A",
				title: "Senior Software Engineer",
				priorApplications: malformed,
				cooldownDays: 180,
				now: "2026-06-15",
			}),
		).toBe(false);
	});

	it("checks every prior application, not just the first", () => {
		const priors = [
			{ company: "OtherCo", role: "Senior Software Engineer", updatedAt: "2026-06-01" },
			{ company: "CompanyA", role: "Platform Engineer", updatedAt: "2026-06-10" },
		];
		expect(
			cooldownBlocked({
				company: "Company A",
				title: "Senior Platform Engineer",
				priorApplications: priors,
				cooldownDays: 90,
				now: "2026-07-01",
			}),
		).toBe(true);
	});
});
