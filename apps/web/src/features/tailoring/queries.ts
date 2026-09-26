import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type TailoringRun = RouterOutput["evaluations"]["tailoringRuns"]["get"];

// A single source of truth for the per-application tailoring runs list so the query key stays
// identical between the panel and any future surface (same pattern as the evaluations feature).
export const tailoringRunsListQueryOptions = (applicationId: string) =>
	orpc.evaluations.tailoringRuns.list.queryOptions({ input: { applicationId } });

export const tailoringRunsListQueryKey = (applicationId: string) =>
	orpc.evaluations.tailoringRuns.list.queryKey({ input: { applicationId } });

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
