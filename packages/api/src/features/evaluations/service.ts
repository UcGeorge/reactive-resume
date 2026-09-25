import type {
	CareerFactsProfile,
	CareerWorkAuthProfile,
	EvaluationBlocks,
	EvaluationRequirement,
	EvaluationStatus,
	EvaluationWorkAuth,
	LegitimacyTier,
	SkillGapResult,
} from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

type EvaluationRow = typeof schema.evaluation.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

export const evaluationsService = {
	getById: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.select()
			.from(schema.evaluation)
			.where(and(eq(schema.evaluation.id, input.id), eq(schema.evaluation.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	listByApplication: async (input: { applicationId: string; userId: string }) => {
		const rows = await db
			.select()
			.from(schema.evaluation)
			.where(and(eq(schema.evaluation.applicationId, input.applicationId), eq(schema.evaluation.userId, input.userId)))
			.orderBy(desc(schema.evaluation.createdAt));
		return rows.map(stripUserId);
	},

	create: async (input: {
		userId: string;
		applicationId: string;
		resumeId: string;
		jdArchived: string;
		jdFingerprint: string | null;
		skillGap: SkillGapResult;
	}) => {
		const [row] = await db
			.insert(schema.evaluation)
			.values({
				userId: input.userId,
				applicationId: input.applicationId,
				resumeId: input.resumeId,
				status: "pending",
				jdArchived: input.jdArchived,
				jdFingerprint: input.jdFingerprint,
				skillGap: input.skillGap,
			})
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the evaluation." });
		return stripUserId(row);
	},

	/** Internal (pipeline) update — not exposed as a procedure. */
	update: async (input: {
		id: string;
		userId: string;
		status?: EvaluationStatus;
		error?: string | null;
		score?: number | null;
		archetype?: string | null;
		legitimacy?: LegitimacyTier | null;
		workAuth?: EvaluationWorkAuth | null;
		advertisedComp?: string | null;
		requirements?: EvaluationRequirement[] | null;
		blocks?: EvaluationBlocks | null;
		provider?: string | null;
		model?: string | null;
	}): Promise<EvaluationRow> => {
		const { id, userId, ...fields } = input;
		const [row] = await db
			.update(schema.evaluation)
			.set(fields)
			.where(and(eq(schema.evaluation.id, id), eq(schema.evaluation.userId, userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return row;
	},

	delete: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.delete(schema.evaluation)
			.where(and(eq(schema.evaluation.id, input.id), eq(schema.evaluation.userId, input.userId)))
			.returning({ id: schema.evaluation.id });
		if (!row) throw new ORPCError("NOT_FOUND");
	},

	/** The user's career profile, or null before they have saved one. */
	getCareerProfile: async (input: { userId: string }) => {
		const [row] = await db
			.select()
			.from(schema.careerProfile)
			.where(eq(schema.careerProfile.userId, input.userId))
			.limit(1);
		return row ?? null;
	},

	upsertCareerProfile: async (input: {
		userId: string;
		workAuth?: CareerWorkAuthProfile | null | undefined;
		facts?: CareerFactsProfile | null | undefined;
	}) => {
		const { userId, ...fields } = input;
		const [row] = await db
			.insert(schema.careerProfile)
			.values({ userId, ...fields })
			.onConflictDoUpdate({ target: schema.careerProfile.userId, set: fields })
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not save the career profile." });
		return stripUserId(row);
	},
};
