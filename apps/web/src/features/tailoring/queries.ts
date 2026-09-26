import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type TailoringRun = RouterOutput["evaluations"]["tailoringRuns"]["get"];

// A single source of truth for the per-application tailoring runs list so the query key stays
// identical between the panel and any future surface (same pattern as the evaluations feature).
export const tailoringRunsListQueryOptions = (applicationId: string) =>
	orpc.evaluations.tailoringRuns.list.queryOptions({ input: { applicationId } });

export const tailoringRunsListQueryKey = (applicationId: string) =>
	orpc.evaluations.tailoringRuns.list.queryKey({ input: { applicationId } });

/** A run whose request is still working on the server (mirrors the API's in-flight set). */
export const isTailoringInFlight = (status: TailoringRun["status"]) =>
	status === "pending" || status === "planned" || status === "gated";

const TAILORING_POLL_INTERVAL_MS = 3000;

/** The runs list, polled while any run is in flight. The server owns the progress, so every
 * surface (Tailoring tab, copilot) shows it after tab switches and reloads alike.
 * `pollWhileStarting` covers the moment between clicking Tailor and the run row appearing —
 * pass the mutation's pending flag so the first step shows without waiting a full interval. */
export const tailoringRunsLiveQueryOptions = (
	applicationId: string,
	options: { pollWhileStarting?: boolean } = {},
) => ({
	...tailoringRunsListQueryOptions(applicationId),
	refetchInterval: (query: { state: { data?: TailoringRun[] | undefined } }) =>
		options.pollWhileStarting || query.state.data?.some((run) => isTailoringInFlight(run.status))
			? TAILORING_POLL_INTERVAL_MS
			: false,
});

export const tailoringRunQueryOptions = (id: string) =>
	orpc.evaluations.tailoringRuns.get.queryOptions({ input: { id } });

export const tailoringRunQueryKey = (id: string) => orpc.evaluations.tailoringRuns.get.queryKey({ input: { id } });

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice. Callers
// invalidate the runs list on success (and the application itself when the linked resume
// changed, i.e. after tailorResume and discard).
export const tailorResumeMutationOptions = (
	...args: Parameters<typeof orpc.applications.ai.tailorResume.mutationOptions>
) => orpc.applications.ai.tailorResume.mutationOptions(...args);

export const discardTailoringRunMutationOptions = (
	...args: Parameters<typeof orpc.evaluations.tailoringRuns.discard.mutationOptions>
) => orpc.evaluations.tailoringRuns.discard.mutationOptions(...args);

export const auditTailoringRunMutationOptions = (
	...args: Parameters<typeof orpc.evaluations.tailoringRuns.audit.mutationOptions>
) => orpc.evaluations.tailoringRuns.audit.mutationOptions(...args);

export const factCheckMutationOptions = (...args: Parameters<typeof orpc.evaluations.factCheck.mutationOptions>) =>
	orpc.evaluations.factCheck.mutationOptions(...args);
