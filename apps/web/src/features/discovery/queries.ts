import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type DiscoveryStatus = RouterOutput["discovery"]["status"];
export type WatchedCompany = RouterOutput["discovery"]["watchedCompanies"]["list"][number];
export type DiscoveredJob = RouterOutput["discovery"]["jobs"]["list"][number];
export type DiscoveredJobStatus = DiscoveredJob["status"];
export type ScannerSettings = RouterOutput["discovery"]["settings"]["get"];
export type ScanResult = RouterOutput["discovery"]["watchedCompanies"]["test"];

// A single source of truth for each discovery query so the key stays identical between the
// Discover page's views and any future surface (same pattern as the evaluations feature).
export const discoveryStatusQueryOptions = () => orpc.discovery.status.queryOptions();

export const discoveryStatusQueryKey = () => orpc.discovery.status.queryKey();

export const watchedCompaniesQueryOptions = () => orpc.discovery.watchedCompanies.list.queryOptions();

export const watchedCompaniesQueryKey = () => orpc.discovery.watchedCompanies.list.queryKey();

// One cache entry per inbox status chip; `discoveredJobsKey` is the shared partial key so a
// scan or dismissal invalidates every chip's list at once.
export const discoveredJobsQueryOptions = (status: DiscoveredJobStatus) =>
	orpc.discovery.jobs.list.queryOptions({ input: { status } });

export const discoveredJobsKey = () => orpc.discovery.jobs.list.key();

export const scannerSettingsQueryOptions = () => orpc.discovery.settings.get.queryOptions();

export const scannerSettingsQueryKey = () => orpc.discovery.settings.get.queryKey();

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice.
export const scanNowMutationOptions = (...args: Parameters<typeof orpc.discovery.scanNow.mutationOptions>) =>
	orpc.discovery.scanNow.mutationOptions(...args);

export const createWatchedCompanyMutationOptions = (
	...args: Parameters<typeof orpc.discovery.watchedCompanies.create.mutationOptions>
) => orpc.discovery.watchedCompanies.create.mutationOptions(...args);

export const updateWatchedCompanyMutationOptions = (
	...args: Parameters<typeof orpc.discovery.watchedCompanies.update.mutationOptions>
) => orpc.discovery.watchedCompanies.update.mutationOptions(...args);

export const deleteWatchedCompanyMutationOptions = (
	...args: Parameters<typeof orpc.discovery.watchedCompanies.delete.mutationOptions>
) => orpc.discovery.watchedCompanies.delete.mutationOptions(...args);

export const testWatchedCompanyMutationOptions = (
	...args: Parameters<typeof orpc.discovery.watchedCompanies.test.mutationOptions>
) => orpc.discovery.watchedCompanies.test.mutationOptions(...args);

export const updateScannerSettingsMutationOptions = (
	...args: Parameters<typeof orpc.discovery.settings.update.mutationOptions>
) => orpc.discovery.settings.update.mutationOptions(...args);

export const markJobSeenMutationOptions = (...args: Parameters<typeof orpc.discovery.jobs.markSeen.mutationOptions>) =>
	orpc.discovery.jobs.markSeen.mutationOptions(...args);

export const dismissJobMutationOptions = (...args: Parameters<typeof orpc.discovery.jobs.dismiss.mutationOptions>) =>
	orpc.discovery.jobs.dismiss.mutationOptions(...args);

export const bulkDismissJobsMutationOptions = (
	...args: Parameters<typeof orpc.discovery.jobs.bulkDismiss.mutationOptions>
) => orpc.discovery.jobs.bulkDismiss.mutationOptions(...args);

export const importJobMutationOptions = (...args: Parameters<typeof orpc.discovery.jobs.import.mutationOptions>) =>
	orpc.discovery.jobs.import.mutationOptions(...args);
