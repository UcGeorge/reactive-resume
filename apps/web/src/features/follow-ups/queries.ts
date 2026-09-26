import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type FollowUpQueueEntry = RouterOutput["followUps"]["queue"][number];
export type FollowUpKind = FollowUpQueueEntry["kind"];

// A single source of truth for each follow-ups query so the key stays identical between the
// Applications page's Follow-ups view and the view-switcher badge (same pattern as discovery).
export const followUpsQueueQueryOptions = () => orpc.followUps.queue.queryOptions();

// Shared partial key so completing/snoozing/dismissing invalidates every queue read at once,
// whatever horizon it was fetched with.
export const followUpsQueueKey = () => orpc.followUps.queue.key();

export const followUpsDueCountQueryOptions = () => orpc.followUps.dueCount.queryOptions();

export const followUpsDueCountQueryKey = () => orpc.followUps.dueCount.queryKey();

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice.
export const completeFollowUpMutationOptions = (...args: Parameters<typeof orpc.followUps.complete.mutationOptions>) =>
	orpc.followUps.complete.mutationOptions(...args);

export const snoozeFollowUpMutationOptions = (...args: Parameters<typeof orpc.followUps.snooze.mutationOptions>) =>
	orpc.followUps.snooze.mutationOptions(...args);

export const dismissFollowUpMutationOptions = (...args: Parameters<typeof orpc.followUps.dismiss.mutationOptions>) =>
	orpc.followUps.dismiss.mutationOptions(...args);

export const draftFollowUpMutationOptions = (...args: Parameters<typeof orpc.followUps.draft.mutationOptions>) =>
	orpc.followUps.draft.mutationOptions(...args);
