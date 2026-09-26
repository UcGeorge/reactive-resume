import type { FactGateReportData, TailoringChange } from "@reactive-resume/schema/career/data";
import type { LanguageModel } from "ai";
import { ORPCError } from "@orpc/client";
import { and, desc, eq } from "drizzle-orm";
import z from "zod";
import { tailoringPlanSystemPrompt } from "@reactive-resume/ai/prompts";
import { resumeDataToFactTexts, verifyFacts } from "@reactive-resume/career/fact-gate";
import { decideReuse } from "@reactive-resume/career/reuse";
import { computeSkillGap } from "@reactive-resume/career/skill-gap";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { applyResumePatches } from "@reactive-resume/resume/patch";
import { tailoringOperationSchema } from "@reactive-resume/schema/career/data";
import { generateId, slugify } from "@reactive-resume/utils/string";
import { generateJson } from "../ai/generate-json";
import { getModel } from "../ai/service";
import { aiProvidersService } from "../ai-providers/service";
import { applicationService } from "../applications/service";
import { evaluationsService } from "../evaluations/service";
import { resumeService } from "../resume/service";
import { compileTailoringPlan, sixSecondLint } from "./compile";
import { tailoringService } from "./service";

/**
 * The tailoring pipeline (career-ops pdf steps 8-19, on Reactive Resume primitives):
 * reuse gate → constrained plan call → deterministic compile → fact gate (hard, with one
 * strip-and-retry) → materialize a real resume copy plus a version snapshot. The tailored
 * artifact is a copy, so "approval" is inherent: the UI shows the changes and the fact-gate
 * report, and Discard deletes the copy.
 */

const planOutput = z.object({
	changes: z
		.array(z.object({ section: z.string(), change: z.string(), why: z.string() }))
		.catch([])
		.transform((values) => values.slice(0, 20)),
	operations: z
		.array(tailoringOperationSchema)
		.catch([])
		.transform((values) => values.slice(0, 40)),
});

// Budget for the single plan call. Tailoring runs inside the request, and on Vercel the
// Function is killed at 300 s, which would skip the failure bookkeeping below.
const TAILORING_PLAN_BUDGET_MS = process.env.VERCEL === "1" ? 240 * 1000 : 10 * 60 * 1000;

async function resolveModel(userId: string): Promise<LanguageModel> {
	const provider = await aiProvidersService.getDefaultRunnable({ userId });
	if (!provider) {
		throw new ORPCError("BAD_REQUEST", {
			message: "No AI provider is configured. Add one in Settings → Integrations to use AI features.",
		});
	}
	return getModel({
		provider: provider.provider,
		model: provider.model,
		apiKey: provider.apiKey,
		...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
	});
}

async function latestCompleteEvaluation(userId: string, applicationId: string) {
	const [row] = await db
		.select()
		.from(schema.evaluation)
		.where(
			and(
				eq(schema.evaluation.userId, userId),
				eq(schema.evaluation.applicationId, applicationId),
				eq(schema.evaluation.status, "complete"),
			),
		)
		.orderBy(desc(schema.evaluation.createdAt))
		.limit(1);
	return row ?? null;
}

export type TailorResumeResult = {
	resumeId: string;
	name: string;
	tailoringRunId: string;
	reused: boolean;
	factGate: FactGateReportData | null;
};

