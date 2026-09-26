import { createSelectSchema } from "drizzle-zod";
import z from "zod";
import * as schema from "@reactive-resume/db/schema";
import {
	discoveredJobFlagsSchema,
	discoveredJobSalarySchema,
	discoveredJobStatusSchema,
	scannerSettingsSchema,
	titleFilterConfigSchema,
	watchedCompanyStatusSchema,
} from "@reactive-resume/schema/career/data";

const httpsUrlSchema = z
	.string()
	.trim()
	.pipe(z.url({ protocol: /^https$/, error: "Careers URL must use https." }));

const watchedCompanySchema = createSelectSchema(schema.watchedCompany, {
	id: z.string(),
	name: z.string().trim().min(1),
	careersUrl: httpsUrlSchema,
	provider: z.string().nullable(),
	enabled: z.boolean(),
	titleFilterOverride: titleFilterConfigSchema.nullable(),
	lastScanAt: z.date().nullable(),
	lastStatus: watchedCompanyStatusSchema.nullable(),
	lastError: z.string().nullable(),
	failCount: z.number().int(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const watchedCompanyOutput = watchedCompanySchema.omit({ userId: true });

const discoveredJobSchema = createSelectSchema(schema.discoveredJob, {
	id: z.string(),
	watchedCompanyId: z.string().nullable(),
	company: z.string(),
	title: z.string(),
	url: z.string(),
	dedupKey: z.string(),
	location: z.string().nullable(),
	description: z.string().nullable(),
	fingerprint: z.string().nullable(),
	salary: discoveredJobSalarySchema.nullable(),
	postedAt: z.date().nullable(),
	firstSeenAt: z.date(),
	lastSeenAt: z.date(),
	status: discoveredJobStatusSchema,
	applicationId: z.string().nullable(),
	flags: discoveredJobFlagsSchema.nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const discoveredJobOutput = discoveredJobSchema.omit({ userId: true });

const scanResultSchema = z.object({
	watchedCompanyId: z.string(),
	status: z.enum(["ok", "error", "unsupported"]),
	fetched: z.number(),
	matched: z.number(),
	added: z.number(),
	expired: z.number(),
	error: z.string().optional(),
});

export const discoveryDto = {
	watchedCompanies: {
		list: {
			input: z.object({}).optional().default({}),
			output: z.array(watchedCompanyOutput),
		},
		create: {
			input: z.object({
				name: watchedCompanySchema.shape.name,
				careersUrl: watchedCompanySchema.shape.careersUrl,
				provider: z.string().optional(),
				titleFilterOverride: titleFilterConfigSchema.nullable().optional(),
			}),
			output: watchedCompanyOutput,
		},
		update: {
			input: z.object({
				id: z.string(),
				name: watchedCompanySchema.shape.name.optional(),
				careersUrl: watchedCompanySchema.shape.careersUrl.optional(),
				provider: z.string().nullable().optional(),
				enabled: z.boolean().optional(),
				titleFilterOverride: titleFilterConfigSchema.nullable().optional(),
			}),
			output: watchedCompanyOutput,
		},
		delete: {
			input: z.object({ id: z.string() }),
			output: z.void(),
		},
		// One live fetch, the onboarding moment: does this board work, and how many postings?
		test: {
			input: z.object({ id: z.string() }),
			output: scanResultSchema,
		},
	},
	settings: {
		get: {
			input: z.object({}).optional().default({}),
			output: scannerSettingsSchema,
		},
		update: {
			input: scannerSettingsSchema.partial(),
			output: scannerSettingsSchema,
		},
	},
	scanNow: {
		input: z.object({ watchedCompanyId: z.string().optional() }).optional().default({}),
		output: z.object({ results: z.array(scanResultSchema) }),
	},
	status: {
		input: z.object({}).optional().default({}),
		output: z.object({
			enabled: z.boolean(),
			newCount: z.number(),
			watchedCount: z.number(),
			lastScanAt: z.date().nullable(),
		}),
	},
	jobs: {
		list: {
			input: z
				.object({
					status: discoveredJobStatusSchema.optional(),
					limit: z.number().int().min(1).max(500).optional(),
				})
				.optional()
				.default({}),
			output: z.array(discoveredJobOutput),
		},
		markSeen: {
			input: z.object({ id: z.string() }),
			output: discoveredJobOutput,
		},
		dismiss: {
			input: z.object({ id: z.string() }),
			output: discoveredJobOutput,
		},
		bulkDismiss: {
			input: z.object({ ids: z.array(z.string()).min(1).max(200) }),
			output: z.object({ dismissed: z.number() }),
		},
		import: {
			input: z.object({ id: z.string() }),
			output: z.object({ applicationId: z.string() }),
		},
	},
};
