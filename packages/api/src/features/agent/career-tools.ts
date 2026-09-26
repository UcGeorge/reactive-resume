import type { ToolSet } from "ai";
import { tool } from "ai";
import z from "zod";
import { matchStories } from "@reactive-resume/career/stories";
import { applicationService } from "../applications/service";
import { evaluationsService } from "../evaluations/service";
import { storiesService } from "../stories/service";

/**
 * The interview-practice toolset merged into the agent through the `extraTools` seam: the
 * agent can read and save STAR+Reflection stories and pull the evaluation brief for a
 * target application. Grounding rules ride the tool descriptions — a story saved through
 * here always lands `derived-unverified` until the user confirms it, and the matcher is the
 * deterministic scorer, so the model picks among grounded candidates rather than free-associating.
 */
export function buildCareerAgentTools(userId: string): ToolSet {
	return {
		list_stories: tool({
			description:
				"List the user's interview story bank: titles, themes, routing tags and provenance. Use read_story for a story's full STAR+Reflection text.",
			inputSchema: z.object({}),
			execute: async () => {
				const stories = await storiesService.list({ userId });
				return stories.map((story) => ({
					id: story.id,
					title: story.title,
					theme: story.theme,
					tags: story.tags,
					provenance: story.provenance,
				}));
			},
		}),
		read_story: tool({
			description: "Read one story's full STAR+Reflection content by id.",
			inputSchema: z.object({ id: z.string() }),
			execute: async ({ id }) => {
				const story = await storiesService.getById({ id, userId });
				const { userId: _userId, ...rest } = story;
				return rest;
			},
		}),
		save_story: tool({
			description:
				"Save a new STAR+Reflection story to the bank. Use the user's own words from this conversation. NEVER invent numbers, employers or scope — a number the user did not state does not exist. Saved stories are marked derived-unverified until the user confirms them.",
			inputSchema: z.object({
				title: z.string().min(1),
				theme: z.string().default(""),
				situation: z.string().default(""),
				task: z.string().default(""),
				action: z.string().default(""),
				result: z.string().default(""),
				reflection: z.string().default(""),
				tags: z.array(z.string()).default([]),
			}),
			execute: async (input) => {
				const story = await storiesService.create({ userId, ...input, provenance: "derived-unverified" });
				return { id: story.id, provenance: story.provenance };
			},
		}),
		get_application_brief: tool({
			description:
				"Read the interview brief for one application: role, company, current stage, and — when a deep evaluation exists — its score, hard stops, gaps with mitigations, top strengths and planned interview questions.",
			inputSchema: z.object({ applicationId: z.string() }),
			execute: async ({ applicationId }) => {
				const application = await applicationService.getById({ id: applicationId, userId });
				const evaluations = await evaluationsService.listByApplication({ applicationId, userId });
				const latest = evaluations.find((evaluation) => evaluation.status === "complete");
				return {
					role: application.role,
					company: application.company,
					stage: application.status,
					evaluation: latest
						? {
								score: latest.score,
								decision: latest.blocks?.finalDecision ?? null,
								hardStops: latest.blocks?.hardStops ?? [],
								gaps: latest.blocks?.gaps ?? [],
								topStrengths: latest.blocks?.topStrengths ?? [],
								interviewPlan: latest.blocks?.interviewPlan ?? [],
							}
						: null,
				};
			},
		}),
		match_story_to_question: tool({
			description:
				"Deterministically rank the user's stories against an interview question (tag hits, token overlap, optional JD-term boost). Returns the top candidates with reasons — pick among these, never invent a story.",
			inputSchema: z.object({ question: z.string().min(3), applicationId: z.string().optional() }),
			execute: async ({ question, applicationId }) => {
				const stories = await storiesService.list({ userId });
				let jdTerms: string[] | undefined;
				if (applicationId) {
					const evaluations = await evaluationsService.listByApplication({ applicationId, userId });
					const latest = evaluations.find((evaluation) => evaluation.status === "complete");
					jdTerms = latest?.requirements?.map((row) => row.requirement);
				}
				const ranked = matchStories({
					question,
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
				return ranked.slice(0, 3).map((entry: { id: string; score: number; reasons: string[] }) => ({
					id: entry.id,
					title: stories.find((story) => story.id === entry.id)?.title ?? "",
					score: entry.score,
					reasons: entry.reasons,
				}));
			},
		}),
	};
}
