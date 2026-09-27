import z from "zod";
import { publicProcedure } from "../../context";
import { statisticsService } from "./service";

export const statisticsRouter = {
	getTotals: publicProcedure
		.route({
			method: "GET",
			path: "/statistics",
			tags: ["Platform Statistics"],
			operationId: "getStatisticsTotals",
			summary: "Get user and resume totals with their cache timestamp",
		})
		.output(
			z.object({
				users: z.number(),
				resumes: z.number(),
				cachedAt: z
					.number()
					.nullable()
					.describe("Oldest count's cache timestamp in Unix milliseconds, or null for fallback totals."),
			}),
		)
		.handler(() => statisticsService.getTotals()),
};
