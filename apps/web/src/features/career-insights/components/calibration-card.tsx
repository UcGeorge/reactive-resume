import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { calibrationQueryOptions } from "../queries";
import { InsightCard, RateBar } from "./insight-card";

// Score bands vs what actually happened. The advisory line leads on purpose: this section
// reports on the evaluator, it never tunes it.
export function CalibrationCard() {
	const { data, isLoading } = useQuery(calibrationQueryOptions());

	return (
		<InsightCard
			title={<Trans>Calibration</Trans>}
			description={<Trans>Evaluation score bands vs interviews and offers, settled applications only</Trans>}
		>
			{isLoading || !data ? (
				<Skeleton className="h-32 w-full" />
			) : (
				<div className="flex flex-col gap-4">
					<p className="rounded-md border border-border bg-muted/40 p-3 text-sm">{data.advisory}</p>

					{data.settled === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No settled applications with evaluations yet — calibration starts once outcomes land.</Trans>
						</p>
					) : (
						<div className="flex flex-col gap-3">
							{data.bands.map((band) => (
								<div key={band.band} className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 text-xs">
									<div>
										<p className="font-medium">{band.band}</p>
										<p className="text-muted-foreground tabular-nums">
											<Trans>
												{band.total} total · {band.interviews} interviews · {band.offers} offers
											</Trans>
										</p>
									</div>
									{band.interviewRate === null ? (
										<span className="text-muted-foreground">
											{band.insufficient ? (
												<Trans>not enough data yet (n &lt; 5)</Trans>
											) : (
												<Trans>no interview data</Trans>
											)}
										</span>
									) : (
										<RateBar rate={band.interviewRate} />
									)}
								</div>
							))}
						</div>
					)}

					{data.excludedInFlight > 0 && (
						<p className="text-muted-foreground text-xs">
							{plural(data.excludedInFlight, {
								one: "# application still in play — not counted.",
								other: "# applications still in play — not counted.",
							})}
						</p>
					)}
				</div>
			)}
		</InsightCard>
	);
}
