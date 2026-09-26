import z from "zod";

// Career-domain shapes: deep JD evaluation, deterministic skill gap, and the per-user career
// profile. The evaluation vocabulary is a set of bounded enums, never free-form numbers — a
// 0-100 integer advertises distinguishable levels the evidence cannot support and invites
// arithmetic nobody licensed. (Design ported from career-ops' oferta evaluation.)

// --- Skill gap (deterministic, zero-LLM) ----------------------------------------

// An empty three-bucket result is indistinguishable from a clean bill of health, so an
// inconclusive run carries an explicit reason instead of silently reading as "no gaps".
export const skillGapLowConfidenceReasonSchema = z.enum(["empty-jd", "no-requirements-section", "no-skill-candidates"]);

export type SkillGapLowConfidenceReason = z.infer<typeof skillGapLowConfidenceReasonSchema>;

export const skillGapLowConfidenceSchema = z.object({
	reason: skillGapLowConfidenceReasonSchema,
	message: z.string(),
});

export const skillGapResultSchema = z.object({
	/** JD skills already named in the resume's Skills section. */
	existing: z.array(z.string()),
	/** JD skills not named as a skill, but present in the resume's prose. */
	supportedByResume: z.array(z.string()),
	/** JD skills with no trace anywhere in the resume. Never auto-added — only reported. */
	gap: z.array(z.string()),
	/** Non-null when the run was inconclusive; "not the same as no gaps". */
	lowConfidence: skillGapLowConfidenceSchema.nullable(),
});

export type SkillGapResult = z.infer<typeof skillGapResultSchema>;

// --- Requirement table (evaluation Block B) -------------------------------------

export const requirementImportanceSchema = z.enum(["critical", "high", "meaningful", "preferred", "low_signal"]);

export type RequirementImportance = z.infer<typeof requirementImportanceSchema>;

/**
 * How the importance band is backed: `stated` requires a verbatim JD quote, `structural` a
 * section/structure reference auditable from the JD alone, `inferred` is labelled market
 * knowledge. An `inferred` row can never be `critical` or `high` — importance only creates
 * obligations when the JD itself carries it (the anti-anchoring gate).
 */
export const requirementEvidenceTierSchema = z.enum(["stated", "structural", "inferred"]);

export type RequirementEvidenceTier = z.infer<typeof requirementEvidenceTierSchema>;

/** ✅ strong / ⚠️ partial / ❌ missing / ➖ na (a gate the candidate satisfies, not a skill claim). */
export const requirementMatchSchema = z.enum(["strong", "partial", "missing", "na"]);

export type RequirementMatch = z.infer<typeof requirementMatchSchema>;

export const evaluationRequirementSchema = z.object({
	/** One JD requirement, including ones the candidate meets — that is what keeps importance
	 * readable as "significance in this posting" rather than "list of my problems". */
	requirement: z.string(),
	importance: requirementImportanceSchema,
	evidenceTier: requirementEvidenceTierSchema,
	/** Verbatim JD quote for `stated`, structure reference for `structural`, null for `inferred`. */
	jdSignal: z.string().nullable(),
	/** Null until the resume pass fills it. */
	match: requirementMatchSchema.nullable(),
	/** The exact resume line backing a strong match, or what is missing. */
	evidence: z.string().nullable(),
});

export type EvaluationRequirement = z.infer<typeof evaluationRequirementSchema>;

// --- Machine-summary enums --------------------------------------------------------

export const evaluationWorkAuthSchema = z.enum(["sponsors", "not_needed", "unstated", "no_sponsorship"]);

export type EvaluationWorkAuth = z.infer<typeof evaluationWorkAuthSchema>;

export const legitimacyTierSchema = z.enum(["high_confidence", "proceed_with_caution", "suspicious"]);

export type LegitimacyTier = z.infer<typeof legitimacyTierSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high"]);

export const finalDecisionSchema = z.enum(["apply", "consider", "research_first", "skip"]);

export type FinalDecision = z.infer<typeof finalDecisionSchema>;

// --- Evaluation blocks -------------------------------------------------------------

/** A legitimacy signal's verdict. `not_evaluated` is a real state: a signal this pipeline has
 * no data for is reported as unexamined, never silently skipped. */
export const legitimacySignalStatusSchema = z.enum(["ok", "caution", "flag", "not_evaluated"]);

export const legitimacySignalSchema = z.object({
	signal: z.string(),
	status: legitimacySignalStatusSchema,
	note: z.string().nullable(),
});

export const evaluationGapSchema = z.object({
	requirement: z.string(),
	importance: requirementImportanceSchema,
	/** Specific interview-risk description. Mandatory for missing/partial at critical/high. */
	risk: z.string(),
	/** Concrete mitigation: cover-letter phrase, adjacent experience, quick project. */
	mitigation: z.string(),
});

