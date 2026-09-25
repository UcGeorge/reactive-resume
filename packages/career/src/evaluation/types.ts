import type {
	evaluationRequirementSchema,
	requirementImportanceSchema,
	requirementMatchSchema,
} from "@reactive-resume/schema/career/data";
import type z from "zod";

export type EvaluationRequirement = z.infer<typeof evaluationRequirementSchema>;
export type RequirementImportance = z.infer<typeof requirementImportanceSchema>;
export type RequirementMatch = z.infer<typeof requirementMatchSchema>;
