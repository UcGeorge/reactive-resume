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
