import type { EvaluationBlocks, EvaluationRequirement, SkillGapResult } from "@reactive-resume/schema/career/data";
import type { LanguageModel } from "ai";
import type { EvaluationRunPayload } from "../jobs/registry";
import z from "zod";
import {
	evaluationLegitimacySystemPrompt,
	evaluationPass1SystemPrompt,
	evaluationPass2SystemPrompt,
	evaluationStrategySystemPrompt,
} from "@reactive-resume/ai/prompts";
import {
	applyRowBudget,
	eligibleForHardStop,
	mergeRequirementPasses,
	sortRequirements,
} from "@reactive-resume/career/evaluation";
import { hourlyRateSignal, payRangeWidthSignal } from "@reactive-resume/career/legitimacy";
import {
	evaluationWorkAuthSchema,
	legitimacyTierSchema,
	requirementEvidenceTierSchema,
	requirementImportanceSchema,
	requirementMatchSchema,
	riskLevelSchema,
} from "@reactive-resume/schema/career/data";
import { generateJson } from "../ai/generate-json";
import { resolveRunnableForFeature, runnableToModel } from "../ai/resolve-model";
import { applicationService } from "../applications/service";
import { resumeService } from "../resume/service";
import { evaluationsService } from "./service";

/**
 * The evaluation pipeline: two-pass anti-anchoring requirement analysis, a strategy pass,
 * a text-only legitimacy pass, and a deterministic assembly step.
 *
 * The two-pass rule is the mechanism, not a style choice: pass 1 grades each requirement's
 * importance from the JD alone, before the resume is ever in context, so the model cannot
 * anchor importance on the candidate's strengths. Pass 2 fills match/evidence per row, and
 * `mergeRequirementPasses` re-asserts the frozen importance whatever pass 2 returned.
 *
 * Everything the LLM is not needed for is deterministic TS: the skill gap (computed at
 * start time, before this pipeline runs), the pay-range/hourly arithmetic, hard-stop
 * derivation, the risk summary, and the final score sync onto the application row.
 */

// --- LLM output schemas (tolerant on enums: a wobbled value degrades safely) ---------

const nullableString = z.string().nullable().catch(null);

const passOneOutput = z.object({
	roleSummary: z.object({
		summary: z.string().catch(""),
		geoNote: nullableString,
		workAuthNote: nullableString,
	}),
	archetype: nullableString,
	workAuth: evaluationWorkAuthSchema.catch("unstated"),
	via: nullableString,
	reportsTo: nullableString,
	advertisedComp: nullableString,
	compBounds: z
		.object({
			lower: z.number(),
			upper: z.number(),
			currency: z.string(),
			period: z.string(),
		})
		.nullable()
		.catch(null),
	fixedComp: z
		.object({
			amount: z.number(),
			period: z.enum(["hourly", "monthly", "annual"]),
			currency: z.string(),
			statedHoursPerWeek: z.number().optional(),
		})
		.nullable()
		.catch(null),
	requirements: z
		.array(
			z.object({
				requirement: z.string(),
				importance: requirementImportanceSchema.catch("meaningful"),
				evidenceTier: requirementEvidenceTierSchema.catch("inferred"),
				jdSignal: nullableString,
			}),
		)
		.catch([])
		.transform((rows) => rows.slice(0, 15)),
	anomalies: z.array(z.string()).catch([]),
});

const passTwoOutput = z.object({
	matches: z
		.array(
			z.object({
				match: requirementMatchSchema.catch("partial"),
				evidence: nullableString,
			}),
		)
		.catch([]),
	topStrengths: z
		.array(z.string())
		.catch([])
		.transform((values) => values.slice(0, 5)),
	softGapCandidates: z
		.array(z.string())
		.catch([])
		.transform((values) => values.slice(0, 8)),
});

const strategyOutput = z.object({
	levelStrategy: z.object({
		assessment: z.string().catch(""),
		positioning: z.string().catch(""),
	}),
	compensation: z.object({
		notes: z.string().catch(""),
		reliability: nullableString,
	}),
	customizationPlan: z
		.array(z.object({ area: z.string(), recommendation: z.string() }))
		.catch([])
		.transform((values) => values.slice(0, 10)),
	interviewPlan: z
		.array(z.object({ question: z.string(), competency: z.string(), hint: nullableString }))
		.catch([])
		.transform((values) => values.slice(0, 10)),
	gaps: z
		.array(
			z.object({
				requirement: z.string(),
				importance: requirementImportanceSchema.catch("meaningful"),
				risk: z.string(),
				mitigation: z.string(),
			}),
		)
		.catch([])
		.transform((values) => values.slice(0, 12)),
	finalDecision: z.enum(["apply", "consider", "research_first", "skip"]).catch("consider"),
	score: z.coerce
		.number()
		.catch(0)
		.transform((value) => Math.round(Math.min(5, Math.max(1, value)) * 10) / 10),
	confidence: riskLevelSchema.catch("low"),
	nextAction: z.string().catch(""),
	draftAnswers: z
		.array(z.object({ question: z.string(), answer: z.string() }))
		.nullable()
		.catch(null),
});

