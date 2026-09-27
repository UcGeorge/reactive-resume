import type {
	AiRequestFile,
	AiRequestKind,
	AiRequestPayload,
	AiRequestResult,
	AiRequestStatus,
} from "@reactive-resume/db/schema";
import { ORPCError } from "@orpc/client";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";

type AiRequestRecord = typeof schema.aiRequest.$inferSelect;

const POLL_INTERVAL_MS = 1_000;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;
export const MAX_CLAIM_WAIT_SECONDS = 25;

const LEASE_EXPIRED_MESSAGE = "The connected agent claimed the request but did not answer within 10 minutes.";
const CANCELED_MESSAGE = "The request was canceled by the feature that made it.";

export type ClaimedAiRequest = AiRequestPayload & {
	id: string;
	kind: AiRequestKind;
	providerId: string;
	createdAt: Date;
	leaseExpiresAt: Date | null;
	files: (AiRequestFile & { index: number })[];
	instructions: string;
};

export type AiRequestSummary = {
	id: string;
	kind: AiRequestKind;
	status: AiRequestStatus;
	providerId: string;
	error: string | null;
	createdAt: Date;
	claimedAt: Date | null;
	completedAt: Date | null;
};

type CompletionInput = { text?: string; toolCalls?: AiRequestResult["toolCalls"] };

function requestTimeoutMs() {
	return env.AI_AGENT_REQUEST_TIMEOUT_MS ?? 120_000;
}

function appUrl() {
	return env.APP_URL.replace(/\/$/, "");
}

export function noAgentMessage(timeoutMs: number) {
	return `No connected agent answered within ${Math.round(timeoutMs / 1000)} seconds. Connect an MCP client to ${appUrl()}/mcp and run the serve_ai_requests prompt (or call claim_ai_request in a loop), then try again.`;
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}

		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why an answer cannot be accepted, as sentences the agent can act on. Empty when it can. */
export function validateCompletion(request: AiRequestPayload, input: CompletionInput): string[] {
	const errors: string[] = [];
	const text = input.text?.trim() ?? "";
	const toolCalls = input.toolCalls ?? [];
	const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));

	if (!text && toolCalls.length === 0) errors.push("Provide text, at least one tool call, or both.");

	if (toolCalls.length > 0 && toolNames.size === 0) {
		errors.push("This request offers no tools, so it must be answered with text only.");
	}

	for (const call of toolCalls) {
		if (toolNames.size > 0 && !toolNames.has(call.toolName)) {
			errors.push(`Unknown tool "${call.toolName}". Available tools: ${[...toolNames].join(", ")}.`);
		}
		if (!isPlainObject(call.input)) errors.push(`The input for tool "${call.toolName}" must be a JSON object.`);
	}

	if (request.responseFormat?.type === "json" && text) {
		try {
			if (!isPlainObject(JSON.parse(text)))
				errors.push("The text must be a single JSON object, with no prose around it.");
		} catch {
			errors.push("The text must be a single valid JSON object, with no prose or code fences around it.");
		}
	}

	return errors;
}

function buildInstructions(row: AiRequestRecord) {
	const lines = [
		"Answer this request yourself, as the language model would: do not call other Reactive Resume tools to fulfil it.",
		"Reply through complete_ai_request with `text` for a written answer.",
	];

	if ((row.request.tools ?? []).length > 0) {
		lines.push(
			"To call a tool instead, reply with `toolCalls`: each `toolName` must be one of the request's tools and each `input` must match that tool's inputSchema. The requesting feature executes the tool and sends the result back as a new request.",
		);
	}

	if (row.request.responseFormat?.type === "json") {
		lines.push(
			"The `text` must be exactly one JSON object matching responseFormat.schema, with no prose or code fences.",
		);
	}

	if ((row.request.files ?? []).length > 0) {
		lines.push("Message parts with a `fileIndex` refer to the attached file resources in order.");
	}

	lines.push("If the request cannot be answered, call fail_ai_request with the reason.");

	if (row.leaseExpiresAt) lines.push(`This claim expires at ${row.leaseExpiresAt.toISOString()}.`);

	return lines.join(" ");
}

function toClaimed(row: AiRequestRecord): ClaimedAiRequest {
	return {
		...row.request,
		id: row.id,
		kind: row.kind,
		providerId: row.aiProviderId,
		createdAt: row.createdAt,
		leaseExpiresAt: row.leaseExpiresAt,
		files: (row.request.files ?? []).map((file, index) => ({ ...file, index })),
		instructions: buildInstructions(row),
	};
}