export const evaluationBlocksSchema = z.object({
	/** Block A — role summary plus geo / work-authorization flags. */
	roleSummary: z.object({
		summary: z.string(),
		geoNote: z.string().nullable(),
		workAuthNote: z.string().nullable(),
	}),
	/** Block C — level and strategy ("sell senior without lying"). */
	levelStrategy: z.object({
		assessment: z.string(),
		positioning: z.string(),
	}),
	/** Block D — compensation, with a reliability read on the posting's own numbers. */
	compensation: z.object({
		notes: z.string(),
		reliability: z.string().nullable(),
	}),
	/** Block E — resume/profile customization plan. */
	customizationPlan: z.array(z.object({ area: z.string(), recommendation: z.string() })),
	/** Block F — interview preparation plan (drives story-bank suggestions later). */
	interviewPlan: z.array(
		z.object({
			question: z.string(),
			competency: z.string(),
			hint: z.string().nullable(),
		}),
	),
	/** Block G — posting legitimacy signals (research-free subset + deterministic arithmetic). */
	legitimacySignals: z.array(legitimacySignalSchema),
	/** Gaps with mandatory mitigations for critical/high misses. */
	gaps: z.array(evaluationGapSchema),
	/** Assembled deterministically from the signal verdicts — aggregation, not judgment. */
	riskSummary: z.object({
		level: riskLevelSchema,
		items: z.array(z.string()),
		notEvaluated: z.array(z.string()),
	}),
	/** Block H — draft application answers; only produced when the score clears 4.5. */
	draftAnswers: z.array(z.object({ question: z.string(), answer: z.string() })).nullable(),
	hardStops: z.array(z.string()),
	softGaps: z.array(z.string()),
	topStrengths: z.array(z.string()),
	finalDecision: finalDecisionSchema,
	confidence: riskLevelSchema,
	nextAction: z.string(),
	/** Agency / recruiting firm when the posting is not direct, else null. */
	via: z.string().nullable(),
	/** The JD's own stated reporting line, verbatim — never inferred. */
	reportsTo: z.string().nullable(),
});

export type EvaluationBlocks = z.infer<typeof evaluationBlocksSchema>;

export const evaluationStatusSchema = z.enum(["pending", "running", "complete", "failed"]);

export type EvaluationStatus = z.infer<typeof evaluationStatusSchema>;

// --- Tailoring ---------------------------------------------------------------------

export const tailoringStatusSchema = z.enum(["pending", "planned", "gated", "complete", "failed", "rejected"]);

export type TailoringStatus = z.infer<typeof tailoringStatusSchema>;

/** The JD-vs-JD reuse decision taken before any tokens are spent. */
export const reuseDecisionSchema = z.object({
	decision: z.enum(["reuse", "reuse-with-edits", "regenerate"]),
	score: z.number(),
	reason: z.string(),
});

export type ReuseDecision = z.infer<typeof reuseDecisionSchema>;

/** One constrained mutation the tailoring plan may propose. The compiler enforces the path
 * allowlist and the skills-source rule; anything outside it is dropped and recorded. */
export const tailoringOperationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("set"),
		path: z.string(),
		value: z.string(),
		rationale: z.string(),
	}),
	z.object({
		kind: z.literal("move"),
		arrayPath: z.string(),
		from: z.number().int().min(0),
		to: z.number().int().min(0),
		rationale: z.string(),
	}),
	z.object({
		kind: z.literal("hide"),
		path: z.string(),
		rationale: z.string(),
	}),
	z.object({
		kind: z.literal("add-skill"),
		name: z.string(),
		keywords: z.array(z.string()).default([]),
		rationale: z.string(),
	}),
]);

export type TailoringOperation = z.infer<typeof tailoringOperationSchema>;

/** Human-readable changelog entry — the bundle's "changes.md" as data. */
export const tailoringChangeSchema = z.object({
	section: z.string(),
	change: z.string(),
	why: z.string(),
});

export type TailoringChange = z.infer<typeof tailoringChangeSchema>;

export const factViolationSchema = z.object({
	kind: z.string(),
	claim: z.string(),
	detail: z.string(),
});

export const factGateReportSchema = z.object({
	passed: z.boolean(),
	violations: z.array(factViolationSchema),
	warnings: z.array(factViolationSchema),
});

export type FactGateReportData = z.infer<typeof factGateReportSchema>;

/** The adversarial hiring-manager audit verdict, one row per audited bullet. */
export const auditVerdictSchema = z.enum(["keep", "cut", "rewrite"]);

export const auditRowSchema = z.object({
	index: z.number().int(),
	bullet: z.string(),
	verdict: auditVerdictSchema,
	why: z.string(),
	rewrite: z.string().nullable(),
});

export const auditReportSchema = z.object({
	/** How the reviewer persona was grounded. This pipeline synthesizes from the JD alone
	 * (tier C); a research-backed tier A/B needs provider web search. */
	tier: z.enum(["A", "B", "C"]),
	persona: z.string(),
	rows: z.array(auditRowSchema),
	scopeRead: z.string(),
	wouldAdvance: z.boolean(),
	reason: z.string(),
	/** True when the reviewer returned fewer rows than bullets — a partial audit, said out loud. */
	incomplete: z.boolean(),
	createdAt: z.string(),
});

export type AuditReport = z.infer<typeof auditReportSchema>;

// --- Career profile ----------------------------------------------------------------

export const careerWorkAuthProfileSchema = z.object({
	/** Countries / regions the user is authorized to work in, free text ("EU", "United States"). */
	authorizedIn: z.array(z.string()).default([]),
	needsSponsorship: z.boolean().default(false),
});

export type CareerWorkAuthProfile = z.infer<typeof careerWorkAuthProfileSchema>;

/** Per-user facts allowlist consumed by the fact gate: claims the gate should accept even
 * when the source resume does not carry them, and phrases it must always block or flag. */
export const careerFactsProfileSchema = z.object({
	allowMetrics: z.array(z.string()).default([]),
	allowFacts: z.array(z.string()).default([]),
	forbiddenPhrases: z.array(z.string()).default([]),
	warnPhrases: z.array(z.string()).default([]),
});

export type CareerFactsProfile = z.infer<typeof careerFactsProfileSchema>;
