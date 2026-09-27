import { ORPCError } from "@orpc/client";
import z from "zod";
import { coverLetterGuidedSystemPrompt } from "@reactive-resume/ai/prompts";
import { resumeDataToFactTexts, verifyFacts } from "@reactive-resume/career/fact-gate";
import { computeSkillGap, resumeSkillGapTexts } from "@reactive-resume/career/skill-gap";
import { matchJobDescription, normalizeForMatching } from "@reactive-resume/resume/ats-pdf/jd";
import { factGateReportSchema } from "@reactive-resume/schema/career/data";
import { protectedProcedure } from "../../context";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { generateJson } from "../ai/generate-json";
import { resolveModelForFeature } from "../ai/resolve-model";
import { applicationService } from "../applications/service";
import { evaluationsService } from "../evaluations/service";
import { resumeService } from "../resume/service";

/**
 * The gated cover-letter flow (career-ops `cover.md`): four mandatory prompts, a gap
 * conversation, and achievements taken verbatim from the linked resume. The gate lives in
 * this procedure's input schema and its verbatim-achievement check, so "just generate it"
 * cannot bypass it whatever client calls the API. Drafting returns text only — saving the
 * letter is the user's explicit approval step, through the ordinary create procedure.
 */

const reserved = { tags: ["Cover Letters", "AI"] } as const;

const guidedErrors = {
	BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
	BAD_REQUEST: { message: "Invalid guided cover-letter request.", status: 400 },
};

async function resolveModel(userId: string) {
	return (await resolveModelForFeature(userId, "cover-letter")).model;
}

const gapHandlingSchema = z.enum(["address", "adjacent", "omit"]);

const suggestOutput = z.object({
	angles: z.object({
		whyCompany: z.array(z.string()).catch([]),
		problem: z.array(z.string()).catch([]),
		approach: z.array(z.string()).catch([]),
		tone: z.array(z.string()).catch([]),
	}),
});

const mandatoryAnswer = z
	.string()
	.trim()
	.min(20, "Answer all four prompts before drafting (at least a sentence each).");

