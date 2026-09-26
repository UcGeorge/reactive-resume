import type { RouterOutput } from "@/libs/orpc/client";
import { orpc } from "@/libs/orpc/client";

export type GuidedSuggestions = RouterOutput["coverLetters"]["guided"]["suggestAngles"];
export type GapHandling = "address" | "adjacent" | "omit";

// Mutations keep the repo pattern of passing TanStack callbacks at the call site; these
// wrappers only pin the procedure so feature code never spells the namespace twice.
export const suggestAnglesMutationOptions = (
	...args: Parameters<typeof orpc.coverLetters.guided.suggestAngles.mutationOptions>
) => orpc.coverLetters.guided.suggestAngles.mutationOptions(...args);

export const draftGuidedCoverLetterMutationOptions = (
	...args: Parameters<typeof orpc.coverLetters.guided.draft.mutationOptions>
) => orpc.coverLetters.guided.draft.mutationOptions(...args);

// Saving the approved letter goes through the ordinary create procedure — the guided flow
// never persists anything on its own.
export const createCoverLetterMutationOptions = (
	...args: Parameters<typeof orpc.coverLetters.create.mutationOptions>
) => orpc.coverLetters.create.mutationOptions(...args);
