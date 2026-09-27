import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";
import { generateId } from "@reactive-resume/utils/string";
import { user } from "./auth";
import { resume } from "./resume";

type AgentUiMessage = Record<string, unknown>;
type StoredJsonPatchOperation =
	| { op: "add"; path: string; value: unknown }
	| { op: "remove"; path: string }
	| { op: "replace"; path: string; value: unknown }
	| { op: "move"; path: string; from: string }
	| { op: "copy"; path: string; from: string }
	| { op: "test"; path: string; value: unknown };

export const aiProvider = pg.pgTable(
	"ai_providers",
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
		label: pg.text("label").notNull(),
		provider: pg.text("provider").notNull(),
		model: pg.text("model").notNull(),
		baseUrl: pg.text("base_url"),
		encryptedApiKey: pg.text("encrypted_api_key").notNull(),
		apiKeySalt: pg.text("api_key_salt").notNull(),
		apiKeyHash: pg.text("api_key_hash").notNull(),
		apiKeyPreview: pg.text("api_key_preview").notNull(),
		testStatus: pg.text("test_status").notNull().default("untested"),
		testError: pg.text("test_error"),
		lastTestedAt: pg.timestamp("last_tested_at", { withTimezone: true }),
		lastUsedAt: pg.timestamp("last_used_at", { withTimezone: true }),
		enabled: pg.boolean("enabled").notNull().default(false),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.userId, t.enabled),
		pg.index().on(t.userId, t.lastUsedAt.desc()),
		pg.index().on(t.userId, t.createdAt.asc()),
	],
);

export type AiRequestStatus = "queued" | "claimed" | "completed" | "failed" | "canceled";
export type AiRequestKind = "generate" | "test";
/** A file attached to a queued request; `data` is base64. */
export type AiRequestFile = { mediaType: string; filename?: string; data: string };
export type AiRequestMessage = {
	role: "user" | "assistant" | "tool";
	content: Record<string, unknown>[];
};
/** The serialised language-model call a connected agent answers. */
export type AiRequestPayload = {
	system?: string;
	messages: AiRequestMessage[];
	tools?: {
		name: string;
		description?: string;
		inputSchema: unknown;
		inputExamples?: { input: Record<string, unknown> }[];
	}[];
	toolChoice?: { type: "auto" | "none" | "required" } | { type: "tool"; toolName: string };
	responseFormat?: { type: "text" } | { type: "json"; schema?: unknown; name?: string; description?: string };
	files?: AiRequestFile[];
	maxOutputTokens?: number;
};
export type AiRequestResult = {
	text?: string;
	toolCalls?: { toolName: string; input: Record<string, unknown> }[];
};