export const guidedCoverLetterRouter = {
	// Step material: deterministic keywords + gaps, plus LLM-suggested angles per prompt.
	suggestAngles: protectedProcedure
		.route({
			method: "POST",
			path: "/cover-letters/guided/suggest",
			operationId: "suggestGuidedCoverLetterAngles",
			...reserved,
		})
		.input(z.object({ applicationId: z.string() }))
		.use(aiRequestRateLimit)
		.output(
			z.object({
				keywords: z.array(z.string()),
				gaps: z.array(z.string()),
				achievements: z.array(z.string()),
				angles: suggestOutput.shape.angles,
			}),
		)
		.errors(guidedErrors)
		.handler(async ({ context, input }) => {
			const application = await applicationService.getById({ id: input.applicationId, userId: context.user.id });
			if (!application.jobDescription) {
				throw new ORPCError("BAD_REQUEST", { message: "Paste the job description into this application first." });
			}
			if (!application.resumeId) {
				throw new ORPCError("BAD_REQUEST", { message: "Link a resume to this application first." });
			}
			const resume = await resumeService.getById({ id: application.resumeId, userId: context.user.id });

			// Deterministic halves: confirmed-keyword candidates and the gap conversation.
			const texts = resumeSkillGapTexts(resume.data);
			const report = matchJobDescription({
				jobDescription: application.jobDescription,
				resumeText: `${texts.namedSkillsText}\n${texts.proseText}`,
			});
			const skillGap = computeSkillGap({ jobDescription: application.jobDescription, resume: resume.data });

			// Achievement candidates: the resume's own bullet lines, verbatim.
			const achievements = texts.proseText
				.split("\n")
				.map((line) => line.replace(/^[-*•]\s*/, "").trim())
				.filter((line) => line.length >= 30)
				.slice(0, 40);

			const model = await resolveModel(context.user.id);
			const suggested = suggestOutput.parse(
				await generateJson(
					model,
					{
						prompt: [
							`Suggest angles for a cover letter's guided intake. Return ONLY JSON {"angles":{"whyCompany":["…2-3 short angle suggestions…"],"problem":[…],"approach":[…],"tone":["e.g. direct and technical","warm and curious"]}}. Ground every suggestion in the posting below; no invented company facts.`,
							`ROLE: ${application.role} at ${application.company}`,
							`JOB DESCRIPTION:\n${application.jobDescription}`,
						].join("\n\n"),
					},
					suggestOutput,
				),
			);

			return {
				keywords: [...report.matchedTerms, ...report.missingTerms].slice(0, 20),
				gaps: skillGap.gap,
				achievements,
				angles: suggested.angles,
			};
		}),

	// The gated draft. All four prompts are required by the schema; achievements must appear
	// verbatim in the linked resume; gap answers must cover every gap surfaced at suggest
	// time that the client passes through. Returns text + fact-gate warnings; saving is a
	// separate, explicit act.
	draft: protectedProcedure
		.route({
			method: "POST",
			path: "/cover-letters/guided/draft",
			operationId: "draftGuidedCoverLetter",
			...reserved,
		})
		.input(
			z.object({
				applicationId: z.string(),
				research: z.string().trim().max(4000).nullable(),
				keywords: z.array(z.string()).min(1, "Confirm at least one keyword.").max(25),
				gapAnswers: z.array(z.object({ gap: z.string(), handling: gapHandlingSchema })).max(20),
				whyCompany: mandatoryAnswer,
				problem: mandatoryAnswer,
				approach: mandatoryAnswer,
				tone: z.string().trim().min(3, "Pick a tone."),
				selectedAchievements: z.array(z.string().trim().min(10)).min(1, "Select at least one achievement.").max(10),
				recipient: z.string().trim().max(120).optional(),
			}),
		)
		.use(aiRequestRateLimit)
		.output(z.object({ letter: z.string(), factGate: factGateReportSchema, words: z.number() }))
		.errors(guidedErrors)
		.handler(async ({ context, input }) => {
			const application = await applicationService.getById({ id: input.applicationId, userId: context.user.id });
			if (!application.jobDescription || !application.resumeId) {
				throw new ORPCError("BAD_REQUEST", { message: "The application needs a job description and a linked resume." });
			}
			const resume = await resumeService.getById({ id: application.resumeId, userId: context.user.id });

			// Verbatim enforcement: every selected achievement must exist in the resume text.
			const resumeText = normalizeForMatching(resumeDataToFactTexts(resume.data));
			for (const achievement of input.selectedAchievements) {
				if (!resumeText.includes(normalizeForMatching(achievement))) {
					throw new ORPCError("BAD_REQUEST", {
						message: `This achievement is not in the linked resume verbatim: "${achievement.slice(0, 80)}…"`,
					});
				}
			}

			const [model, profile] = await Promise.all([
				resolveModel(context.user.id),
				evaluationsService.getCareerProfile({ userId: context.user.id }),
			]);

			const { letter } = await generateJson(
				model,
				{
					system: coverLetterGuidedSystemPrompt,
					prompt: [
						`LOCALE: write prose in ${context.locale || "en-US"}.`,
						`ROLE: ${application.role} at ${application.company}`,
						input.recipient ? `RECIPIENT: ${input.recipient}` : "RECIPIENT: none known.",
						`WHY THIS COMPANY (user's answer): ${input.whyCompany}`,
						`PROBLEM TO SOLVE (user's answer): ${input.problem}`,
						`APPROACH (user's answer): ${input.approach}`,
						`TONE: ${input.tone}`,
						input.research ? `COMPANY RESEARCH (user-confirmed): ${input.research}` : "COMPANY RESEARCH: none.",
						`CONFIRMED KEYWORDS: ${input.keywords.join(", ")}`,
						input.gapAnswers.length > 0
							? `GAP HANDLING:\n${input.gapAnswers.map((entry) => `- ${entry.gap}: ${entry.handling}`).join("\n")}`
							: "GAP HANDLING: none surfaced.",
						`SELECTED ACHIEVEMENTS (verbatim, the only claim material):\n${input.selectedAchievements
							.map((achievement) => `- ${achievement}`)
							.join("\n")}`,
						profile?.voiceNotes ? `VOICE NOTES (style only): ${profile.voiceNotes}` : "",
						`JOB DESCRIPTION:\n${application.jobDescription}`,
					]
						.filter(Boolean)
						.join("\n\n"),
				},
				z.object({ letter: z.string().min(200) }),
			);

			// Warning layer, not a gate: the letter is the user's own composition to approve.
			const factGate = verifyFacts({
				candidate: letter,
				sources: [{ label: "source resume", text: resumeDataToFactTexts(resume.data) }],
				...(profile?.facts ? { allow: profile.facts } : {}),
			});

			return { letter, factGate, words: letter.split(/\s+/).filter(Boolean).length };
		}),
};
