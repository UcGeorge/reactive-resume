import z from "zod";
import { protectedProcedure } from "../../context";
import {
	computeCalibration,
	computeChannelStats,
	computeFunnelVelocity,
	computeGapHeatmap,
	computeRejectionPatterns,
} from "./service";

const reserved = { tags: ["Career Insights"] } as const;

export const careerInsightsRouter = {
	calibration: protectedProcedure
		.route({ method: "GET", path: "/career/insights/calibration", operationId: "getCalibrationReport", ...reserved })
		.input(z.object({}).optional().default({}))
		.output(
			z.object({
				bands: z.array(
					z.object({
						band: z.string(),
						total: z.number(),
						interviews: z.number(),
						offers: z.number(),
						interviewRate: z.number().nullable(),
						insufficient: z.boolean(),
					}),
				),
				settled: z.number(),
				excludedInFlight: z.number(),
				advisory: z.string(),
			}),
		)
		.handler(({ context }) => computeCalibration(context.user.id)),

	gapHeatmap: protectedProcedure
		.route({ method: "GET", path: "/career/insights/gap-heatmap", operationId: "getGapHeatmap", ...reserved })
		.input(z.object({}).optional().default({}))
		.output(
			z.object({
				heatmap: z.array(
					z.object({
						skill: z.string(),
						appearances: z.number(),
						weight: z.number(),
						nowCovered: z.boolean(),
					}),
				),
				evaluations: z.number(),
			}),
		)
		.handler(({ context }) => computeGapHeatmap(context.user.id)),

	funnelVelocity: protectedProcedure
		.route({ method: "GET", path: "/career/insights/funnel-velocity", operationId: "getFunnelVelocity", ...reserved })
		.input(z.object({}).optional().default({}))
		.output(z.array(z.object({ transition: z.string(), count: z.number(), medianDays: z.number().nullable() })))
		.handler(({ context }) => computeFunnelVelocity(context.user.id)),

	channelStats: protectedProcedure
		.route({ method: "GET", path: "/career/insights/channels", operationId: "getChannelStats", ...reserved })
		.input(z.object({}).optional().default({}))
		.output(
			z.array(
				z.object({
					channel: z.string(),
					total: z.number(),
					screening: z.number(),
					interviews: z.number(),
					offers: z.number(),
					advanceRate: z.number().nullable(),
					insufficient: z.boolean(),
				}),
			),
		)
		.handler(({ context }) => computeChannelStats(context.user.id)),

	rejectionPatterns: protectedProcedure
		.route({
			method: "GET",
			path: "/career/insights/rejection-patterns",
			operationId: "getRejectionPatterns",
			...reserved,
		})
		.input(z.object({}).optional().default({}))
		.output(
			z.object({
				rejectedTotal: z.number(),
				medianDaysToRejection: z.number().nullable(),
				rejectedBeforeScreeningShare: z.number().nullable(),
				dropByStage: z.array(z.object({ stage: z.string(), count: z.number() })),
				insufficient: z.boolean(),
			}),
		)
		.handler(({ context }) => computeRejectionPatterns(context.user.id)),
};
