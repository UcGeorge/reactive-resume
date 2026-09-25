import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type Evaluation = RouterOutput["evaluations"]["get"];

// A single source of truth for the per-application evaluations list so the query key stays
// identical between the panel, the copilot's "Full evaluation" action, and any future surface.
export const evaluationsListQueryOptions = (applicationId: string) =>
	orpc.evaluations.listByApplication.queryOptions({ input: { applicationId } });

export const evaluationsListQueryKey = (applicationId: string) =>
	orpc.evaluations.listByApplication.queryKey({ input: { applicationId } });

export const evaluationQueryOptions = (id: string) => orpc.evaluations.get.queryOptions({ input: { id } });

export const evaluationQueryKey = (id: string) => orpc.evaluations.get.queryKey({ input: { id } });

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice.
export const startEvaluationMutationOptions = (...args: Parameters<typeof orpc.evaluations.start.mutationOptions>) =>
	orpc.evaluations.start.mutationOptions(...args);

export const retryEvaluationMutationOptions = (...args: Parameters<typeof orpc.evaluations.retry.mutationOptions>) =>
	orpc.evaluations.retry.mutationOptions(...args);

export const deleteEvaluationMutationOptions = (...args: Parameters<typeof orpc.evaluations.delete.mutationOptions>) =>
	orpc.evaluations.delete.mutationOptions(...args);
