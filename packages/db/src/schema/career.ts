import type {
	AuditReport,
	CareerFactsProfile,
	CareerWorkAuthProfile,
	EvaluationBlocks,
	EvaluationRequirement,
	EvaluationStatus,
	EvaluationWorkAuth,
	FactGateReportData,
	LegitimacyTier,
	ReuseDecision,
	SkillGapResult,
	TailoringChange,
	TailoringOperation,
	TailoringStatus,
} from "@reactive-resume/schema/career/data";
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
	(t) => [pg.index().on(t.userId), pg.index().on(t.userId, t.applicationId, t.createdAt.desc())],
);
