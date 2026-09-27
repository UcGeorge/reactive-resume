import type { AiRequestSummary, ClaimedAiRequest } from "./service";
import { type } from "@orpc/server";
import z from "zod";
import { protectedProcedure } from "../../context";
import { aiRequestsService, MAX_CLAIM_WAIT_SECONDS } from "./service";

const reserved = { tags: ["AI Requests"] } as const;

const requestStatusSchema = z.enum(["queued", "claimed", "completed", "failed", "canceled"]);

const toolCallSchema = z.object({
	toolName: z.string().min(1).describe("One of the tools offered by the request."),
	input: z.record(z.string(), z.unknown()).describe("Arguments matching that tool's inputSchema."),
});

/**
 * The queue behind "Connected agent (MCP)" providers. Any authenticated client can serve its own
 * requests over these routes; the MCP tools wrap them for agents that speak MCP. No rate limiter:
 * `claim` is a long-poll by design, and the API-key limiter still applies per key.
 */
export const aiRequestsRouter = {
	claim: protectedProcedure
		.route({
			method: "POST",
			path: "/ai-requests/claim",
			operationId: "claimAiRequest",
			summary: "Claim the next queued AI request",
			description:
				"Long-polls the queue of inference requests that features enqueued for a Connected agent (MCP) provider. Returns at most one request, atomically marked as claimed with a lease, or null when nothing arrived within `wait` seconds.",
			...reserved,
		})
		.input(
			z.object({
				providerId: z.string().optional().describe("Only claim requests for this AI provider id."),
				wait: z.number().int().min(0).max(MAX_CLAIM_WAIT_SECONDS).default(0),
			}),
		)
		.output(type<ClaimedAiRequest | null>())
		.handler(({ context, input }) =>
			aiRequestsService.claim({
				userId: context.user.id,
				...(input.providerId ? { providerId: input.providerId } : {}),
				wait: input.wait,
			}),
		),

	complete: protectedProcedure
		.route({
			method: "POST",
			path: "/ai-requests/complete",
			operationId: "completeAiRequest",
			summary: "Deliver the answer for a claimed AI request",
			description:
				"Answers a claimed request with `text` (a single JSON object when the request's responseFormat is json) and/or `toolCalls` (names from the request's tools). Validation problems are returned as an error so the answer can be fixed and resent.",
			...reserved,
		})
		.input(
			z.object({
				id: z.string().min(1),
				text: z.string().optional(),
				toolCalls: z.array(toolCallSchema).optional(),
			}),
		)
		.output(z.object({ id: z.string(), status: z.literal("completed") }))
		.errors({
			BAD_REQUEST: { message: "The answer does not fit the request.", status: 400 },
			CONFLICT: { message: "The request is not claimed.", status: 409 },
			NOT_FOUND: { message: "AI request was not found.", status: 404 },
		})
		.handler(({ context, input }) =>
			aiRequestsService.complete({
				userId: context.user.id,
				id: input.id,
				...(input.text !== undefined ? { text: input.text } : {}),
				...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
			}),
		),

	fail: protectedProcedure
		.route({
			method: "POST",
			path: "/ai-requests/fail",
			operationId: "failAiRequest",
			summary: "Give up on a claimed AI request",
			description:
				"Marks a queued or claimed request as failed with a reason the requesting feature shows to the user.",
			...reserved,
		})
		.input(z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(2000) }))
		.output(z.object({ id: z.string(), status: z.literal("failed") }))
		.errors({
			CONFLICT: { message: "The request is already finished.", status: 409 },
			NOT_FOUND: { message: "AI request was not found.", status: 404 },
		})
		.handler(({ context, input }) =>
			aiRequestsService.fail({ userId: context.user.id, id: input.id, reason: input.reason }),
		),

	list: protectedProcedure
		.route({
			method: "GET",
			path: "/ai-requests",
			operationId: "listAiRequests",
			summary: "List recent AI requests",
			description: "Recent requests for the authenticated user, newest first, without their payloads.",
			...reserved,
		})
		.input(z.object({ status: requestStatusSchema.optional() }))
		.output(type<AiRequestSummary[]>())
		.handler(({ context, input }) =>
			aiRequestsService.list({ userId: context.user.id, ...(input.status ? { status: input.status } : {}) }),
		),
};