function toSummary(row: AiRequestRecord): AiRequestSummary {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		providerId: row.aiProviderId,
		error: row.error,
		createdAt: row.createdAt,
		claimedAt: row.claimedAt,
		completedAt: row.completedAt,
	};
}

// Guarded status change: only rows still in one of `from` move, so two writers (the waiting
// feature and the agent) cannot both win. Returns whether this call was the one that moved it.
async function transition(
	input: { id: string; userId: string; from: AiRequestStatus[] },
	set: Partial<Pick<AiRequestRecord, "status" | "result" | "error" | "completedAt">>,
) {
	const moved = await db
		.update(schema.aiRequest)
		.set(set)
		.where(
			and(
				eq(schema.aiRequest.id, input.id),
				eq(schema.aiRequest.userId, input.userId),
				inArray(schema.aiRequest.status, input.from),
			),
		)
		.returning({ id: schema.aiRequest.id });

	return moved.length === 1;
}

async function cleanupTerminalRequests(userId: string) {
	await db
		.delete(schema.aiRequest)
		.where(
			and(
				eq(schema.aiRequest.userId, userId),
				inArray(schema.aiRequest.status, ["completed", "failed", "canceled"]),
				lt(schema.aiRequest.updatedAt, new Date(Date.now() - CLEANUP_AFTER_MS)),
			),
		);
}

async function expireLeases(userId: string) {
	await db
		.update(schema.aiRequest)
		.set({ status: "failed", error: LEASE_EXPIRED_MESSAGE })
		.where(
			and(
				eq(schema.aiRequest.userId, userId),
				eq(schema.aiRequest.status, "claimed"),
				lt(schema.aiRequest.leaseExpiresAt, new Date()),
			),
		);
}

function claimNext(input: { userId: string; providerId?: string | undefined }) {
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: schema.aiRequest.id })
			.from(schema.aiRequest)
			.where(
				and(
					eq(schema.aiRequest.userId, input.userId),
					eq(schema.aiRequest.status, "queued"),
					...(input.providerId ? [eq(schema.aiRequest.aiProviderId, input.providerId)] : []),
				),
			)
			.orderBy(asc(schema.aiRequest.createdAt))
			.limit(1)
			.for("update", { skipLocked: true });

		if (!candidate) return null;

		const now = new Date();
		const [claimed] = await tx
			.update(schema.aiRequest)
			.set({ status: "claimed", claimedAt: now, leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
			.where(and(eq(schema.aiRequest.id, candidate.id), eq(schema.aiRequest.status, "queued")))
			.returning();

		return claimed ?? null;
	});
}

async function getOwned(input: { id: string; userId: string }) {
	const [row] = await db
		.select()
		.from(schema.aiRequest)
		.where(and(eq(schema.aiRequest.id, input.id), eq(schema.aiRequest.userId, input.userId)))
		.limit(1);

	if (!row) throw new ORPCError("NOT_FOUND", { message: "AI request was not found." });

	return row;
}