const legitimacyOutput = z.object({
	signals: z
		.array(
			z.object({
				signal: z.string(),
				status: z.enum(["ok", "caution", "flag"]).catch("caution"),
				note: nullableString,
			}),
		)
		.catch([]),
	legitimacy: legitimacyTierSchema.catch("proceed_with_caution"),
});

// Block G signals this pipeline has no data for; reported as unexamined, never invented.
const NOT_EVALUATED_SIGNALS = [
	"company-research (layoffs, news, registry)",
	"agency licensing",
	"repost-history",
	"interview-experience reports",
] as const;

// Wall-clock budget for all LLM calls of one run. On Vercel the Function is killed at 300 s
// (which also skips the catch below), so the budget leaves room for the start request and
// the final writes; the queue worker has no such cap.
const EVALUATION_BUDGET_MS = process.env.VERCEL === "1" ? 240 * 1000 : 10 * 60 * 1000;

const BUDGET_EXCEEDED_MESSAGE =
	"The evaluation ran out of time — the AI provider was too slow. Run it again, or switch to a faster model.";

// --- Helpers ------------------------------------------------------------------------

function localeLine(locale: string): string {
	return `LOCALE: write prose in ${locale || "en-US"}.`;
}

async function resolveDefaultModel(userId: string): Promise<{
	model: LanguageModel;
	provider: string;
	modelId: string;
} | null> {
	const provider = await resolveRunnableForFeature(userId, "evaluation");
	if (!provider) return null;
	return {
		model: runnableToModel(provider),
		provider: provider.provider,
		modelId: provider.model,
	};
}

function deterministicLegitimacySignals(passOne: z.infer<typeof passOneOutput>) {
	const signals: EvaluationBlocks["legitimacySignals"] = [];

	if (passOne.compBounds) {
		const finding = payRangeWidthSignal(passOne.compBounds);
		signals.push({
			signal: "pay-range-width",
			status: finding ? "caution" : "ok",
			note: finding?.note ?? null,
		});
	}
	if (passOne.fixedComp) {
		const finding = hourlyRateSignal(passOne.fixedComp);
		if (finding) {
			signals.push({ signal: "comparable-hourly-rate", status: "ok", note: finding.note });
		}
	}
	return signals;
}

function assembleRiskSummary(
	legitimacy: z.infer<typeof legitimacyOutput>["legitimacy"],
	signals: EvaluationBlocks["legitimacySignals"],
	hardStops: readonly string[],
): EvaluationBlocks["riskSummary"] {
	const flagged = signals.filter((signal) => signal.status === "flag");
	const cautions = signals.filter((signal) => signal.status === "caution");

	// Pure aggregation of verdicts already rendered — never a fresh judgment.
	const level =
		legitimacy === "suspicious" || hardStops.length > 0 || flagged.length >= 2
			? "high"
			: legitimacy === "proceed_with_caution" || flagged.length > 0 || cautions.length >= 2
				? "medium"
				: "low";

	return {
		level,
		items: [
			...hardStops.map((stop) => `Hard stop: ${stop}`),
			...flagged.map((signal) => `${signal.signal}: ${signal.note ?? "flagged"}`),
			...cautions.map((signal) => `${signal.signal}: ${signal.note ?? "caution"}`),
		],
		notEvaluated: [...NOT_EVALUATED_SIGNALS],
	};
}

/** Hard stops are derived, not asked for: critical rows the resume misses (the clamp already
 * guarantees no critical row is `inferred`) plus an explicit sponsorship refusal. */
function deriveHardStops(
	requirements: readonly EvaluationRequirement[],
	workAuth: z.infer<typeof passOneOutput>["workAuth"],
): string[] {
	const stops = requirements
		.filter((row) => row.importance === "critical" && row.match === "missing" && eligibleForHardStop(row))
		.map((row) => row.requirement);
	if (workAuth === "no_sponsorship") stops.push("The posting explicitly refuses visa sponsorship.");
	return stops;
}

function deriveSoftGaps(
	requirements: readonly EvaluationRequirement[],
	candidates: readonly string[],
	hardStops: readonly string[],
): string[] {
	const fromRows = requirements
		.filter(
			(row) =>
				(row.match === "missing" || row.match === "partial") &&
				row.importance !== "critical" &&
				!hardStops.includes(row.requirement),
		)
		.map((row) => row.requirement);
	return [...new Set([...fromRows, ...candidates])].slice(0, 10);
}

