import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { funnelVelocityQueryOptions } from "../queries";
import { InsightCard } from "./insight-card";

// How long each stage transition typically takes — median days per observed transition.
export function FunnelVelocityCard() {
	const { data, isLoading } = useQuery(funnelVelocityQueryOptions());

	return (
		<InsightCard
			title={<Trans>Funnel velocity</Trans>}
			description={<Trans>Median days between stage transitions</Trans>}
		>
			{isLoading || !data ? (
				<Skeleton className="h-32 w-full" />
			) : data.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No stage transitions recorded yet — velocity appears as applications move through stages.</Trans>
				</p>
			) : (
				<div className="flex flex-col gap-2.5">
					{data.map((row) => (
						<div key={row.transition} className="flex items-center justify-between gap-3 text-xs">
							<span className="min-w-0 truncate font-medium">{row.transition}</span>
							<span className="shrink-0 text-muted-foreground tabular-nums">
								{row.medianDays === null ? (
									<Trans>no timing data</Trans>
								) : (
									plural(Math.round(row.medianDays * 10) / 10, {
										one: "median # day",
										other: "median # days",
									})
								)}
								{" · "}
								{plural(row.count, { one: "# move", other: "# moves" })}
							</span>
						</div>
					))}
				</div>
			)}
		</InsightCard>
	);
}
