import { createSelectSchema } from "drizzle-zod";
import z from "zod";
import * as schema from "@reactive-resume/db/schema";
import {
	auditReportSchema,
	careerFactsProfileSchema,
	careerWorkAuthProfileSchema,
	evaluationBlocksSchema,
	evaluationRequirementSchema,
	evaluationStatusSchema,
	evaluationWorkAuthSchema,
	factGateReportSchema,
	legitimacyTierSchema,
	reuseDecisionSchema,
	scannerSettingsSchema,
	skillGapResultSchema,
	tailoringChangeSchema,
	tailoringOperationSchema,
	tailoringStatusSchema,
} from "@reactive-resume/schema/career/data";

const evaluationSchema = createSelectSchema(schema.evaluation, {
	id: z.string().describe("The ID of the evaluation."),
	applicationId: z.string().describe("The application this evaluation belongs to."),
	resumeId: z.string().nullable().describe("The resume evaluated against, if it still exists."),
	status: evaluationStatusSchema.describe("The pipeline status of this evaluation."),
	error: z.string().nullable(),
	score: z.number().min(1).max(5).nullable().describe("The holistic 1-5 score; 4.0 is the apply line."),
	archetype: z.string().nullable(),
	legitimacy: legitimacyTierSchema.nullable(),
	workAuth: evaluationWorkAuthSchema.nullable(),
	advertisedComp: z.string().nullable().describe("The posting's own advertised figure, verbatim."),
	requirements: z.array(evaluationRequirementSchema).nullable(),
	blocks: evaluationBlocksSchema.nullable(),
	skillGap: skillGapResultSchema.nullable(),
	jdArchived: z.string().describe("The job description snapshotted verbatim at evaluation time."),
	jdFingerprint: z.string().nullable(),
	provider: z.string().nullable(),
	model: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const evaluationOutput = evaluationSchema.omit({ userId: true });

const careerProfileSchema = createSelectSchema(schema.careerProfile, {
	id: z.string(),
	workAuth: careerWorkAuthProfileSchema.nullable(),
	facts: careerFactsProfileSchema.nullable(),
	scanner: scannerSettingsSchema.nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const careerProfileOutput = careerProfileSchema.omit({ userId: true });

const tailoringRunSchema = createSelectSchema(schema.tailoringRun, {
	id: z.string(),
	applicationId: z.string(),
	evaluationId: z.string().nullable(),
	sourceResumeId: z.string().nullable(),
	tailoredResumeId: z.string().nullable(),
	version: z.number().int().min(1),
	status: tailoringStatusSchema,
	error: z.string().nullable(),
	reuseDecision: reuseDecisionSchema.nullable(),
	plan: z.array(tailoringOperationSchema).nullable(),
	operations: z.array(z.unknown()).nullable(),
	changes: z.array(tailoringChangeSchema).nullable(),
	factGateReport: factGateReportSchema.nullable(),
	auditReport: auditReportSchema.nullable(),
	jdArchived: z.string(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const tailoringRunOutput = tailoringRunSchema.omit({ userId: true });

export const tailoringDto = {
	list: {
		input: z.object({ applicationId: z.string() }),
		output: z.array(tailoringRunOutput),
	},
	get: {
		input: z.object({ id: z.string() }),
		output: tailoringRunOutput,
	},
	discard: {
		input: z.object({ id: z.string() }),
		output: z.void(),
	},
	audit: {
		input: z.object({ tailoringRunId: z.string() }),
		output: auditReportSchema,
	},
	factCheck: {
		input: z.object({ resumeId: z.string() }),
		output: factGateReportSchema.extend({
			sourceResumeId: z.string(),
			tailoringRunId: z.string(),
		}),
	},
};

export const evaluationDto = {
	start: {
		input: z.object({ applicationId: z.string() }),
		output: evaluationOutput,
	},

	get: {
		input: z.object({ id: z.string() }),
		output: evaluationOutput,
	},

	listByApplication: {
		input: z.object({ applicationId: z.string() }),
		output: z.array(evaluationOutput),
	},

	retry: {
		input: z.object({ id: z.string() }),
		output: evaluationOutput,
	},

	delete: {
		input: z.object({ id: z.string() }),
		output: z.void(),
	},

	getCareerProfile: {
		input: z.object({}).optional().default({}),
		output: careerProfileOutput.nullable(),
	},

	updateCareerProfile: {
		input: z.object({
			workAuth: careerWorkAuthProfileSchema.nullable().optional(),
			facts: careerFactsProfileSchema.nullable().optional(),
		}),
		output: careerProfileOutput,
	},
};
