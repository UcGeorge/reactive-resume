import type { AIProvider, AiFeature } from "@reactive-resume/ai/types";
import type { LanguageModel } from "ai";
import type { RunnableAiProvider } from "../ai-providers/service";
import { ORPCError } from "@orpc/client";
import { aiProvidersService } from "../ai-providers/service";
import { getModel } from "./service";

export const NO_AI_PROVIDER_MESSAGE =
	"No AI provider is configured. Add one in Settings → Integrations to use AI features.";

export type ResolvedFeatureModel = {
	model: LanguageModel;
	provider: AIProvider;
	providerId: string;
	modelId: string;
};

/** Builds a model from a runnable provider row, carrying the owner for queue-backed providers. */
export function runnableToModel(provider: RunnableAiProvider): LanguageModel {
	return getModel({
		provider: provider.provider,
		model: provider.model,
		apiKey: provider.apiKey,
		id: provider.id,
		userId: provider.userId,
		...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
	});
}

/** The provider a feature should use, or null when the user has none that is tested and enabled. */
export async function resolveRunnableForFeature(userId: string, feature: AiFeature) {
	return (await aiProvidersService.resolveForFeature({ userId, feature })).provider;
}

/** The feature's provider as a ready model, or the standard "configure a provider" error. */
export async function resolveModelForFeature(userId: string, feature: AiFeature): Promise<ResolvedFeatureModel> {
	const provider = await resolveRunnableForFeature(userId, feature);
	if (!provider) throw new ORPCError("BAD_REQUEST", { message: NO_AI_PROVIDER_MESSAGE });

	return {
		model: runnableToModel(provider),
		provider: provider.provider,
		providerId: provider.id,
		modelId: provider.model,
	};
}
