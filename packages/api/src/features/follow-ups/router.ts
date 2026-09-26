import { ORPCError } from "@orpc/client";
import { protectedProcedure } from "../../context";
import { followUpDto } from "../../dto/follow-up";
import { aiRequestRateLimit } from "../../middleware/rate-limit";
import { applicationService } from "../applications/service";
import { followUpsService } from "./service";

const reserved = { tags: ["Follow-ups"] } as const;

const followUpErrors = {
	BAD_REQUEST: { message: "Invalid follow-up request.", status: 400 },
	NOT_FOUND: { message: "Follow-up not found.", status: 404 },
};

export const followUpsRouter = {
	// The due/upcoming queue. Reading it lazily recomputes cadence rows for active
	// applications, so the queue is correct even between daily sweeps.
	queue: protectedProcedure
		.route({ method: "GET", path: "/follow-ups/queue", operationId: "getFollowUpQueue", ...reserved })
		.input(followUpDto.queue.input)
		.output(followUpDto.queue.output)
		.errors(followUpErrors)
		.handler(async ({ context, input }) => {
			await followUpsService.recomputeAll({ userId: context.user.id });
			return followUpsService.queue({ userId: context.user.id, horizonDays: input.horizonDays });
		}),

	dueCount: protectedProcedure
		.route({ method: "GET", path: "/follow-ups/due-count", operationId: "getFollowUpDueCount", ...reserved })
		.input(followUpDto.dueCount.input)
		.output(followUpDto.dueCount.output)
		.errors(followUpErrors)
		.handler(async ({ context }) => ({ due: await followUpsService.dueCount({ userId: context.user.id }) })),

	complete: protectedProcedure
		.route({ method: "POST", path: "/follow-ups/{id}/complete", operationId: "completeFollowUp", ...reserved })
		.input(followUpDto.complete.input)
		.output(followUpDto.complete.output)
		.errors(followUpErrors)
		.handler(({ context, input }) =>
			followUpsService.setStatus({ id: input.id, userId: context.user.id, status: "done" }),
		),

	snooze: protectedProcedure
		.route({ method: "POST", path: "/follow-ups/{id}/snooze", operationId: "snoozeFollowUp", ...reserved })
		.input(followUpDto.snooze.input)
		.output(followUpDto.snooze.output)
		.errors(followUpErrors)
		.handler(({ context, input }) => {
			if (input.until.getTime() <= Date.now()) {
				throw new ORPCError("BAD_REQUEST", { message: "Snooze until must be in the future." });
			}
			return followUpsService.setStatus({
				id: input.id,
				userId: context.user.id,
				status: "snoozed",
				snoozedUntil: input.until,
			});
		}),

	dismiss: protectedProcedure
		.route({ method: "POST", path: "/follow-ups/{id}/dismiss", operationId: "dismissFollowUp", ...reserved })
		.input(followUpDto.dismiss.input)
		.output(followUpDto.dismiss.output)
		.errors(followUpErrors)
		.handler(({ context, input }) =>
			followUpsService.setStatus({ id: input.id, userId: context.user.id, status: "dismissed" }),
		),

	createCustom: protectedProcedure
		.route({ method: "POST", path: "/follow-ups", operationId: "createCustomFollowUp", ...reserved })
		.input(followUpDto.createCustom.input)
		.output(followUpDto.createCustom.output)
		.errors(followUpErrors)
		.handler(({ context, input }) => followUpsService.createCustom({ userId: context.user.id, ...input })),

	// Draft the follow-up message itself: delegates to the copilot's existing draftMessage
	// with the elapsed-days context the cadence row carries.
	draft: protectedProcedure
		.route({ method: "POST", path: "/follow-ups/{id}/draft", operationId: "draftFollowUpMessage", ...reserved })
		.input(followUpDto.draft.input)
		.use(aiRequestRateLimit)
		.output(followUpDto.draft.output)
		.errors({ ...followUpErrors, BAD_GATEWAY: { message: "The AI provider returned an error.", status: 502 } })
		.handler(async ({ context, input }) => {
			const queue = await followUpsService.queue({ userId: context.user.id, horizonDays: 365 });
			const entry = queue.find((row) => row.id === input.id);
			if (!entry) throw new ORPCError("NOT_FOUND");
			// Reuse the copilot's draft path through the router client would recurse the
			// middleware; call the applications AI helper contextually instead by importing
			// its building blocks lazily.
			const { draftFollowUpText } = await import("./draft");
			const application = await applicationService.getById({ id: entry.applicationId, userId: context.user.id });
			return { text: await draftFollowUpText({ userId: context.user.id, application, followUp: entry }) };
		}),
};
