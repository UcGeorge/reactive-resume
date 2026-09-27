import type { AiFeature } from "@reactive-resume/ai/types";
import { AI_FEATURES } from "@reactive-resume/ai/types";

export type RouteStatus = "unset" | "ok" | "unavailable" | "removed";
type RouteSource = "feature" | "default" | "fallback";

type ProviderLike = { id: string; enabled: boolean; testStatus: string; createdAt: Date };
type RouteLike = { feature: string; aiProviderId: string | null };

export type ResolvedRoute = {
	providerId: string | null;
	source: RouteSource;
	/** Set when a route existed but was skipped, so the UI can say why the default was used. */
	warning?: "unavailable" | "removed";
};

export type AiProviderRouteStatus = {
	feature: AiFeature;
	aiProviderId: string | null;
	status: RouteStatus;
	effectiveProviderId: string | null;
	source: RouteSource;
};

function isRunnable(provider: ProviderLike) {
	return provider.enabled && provider.testStatus === "success";
}

function routeFor(feature: AiFeature, routes: RouteLike[]) {
	return routes.find((route) => route.feature === feature);
}

export function routeStatus(route: RouteLike | undefined, providers: ProviderLike[]): RouteStatus {
	if (!route) return "unset";
	if (route.aiProviderId === null) return "removed";

	const provider = providers.find((candidate) => candidate.id === route.aiProviderId);
	return provider && isRunnable(provider) ? "ok" : "unavailable";
}

// Feature route → default route → oldest runnable provider. A route whose provider cannot run is
// skipped rather than failing the feature; its status is reported so the UI can flag it.
export function resolveFeatureProviderId(
	feature: AiFeature,
	routes: RouteLike[],
	providers: ProviderLike[],
): ResolvedRoute {
	let warning: ResolvedRoute["warning"];

	const consider = (route: RouteLike | undefined) => {
		const status = routeStatus(route, providers);
		if (status === "ok") return route?.aiProviderId ?? null;
		if (status === "unavailable" || status === "removed") warning ??= status;
		return null;
	};

	if (feature !== "default") {
		const viaFeature = consider(routeFor(feature, routes));
		if (viaFeature) return { providerId: viaFeature, source: "feature" };
	}

	const viaDefault = consider(routeFor("default", routes));
	if (viaDefault) return { providerId: viaDefault, source: "default", ...(warning ? { warning } : {}) };

	const oldest = providers
		.filter(isRunnable)
		.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];

	return { providerId: oldest?.id ?? null, source: "fallback", ...(warning ? { warning } : {}) };
}

export function listRouteStatuses(routes: RouteLike[], providers: ProviderLike[]): AiProviderRouteStatus[] {
	return AI_FEATURES.map((feature) => {
		const route = routeFor(feature, routes);
		const resolved = resolveFeatureProviderId(feature, routes, providers);

		return {
			feature,
			aiProviderId: route?.aiProviderId ?? null,
			status: routeStatus(route, providers),
			effectiveProviderId: resolved.providerId,
			source: resolved.source,
		};
	});
}
