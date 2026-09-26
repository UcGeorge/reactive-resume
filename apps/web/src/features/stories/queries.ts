import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type Story = RouterOutput["stories"]["list"][number];
export type StoryProvenance = Story["provenance"];

// A single source of truth for the story-bank list so the key stays identical between the
// Interviews page's grid, the matcher results, and any future surface (same pattern as discovery).
export const storiesListQueryOptions = () => orpc.stories.list.queryOptions();

export const storiesListQueryKey = () => orpc.stories.list.queryKey();

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice.
export const createStoryMutationOptions = (...args: Parameters<typeof orpc.stories.create.mutationOptions>) =>
	orpc.stories.create.mutationOptions(...args);

export const updateStoryMutationOptions = (...args: Parameters<typeof orpc.stories.update.mutationOptions>) =>
	orpc.stories.update.mutationOptions(...args);

export const deleteStoryMutationOptions = (...args: Parameters<typeof orpc.stories.delete.mutationOptions>) =>
	orpc.stories.delete.mutationOptions(...args);

export const checkProvenanceMutationOptions = (
	...args: Parameters<typeof orpc.stories.checkProvenance.mutationOptions>
) => orpc.stories.checkProvenance.mutationOptions(...args);

export const matchStoriesMutationOptions = (...args: Parameters<typeof orpc.stories.match.mutationOptions>) =>
	orpc.stories.match.mutationOptions(...args);

export const suggestStoriesFromResumeMutationOptions = (
	...args: Parameters<typeof orpc.stories.suggestFromResume.mutationOptions>
) => orpc.stories.suggestFromResume.mutationOptions(...args);
