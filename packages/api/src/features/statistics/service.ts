import { count } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// Fallbacks when the database cannot be counted. Zero, not upstream's totals: a fork must not
// advertise numbers that are not its own.
const LAST_KNOWN = {
	users: 0,
	resumes: 0,
} as const;

// ponytail: file-based disk cache replaced with module-level memo; LAST_KNOWN fallbacks cover restarts
const memCache = new Map<string, { value: number; cachedAt: number }>();

/** Clear all cached statistics. Exposed for test isolation only. */
export const clearStatisticsCache = () => memCache.clear();

const getCached = (key: string) => {
	const entry = memCache.get(key);
	if (!entry || Date.now() - entry.cachedAt >= CACHE_DURATION_MS) return null;
	return entry;
};

const setCached = (key: string, value: number) => {
	memCache.set(key, { value, cachedAt: Date.now() });
};

const getCachedCount = async (
	key: string,
	lastKnown: number,
	fetcher: () => Promise<number | null>,
): Promise<number> => {
	const cached = getCached(key);
	if (cached !== null) return cached.value;

	try {
		const value = await fetcher();
		if (value !== null) {
			setCached(key, value);
			return value;
		}
	} catch {
		// Ignore errors, use last known value
	}

	return lastKnown;
};

const getCountFromDatabase = async (table: typeof schema.user | typeof schema.resume): Promise<number | null> => {
	const [result] = await db.select({ count: count() }).from(table);
	if (!result) return null;
	return result.count;
};

export const statisticsService = {
	getTotals: async () => {
		const [users, resumes] = await Promise.all([
			statisticsService.user.getCount(),
			statisticsService.resume.getCount(),
		]);
		const usersCache = getCached("users");
		const resumesCache = getCached("resumes");

		return {
			users,
			resumes,
			// Use the older count's timestamp so the pair never looks fresher than either total.
			cachedAt:
				usersCache?.value === users && resumesCache?.value === resumes
					? Math.min(usersCache.cachedAt, resumesCache.cachedAt)
					: null,
		};
	},
	user: {
		getCount: () => {
			return getCachedCount("users", LAST_KNOWN.users, () => getCountFromDatabase(schema.user));
		},
	},
	resume: {
		getCount: () => {
			return getCachedCount("resumes", LAST_KNOWN.resumes, () => getCountFromDatabase(schema.resume));
		},
	},
};
