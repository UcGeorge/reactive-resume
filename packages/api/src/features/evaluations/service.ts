import type {
	CadenceSettings,
	CareerFactsProfile,
	CareerWorkAuthProfile,
	EvaluationBlocks,
	EvaluationRequirement,
	EvaluationStatus,
	EvaluationWorkAuth,
	LegitimacyTier,
	ScannerSettings,
	SkillGapResult,
} from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

type EvaluationRow = typeof schema.evaluation.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

/** A pending/running evaluation untouched for this long can no longer finish: on serverless
 * the Function hosting it was killed at its duration cap (so the pipeline's own catch never
 * ran); under the queue worker, pg-boss retries have long since given up. */
const STALE_EVALUATION_MS = process.env.VERCEL === "1" ? 6 * 60 * 1000 : 30 * 60 * 1000;

const STALE_EVALUATION_MESSAGE =
	"The evaluation stopped before finishing — the AI provider was likely too slow. Run it again, or switch to a faster model.";

/** Lazily fail the user's evaluations that were orphaned mid-run, so none spins forever. */
async function failStaleEvaluations(userId: string): Promise<void> {
	await db
		.update(schema.evaluation)
		.set({ status: "failed", error: STALE_EVALUATION_MESSAGE })
		.where(
			and(
				eq(schema.evaluation.userId, userId),
				inArray(schema.evaluation.status, ["pending", "running"]),
				lt(schema.evaluation.updatedAt, new Date(Date.now() - STALE_EVALUATION_MS)),
			),
		);
}

export const evaluationsService = {
	getById: async (input: { id: string; userId: string }) => {
		await failStaleEvaluations(input.userId);
		const [row] = await db
			.select()
			.from(schema.evaluation)
			.where(and(eq(schema.evaluation.id, input.id), eq(schema.evaluation.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	listByApplication: async (input: { applicationId: string; userId: string }) => {
		await failStaleEvaluations(input.userId);
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
		scanner?: ScannerSettings | null | undefined;
		cadence?: CadenceSettings | null | undefined;
		voiceNotes?: string | null | undefined;
		emailDigest?: boolean | undefined;
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
