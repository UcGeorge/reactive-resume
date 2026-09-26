import type {
	AuditReport,
	FactGateReportData,
	ReuseDecision,
	TailoringChange,
	TailoringOperation,
	TailoringStatus,
} from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

type TailoringRunRow = typeof schema.tailoringRun.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

/** Statuses of a run whose request is still working. Mirrored by the partial unique index
 * `tailoring_run_in_flight_unique` in the schema, which is what makes "one run per
 * application at a time" atomic. */
const IN_FLIGHT_TAILORING_STATUSES = ["pending", "planned", "gated"] as const satisfies readonly TailoringStatus[];

/** An in-flight run untouched this long can no longer finish: its request died (on Vercel,
 * killed at the 300 s Function cap), which skips the pipeline's own failure bookkeeping. */
const STALE_TAILORING_MS = process.env.VERCEL === "1" ? 6 * 60 * 1000 : 15 * 60 * 1000;

/** Lazily fail the user's runs orphaned mid-flight, so none shows as running forever. */
async function failStaleRuns(userId: string): Promise<void> {
	await db
		.update(schema.tailoringRun)
		.set({
			status: "failed",
			error: "Tailoring stopped before finishing — the AI provider was likely too slow. Run it again.",
		})
		.where(
			and(
				eq(schema.tailoringRun.userId, userId),
				inArray(schema.tailoringRun.status, [...IN_FLIGHT_TAILORING_STATUSES]),
				lt(schema.tailoringRun.updatedAt, new Date(Date.now() - STALE_TAILORING_MS)),
			),
		);
}

export const tailoringService = {
	failStaleRuns,

	getById: async (input: { id: string; userId: string }) => {
		await failStaleRuns(input.userId);
		const [row] = await db
			.select()
			.from(schema.tailoringRun)
			.where(and(eq(schema.tailoringRun.id, input.id), eq(schema.tailoringRun.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	listByApplication: async (input: { applicationId: string; userId: string }) => {
		await failStaleRuns(input.userId);
		const rows = await db
			.select()
			.from(schema.tailoringRun)
			.where(
				and(eq(schema.tailoringRun.applicationId, input.applicationId), eq(schema.tailoringRun.userId, input.userId)),
			)
			.orderBy(desc(schema.tailoringRun.createdAt));
		return rows.map(stripUserId);
	},

	/** A run for this application that is still working, or null. */
	inFlightForApplication: async (input: { applicationId: string; userId: string }): Promise<TailoringRunRow | null> => {
		const [row] = await db
			.select()
			.from(schema.tailoringRun)
			.where(
				and(
					eq(schema.tailoringRun.applicationId, input.applicationId),
					eq(schema.tailoringRun.userId, input.userId),
					inArray(schema.tailoringRun.status, [...IN_FLIGHT_TAILORING_STATUSES]),
				),
			)
			.limit(1);
		return row ?? null;
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
