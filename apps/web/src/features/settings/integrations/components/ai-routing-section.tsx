import type { RouterOutput } from "@/libs/orpc/client";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Label } from "@reactive-resume/ui/components/label";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { Combobox } from "@/components/ui/combobox";
import { AI_FEATURE_COPY } from "@/features/settings/integrations/ai-features";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type RouteRow = RouterOutput["aiProviders"]["routes"]["list"][number];
type SavedProvider = RouterOutput["aiProviders"]["list"][number];

const USE_DEFAULT = "__default__";

type RouteBadgeProps = {
	status: RouteRow["status"];
};

// Only the two states where the server silently used something else get a badge; "ok" and
// "unset" are what the picker already shows.
function RouteBadge({ status }: RouteBadgeProps) {
	if (status === "unavailable") {
		return (
			<Badge variant="destructive">
				<Trans>Provider unavailable, using default</Trans>
			</Badge>
		);
	}

	if (status === "removed") {
		return (
			<Badge variant="destructive">
				<Trans>Provider removed, using default</Trans>
			</Badge>
		);
	}

	return null;
}

function providerOptionLabel(provider: SavedProvider) {
	const base = `${provider.label} · ${provider.provider} · ${provider.model}`;
	const usable = provider.enabled && provider.testStatus === "success";

	return usable ? base : `${base} (${t`not connected`})`;
}

export function AiRoutingSection() {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();
	const { data: providers, error } = useQuery(orpc.aiProviders.list.queryOptions());
	const { data: routes, isLoading } = useQuery(orpc.aiProviders.routes.list.queryOptions());
	const { mutate: setRoute, isPending } = useMutation(orpc.aiProviders.routes.set.mutationOptions());

	// The providers section already explains the configuration error; a second banner would repeat it.
	if (error) return null;

	// Every saved provider is offered, not only usable ones, so a route to an untested provider
	// still shows what it points at instead of an empty picker.
	const providerOptions = (providers ?? []).map((provider) => ({
		value: provider.id,
		label: providerOptionLabel(provider),
		keywords: [provider.label, provider.provider, provider.model],
	}));

	return (
		<section className="grid gap-6">
			<div>
				<h2 className="font-semibold text-lg">
					<Trans>Routing</Trans>
				</h2>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Pick which provider each feature uses. Features without a route use Default; an unset Default uses the
						oldest tested provider.
					</Trans>
				</p>
			</div>

			{isLoading ? (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Spinner />
					<Trans>Loading routes…</Trans>
				</div>
			) : null}

			{routes ? (
				<div className="divide-y rounded-md border bg-card">
					{routes.map((row) => {
						const copy = AI_FEATURE_COPY[row.feature];
						const inputId = `ai-route-${row.feature}`;
						const defaultLabel = row.feature === "default" ? t`Oldest tested provider` : t`Use default`;

						return (
							<div
								key={row.feature}
								className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] md:items-center"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<Label htmlFor={inputId} className="font-medium">
											{i18n._(copy.label)}
										</Label>
										<RouteBadge status={row.status} />
									</div>
									<p className="text-muted-foreground text-sm">{i18n._(copy.description)}</p>
								</div>

								<Combobox
									id={inputId}
									value={row.aiProviderId ?? USE_DEFAULT}
									showClear={false}
									disabled={isPending}
									options={[{ value: USE_DEFAULT, label: defaultLabel }, ...providerOptions]}
									onValueChange={(value) => {
										if (!value) return;

										setRoute(
											{ feature: row.feature, aiProviderId: value === USE_DEFAULT ? null : value },
											{
												onSuccess: (updated) =>
													queryClient.setQueryData(orpc.aiProviders.routes.list.queryKey(), updated),
												onError: (mutationError) =>
													toast.add({
														type: "error",
														description: getOrpcErrorMessage(mutationError, {
															fallback: t`Failed to update routing.`,
														}),
													}),
											},
										);
									}}
								/>
							</div>
						);
					})}
				</div>
			) : null}
		</section>
	);
}
