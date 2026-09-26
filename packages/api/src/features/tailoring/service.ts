import type {
	AuditReport,
	FactGateReportData,
	ReuseDecision,
	TailoringChange,
	TailoringOperation,
	TailoringStatus,
} from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

type TailoringRunRow = typeof schema.tailoringRun.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

export const tailoringService = {
	getById: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.select()
			.from(schema.tailoringRun)
			.where(and(eq(schema.tailoringRun.id, input.id), eq(schema.tailoringRun.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	listByApplication: async (input: { applicationId: string; userId: string }) => {
		const rows = await db
			.select()
			.from(schema.tailoringRun)
			.where(
				and(eq(schema.tailoringRun.applicationId, input.applicationId), eq(schema.tailoringRun.userId, input.userId)),
			)
			.orderBy(desc(schema.tailoringRun.createdAt));
		return rows.map(stripUserId);
	},

	/** The newest run for an application, or null — the reuse gate reads this. */
	latestForApplication: async (input: { applicationId: string; userId: string }): Promise<TailoringRunRow | null> => {
		const [row] = await db
			.select()
			.from(schema.tailoringRun)
			.where(
				and(eq(schema.tailoringRun.applicationId, input.applicationId), eq(schema.tailoringRun.userId, input.userId)),
			)
			.orderBy(desc(schema.tailoringRun.createdAt))
			.limit(1);
		return row ?? null;
	},

	create: async (input: {
		userId: string;
		applicationId: string;
		evaluationId?: string | null | undefined;
		sourceResumeId: string;
		jdArchived: string;
		reuseDecision?: ReuseDecision | null | undefined;
	}): Promise<TailoringRunRow> => {
		// v001..vNNN per application, atomically: next version = count of prior runs + 1.
		const [{ count }] = (await db
			.select({ count: sql<number>`count(*)::int` })
			.from(schema.tailoringRun)
			.where(
				and(eq(schema.tailoringRun.applicationId, input.applicationId), eq(schema.tailoringRun.userId, input.userId)),
			)) as [{ count: number }];

		const [row] = await db
			.insert(schema.tailoringRun)
			.values({
				userId: input.userId,
				applicationId: input.applicationId,
				evaluationId: input.evaluationId ?? null,
				sourceResumeId: input.sourceResumeId,
				version: count + 1,
				status: "pending",
				jdArchived: input.jdArchived,
				reuseDecision: input.reuseDecision ?? null,
			})
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the tailoring run." });
		return row;
	},

	update: async (input: {
		id: string;
		userId: string;
		status?: TailoringStatus;
		error?: string | null;
		tailoredResumeId?: string | null;
		plan?: TailoringOperation[] | null;
		operations?: unknown[] | null;
		changes?: TailoringChange[] | null;
		factGateReport?: FactGateReportData | null;
		auditReport?: AuditReport | null;
	}): Promise<TailoringRunRow> => {
		const { id, userId, ...fields } = input;
		const [row] = await db
			.update(schema.tailoringRun)
			.set(fields)
			.where(and(eq(schema.tailoringRun.id, id), eq(schema.tailoringRun.userId, userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return row;
	},

	/** The run that produced a given tailored resume, or null — the fact-check badge's source lookup. */
	findByTailoredResume: async (input: { resumeId: string; userId: string }): Promise<TailoringRunRow | null> => {
		const [row] = await db
			.select()
			.from(schema.tailoringRun)
			.where(
				and(eq(schema.tailoringRun.tailoredResumeId, input.resumeId), eq(schema.tailoringRun.userId, input.userId)),
			)
			.orderBy(desc(schema.tailoringRun.createdAt))
			.limit(1);
		return row ?? null;
	},
};