// Inference requests queued for a "Connected agent (MCP)" provider. The requesting feature
// inserts a row and polls it; an MCP client claims the row, answers with its own model and
// completes it. Rows are per user and cleaned up opportunistically once they are terminal.
export const aiRequest = pg.pgTable(
	"ai_requests",
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
		aiProviderId: pg
			.text("ai_provider_id")
			.notNull()
			.references(() => aiProvider.id, { onDelete: "cascade" }),
		status: pg.text("status").notNull().default("queued").$type<AiRequestStatus>(),
		kind: pg.text("kind").notNull().default("generate").$type<AiRequestKind>(),
		request: pg.jsonb("request").notNull().$type<AiRequestPayload>(),
		result: pg.jsonb("result").$type<AiRequestResult>(),
		error: pg.text("error"),
		claimedAt: pg.timestamp("claimed_at", { withTimezone: true }),
		leaseExpiresAt: pg.timestamp("lease_expires_at", { withTimezone: true }),
		completedAt: pg.timestamp("completed_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.userId, t.status, t.createdAt), pg.index().on(t.aiProviderId, t.status)],
);

// Which saved provider each AI feature uses. `feature` is one of the values in
// `AI_FEATURES` (@reactive-resume/ai/types), validated at the API layer. A provider that is
// deleted leaves the row behind with a null provider so the UI can say "removed".
export const aiProviderRoute = pg.pgTable(
	"ai_provider_routes",
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
		feature: pg.text("feature").notNull(),
		aiProviderId: pg.text("ai_provider_id").references(() => aiProvider.id, { onDelete: "set null" }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.uniqueIndex().on(t.userId, t.feature)],
);

export const agentThread = pg.pgTable(
	"agent_threads",
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
		aiProviderId: pg.text("ai_provider_id").references(() => aiProvider.id, { onDelete: "set null" }),
		sourceResumeId: pg.text("source_resume_id").references(() => resume.id, { onDelete: "set null" }),
		workingResumeId: pg.text("working_resume_id").references(() => resume.id, { onDelete: "set null" }),
		title: pg.text("title").notNull(),
		status: pg.text("status").notNull().default("active"),
		// Per-thread "Review edits" toggle: when true, apply_resume_patch requires user approval.
		reviewPatches: pg.boolean("review_patches").notNull().default(false),
		activeRunId: pg.text("active_run_id"),
		activeStreamId: pg.text("active_stream_id"),
		activeRunStartedAt: pg.timestamp("active_run_started_at", { withTimezone: true }),
		lastMessageAt: pg.timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
		archivedAt: pg.timestamp("archived_at", { withTimezone: true }),
		deletedAt: pg.timestamp("deleted_at", { withTimezone: true }),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [
		pg.index().on(t.userId, t.status, t.lastMessageAt.desc()),
		pg.index().on(t.workingResumeId),
		pg.index().on(t.aiProviderId),
		// At most one active in-place thread per (user, working, source) resume; guards the
		// getOrCreateForResume SELECT-then-INSERT race via onConflictDoNothing.
		pg
			.uniqueIndex("agent_threads_active_in_place_unique")
			.on(t.userId, t.workingResumeId, t.sourceResumeId)
			.where(sql`${t.status} = 'active' and ${t.deletedAt} is null`),
	],
);

export const agentMessage = pg.pgTable(
	"agent_messages",
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
		threadId: pg
			.text("thread_id")
			.notNull()
			.references(() => agentThread.id, { onDelete: "cascade" }),
		role: pg.text("role").notNull(),
		status: pg.text("status").notNull().default("completed"),
		sequence: pg.integer("sequence").notNull(),
		uiMessage: pg.jsonb("ui_message").notNull().$type<AgentUiMessage>(),
		error: pg.text("error"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.uniqueIndex().on(t.threadId, t.sequence), pg.index().on(t.userId, t.createdAt.desc())],
);

export const agentAttachment = pg.pgTable(
	"agent_attachments",
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
		threadId: pg
			.text("thread_id")
			.notNull()
			.references(() => agentThread.id, { onDelete: "cascade" }),
		messageId: pg.text("message_id").references(() => agentMessage.id, { onDelete: "set null" }),
		storageKey: pg.text("storage_key").notNull(),
		filename: pg.text("filename").notNull(),
		mediaType: pg.text("media_type").notNull(),
		size: pg.integer("size").notNull(),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [pg.index().on(t.threadId), pg.index().on(t.messageId), pg.index().on(t.userId)],
);

export const agentAction = pg.pgTable(
	"agent_actions",
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
		threadId: pg
			.text("thread_id")
			.notNull()
			.references(() => agentThread.id, { onDelete: "cascade" }),
		messageId: pg.text("message_id").references(() => agentMessage.id, { onDelete: "set null" }),
		resumeId: pg.text("resume_id").references(() => resume.id, { onDelete: "set null" }),
		kind: pg.text("kind").notNull(),
		status: pg.text("status").notNull().default("applied"),
		title: pg.text("title").notNull(),
		summary: pg.text("summary"),
		operations: pg.jsonb("operations").notNull().$type<StoredJsonPatchOperation[]>(),
		snapshotData: pg.jsonb("snapshot_data").$type<ResumeData | null>(),
		baseUpdatedAt: pg.timestamp("base_updated_at", { withTimezone: true }).notNull(),
		appliedUpdatedAt: pg.timestamp("applied_updated_at", { withTimezone: true }).notNull(),
		revertedAt: pg.timestamp("reverted_at", { withTimezone: true }),
		revertMessage: pg.text("revert_message"),
		createdAt: pg.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: pg
			.timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date()),
	},
	(t) => [pg.index().on(t.threadId, t.createdAt.desc()), pg.index().on(t.resumeId), pg.index().on(t.messageId)],
);
