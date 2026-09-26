import type {
	DiscoveredJobFlags,
	DiscoveredJobSalary,
	DiscoveredJobStatus,
	ScannerSettings,
	TitleFilterConfig,
	WatchedCompanyStatus,
} from "@reactive-resume/schema/career/data";
import { ORPCError } from "@orpc/client";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { DEFAULT_SCANNER_SETTINGS } from "@reactive-resume/schema/career/data";

type WatchedCompanyRow = typeof schema.watchedCompany.$inferSelect;
type DiscoveredJobRow = typeof schema.discoveredJob.$inferSelect;

function stripUserId<T extends { userId: string }>(row: T): Omit<T, "userId"> {
	const { userId: _userId, ...rest } = row;
	return rest;
}

type ScannerSettingsPatch = { [K in keyof ScannerSettings]?: ScannerSettings[K] | undefined };

/** The user's scanner settings with defaults filled in (deep for the nested filters). */
export function resolveScannerSettings(raw: ScannerSettingsPatch | null | undefined): ScannerSettings {
	return {
		titleFilter: { ...DEFAULT_SCANNER_SETTINGS.titleFilter, ...raw?.titleFilter },
		locationFilter: { ...DEFAULT_SCANNER_SETTINGS.locationFilter, ...raw?.locationFilter },
		contentExclude: raw?.contentExclude ?? DEFAULT_SCANNER_SETTINGS.contentExclude,
		cooldownDays: raw?.cooldownDays ?? DEFAULT_SCANNER_SETTINGS.cooldownDays,
		blacklist: raw?.blacklist ?? DEFAULT_SCANNER_SETTINGS.blacklist,
	};
}

