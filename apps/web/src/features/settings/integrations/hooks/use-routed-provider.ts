import type { AiFeature } from "@reactive-resume/ai/types";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/libs/orpc/client";

/**
 * The provider a feature resolves to on the server (its own route, then Default, then the oldest
 * tested provider). Pickers preselect this so the web agrees with what the server would use.
 */
export function useRoutedProvider(feature: AiFeature) {
	const { data, isLoading } = useQuery(orpc.aiProviders.routes.list.queryOptions());
	const route = data?.find((row) => row.feature === feature);

	return {
		providerId: route?.effectiveProviderId ?? null,
		status: route?.status ?? "unset",
		isLoading,
	};
}
