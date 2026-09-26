import { createSelectSchema } from "drizzle-zod";
import z from "zod";
import * as schema from "@reactive-resume/db/schema";
import { storyProvenanceSchema } from "@reactive-resume/schema/career/data";

const storySchema = createSelectSchema(schema.story, {
	id: z.string(),
	title: z.string().trim().min(1),
	theme: z.string(),
	situation: z.string(),
	task: z.string(),
	action: z.string(),
	result: z.string(),
	reflection: z.string(),
	provenance: storyProvenanceSchema,
	tags: z.array(z.string()),
	sourceResumeId: z.string().nullable(),
	sourceApplicationId: z.string().nullable(),
	lastUsedAt: z.date().nullable(),
	timesUsed: z.number().int(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const storyOutput = storySchema.omit({ userId: true });

const editableFields = z.object({
	title: storySchema.shape.title,
	theme: z.string().trim().max(120).optional(),
	situation: z.string().trim().max(4000).optional(),
	task: z.string().trim().max(4000).optional(),
	action: z.string().trim().max(4000).optional(),
	result: z.string().trim().max(4000).optional(),
	reflection: z.string().trim().max(4000).optional(),
	tags: z.array(z.string().trim().min(1)).max(20).optional(),
	provenance: storyProvenanceSchema.optional(),
	sourceResumeId: z.string().nullable().optional(),
	sourceApplicationId: z.string().nullable().optional(),
});

export const storyDto = {
	list: {
		input: z.object({}).optional().default({}),
		output: z.array(storyOutput),
	},
	get: {
		input: z.object({ id: z.string() }),
		output: storyOutput,
	},
	create: {
		input: editableFields,
		output: storyOutput,
	},
	update: {
		input: editableFields.partial().extend({ id: z.string(), title: storySchema.shape.title.optional() }),
		output: storyOutput,
	},
	delete: {
		input: z.object({ id: z.string() }),
		output: z.void(),
	},
	checkProvenance: {
		input: z.object({ id: z.string() }),
		output: z.object({
			suggested: storyProvenanceSchema,
			verifiedClaims: z.array(z.string()),
			unverifiedClaims: z.array(z.string()),
			reasons: z.array(z.string()),
		}),
	},
	match: {
		input: z.object({ question: z.string().trim().min(3), applicationId: z.string().optional() }),
		output: z.array(
			z.object({
				id: z.string(),
				score: z.number(),
				reasons: z.array(z.string()),
				story: storyOutput,
			}),
		),
	},
	suggestFromResume: {
		input: z.object({ resumeId: z.string() }),
		output: z.object({ created: z.number(), stories: z.array(storyOutput) }),
	},
	suggestFromEvaluation: {
		input: z.object({ evaluationId: z.string() }),
		output: z.object({ created: z.number(), stories: z.array(storyOutput) }),
	},
};
