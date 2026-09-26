import type { CadenceConfig } from "@reactive-resume/career/cadence";
import type { FollowUpKind, FollowUpStatus } from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { DEFAULT_CADENCE, nextFollowUp } from "@reactive-resume/career/cadence";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { evaluationsService } from "../evaluations/service";

type FollowUpRow = typeof schema.followUp.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

function resolveCadence(overrides: Partial<Record<keyof CadenceConfig, number | undefined>> | null): CadenceConfig {
	return {
		appliedFirstDays: overrides?.appliedFirstDays ?? DEFAULT_CADENCE.appliedFirstDays,
		appliedSubsequentDays: overrides?.appliedSubsequentDays ?? DEFAULT_CADENCE.appliedSubsequentDays,
		maxApplied: overrides?.maxApplied ?? DEFAULT_CADENCE.maxApplied,
		respondedInitialDays: overrides?.respondedInitialDays ?? DEFAULT_CADENCE.respondedInitialDays,
		respondedSubsequentDays: overrides?.respondedSubsequentDays ?? DEFAULT_CADENCE.respondedSubsequentDays,
		interviewThankYouDays: overrides?.interviewThankYouDays ?? DEFAULT_CADENCE.interviewThankYouDays,
	};
}

/** Stages with nothing left to follow up on. */
const TERMINAL_STAGES = new Set(["rejected", "offer"]);

export const followUpsService = {
	/** Recompute the next cadence follow-up for one application, materializing at most one
	 * new pending row. Lazy-called on queue reads and by the daily sweep — recomputing is
	 * idempotent because an existing pending/snoozed row suppresses creation. */
	recomputeForApplication: async (input: { userId: string; applicationId: string }): Promise<void> => {
		const [application] = await db
			.select()
			.from(schema.application)
			.where(and(eq(schema.application.id, input.applicationId), eq(schema.application.userId, input.userId)))
			.limit(1);
		if (!application || application.archived || TERMINAL_STAGES.has(application.status)) return;

		const existing = await db
			.select()
			.from(schema.followUp)
			.where(and(eq(schema.followUp.applicationId, input.applicationId), eq(schema.followUp.userId, input.userId)));

		const profile = await evaluationsService.getCareerProfile({ userId: input.userId });

		const next = nextFollowUp({
			status: application.status,
			timeline: application.activity.map((entry) =>
				entry.type === "stage"
					? { type: "stage" as const, stage: entry.stage, at: new Date(entry.at) }
					: { type: "note" as const, text: entry.text, at: new Date(entry.at) },
			),
			existing: existing.map((row) => ({
				kind: row.kind,
				dueAt: row.dueAt,
				status: row.status,
			})),
			cadence: resolveCadence(profile?.cadence ?? null),
			now: new Date(),
		});
		if (!next) return;

		await db.insert(schema.followUp).values({
			userId: input.userId,
			applicationId: input.applicationId,
			kind: next.kind,
			dueAt: next.dueAt,
			note: next.reason,
		});
	},

	/** Recompute across every active application for a user (the daily sweep / queue read). */
	recomputeAll: async (input: { userId: string }): Promise<void> => {
		const applications = await db
			.select({ id: schema.application.id })
			.from(schema.application)
			.where(
				and(
					eq(schema.application.userId, input.userId),
					eq(schema.application.archived, false),
					sql`${schema.application.status} NOT IN ('rejected', 'offer')`,
				),
			);
		for (const application of applications) {
			await followUpsService.recomputeForApplication({ userId: input.userId, applicationId: application.id });
		}
	},

	/** The queue, joined with its applications: overdue and upcoming pending rows (snoozed
	 * rows surface again once their snooze lapses). */
	queue: async (input: { userId: string; horizonDays?: number | undefined }) => {
		const horizon = new Date(Date.now() + (input.horizonDays ?? 14) * 86_400_000);
		const rows = await db
			.select({
				followUp: schema.followUp,
				application: {
					id: schema.application.id,
					company: schema.application.company,
					role: schema.application.role,
					status: schema.application.status,
				},
			})
			.from(schema.followUp)
			.innerJoin(schema.application, eq(schema.followUp.applicationId, schema.application.id))
			.where(
				and(
					eq(schema.followUp.userId, input.userId),
					or(
						and(eq(schema.followUp.status, "pending"), lte(schema.followUp.dueAt, horizon)),
						and(
							eq(schema.followUp.status, "snoozed"),
							or(isNull(schema.followUp.snoozedUntil), lte(schema.followUp.snoozedUntil, new Date())),
						),
					),
				),
			)
			.orderBy(asc(schema.followUp.dueAt));
		return rows.map((row) => ({ ...stripUserId(row.followUp), application: row.application }));
	},

	dueCount: async (input: { userId: string }): Promise<number> => {
		const [row] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(schema.followUp)
			.where(
				and(
					eq(schema.followUp.userId, input.userId),
					eq(schema.followUp.status, "pending"),
					lte(schema.followUp.dueAt, new Date()),
				),
			);
		return row?.count ?? 0;
	},

	setStatus: async (input: { id: string; userId: string; status: FollowUpStatus; snoozedUntil?: Date | null }) => {
		const [row] = await db
			.update(schema.followUp)
			.set({
				status: input.status,
				...(input.status === "done" ? { completedAt: new Date() } : {}),
				...(input.snoozedUntil !== undefined ? { snoozedUntil: input.snoozedUntil } : {}),
			})
			.where(and(eq(schema.followUp.id, input.id), eq(schema.followUp.userId, input.userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	createCustom: async (input: { userId: string; applicationId: string; dueAt: Date; note?: string | undefined }) => {
		// Ownership check via the application row.
		const [application] = await db
			.select({ id: schema.application.id })
			.from(schema.application)
			.where(and(eq(schema.application.id, input.applicationId), eq(schema.application.userId, input.userId)))
			.limit(1);
		if (!application) throw new ORPCError("NOT_FOUND");

		const [row] = await db
			.insert(schema.followUp)
			.values({
				userId: input.userId,
				applicationId: input.applicationId,
				kind: "custom" as FollowUpKind,
				dueAt: input.dueAt,
				note: input.note ?? null,
			})
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the follow-up." });
		return stripUserId(row);
	},

	/** Users with due, un-notified follow-ups who opted into the email digest. */
	digestCandidates: async (): Promise<{ userId: string; email: string; name: string; due: FollowUpRow[] }[]> => {
		const due = await db
			.select({ followUp: schema.followUp, email: schema.user.email, name: schema.user.name })
			.from(schema.followUp)
			.innerJoin(schema.careerProfile, eq(schema.careerProfile.userId, schema.followUp.userId))
			.innerJoin(schema.user, eq(schema.user.id, schema.followUp.userId))
			.where(
				and(
					eq(schema.followUp.status, "pending"),
					lte(schema.followUp.dueAt, new Date()),
					isNull(schema.followUp.emailNotifiedAt),
					eq(schema.careerProfile.emailDigest, true),
				),
			);
		const byUser = new Map<string, { userId: string; email: string; name: string; due: FollowUpRow[] }>();
		for (const row of due) {
			const entry = byUser.get(row.followUp.userId) ?? {
				userId: row.followUp.userId,
				email: row.email,
				name: row.name,
				due: [],
			};
			entry.due.push(row.followUp);
			byUser.set(row.followUp.userId, entry);
		}
		return [...byUser.values()];
	},

	markNotified: async (ids: string[]): Promise<void> => {
		if (ids.length === 0) return;
		await db.update(schema.followUp).set({ emailNotifiedAt: new Date() }).where(inArray(schema.followUp.id, ids));
	},
};