export const discoveryService = {
	// --- Watched companies ---------------------------------------------------------

	listWatchedCompanies: async (input: { userId: string }) => {
		const rows = await db
			.select()
			.from(schema.watchedCompany)
			.where(eq(schema.watchedCompany.userId, input.userId))
			.orderBy(schema.watchedCompany.name);
		return rows.map(stripUserId);
	},

	getWatchedCompany: async (input: { id: string; userId: string }): Promise<WatchedCompanyRow> => {
		const [row] = await db
			.select()
			.from(schema.watchedCompany)
			.where(and(eq(schema.watchedCompany.id, input.id), eq(schema.watchedCompany.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return row;
	},

	listEnabledWatchedCompanies: (input: { userId: string }): Promise<WatchedCompanyRow[]> => {
		return db
			.select()
			.from(schema.watchedCompany)
			.where(and(eq(schema.watchedCompany.userId, input.userId), eq(schema.watchedCompany.enabled, true)));
	},

	/** Every user with at least one enabled watch — the cron fan-out reads this. */
	listUsersWithWatches: async (): Promise<string[]> => {
		const rows = await db
			.selectDistinct({ userId: schema.watchedCompany.userId })
			.from(schema.watchedCompany)
			.where(eq(schema.watchedCompany.enabled, true));
		return rows.map((row) => row.userId);
	},

	createWatchedCompany: async (input: {
		userId: string;
		name: string;
		careersUrl: string;
		provider?: string | null | undefined;
		titleFilterOverride?: TitleFilterConfig | null | undefined;
	}) => {
		const [row] = await db
			.insert(schema.watchedCompany)
			.values({
				userId: input.userId,
				name: input.name,
				careersUrl: input.careersUrl,
				provider: input.provider ?? null,
				titleFilterOverride: input.titleFilterOverride ?? null,
			})
			.returning();
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the watched company." });
		return stripUserId(row);
	},

	updateWatchedCompany: async (input: {
		id: string;
		userId: string;
		name?: string | undefined;
		careersUrl?: string | undefined;
		provider?: string | null | undefined;
		enabled?: boolean | undefined;
		titleFilterOverride?: TitleFilterConfig | null | undefined;
	}) => {
		const { id, userId, ...fields } = input;
		const [row] = await db
			.update(schema.watchedCompany)
			.set(fields)
			.where(and(eq(schema.watchedCompany.id, id), eq(schema.watchedCompany.userId, userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	/** Internal: record a scan outcome on the watch row. */
	recordScanOutcome: async (input: {
		id: string;
		userId: string;
		status: WatchedCompanyStatus;
		error?: string | null;
	}) => {
		await db
			.update(schema.watchedCompany)
			.set({
				lastScanAt: new Date(),
				lastStatus: input.status,
				lastError: input.error ?? null,
				failCount: input.status === "ok" ? 0 : sql`${schema.watchedCompany.failCount} + 1`,
			})
			.where(and(eq(schema.watchedCompany.id, input.id), eq(schema.watchedCompany.userId, input.userId)));
	},

	deleteWatchedCompany: async (input: { id: string; userId: string }) => {
		const [row] = await db
			.delete(schema.watchedCompany)
			.where(and(eq(schema.watchedCompany.id, input.id), eq(schema.watchedCompany.userId, input.userId)))
			.returning({ id: schema.watchedCompany.id });
		if (!row) throw new ORPCError("NOT_FOUND");
	},

	// --- Discovered jobs -----------------------------------------------------------

	listJobs: async (input: { userId: string; status?: DiscoveredJobStatus | undefined; limit?: number | undefined }) => {
		const conditions = [eq(schema.discoveredJob.userId, input.userId)];
		if (input.status) conditions.push(eq(schema.discoveredJob.status, input.status));
		const rows = await db
			.select()
			.from(schema.discoveredJob)
			.where(and(...conditions))
			.orderBy(desc(schema.discoveredJob.firstSeenAt))
			.limit(Math.min(input.limit ?? 200, 500));
		return rows.map(stripUserId);
	},

	getJob: async (input: { id: string; userId: string }): Promise<DiscoveredJobRow> => {
		const [row] = await db
			.select()
			.from(schema.discoveredJob)
			.where(and(eq(schema.discoveredJob.id, input.id), eq(schema.discoveredJob.userId, input.userId)))
			.limit(1);
		if (!row) throw new ORPCError("NOT_FOUND");
		return row;
	},

	countNewJobs: async (input: { userId: string }): Promise<number> => {
		const [row] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(schema.discoveredJob)
			.where(and(eq(schema.discoveredJob.userId, input.userId), eq(schema.discoveredJob.status, "new")));
		return row?.count ?? 0;
	},

	/** Upsert one scanned posting. New rows arrive `new`; an existing row only bumps
	 * lastSeenAt (and refreshes mutable posting fields) — user-set statuses survive. */
	upsertJob: async (input: {
		userId: string;
		watchedCompanyId: string | null;
		company: string;
		title: string;
		url: string;
		dedupKey: string;
		location: string | null;
		description: string | null;
		fingerprint: string | null;
		salary: DiscoveredJobSalary | null;
		postedAt: Date | null;
		flags: DiscoveredJobFlags | null;
	}): Promise<{ id: string; isNew: boolean }> => {
		const { userId, ...fields } = input;
		const [row] = await db
			.insert(schema.discoveredJob)
			.values({ userId, ...fields })
			.onConflictDoUpdate({
				target: [schema.discoveredJob.userId, schema.discoveredJob.dedupKey],
				set: {
					lastSeenAt: new Date(),
					title: fields.title,
					url: fields.url,
					location: fields.location,
					description: fields.description,
					fingerprint: fields.fingerprint,
					salary: fields.salary,
					postedAt: fields.postedAt,
					// An expired posting that reappears is live again; anything else keeps its status.
					status: sql`CASE WHEN ${schema.discoveredJob.status} = 'expired' THEN 'new' ELSE ${schema.discoveredJob.status} END`,
				},
			})
			.returning({ id: schema.discoveredJob.id, createdAt: schema.discoveredJob.createdAt });
		if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not record the discovered job." });
		return { id: row.id, isNew: Date.now() - row.createdAt.getTime() < 5000 };
	},

	setJobStatus: async (input: {
		id: string;
		userId: string;
		status: DiscoveredJobStatus;
		applicationId?: string | null;
	}) => {
		const [row] = await db
			.update(schema.discoveredJob)
			.set({
				status: input.status,
				...(input.applicationId !== undefined ? { applicationId: input.applicationId } : {}),
			})
			.where(and(eq(schema.discoveredJob.id, input.id), eq(schema.discoveredJob.userId, input.userId)))
			.returning();
		if (!row) throw new ORPCError("NOT_FOUND");
		return stripUserId(row);
	},

	bulkDismiss: async (input: { ids: string[]; userId: string }) => {
		const rows = await db
			.update(schema.discoveredJob)
			.set({ status: "dismissed" })
			.where(
				and(
					inArray(schema.discoveredJob.id, input.ids),
					eq(schema.discoveredJob.userId, input.userId),
					inArray(schema.discoveredJob.status, ["new", "seen"]),
				),
			)
			.returning({ id: schema.discoveredJob.id });
		return { dismissed: rows.length };
	},

	/** Mark still-open rows for a watch expired when they vanished from the board. */
	expireVanished: async (input: {
		userId: string;
		watchedCompanyId: string;
		seenDedupKeys: readonly string[];
	}): Promise<number> => {
		const conditions = [
			eq(schema.discoveredJob.userId, input.userId),
			eq(schema.discoveredJob.watchedCompanyId, input.watchedCompanyId),
			inArray(schema.discoveredJob.status, ["new", "seen"]),
		];
		const rows = await db
			.update(schema.discoveredJob)
			.set({ status: "expired" })
			.where(
				input.seenDedupKeys.length > 0
					? and(
							...conditions,
							sql`${schema.discoveredJob.dedupKey} NOT IN (${sql.join(
								input.seenDedupKeys.map((key) => sql`${key}`),
								sql`, `,
							)})`,
						)
					: and(...conditions),
			)
			.returning({ id: schema.discoveredJob.id });
		return rows.length;
	},

	/** Recent rows with fingerprints, for repost/cross-listing comparison. */
	recentFingerprinted: (input: { userId: string; windowDays: number }) => {
		const cutoff = new Date(Date.now() - input.windowDays * 86_400_000);
		return db
			.select({
				url: schema.discoveredJob.url,
				company: schema.discoveredJob.company,
				title: schema.discoveredJob.title,
				fingerprint: schema.discoveredJob.fingerprint,
				firstSeenAt: schema.discoveredJob.firstSeenAt,
			})
			.from(schema.discoveredJob)
			.where(
				and(
					eq(schema.discoveredJob.userId, input.userId),
					sql`${schema.discoveredJob.fingerprint} IS NOT NULL`,
					sql`${schema.discoveredJob.firstSeenAt} >= ${cutoff}`,
				),
			);
	},

	/** Applications considered for the re-apply cooldown. */
	recentApplications: (input: { userId: string; windowDays: number }) => {
		const cutoff = new Date(Date.now() - input.windowDays * 86_400_000);
		return db
			.select({
				company: schema.application.company,
				role: schema.application.role,
				updatedAt: schema.application.updatedAt,
			})
			.from(schema.application)
			.where(and(eq(schema.application.userId, input.userId), lt(sql`${cutoff}`, schema.application.updatedAt)));
	},
};
