import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type CalibrationReport = RouterOutput["careerInsights"]["calibration"];
export type CalibrationBand = CalibrationReport["bands"][number];
export type GapHeatmapReport = RouterOutput["careerInsights"]["gapHeatmap"];
export type GapHeatmapEntry = GapHeatmapReport["heatmap"][number];
export type FunnelVelocityRow = RouterOutput["careerInsights"]["funnelVelocity"][number];
export type ChannelStatsRow = RouterOutput["careerInsights"]["channelStats"][number];
export type RejectionPatterns = RouterOutput["careerInsights"]["rejectionPatterns"];

// A single source of truth for each learning-loop query so the key stays identical between
// the Insights page's sections and any future surface (same pattern as discovery).
export const calibrationQueryOptions = () => orpc.careerInsights.calibration.queryOptions();

export const calibrationQueryKey = () => orpc.careerInsights.calibration.queryKey();

export const gapHeatmapQueryOptions = () => orpc.careerInsights.gapHeatmap.queryOptions();

export const gapHeatmapQueryKey = () => orpc.careerInsights.gapHeatmap.queryKey();

export const funnelVelocityQueryOptions = () => orpc.careerInsights.funnelVelocity.queryOptions();

export const funnelVelocityQueryKey = () => orpc.careerInsights.funnelVelocity.queryKey();

export const channelStatsQueryOptions = () => orpc.careerInsights.channelStats.queryOptions();

export const channelStatsQueryKey = () => orpc.careerInsights.channelStats.queryKey();

export const rejectionPatternsQueryOptions = () => orpc.careerInsights.rejectionPatterns.queryOptions();

export const rejectionPatternsQueryKey = () => orpc.careerInsights.rejectionPatterns.queryKey();
