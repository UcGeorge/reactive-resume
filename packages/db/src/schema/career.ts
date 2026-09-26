import type {
	AuditReport,
	CadenceSettings,
	CareerFactsProfile,
	CareerWorkAuthProfile,
	DiscoveredJobFlags,
	DiscoveredJobSalary,
	DiscoveredJobStatus,
	EvaluationBlocks,
	EvaluationRequirement,
	EvaluationStatus,
	EvaluationWorkAuth,
	FactGateReportData,
	FollowUpKind,
	FollowUpStatus,
	LegitimacyTier,
	ReuseDecision,
	ScannerSettings,
	SkillGapResult,
	StoryProvenance,
	TailoringChange,
	TailoringOperation,
	TailoringStatus,
	TitleFilterConfig,
	WatchedCompanyStatus,
} from "@reactive-resume/schema/career/data";
import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { application } from "./applications";
import { user } from "./auth";
import { resume } from "./resume";

// Per-user career profile: work authorization for evaluation Block A, and the facts
// allowlist the fact gate consults. One row per user, created lazily on first use.
export const careerProfile = pg.pgTable(
	"career_profile",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.unique()
			.references(() => user.id, { onDelete: "cascade" }),
		workAuth: pg.jsonb("work_auth").$type<CareerWorkAuthProfile>(),
		facts: pg.jsonb("facts").$type<CareerFactsProfile>(),
		scanner: pg.jsonb("scanner").$type<ScannerSettings>(),
		cadence: pg.jsonb("cadence").$type<CadenceSettings>(),
		// Optional abstract voice descriptors for candidate-facing prose (cover letters,
		// outreach) — style, never content. The anti-slop tier applies regardless.
		voiceNotes: pg.text("voice_notes"),
		// Daily follow-up email digest (only when the instance has SMTP configured).
		emailDigest: pg.boolean("email_digest").notNull().default(false),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId)],
);

// A deep evaluation of one application's job description against a resume. First-class
// entity rather than a blob on the application row: multiple evaluations accrue per
// application over time (re-posts, JD edits, resume revisions), the learning loop queries
// them in aggregate, and the background pipeline needs a status of its own.
export const evaluation = pg.pgTable(
	"evaluation",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: pg
			.text("application_id")
			.notNull()
			.references(() => application.id, { onDelete: "cascade" }),
		// The resume evaluated against. Kept on resume delete (set null) so the report and its
		// archived JD survive as history.
		resumeId: pg.text("resume_id").references(() => resume.id, { onDelete: "set null" }),
		status: pg.text("status").$type<EvaluationStatus>().notNull().default("pending"),
		error: pg.text("error"),
		// 1–5 with one decimal, the holistic judgment; the requirement table never feeds it
		// arithmetically (score neutrality).
		score: pg.real("score"),
		archetype: pg.text("archetype"),
		legitimacy: pg.text("legitimacy").$type<LegitimacyTier>(),
		workAuth: pg.text("work_auth").$type<EvaluationWorkAuth>(),
		// The JD's own advertised figure, verbatim; null when the posting states nothing.
		advertisedComp: pg.text("advertised_comp"),
		requirements: pg.jsonb("requirements").$type<EvaluationRequirement[]>(),
		blocks: pg.jsonb("blocks").$type<EvaluationBlocks>(),
		// Deterministic three-bucket skill gap; computed synchronously, present even when no AI
		// provider is configured and the LLM blocks never run.
		skillGap: pg.jsonb("skill_gap").$type<SkillGapResult>(),
		// The JD snapshotted verbatim at evaluation time. Postings get edited and taken down;
		// the report keeps meaning only next to the exact text it judged.
		jdArchived: pg.text("jd_archived").notNull(),
		// 16-hex SimHash of the archived JD, for repost/cross-listing comparisons.
		jdFingerprint: pg.text("jd_fingerprint"),
		provider: pg.text("provider"),
		model: pg.text("model"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId), pg.index().on(t.userId, t.applicationId, t.createdAt.desc())],
);

// A scheduled follow-up on one application. Materialized from the cadence rules (or
// created custom by the user), surfaced as an in-app queue and an optional email digest.
// The display-only followUpAt/followUpNote fields on the application row remain what they
// were; the queue reads them as a user-pinned custom entry.
export const followUp = pg.pgTable(
	"follow_up",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: pg
			.text("application_id")
			.notNull()
			.references(() => application.id, { onDelete: "cascade" }),
		kind: pg.text("kind").$type<FollowUpKind>().notNull(),
		dueAt: pg.timestamp("due_at", { withTimezone: true }).notNull(),
		status: pg.text("status").$type<FollowUpStatus>().notNull().default("pending"),
		note: pg.text("note"),
		completedAt: pg.timestamp("completed_at", { withTimezone: true }),
		snoozedUntil: pg.timestamp("snoozed_until", { withTimezone: true }),
		emailNotifiedAt: pg.timestamp("email_notified_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId, t.status, t.dueAt), pg.index().on(t.applicationId)],
);

// A company whose job board the background scanner watches for this user. `careersUrl` is
// what the user pastes; the provider is auto-detected from it (or pinned explicitly).
export const watchedCompany = pg.pgTable(
	"watched_company",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: pg.text("name").notNull(),
		careersUrl: pg.text("careers_url").notNull(),
		/** Pinned provider id; null = auto-detect on each scan. */
		provider: pg.text("provider"),
		enabled: pg.boolean("enabled").notNull().default(true),
		/** Widens/narrows the user's global title filter for this one company. */
		titleFilterOverride: pg.jsonb("title_filter_override").$type<TitleFilterConfig>(),
		lastScanAt: pg.timestamp("last_scan_at", { withTimezone: true }),
		lastStatus: pg.text("last_status").$type<WatchedCompanyStatus>(),
		lastError: pg.text("last_error"),
		/** Consecutive failures; scans back off on persistent breakage instead of hammering. */
		failCount: pg.integer("fail_count").notNull().default(0),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId, t.enabled)],
);