export async function runTailoring(input: {
	applicationId: string;
	userId: string;
	locale: string;
}): Promise<TailorResumeResult> {
	const { applicationId, userId, locale } = input;

	const application = await applicationService.getById({ id: applicationId, userId });
	if (!application.resumeId) {
		throw new ORPCError("BAD_REQUEST", { message: "Link a resume to this application first." });
	}
	if (!application.jobDescription) {
		throw new ORPCError("BAD_REQUEST", { message: "Paste the job description into this application first." });
	}

	// One run per application at a time: a second click (or a second tab) while one is working
	// would otherwise start a duplicate run. Stale orphans are failed first so they never block.
	await tailoringService.failStaleRuns(userId);
	if (await tailoringService.inFlightForApplication({ applicationId, userId })) {
		throw new ORPCError("CONFLICT", {
			message: "A tailoring run is already in progress for this application — follow it in the Tailoring tab.",
		});
	}

	// --- Reuse gate: compare against the previous run's archived JD before spending tokens.
	const previousRun = await tailoringService.latestForApplication({ applicationId, userId });
	const reuse =
		previousRun === null
			? null
			: decideReuse({
					previousJd: previousRun.jdArchived,
					nextJd: application.jobDescription,
				});

	if (reuse?.decision === "reuse" && previousRun?.status === "complete" && previousRun.tailoredResumeId !== null) {
		const tailored = await resumeService.getById({ id: previousRun.tailoredResumeId, userId }).catch(() => null);
		if (tailored) {
			const run = await tailoringService.create({
				userId,
				applicationId,
				sourceResumeId: previousRun.sourceResumeId ?? application.resumeId,
				jdArchived: application.jobDescription,
				reuseDecision: reuse,
			});
			await tailoringService.update({
				id: run.id,
				userId,
				status: "complete",
				tailoredResumeId: tailored.id,
				changes: [
					{
						section: "Reuse",
						change: `Reused tailored resume from run v${previousRun.version} (similarity ${reuse.score.toFixed(2)}).`,
						why: reuse.reason,
					},
				],
				factGateReport: previousRun.factGateReport,
			});
			if (application.resumeId !== tailored.id) {
				await applicationService.update({ id: applicationId, userId, resumeId: tailored.id });
			}
			await applicationService.addNote({
				id: applicationId,
				userId,
				text: `Tailoring: reused ${tailored.name} (JD similarity ${reuse.score.toFixed(2)})`,
			});
			return {
				resumeId: tailored.id,
				name: tailored.name,
				tailoringRunId: run.id,
				reused: true,
				factGate: previousRun.factGateReport,
			};
		}
	}

	// --- Full pipeline.
	// The source of a tailored copy must be the untailored base whenever we can find it: if
	// the application already points at a previous run's tailored copy, tailor from that
	// run's source instead of stacking tailorings on tailorings.
	const sourceResumeId =
		previousRun?.tailoredResumeId === application.resumeId && previousRun.sourceResumeId
			? previousRun.sourceResumeId
			: application.resumeId;
	const source = await resumeService.getById({ id: sourceResumeId, userId }).catch(() => null);
	const effectiveSource = source ?? (await resumeService.getById({ id: application.resumeId, userId }));

	const model = await resolveModel(userId);
	const [profile, evaluation] = await Promise.all([
		evaluationsService.getCareerProfile({ userId }),
		latestCompleteEvaluation(userId, applicationId),
	]);

	const skillGap = computeSkillGap({ jobDescription: application.jobDescription, resume: effectiveSource.data });
	const allowedSkills = [...skillGap.existing, ...skillGap.supportedByResume];

	const run = await tailoringService.create({
		userId,
		applicationId,
		evaluationId: evaluation?.id ?? null,
		sourceResumeId: effectiveSource.id,
		jdArchived: application.jobDescription,
		reuseDecision: reuse,
	});

	// Failures already written to the run (the fact gate records its own report) skip the
	// generic bookkeeping in the catch; every other failure must mark the run failed, or it
	// shows as in progress until the stale sweep catches it.
	let failureRecorded = false;

	try {
		const requirementContext = (evaluation?.requirements ?? [])
			.filter((row) => row.importance === "critical" || row.importance === "high")
			.map((row) => `- [${row.importance}] ${row.requirement} (${row.match ?? "unassessed"})`)
			.join("\n");

		const plan = planOutput.parse(
			await generateJson(
				model,
				{
					system: tailoringPlanSystemPrompt,
					prompt: [
						`LOCALE: write prose in ${locale || "en-US"}.`,
						`ROLE: ${application.role} at ${application.company}`,
						`EXISTING (named skills, usable): ${skillGap.existing.join(", ") || "(none)"}`,
						`SUPPORTED BY RESUME (prose-backed, usable): ${skillGap.supportedByResume.join(", ") || "(none)"}`,
						`GAP (FORBIDDEN as claims): ${skillGap.gap.join(", ") || "(none)"}${skillGap.lowConfidence ? `\nSKILL-GAP LOW CONFIDENCE: ${skillGap.lowConfidence.message}` : ""}`,
						requirementContext ? `HIGHEST-IMPORTANCE REQUIREMENTS (from the evaluation):\n${requirementContext}` : "",
						`JOB DESCRIPTION:\n${application.jobDescription}`,
						`RESUME (the document your operations mutate):\n${JSON.stringify(effectiveSource.data)}`,
					]
						.filter(Boolean)
						.join("\n\n"),
				},
				planOutput,
				{ abortSignal: AbortSignal.timeout(TAILORING_PLAN_BUDGET_MS) },
			),
		);

		await tailoringService.update({ id: run.id, userId, status: "planned", plan: plan.operations });

		// Deterministic compile + apply.
		let compiled = compileTailoringPlan(effectiveSource.data, plan.operations, allowedSkills);
		let tailoredData = applyResumePatches(structuredClone(effectiveSource.data), compiled.operations);

		// Hard fact gate, with one strip-and-retry: drop the ops whose values carry the
		// violating claims, re-apply, re-gate. Still dirty → the run fails, no resume exists.
		const sourceText = resumeDataToFactTexts(effectiveSource.data);
		const allow = profile?.facts ?? undefined;
		let report = verifyFacts({
			candidate: resumeDataToFactTexts(tailoredData),
			sources: [{ label: "source resume", text: sourceText }],
			...(allow ? { allow } : {}),
		});

		if (!report.passed) {
			const dirtyClaims = report.violations.map((violation) => violation.claim.toLowerCase());
			const cleanPlan = plan.operations.filter((operation) => {
				const value =
					operation.kind === "set" ? operation.value : operation.kind === "add-skill" ? operation.name : null;
				if (value === null) return true;
				const lowered = value.toLowerCase();
				return !dirtyClaims.some((claim) => lowered.includes(claim));
			});
			compiled = compileTailoringPlan(effectiveSource.data, cleanPlan, allowedSkills);
			tailoredData = applyResumePatches(structuredClone(effectiveSource.data), compiled.operations);
			report = verifyFacts({
				candidate: resumeDataToFactTexts(tailoredData),
				sources: [{ label: "source resume", text: sourceText }],
				...(allow ? { allow } : {}),
			});
		}

		if (!report.passed) {
			await tailoringService.update({
				id: run.id,
				userId,
				status: "failed",
				error: "The fact gate rejected the tailored resume.",
				factGateReport: report,
				changes: plan.changes,
			});
			failureRecorded = true;
			throw new ORPCError("BAD_REQUEST", {
				message: `The fact gate rejected the tailored resume: ${report.violations
					.slice(0, 3)
					.map((violation) => violation.detail)
					.join(" | ")}`,
			});
		}

		await tailoringService.update({ id: run.id, userId, status: "gated" });

		// Human changelog: the model's changes + everything the compiler refused + the lint.
		const changes: TailoringChange[] = [
			...plan.changes,
			...compiled.dropped.map((entry) => ({
				section: "Compiler",
				change: `Dropped a ${entry.operation.kind} operation.`,
				why: entry.reason,
			})),
			...sixSecondLint(tailoredData, evaluation?.requirements ?? null),
		];

		// Materialize: a real resume copy, a version snapshot, the application relinked.
		const name = `Tailored — ${application.company} · ${application.role}`.slice(0, 60);
		const newResumeId = await resumeService.create({
			userId,
			name,
			// generateId() is a UUIDv7: its leading characters are a timestamp that only changes every
			// few hours, so the uniqueness suffix must come from the random tail.
			slug: `${slugify(name)}-v${run.version}-${generateId().slice(-6)}`,
			tags: [...effectiveSource.tags.filter((tag) => tag !== "tailored"), "tailored"],
			data: tailoredData,
			locale: locale as never,
		});
		await resumeService.versions.snapshot({
			resumeId: newResumeId,
			userId,
			data: tailoredData,
			label: `Tailored v${run.version} — ${application.company}`.slice(0, 80),
		});

		await applicationService.update({ id: applicationId, userId, resumeId: newResumeId });
		await applicationService.addNote({
			id: applicationId,
			userId,
			text: `AI tailored a resume: ${name} (v${run.version}, fact gate passed)`,
		});

		await tailoringService.update({
			id: run.id,
			userId,
			status: "complete",
			tailoredResumeId: newResumeId,
			operations: compiled.operations,
			changes,
			factGateReport: report,
		});

		return { resumeId: newResumeId, name, tailoringRunId: run.id, reused: false, factGate: report };
	} catch (error) {
		if (!failureRecorded) {
			const message =
				error instanceof Error && error.name === "TimeoutError"
					? "Tailoring ran out of time — the AI provider was too slow. Run it again, or switch to a faster model."
					: error instanceof Error
						? error.message
						: "Tailoring failed.";
			await tailoringService.update({ id: run.id, userId, status: "failed", error: message }).catch(() => undefined);
		}
		throw error;
	}
}

/** Discard a run's tailored copy: delete the resume, repoint the application at the source,
 * mark the run rejected. The inverse of "Keep". */
export async function discardTailoringRun(input: { id: string; userId: string }): Promise<void> {
	const run = await tailoringService.getById({ id: input.id, userId: input.userId });
	if (run.status !== "complete") {
		throw new ORPCError("BAD_REQUEST", { message: "Only a completed run can be discarded." });
	}
	if (run.tailoredResumeId) {
		const application = await applicationService
			.getById({ id: run.applicationId, userId: input.userId })
			.catch(() => null);
		if (application?.resumeId === run.tailoredResumeId && run.sourceResumeId) {
			await applicationService.update({
				id: run.applicationId,
				userId: input.userId,
				resumeId: run.sourceResumeId,
			});
		}
		await resumeService.delete({ id: run.tailoredResumeId, userId: input.userId }).catch(() => undefined);
	}
	await tailoringService.update({ id: input.id, userId: input.userId, status: "rejected", tailoredResumeId: null });
}
