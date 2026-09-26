import { and, eq } from "drizzle-orm";
import z from "zod";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { coverLetterSchema } from "@reactive-resume/schema/cover-letter/data";
import { protectedProcedure } from "../../context";
import { applicationService } from "../applications/service";
import { coverLetterService } from "./service";

/**
 * Link a saved cover letter to a job application, or unlink it. The link is the letter's
 * `sourceApplicationId` — the same field the copilot and guided flows set at creation — so the
 * application's Documents section can list the letters written for it. Changing the link is
 * not a content edit, so it neither takes nor bumps the letter's revision.
 */
export const coverLetterLinkRouter = {
	linkApplication: protectedProcedure
		.route({
			method: "POST",
			path: "/cover-letters/{id}/link-application",
			tags: ["Cover Letters"],
			operationId: "linkCoverLetterApplication",
			summary: "Link a cover letter to an application",
			description: "Sets or clears the job application a saved cover letter belongs to.",
			successDescription: "The updated cover letter.",
		})
		.input(z.object({ id: z.string().min(1), applicationId: z.string().min(1).nullable() }))
		.output(coverLetterSchema)
		.handler(async ({ context, input }) => {
			await coverLetterService.getById({ id: input.id, userId: context.user.id });
			if (input.applicationId) {
				await applicationService.getById({ id: input.applicationId, userId: context.user.id });
			}
			const [row] = await db
				.update(schema.coverLetter)
				.set({ sourceApplicationId: input.applicationId })
				.where(and(eq(schema.coverLetter.id, input.id), eq(schema.coverLetter.userId, context.user.id)))
				.returning();
			return coverLetterSchema.parse(row);
		}),
};
