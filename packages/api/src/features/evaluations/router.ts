import { ORPCError } from "@orpc/client";
import { fingerprintText } from "@reactive-resume/career/fingerprint";
import { computeSkillGap } from "@reactive-resume/career/skill-gap";
import { protectedProcedure } from "../../context";
import { evaluationDto, tailoringDto } from "../../dto/evaluation";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { applicationService } from "../applications/service";
import { runDetached } from "../jobs/lifetime";
import { backgroundJobsAvailable, enqueueJob } from "../jobs/queue";
import { JOB_NAMES } from "../jobs/registry";
import { resumeService } from "../resume/service";
import { runHmAudit } from "../tailoring/audit";
import { discardTailoringRun } from "../tailoring/pipeline";
import { tailoringService } from "../tailoring/service";
import { runEvaluation } from "./pipeline";
import { evaluationsService } from "./service";

const reserved = { tags: ["Evaluations"] } as const;

const evaluationErrors = {
	BAD_REQUEST: { message: "Invalid evaluation request.", status: 400 },
	NOT_FOUND: { message: "Evaluation not found.", status: 404 },
};

/** Hand the evaluation to the background worker, or run it in-process when no worker will
 * ever consume it (operator opt-out, or a serverless deploy whose entry never starts one) —
 * the feature must not silently dead-end either way. */
async function dispatchEvaluationRun(input: { evaluationId: string; userId: string; locale: string }) {
	if (!backgroundJobsAvailable()) {
		// runDetached keeps the work alive past the response on serverless (Vercel waitUntil).
		runDetached(
			runEvaluation(input).catch((error) => {
				console.error("Inline evaluation run failed", { evaluationId: input.evaluationId, error });
			}),
		);
		return;
	}
	await enqueueJob(JOB_NAMES.evaluationRun, input, { singletonKey: input.evaluationId });
}

