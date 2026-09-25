import type { skillGapLowConfidenceSchema, skillGapResultSchema } from "@reactive-resume/schema/career/data";
import type z from "zod";

export type SkillGapLowConfidence = z.infer<typeof skillGapLowConfidenceSchema>;
export type SkillGapResult = z.infer<typeof skillGapResultSchema>;
