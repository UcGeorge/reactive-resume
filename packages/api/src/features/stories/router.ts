import { ORPCError } from "@orpc/client";
import z from "zod";
import { resumeDataToFactTexts } from "@reactive-resume/career/fact-gate";
import { checkStoryProvenance, matchStories } from "@reactive-resume/career/stories";
import { protectedProcedure } from "../../context";
import { storyDto } from "../../dto/story";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { generateJson } from "../ai/generate-json";
import { getModel } from "../ai/service";
import { aiProvidersService } from "../ai-providers/service";
import { evaluationsService } from "../evaluations/service";
import { resumeService } from "../resume/service";
import { storiesService } from "./service";

const reserved = { tags: ["Stories"] } as const;

const storyErrors = {
	BAD_GATEWAY: { message: "The AI provider returned an error or is unreachable.", status: 502 },
	BAD_REQUEST: { message: "Invalid story request.", status: 400 },
	NOT_FOUND: { message: "Story not found.", status: 404 },
};

async function resolveModel(userId: string) {
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

const suggestedStoriesOutput = z.object({
	stories: z
		.array(
			z.object({
				title: z.string(),
				theme: z.string().catch(""),
				situation: z.string().catch(""),
				task: z.string().catch(""),
				action: z.string().catch(""),
				result: z.string().catch(""),
				reflection: z.string().catch(""),
				tags: z.array(z.string()).catch([]),
			}),
		)
		.catch([])
		.transform((values) => values.slice(0, 6)),
});

export const storiesRouter = {
	list: protectedProcedure
		.route({ method: "GET", path: "/stories", operationId: "listStories", ...reserved })
		.input(storyDto.list.input)
		.output(storyDto.list.output)
		.errors(storyErrors)
		.handler(({ context }) => storiesService.list({ userId: context.user.id })),

	get: protectedProcedure
		.route({ method: "GET", path: "/stories/{id}", operationId: "getStory", ...reserved })
		.input(storyDto.get.input)
		.output(storyDto.get.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			const { userId: _userId, ...rest } = await storiesService.getById({ id: input.id, userId: context.user.id });
			return rest;
		}),

	create: protectedProcedure
		.route({ method: "POST", path: "/stories", operationId: "createStory", ...reserved })
		.input(storyDto.create.input)
		.output(storyDto.create.output)
		.errors(storyErrors)
		.handler(({ context, input }) => storiesService.create({ userId: context.user.id, ...input })),

	update: protectedProcedure
		.route({ method: "PATCH", path: "/stories/{id}", operationId: "updateStory", ...reserved })
		.input(storyDto.update.input)
		.output(storyDto.update.output)
		.errors(storyErrors)
		.handler(({ context, input }) => storiesService.update({ userId: context.user.id, ...input })),

	delete: protectedProcedure
		.route({ method: "DELETE", path: "/stories/{id}", operationId: "deleteStory", ...reserved })
		.input(storyDto.delete.input)
		.output(storyDto.delete.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			await storiesService.delete({ id: input.id, userId: context.user.id });
		}),

	// Deterministic provenance re-check against the linked resume: can suggest an upgrade
	// to resume-verified, lists unverified claims for the user to resolve, and never
	// touches the durable states — the user decides, the check only reports.
	checkProvenance: protectedProcedure
		.route({ method: "POST", path: "/stories/{id}/check-provenance", operationId: "checkStoryProvenance", ...reserved })
		.input(storyDto.checkProvenance.input)
		.output(storyDto.checkProvenance.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			const story = await storiesService.getById({ id: input.id, userId: context.user.id });
			const source = story.sourceResumeId
				? await resumeService.getById({ id: story.sourceResumeId, userId: context.user.id }).catch(() => null)
				: null;
			return checkStoryProvenance({
				story: {
					situation: story.situation,
					task: story.task,
					action: story.action,
					result: story.result,
					reflection: story.reflection,
				},
				sourceText: source ? resumeDataToFactTexts(source.data) : null,
				current: story.provenance,
			});
		}),

	// Deterministic story↔question matcher; the JD-term boost comes from the application's
	// latest evaluation when one is named.
	match: protectedProcedure
		.route({ method: "POST", path: "/stories/match", operationId: "matchStoryToQuestion", ...reserved })
		.input(storyDto.match.input)
		.output(storyDto.match.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			const stories = await storiesService.list({ userId: context.user.id });
			let jdTerms: string[] | undefined;
			if (input.applicationId) {
				const evaluations = await evaluationsService.listByApplication({
					applicationId: input.applicationId,
					userId: context.user.id,
				});
				const latest = evaluations.find((evaluation) => evaluation.status === "complete");
				jdTerms = latest?.requirements?.map((row) => row.requirement) ?? undefined;
			}
			const ranked = matchStories({
				question: input.question,
				stories: stories.map((story) => ({
					id: story.id,
					title: story.title,
					theme: story.theme,
					tags: story.tags,
					situation: story.situation,
					task: story.task,
					action: story.action,
					result: story.result,
					reflection: story.reflection,
				})),
				...(jdTerms ? { jdTerms } : {}),
			});
			const byId = new Map(stories.map((story) => [story.id, story]));
			return ranked.flatMap((entry) => {
				const story = byId.get(entry.id);
				return story ? [{ id: entry.id, score: entry.score, reasons: entry.reasons, story }] : [];
			});
		}),

	// LLM extraction of STAR+R candidates from a resume — created as derived-unverified
	// drafts awaiting user confirmation, never as established facts.
	suggestFromResume: protectedProcedure
		.route({
			method: "POST",
			path: "/stories/suggest-from-resume",
			operationId: "suggestStoriesFromResume",
			...reserved,
		})
		.input(storyDto.suggestFromResume.input)
		.use(aiRequestRateLimit)
		.output(storyDto.suggestFromResume.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			const [model, resume] = await Promise.all([
				resolveModel(context.user.id),
				resumeService.getById({ id: input.resumeId, userId: context.user.id }),
			]);
			const suggested = suggestedStoriesOutput.parse(
				await generateJson(
					model,
					{
						prompt: [
							`Extract up to 5 STAR+Reflection interview story candidates from this resume. Return ONLY JSON {"stories":[{"title","theme","situation","task","action","result","reflection","tags":["best-for topics"]}]}. Use only facts the resume states — never invent metrics, scope or outcomes. Each story is grounded in one real project or role.`,
							`RESUME:\n${JSON.stringify(resume.data)}`,
						].join("\n\n"),
					},
					suggestedStoriesOutput,
				),
			);
			const created = [];
			for (const candidate of suggested.stories) {
				created.push(
					await storiesService.create({
						userId: context.user.id,
						...candidate,
						provenance: "derived-unverified",
						sourceResumeId: input.resumeId,
					}),
				);
			}
			return { created: created.length, stories: created };
		}),

	// Story stubs from an evaluation's interview plan (Block F): each planned question
	// becomes a stub the user fills — the plan knows what will be probed, not the answers.
	suggestFromEvaluation: protectedProcedure
		.route({
			method: "POST",
			path: "/stories/suggest-from-evaluation",
			operationId: "suggestStoriesFromEvaluation",
			...reserved,
		})
		.input(storyDto.suggestFromEvaluation.input)
		.output(storyDto.suggestFromEvaluation.output)
		.errors(storyErrors)
		.handler(async ({ context, input }) => {
			const evaluation = await evaluationsService.getById({ id: input.evaluationId, userId: context.user.id });
			const plan = evaluation.blocks?.interviewPlan ?? [];
			if (plan.length === 0) {
				throw new ORPCError("BAD_REQUEST", { message: "This evaluation has no interview plan to draw from." });
			}
			const created = [];
			for (const entry of plan.slice(0, 6)) {
				created.push(
					await storiesService.create({
						userId: context.user.id,
						title: entry.competency || entry.question.slice(0, 60),
						theme: entry.competency,
						situation: "",
						task: "",
						action: "",
						result: "",
						reflection: entry.hint ?? "",
						tags: [entry.question],
						provenance: "derived-unverified",
						sourceApplicationId: evaluation.applicationId,
					}),
				);
			}
			return { created: created.length, stories: created };
		}),
};