export const evaluationsRouter = {
	// Start a deep evaluation of an application's job description against its linked resume.
	// The JD is snapshotted verbatim and the deterministic skill gap is computed synchronously
	// (it needs no AI provider); the LLM passes run in the background.
	start: protectedProcedure
		.route({
			method: "POST",
			path: "/applications/{applicationId}/evaluations",
			operationId: "startEvaluation",
			...reserved,
		})
		.input(evaluationDto.start.input)
		.use(aiRequestRateLimit)
		.output(evaluationDto.start.output)
		.errors(evaluationErrors)
		.handler(async ({ context, input }) => {
			const application = await applicationService.getById({ id: input.applicationId, userId: context.user.id });
			if (!application.resumeId) {
				throw new ORPCError("BAD_REQUEST", { message: "Link a resume to this application first." });
			}
			if (!application.jobDescription) {
				throw new ORPCError("BAD_REQUEST", { message: "Paste the job description into this application first." });
			}

			const resume = await resumeService.getById({ id: application.resumeId, userId: context.user.id });
			const skillGap = computeSkillGap({ jobDescription: application.jobDescription, resume: resume.data });

			const evaluation = await evaluationsService.create({
				userId: context.user.id,
				applicationId: input.applicationId,
				resumeId: application.resumeId,
				jdArchived: application.jobDescription,
				jdFingerprint: fingerprintText(application.jobDescription) || null,
				skillGap,
			});

			await dispatchEvaluationRun({
				evaluationId: evaluation.id,
				userId: context.user.id,
				locale: context.locale,
			});

			return evaluation;
		}),

	get: protectedProcedure
		.route({ method: "GET", path: "/evaluations/{id}", operationId: "getEvaluation", ...reserved })
		.input(evaluationDto.get.input)
		.output(evaluationDto.get.output)
		.errors(evaluationErrors)
		.handler(({ context, input }) => evaluationsService.getById({ id: input.id, userId: context.user.id })),

	listByApplication: protectedProcedure
		.route({
			method: "GET",
			path: "/applications/{applicationId}/evaluations",
			operationId: "listApplicationEvaluations",
			...reserved,
		})
		.input(evaluationDto.listByApplication.input)
		.output(evaluationDto.listByApplication.output)
		.errors(evaluationErrors)
		.handler(({ context, input }) =>
			evaluationsService.listByApplication({ applicationId: input.applicationId, userId: context.user.id }),
		),

	retry: protectedProcedure
		.route({ method: "POST", path: "/evaluations/{id}/retry", operationId: "retryEvaluation", ...reserved })
		.input(evaluationDto.retry.input)
		.use(aiRequestRateLimit)
		.output(evaluationDto.retry.output)
		.errors(evaluationErrors)
		.handler(async ({ context, input }) => {
			const evaluation = await evaluationsService.getById({ id: input.id, userId: context.user.id });
			if (evaluation.status === "running") {
				throw new ORPCError("BAD_REQUEST", { message: "This evaluation is already running." });
			}
			const updated = await evaluationsService.update({
				id: input.id,
				userId: context.user.id,
				status: "pending",
				error: null,
			});
			await dispatchEvaluationRun({ evaluationId: input.id, userId: context.user.id, locale: context.locale });
			const { userId: _userId, ...rest } = updated;
			return rest;
		}),

	delete: protectedProcedure
		.route({ method: "DELETE", path: "/evaluations/{id}", operationId: "deleteEvaluation", ...reserved })
		.input(evaluationDto.delete.input)
		.output(evaluationDto.delete.output)
		.errors(evaluationErrors)
		.handler(async ({ context, input }) => {
			await evaluationsService.delete({ id: input.id, userId: context.user.id });
		}),

	// The per-user career profile (work authorization for Block A, facts allowlist for the
	// fact gate). Lives here rather than its own module until it grows.
	getCareerProfile: protectedProcedure
		.route({ method: "GET", path: "/career/profile", operationId: "getCareerProfile", ...reserved })
		.input(evaluationDto.getCareerProfile.input)
		.output(evaluationDto.getCareerProfile.output)
		.errors(evaluationErrors)
		.handler(async ({ context }) => {
			const profile = await evaluationsService.getCareerProfile({ userId: context.user.id });
			if (!profile) return null;
			const { userId: _userId, ...rest } = profile;
			return rest;
		}),

	updateCareerProfile: protectedProcedure
		.route({ method: "PATCH", path: "/career/profile", operationId: "updateCareerProfile", ...reserved })
		.input(evaluationDto.updateCareerProfile.input)
		.output(evaluationDto.updateCareerProfile.output)
		.errors(evaluationErrors)
		.handler(({ context, input }) => evaluationsService.upsertCareerProfile({ userId: context.user.id, ...input })),

	// The versioned per-application tailoring bundle: reads, discard, the opt-in
	// hiring-manager audit, and the standalone fact check. Tailoring itself starts through
	// the existing `applications.ai.tailorResume` procedure.
	tailoringRuns: {
		list: protectedProcedure
			.route({
				method: "GET",
				path: "/applications/{applicationId}/tailoring-runs",
				operationId: "listTailoringRuns",
				...reserved,
			})
			.input(tailoringDto.list.input)
			.output(tailoringDto.list.output)
			.errors(evaluationErrors)
			.handler(({ context, input }) =>
				tailoringService.listByApplication({ applicationId: input.applicationId, userId: context.user.id }),
			),

		get: protectedProcedure
			.route({ method: "GET", path: "/tailoring-runs/{id}", operationId: "getTailoringRun", ...reserved })
			.input(tailoringDto.get.input)
			.output(tailoringDto.get.output)
			.errors(evaluationErrors)
			.handler(({ context, input }) => tailoringService.getById({ id: input.id, userId: context.user.id })),

		discard: protectedProcedure
			.route({
				method: "POST",
				path: "/tailoring-runs/{id}/discard",
				operationId: "discardTailoringRun",
				...reserved,
			})
			.input(tailoringDto.discard.input)
			.output(tailoringDto.discard.output)
			.errors(evaluationErrors)
			.handler(async ({ context, input }) => {
				await discardTailoringRun({ id: input.id, userId: context.user.id });
			}),

		audit: protectedProcedure
			.route({
				method: "POST",
				path: "/tailoring-runs/{tailoringRunId}/audit",
				operationId: "auditTailoringRun",
				...reserved,
			})
			.input(tailoringDto.audit.input)
			.use(aiRequestRateLimit)
			.output(tailoringDto.audit.output)
			.errors(evaluationErrors)
			.handler(({ context, input }) =>
				runHmAudit({ tailoringRunId: input.tailoringRunId, userId: context.user.id, locale: context.locale }),
			),
	},

	// Deterministic fact check of a tailored resume against its recorded source — the
	// builder badge's backend. A resume with no tailoring run has no source to check against.
	factCheck: protectedProcedure
		.route({ method: "POST", path: "/resumes/{resumeId}/fact-check", operationId: "factCheckResume", ...reserved })
		.input(tailoringDto.factCheck.input)
		.output(tailoringDto.factCheck.output)
		.errors(evaluationErrors)
		.handler(async ({ context, input }) => {
			const run = await tailoringService.findByTailoredResume({
				resumeId: input.resumeId,
				userId: context.user.id,
			});
			if (!run?.sourceResumeId) {
				throw new ORPCError("BAD_REQUEST", {
					message: "This resume has no recorded tailoring source to check against.",
				});
			}
			const [{ resumeDataToFactTexts, verifyFacts }, source, tailored, profile] = await Promise.all([
				import("@reactive-resume/career/fact-gate"),
				resumeService.getById({ id: run.sourceResumeId, userId: context.user.id }),
				resumeService.getById({ id: input.resumeId, userId: context.user.id }),
				evaluationsService.getCareerProfile({ userId: context.user.id }),
			]);
			const report = verifyFacts({
				candidate: resumeDataToFactTexts(tailored.data),
				sources: [{ label: "source resume", text: resumeDataToFactTexts(source.data) }],
				...(profile?.facts ? { allow: profile.facts } : {}),
			});
			return { ...report, sourceResumeId: run.sourceResumeId, tailoringRunId: run.id };
		}),
};