export const aiRequestsService = {
	/**
	 * Queues a request and polls until an agent completes it. Polling runs in the calling process,
	 * so it behaves the same inside an HTTP request, a background job, or a serverless invocation.
	 */
	enqueueAndWait: async (input: {
		userId: string;
		aiProviderId: string;
		kind: AiRequestKind;
		request: AiRequestPayload;
		timeoutMs?: number;
		abortSignal?: AbortSignal;
	}): Promise<{ id: string; result: AiRequestResult }> => {
		const timeoutMs = input.timeoutMs ?? requestTimeoutMs();

		await cleanupTerminalRequests(input.userId);

		const [inserted] = await db
			.insert(schema.aiRequest)
			.values({ userId: input.userId, aiProviderId: input.aiProviderId, kind: input.kind, request: input.request })
			.returning({ id: schema.aiRequest.id });

		if (!inserted) throw new Error("AI_REQUEST_CREATE_FAILED");

		const id = inserted.id;
		const key = { id, userId: input.userId };

		for (;;) {
			if (input.abortSignal?.aborted) {
				await transition({ ...key, from: ["queued", "claimed"] }, { status: "canceled", error: CANCELED_MESSAGE });
				throw input.abortSignal.reason ?? new DOMException("The AI request was aborted.", "AbortError");
			}

			const [current] = await db
				.select({
					status: schema.aiRequest.status,
					result: schema.aiRequest.result,
					error: schema.aiRequest.error,
					createdAt: schema.aiRequest.createdAt,
					leaseExpiresAt: schema.aiRequest.leaseExpiresAt,
				})
				.from(schema.aiRequest)
				.where(and(eq(schema.aiRequest.id, id), eq(schema.aiRequest.userId, input.userId)))
				.limit(1);

			if (!current) throw new Error("AI_REQUEST_MISSING");

			if (current.status === "completed") return { id, result: current.result ?? {} };

			if (current.status === "failed" || current.status === "canceled") {
				throw new ORPCError("BAD_GATEWAY", {
					message: current.error ?? "The connected agent gave up on this request.",
				});
			}

			const now = Date.now();

			if (current.status === "queued" && now - current.createdAt.getTime() > timeoutMs) {
				const message = noAgentMessage(timeoutMs);
				// A claim that landed between the read and this update wins; re-read and keep waiting.
				if (await transition({ ...key, from: ["queued"] }, { status: "failed", error: message })) {
					throw new ORPCError("BAD_GATEWAY", { message });
				}
				continue;
			}

			if (current.status === "claimed" && current.leaseExpiresAt && current.leaseExpiresAt.getTime() < now) {
				if (await transition({ ...key, from: ["claimed"] }, { status: "failed", error: LEASE_EXPIRED_MESSAGE })) {
					throw new ORPCError("BAD_GATEWAY", { message: LEASE_EXPIRED_MESSAGE });
				}
				continue;
			}

			await sleep(POLL_INTERVAL_MS, input.abortSignal);
		}
	},

	/** Long-polls for the oldest queued request, atomically marking it claimed with a lease. */
	claim: async (input: { userId: string; providerId?: string; wait?: number }): Promise<ClaimedAiRequest | null> => {
		const waitSeconds = Math.min(Math.max(input.wait ?? 0, 0), MAX_CLAIM_WAIT_SECONDS);
		const deadline = Date.now() + waitSeconds * 1000;

		for (;;) {
			await expireLeases(input.userId);

			const claimed = await claimNext({ userId: input.userId, providerId: input.providerId });
			if (claimed) return toClaimed(claimed);

			if (Date.now() >= deadline) return null;

			await sleep(POLL_INTERVAL_MS);
		}
	},

	complete: async (input: { userId: string; id: string } & CompletionInput) => {
		const row = await getOwned(input);

		if (row.status !== "claimed") {
			throw new ORPCError("CONFLICT", { message: `Request is ${row.status}, not claimed.` });
		}

		const errors = validateCompletion(row.request, input);
		if (errors.length > 0) {
			throw new ORPCError("BAD_REQUEST", { message: errors.join(" "), data: { errors } });
		}

		const text = input.text?.trim();
		const result: AiRequestResult = {
			...(text ? { text } : {}),
			...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
		};

		const moved = await transition(
			{ id: input.id, userId: input.userId, from: ["claimed"] },
			{ status: "completed", result, completedAt: new Date() },
		);
		if (!moved) throw new ORPCError("CONFLICT", { message: "Request is no longer claimed." });

		return { id: input.id, status: "completed" as const };
	},

	fail: async (input: { userId: string; id: string; reason: string }) => {
		const row = await getOwned(input);

		if (row.status !== "queued" && row.status !== "claimed") {
			throw new ORPCError("CONFLICT", { message: `Request is already ${row.status}.` });
		}

		const moved = await transition(
			{ id: input.id, userId: input.userId, from: ["queued", "claimed"] },
			{ status: "failed", error: input.reason.trim() },
		);
		if (!moved) throw new ORPCError("CONFLICT", { message: "Request is already finished." });

		return { id: input.id, status: "failed" as const };
	},

	list: async (input: { userId: string; status?: AiRequestStatus }): Promise<AiRequestSummary[]> => {
		const rows = await db
			.select()
			.from(schema.aiRequest)
			.where(
				and(
					eq(schema.aiRequest.userId, input.userId),
					...(input.status ? [eq(schema.aiRequest.status, input.status)] : []),
				),
			)
			.orderBy(desc(schema.aiRequest.createdAt))
			.limit(LIST_LIMIT);

		return rows.map(toSummary);
	},
};
