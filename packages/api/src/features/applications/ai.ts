import type { LanguageModel } from "ai";
import { ORPCError } from "@orpc/client";
import { APICallError, generateText, RetryError } from "ai";
import z from "zod";
import { computeSkillGap, resumeSkillGapTexts } from "@reactive-resume/career/skill-gap";
import { env } from "@reactive-resume/env/server";
import { matchJobDescription } from "@reactive-resume/resume/ats-pdf/jd";
import { coverLetterTextToHtml } from "@reactive-resume/resume/cover-letter";
import { createFetchContext } from "@reactive-resume/scanner/context";
import { htmlToText } from "@reactive-resume/scanner/html-to-text";
import { factGateReportSchema, skillGapLowConfidenceSchema } from "@reactive-resume/schema/career/data";
import { protectedProcedure } from "../../context";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { generateJson as sharedGenerateJson } from "../ai/generate-json";
import { resolveModelForFeature } from "../ai/resolve-model";
import { coverLetterService } from "../cover-letters/service";
import { resumeService } from "../resume/service";
import { applicationService } from "./service";

const reserved = { tags: ["Applications", "AI"] } as const;
const MAX_PASTED_JOB_DESCRIPTION_CHARS = 20_000;

// --- AI provider failure translation ------------------------------------------
// The AI SDK surfaces provider-side failures as `APICallError` (HTTP 4xx/5xx from
// the provider) or `RetryError` with `reason: "maxRetriesExceeded"`.  Translating
// only those to BAD_GATEWAY gives the client an actionable status code instead of
// an opaque 500.  Validation, credential, model-resolution, and response-parsing
// errors rethrow unchanged.

function isAiProviderGatewayError(error: unknown): boolean {
	if (APICallError.isInstance(error)) return true;
	if (RetryError.isInstance(error) && error.reason === "maxRetriesExceeded") return true;
	return false;
}

/** Throws a BAD_GATEWAY ORPCError, preserving the original cause for upstream error reporters. */
function throwAiProviderGatewayError(cause?: unknown): never {
	throw new ORPCError("BAD_GATEWAY", { message: "Could not reach the AI provider.", cause });
}

/**
 * Wrapper around the shared `generateJson` that translates AI provider failures
 * to BAD_GATEWAY.  Accepts the same prompt shape as the shared module.
 * Exported for tests.
 */
export async function generateJson<T>(
	model: LanguageModel,
	prompt: { system?: string; prompt: string },
	schema: z.ZodType<T>,
) {
	try {
		return await sharedGenerateJson(model, prompt, schema);
	} catch (error) {
		if (isAiProviderGatewayError(error)) throwAiProviderGatewayError(error);
		throw error;
	}
}

/** Exported for tests: provider-failure translation shared by every copilot procedure. */
export async function generatePlainText(model: LanguageModel, prompt: string) {
	try {
		const { text } = await generateText({ model, messages: [{ role: "user", content: prompt }] });
		return text.trim();
	} catch (error) {
		if (isAiProviderGatewayError(error)) throwAiProviderGatewayError(error);
		throw error;
	}
}

// --- Schema & router -----------------------------------------------------------

const autofillOutput = z.object({
	company: z.string(),
	role: z.string(),
	location: z.string(),
	salary: z.string(),
});

export const autofillInputSchema = z.object({
	jobDescription: z.string().trim().min(1).max(MAX_PASTED_JOB_DESCRIPTION_CHARS),
});

// Tolerant of LLM variance: clamp the score, cap the lists by slicing rather than rejecting.
// Since the deterministic upgrade the score/gaps/strengths come from the skill-gap + keyword
// matcher rather than a prompt, but the wire shape is unchanged; the extra fields are
// additive and optional so existing clients keep working.
const matchScoreOutput = z.object({
	score: z.coerce
		.number()
		.catch(0)
		.transform((n) => Math.max(0, Math.min(100, Math.round(n)))),
	gaps: z
		.array(z.string())
		.catch([])
		.transform((a) => a.slice(0, 8)),
	strengths: z
		.array(z.string())
		.catch([])
		.transform((a) => a.slice(0, 8)),
	/** Weighted keyword coverage 0..1 from the deterministic matcher. */
	coverage: z.number().optional(),
	/** Non-null when the skill-gap extraction was inconclusive — not the same as "no gaps". */
	lowConfidence: skillGapLowConfidenceSchema.nullable().optional(),
});

