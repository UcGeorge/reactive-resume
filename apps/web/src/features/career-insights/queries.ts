import { orpc } from "@/libs/orpc/client";

// A single source of truth for each learning-loop query so the key stays identical between
// the Insights page's sections and any future surface (same pattern as discovery).
export const calibrationQueryOptions = () => orpc.careerInsights.calibration.queryOptions();

export const gapHeatmapQueryOptions = () => orpc.careerInsights.gapHeatmap.queryOptions();

export const funnelVelocityQueryOptions = () => orpc.careerInsights.funnelVelocity.queryOptions();

export const channelStatsQueryOptions = () => orpc.careerInsights.channelStats.queryOptions();

export const rejectionPatternsQueryOptions = () => orpc.careerInsights.rejectionPatterns.queryOptions();