// A job the scanner surfaced. Its own inbox, deliberately NOT a new application status:
// scan volume would drown the board, the pipeline enum is upstream-shared, and the
// seen/expired lifecycle is scanner-domain. "Import" creates a real application and
// back-links it, and every evaluation/tailoring feature applies from there.
export const discoveredJob = pg.pgTable(
	"discovered_job",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		watchedCompanyId: pg.text("watched_company_id").references(() => watchedCompany.id, { onDelete: "set null" }),
		company: pg.text("company").notNull(),
		title: pg.text("title").notNull(),
		url: pg.text("url").notNull(),
		/** Provider dedup key or normalized URL — one row per posting per user. */
		dedupKey: pg.text("dedup_key").notNull(),
		location: pg.text("location"),
		description: pg.text("description"),
		/** 16-hex SimHash of the description when one was available. */
		fingerprint: pg.text("fingerprint"),
		salary: pg.jsonb("salary").$type<DiscoveredJobSalary>(),
		postedAt: pg.timestamp("posted_at", { withTimezone: true }),
		firstSeenAt: pg.timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: pg.timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		status: pg.text("status").$type<DiscoveredJobStatus>().notNull().default("new"),
		/** Back-link once imported into the tracker. */
		applicationId: pg.text("application_id").references(() => application.id, { onDelete: "set null" }),
		flags: pg.jsonb("flags").$type<DiscoveredJobFlags>(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.unique().on(t.userId, t.dedupKey),
		pg.index().on(t.userId, t.status, t.firstSeenAt.desc()),
		pg.index().on(t.userId, t.lastSeenAt.desc()),
	],
);

// A STAR+Reflection story in the interview bank. Provenance is the load-bearing column:
// a compact story card is exactly the surface where an unverified number gets laundered
// into an established fact, so every story carries how its claims are backed.
export const story = pg.pgTable(
	"story",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		title: pg.text("title").notNull(),
		theme: pg.text("theme").notNull().default(""),
		situation: pg.text("situation").notNull().default(""),
		task: pg.text("task").notNull().default(""),
		action: pg.text("action").notNull().default(""),
		result: pg.text("result").notNull().default(""),
		reflection: pg.text("reflection").notNull().default(""),
		provenance: pg.text("provenance").$type<StoryProvenance>().notNull().default("derived-unverified"),
		/** "Best for questions about …" routing tags. */
		tags: pg.text("tags").array().notNull().default([]),
		sourceResumeId: pg.text("source_resume_id").references(() => resume.id, { onDelete: "set null" }),
		sourceApplicationId: pg.text("source_application_id").references(() => application.id, { onDelete: "set null" }),
		lastUsedAt: pg.timestamp("last_used_at", { withTimezone: true }),
		timesUsed: pg.integer("times_used").notNull().default(0),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId, t.updatedAt.desc())],
);

// One tailoring run per attempt: the career-ops per-application bundle mapped onto this
// app's primitives. The tailored CV is a real resume row plus a resume_version snapshot;
// this row carries everything around it — the reuse decision, the constrained plan, the
// compiled JSON Patch, the human changelog, the fact-gate report, and the optional
// hiring-manager audit — so a run stays auditable after the resume itself moves on.
export const tailoringRun = pg.pgTable(
	"tailoring_run",
	{
		id: pg
			.text("id")
			.notNull()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: pg
			.text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: pg
			.text("application_id")
			.notNull()
			.references(() => application.id, { onDelete: "cascade" }),
		evaluationId: pg.text("evaluation_id").references(() => evaluation.id, { onDelete: "set null" }),
		sourceResumeId: pg.text("source_resume_id").references(() => resume.id, { onDelete: "set null" }),
		tailoredResumeId: pg.text("tailored_resume_id").references(() => resume.id, { onDelete: "set null" }),
		// 1..N per application — career-ops' v001..vNNN.
		version: pg.integer("version").notNull().default(1),
		status: pg.text("status").$type<TailoringStatus>().notNull().default("pending"),
		error: pg.text("error"),
		reuseDecision: pg.jsonb("reuse_decision").$type<ReuseDecision>(),
		plan: pg.jsonb("plan").$type<TailoringOperation[]>(),
		// The JSON Patch actually applied, after the compiler's allowlist and the fact gate's
		// strip-and-retry — may be smaller than the plan.
		operations: pg.jsonb("operations").$type<unknown[]>(),
		changes: pg.jsonb("changes").$type<TailoringChange[]>(),
		factGateReport: pg.jsonb("fact_gate_report").$type<FactGateReportData>(),
		auditReport: pg.jsonb("audit_report").$type<AuditReport>(),
		jdArchived: pg.text("jd_archived").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.userId),
		pg.index().on(t.userId, t.applicationId, t.createdAt.desc()),
		// At most one run in flight per application; the pipeline's pre-check is the friendly
		// message, this is the guarantee.
		pg
			.uniqueIndex("tailoring_run_in_flight_unique")
			.on(t.applicationId)
			.where(sql`${t.status} in ('pending', 'planned', 'gated')`),
	],
);