const aiErrors = {
	BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
	BAD_REQUEST: { message: "Invalid application or AI request.", status: 400 },
};

export const aiRouter = {
	// Extract structured fields from a pasted job description. The posting text itself is stored
	// verbatim on the application, so nothing here fetches or scrapes a URL.
	autofill: protectedProcedure
		.route({ method: "POST", path: "/applications/ai/autofill", operationId: "aiAutofillApplication", ...reserved })
		.input(autofillInputSchema)
		.use(aiRequestRateLimit)
		.output(autofillOutput)
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			const { model } = await resolveModelForFeature(context.user.id, "autofill");

			return generateJson(
				model,
				{
					prompt: `Extract the following fields from this job posting. Return ONLY JSON with keys company, role, location, salary. Use an empty string for anything not stated.\n\nJOB POSTING:\n${input.jobDescription}`,
				},
				autofillOutput,
			);
		}),

	// Fetch a job posting URL server-side, extract its text, and autofill from it. This is
	// the URL half the paste-text `autofill` deliberately never did: it goes through the
	// scanner's SSRF-hardened fetch context and is gated by the same operator flag as the
	// job scanner, since both are "the server fetches URLs users typed".
	autofillFromUrl: protectedProcedure
		.route({
			method: "POST",
			path: "/applications/ai/autofill-from-url",
			operationId: "aiAutofillApplicationFromUrl",
			...reserved,
		})
		.input(
			z.object({
				url: z
					.string()
					.trim()
					.pipe(z.url({ protocol: /^https$/ })),
			}),
		)
		.use(aiRequestRateLimit)
		.output(autofillOutput.extend({ jobDescription: z.string() }))
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			if (env.FLAG_DISABLE_JOB_SCANNER) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Fetching job posting URLs is disabled on this server (FLAG_DISABLE_JOB_SCANNER).",
				});
			}

			const fetchContext = createFetchContext();
			let text: string;
			try {
				const html = await fetchContext.fetchText(input.url);
				text = htmlToText(html).slice(0, MAX_PASTED_JOB_DESCRIPTION_CHARS);
			} catch (error) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Could not fetch that URL. Paste the job description text instead.",
					cause: error,
				});
			}
			if (text.trim().length < 100) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"That page returned too little readable text (it may need JavaScript). Paste the job description instead.",
				});
			}

			const { model } = await resolveModelForFeature(context.user.id, "autofill");
			const fields = await generateJson(
				model,
				{
					prompt: `Extract the following fields from this job posting. Return ONLY JSON with keys company, role, location, salary. Use an empty string for anything not stated.\n\nJOB POSTING:\n${text}`,
				},
				autofillOutput,
			);

			return { ...fields, jobDescription: text };
		}),

	// Quick match: score the linked resume against the application's job description.
	// Deterministic since the career upgrade — the three-bucket skill gap plus the weighted
	// keyword matcher, so it is instant, reproducible and needs NO AI provider. The deep
	// A–H analysis lives in `evaluations.start`. Route and output shape are unchanged.
	matchScore: protectedProcedure
		.route({
			method: "POST",
			path: "/applications/{id}/ai/match-score",
			operationId: "aiApplicationMatchScore",
			...reserved,
		})
		.input(z.object({ id: z.string() }))
		.use(aiRequestRateLimit)
		.output(matchScoreOutput)
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			const application = await applicationService.getById({ id: input.id, userId: context.user.id });
			if (!application.resumeId)
				throw new ORPCError("BAD_REQUEST", { message: "Link a resume to this application first." });
			if (!application.jobDescription) {
				throw new ORPCError("BAD_REQUEST", { message: "Paste the job description into this application first." });
			}

			const resume = await resumeService.getById({ id: application.resumeId, userId: context.user.id });

			const skillGap = computeSkillGap({ jobDescription: application.jobDescription, resume: resume.data });
			const texts = resumeSkillGapTexts(resume.data);
			const report = matchJobDescription({
				jobDescription: application.jobDescription,
				resumeText: `${texts.namedSkillsText}\n${texts.proseText}`,
			});

			const score = Math.round(report.weightedCoverage * 100);
			const gaps = [...new Set([...skillGap.gap, ...report.missingTerms])].slice(0, 8);
			const strengths = [
				...new Set([...skillGap.existing, ...skillGap.supportedByResume, ...report.matchedTerms]),
			].slice(0, 8);

			const result = {
				score,
				gaps,
				strengths,
				coverage: report.weightedCoverage,
				lowConfidence: skillGap.lowConfidence,
			};

			await applicationService.setAiResult({
				id: input.id,
				userId: context.user.id,
				matchScore: score,
				aiMetadata: { ...(application.aiMetadata ?? {}), matchScore: result, skillGap },
			});

			return result;
		}),

	// Generate a cover letter or recruiter follow-up from the application + resume context.
	draftMessage: protectedProcedure
		.route({
			method: "POST",
			path: "/applications/{id}/ai/draft-message",
			operationId: "aiDraftApplicationMessage",
			...reserved,
		})
		.input(z.object({ id: z.string(), kind: z.enum(["cover-letter", "follow-up"]) }))
		.use(aiRequestRateLimit)
		.output(z.object({ text: z.string(), coverLetterId: z.string().optional() }))
		.errors(aiErrors)
		.handler(async ({ context, input }) => {
			const application = await applicationService.getById({ id: input.id, userId: context.user.id });
			const { model } = await resolveModelForFeature(context.user.id, "outreach");
			const resume = application.resumeId
				? await resumeService.getById({ id: application.resumeId, userId: context.user.id }).catch(() => null)
				: null;

			const context_ = `ROLE: ${application.role} at ${application.company}${application.location ? ` (${application.location})` : ""}\n${application.jobDescription ? `JOB DESCRIPTION:\n${application.jobDescription}\n` : ""}${resume ? `CANDIDATE RESUME:\n${JSON.stringify(resume.data)}` : ""}`;

			const prompt =
				input.kind === "cover-letter"
					? `Write a concise, specific cover letter (250-350 words, no placeholders like [Name]) for this application, drawing on the resume. Return only the letter text.\n\n${context_}`
					: `Write a short, polite follow-up message (80-120 words) to a recruiter checking in on this application. Warm but not pushy. Return only the message text.\n\n${context_}`;

			const text = await generatePlainText(model, prompt);
			if (input.kind === "follow-up") return { text };
			const letter = await coverLetterService.create({
				userId: context.user.id,
				name: `${application.company} — ${application.role}`.slice(0, 100),
				content: coverLetterTextToHtml(text),
				applicationId: input.id,
				...(resume ? { resumeId: resume.id } : {}),
			});
			return { text, coverLetterId: letter.id };
		}),

	// Create a tailored copy of the linked resume and link it to the application. Since the
	// career upgrade this is the full pipeline — reuse gate, constrained plan, deterministic
	// compile, hard fact gate, versioned run — not a summary-only rewrite. Route and the
	// original output fields are unchanged; the extras are additive.
	tailorResume: protectedProcedure
		.route({
			method: "POST",
			path: "/applications/{id}/ai/tailor-resume",
			operationId: "aiTailorResumeForApplication",
			...reserved,
		})
		.input(z.object({ id: z.string() }))
		.use(aiRequestRateLimit)
		.output(
			z.object({
				resumeId: z.string(),
				name: z.string(),
				tailoringRunId: z.string().optional(),
				reused: z.boolean().optional(),
				factGate: factGateReportSchema.nullable().optional(),
			}),
		)
		.errors({
			...aiErrors,
			CONFLICT: { message: "A tailoring run is already in progress for this application.", status: 409 },
		})
		.handler(async ({ context, input }) => {
			const { runTailoring } = await import("../tailoring/pipeline");
			try {
				return await runTailoring({
					applicationId: input.id,
					userId: context.user.id,
					locale: context.locale,
				});
			} catch (error) {
				if (isAiProviderGatewayError(error)) throwAiProviderGatewayError(error);
				throw error;
			}
		}),
};