// --- The pipeline -------------------------------------------------------------------

export type RunEvaluationInput = EvaluationRunPayload & {
	/** BCP-47 tag for generated prose; falls back to en-US. */
	locale?: string | undefined;
};

export async function runEvaluation(input: RunEvaluationInput): Promise<void> {
	const { evaluationId, userId } = input;
	const locale = input.locale ?? "en-US";

	const evaluation = await evaluationsService.getById({ id: evaluationId, userId });
	if (evaluation.status === "complete") return; // retried delivery of a finished job

	// One signal for every LLM call: the budget timer, plus a controller so a failure in one
	// call cancels its sibling instead of leaving it running (on serverless, holding the
	// Function open) for nothing.
	const controller = new AbortController();
	const abortSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(EVALUATION_BUDGET_MS)]);

	try {
		await evaluationsService.update({ id: evaluationId, userId, status: "running", error: null });

		const resolved = await resolveDefaultModel(userId);
		if (!resolved) {
			throw new Error("No AI provider is configured. Add one in Settings → Integrations to run evaluations.");
		}
		const { model } = resolved;

		const [application, profile] = await Promise.all([
			applicationService.getById({ id: evaluation.applicationId, userId }),
			evaluationsService.getCareerProfile({ userId }),
		]);
		if (!evaluation.resumeId) throw new Error("The evaluated resume no longer exists.");
		const resume = await resumeService.getById({ id: evaluation.resumeId, userId });

		const jd = evaluation.jdArchived;
		const workAuthProfile = profile?.workAuth ?? { authorizedIn: [], needsSponsorship: false };

		// Pass 1 (JD only) and the legitimacy pass (posting text only) both run without the
		// resume in context and need nothing from each other, so they run together: one fewer
		// call on the critical path, and a failure in either ends the run before pass 2 spends
		// tokens.
		const [passOne, legitimacy] = await Promise.all([
			generateJson(
				model,
				{
					system: evaluationPass1SystemPrompt,
					prompt: [
						localeLine(locale),
						`CANDIDATE WORK-AUTHORIZATION PROFILE (not a resume): authorized to work in ${
							workAuthProfile.authorizedIn.length > 0 ? workAuthProfile.authorizedIn.join(", ") : "(not specified)"
						}; needs sponsorship elsewhere: ${workAuthProfile.needsSponsorship ? "yes" : "unknown/no"}.`,
						`ROLE: ${application.role} at ${application.company}${application.location ? ` (${application.location})` : ""}`,
						`JOB DESCRIPTION:\n${jd}`,
					].join("\n\n"),
				},
				passOneOutput,
				{ abortSignal },
			),
			generateJson(
				model,
				{
					system: evaluationLegitimacySystemPrompt,
					prompt: [localeLine(locale), `JOB POSTING:\n${jd}`].join("\n\n"),
				},
				legitimacyOutput,
				{ abortSignal },
			),
		]);

		// Pass 2 — resume against the frozen rows.
		const frozenRows = passOne.requirements.map((row) => ({ ...row, match: null, evidence: null }));
		const passTwo = passTwoOutput.parse(
			await generateJson(
				model,
				{
					system: evaluationPass2SystemPrompt,
					prompt: [
						localeLine(locale),
						`REQUIREMENT ROWS (importance is frozen; answer per row, index-aligned):\n${JSON.stringify(
							frozenRows.map(({ requirement, importance, evidenceTier, jdSignal }) => ({
								requirement,
								importance,
								evidenceTier,
								jdSignal,
							})),
							null,
							1,
						)}`,
						`CANDIDATE WORK-AUTHORIZATION PROFILE: authorized in ${
							workAuthProfile.authorizedIn.join(", ") || "(not specified)"
						}.`,
						`RESUME:\n${JSON.stringify(resume.data)}`,
					].join("\n\n"),
				},
				passTwoOutput,
				{ abortSignal },
			),
		);

		// Deterministic merge: pass-1 importance re-asserted, inferred clamped, sorted, budgeted.
		const merged = mergeRequirementPasses(frozenRows, passTwo.matches);
		const { rows: requirements } = applyRowBudget(sortRequirements(merged));

		const hardStops = deriveHardStops(requirements, passOne.workAuth);
		const softGaps = deriveSoftGaps(requirements, passTwo.softGapCandidates, hardStops);
		const skillGap: SkillGapResult = evaluation.skillGap ?? {
			existing: [],
			supportedByResume: [],
			gap: [],
			lowConfidence: null,
		};

		// Strategy pass — blocks C/E/F/H over the finished table.
		const strategy = strategyOutput.parse(
			await generateJson(
				model,
				{
					system: evaluationStrategySystemPrompt,
					prompt: [
						localeLine(locale),
						`ROLE: ${application.role} at ${application.company}`,
						`ROLE SUMMARY: ${passOne.roleSummary.summary}`,
						`WORK AUTH: ${passOne.workAuth}`,
						`ADVERTISED COMPENSATION: ${passOne.advertisedComp ?? "(none stated)"}`,
						`REQUIREMENT TABLE (importance frozen; match/evidence from the resume pass):\n${JSON.stringify(requirements, null, 1)}`,
						`DETERMINISTIC SKILL GAP — existing: [${skillGap.existing.join(", ")}]; supported by resume prose: [${skillGap.supportedByResume.join(", ")}]; FORBIDDEN as resume claims (gap): [${skillGap.gap.join(", ")}]${skillGap.lowConfidence ? `; LOW CONFIDENCE: ${skillGap.lowConfidence.message}` : ""}`,
						`HARD STOPS: ${hardStops.length > 0 ? hardStops.join(" | ") : "(none)"}`,
						`RESUME:\n${JSON.stringify(resume.data)}`,
					].join("\n\n"),
				},
				strategyOutput,
				{ abortSignal },
			),
		);

		const legitimacySignals: EvaluationBlocks["legitimacySignals"] = [
			...legitimacy.signals.map((signal) => ({ ...signal })),
			...passOne.anomalies.map((anomaly) => ({
				signal: "reviewer-directed-text",
				status: "flag" as const,
				note: anomaly,
			})),
			...deterministicLegitimacySignals(passOne),
			...NOT_EVALUATED_SIGNALS.map((signal) => ({ signal, status: "not_evaluated" as const, note: null })),
		];

		// Mandatory mitigations: a missing/partial critical/high row with no gap entry gets an
		// explicit placeholder naming the omission rather than a silent pass.
		const gapsByRequirement = new Set(strategy.gaps.map((gap) => gap.requirement));
		const gaps = [...strategy.gaps];
		for (const row of requirements) {
			const unmet = row.match === "missing" || row.match === "partial";
			const mandatory = row.importance === "critical" || row.importance === "high";
			if (unmet && mandatory && !gapsByRequirement.has(row.requirement)) {
				gaps.push({
					requirement: row.requirement,
					importance: row.importance,
					risk: "The model did not produce a specific risk for this gap — treat it as unassessed, not absent.",
					mitigation: "Review this requirement yourself before applying.",
				});
			}
		}

		const blocks: EvaluationBlocks = {
			roleSummary: passOne.roleSummary,
			levelStrategy: strategy.levelStrategy,
			compensation: strategy.compensation,
			customizationPlan: strategy.customizationPlan,
			interviewPlan: strategy.interviewPlan,
			legitimacySignals,
			gaps,
			riskSummary: assembleRiskSummary(legitimacy.legitimacy, legitimacySignals, hardStops),
			// Block H only exists above the 4.5 line; the prompt enforces it and this clamps it.
			draftAnswers: strategy.score >= 4.5 ? strategy.draftAnswers : null,
			hardStops,
			softGaps,
			topStrengths: passTwo.topStrengths,
			finalDecision: strategy.finalDecision,
			confidence: strategy.confidence,
			nextAction: strategy.nextAction,
			via: passOne.via,
			reportsTo: passOne.reportsTo,
		};

		await evaluationsService.update({
			id: evaluationId,
			userId,
			status: "complete",
			score: strategy.score,
			archetype: passOne.archetype,
			legitimacy: legitimacy.legitimacy,
			workAuth: passOne.workAuth,
			advertisedComp: passOne.advertisedComp,
			requirements,
			blocks,
			provider: resolved.provider,
			model: resolved.modelId,
		});

		// Reflect the evaluation in the tracker the user already watches: matchScore is the
		// board's 0-100 surface, and the timeline records that an evaluation happened.
		await applicationService.setAiResult({
			id: evaluation.applicationId,
			userId,
			matchScore: Math.round(strategy.score * 20),
			aiMetadata: {
				...(application.aiMetadata ?? {}),
				evaluation: { id: evaluationId, score: strategy.score, decision: strategy.finalDecision },
			},
		});
		await applicationService.addNote({
			id: evaluation.applicationId,
			userId,
			text: `Evaluated: ${strategy.score.toFixed(1)}/5 — ${strategy.finalDecision.replace("_", " ")}`,
		});
	} catch (error) {
		const message = abortSignal.aborted
			? BUDGET_EXCEEDED_MESSAGE
			: error instanceof Error
				? error.message
				: "The evaluation failed.";
		await evaluationsService
			.update({ id: evaluationId, userId, status: "failed", error: message })
			.catch(() => undefined);
		throw error;
	} finally {
		controller.abort();
	}
}
