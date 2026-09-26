import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { channelStatsQueryOptions } from "../queries";
import { InsightCard, RateBar } from "./insight-card";

// Which sources actually advance: per-channel counts with an advance-rate bar once the
// sample is big enough to mean anything.
export function ChannelsCard() {
	const { data, isLoading } = useQuery(channelStatsQueryOptions());

	return (
		<InsightCard
			title={<Trans>Channels</Trans>}
			description={<Trans>Where applications come from, and which sources advance</Trans>}
		>
			{isLoading || !data ? (
				<Skeleton className="h-32 w-full" />
			) : data.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No channel data yet — set a source on your applications to compare them here.</Trans>
				</p>
			) : (
				<div className="flex flex-col gap-1 text-xs">
					<div className="grid grid-cols-[minmax(0,1.4fr)_2.5rem_2.5rem_2.5rem_2.5rem_minmax(0,2fr)] items-center gap-2 pb-1 text-muted-foreground">
						<span>
							<Trans>Channel</Trans>
						</span>
						<span className="text-right">
							<Trans>All</Trans>
						</span>
						<span className="text-right">
							<Trans>Scr</Trans>
						</span>
						<span className="text-right">
							<Trans>Int</Trans>
						</span>
						<span className="text-right">
							<Trans>Off</Trans>
						</span>
						<span className="ps-2">
							<Trans>Advance rate</Trans>
						</span>
					</div>
					{data.map((row) => (
						<div
							key={row.channel}
							className="grid grid-cols-[minmax(0,1.4fr)_2.5rem_2.5rem_2.5rem_2.5rem_minmax(0,2fr)] items-center gap-2 border-border/60 border-t py-1.5"
						>
							<span className="min-w-0 truncate font-medium" title={row.channel}>
								{row.channel}
							</span>
							<span className="text-right tabular-nums">{row.total}</span>
							<span className="text-right text-muted-foreground tabular-nums">{row.screening}</span>
							<span className="text-right text-muted-foreground tabular-nums">{row.interviews}</span>
							<span className="text-right text-muted-foreground tabular-nums">{row.offers}</span>
							<div className="ps-2">
								{row.advanceRate === null ? (
									<span className="text-muted-foreground">
										{row.insufficient ? <Trans>not enough data yet (n &lt; 5)</Trans> : <Trans>no data</Trans>}
									</span>
								) : (
									<RateBar rate={row.advanceRate} />
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</InsightCard>
	);
}
