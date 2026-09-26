import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { rejectionPatternsQueryOptions } from "../queries";
import { InsightCard } from "./insight-card";

// Where rejections cluster: how fast they arrive, how many never reach screening, and which
// stage drops the most.
export function RejectionPatternsCard() {
	const { data, isLoading } = useQuery(rejectionPatternsQueryOptions());

	return (
		<InsightCard
			title={<Trans>Rejection patterns</Trans>}
			description={<Trans>How and where rejections cluster</Trans>}
		>
			{isLoading || !data ? (
				<Skeleton className="h-32 w-full" />
			) : data.rejectedTotal === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No rejections recorded — nothing to learn from here yet.</Trans>
				</p>
			) : (
				<div className="flex flex-col gap-4">
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						<div className="rounded-md border border-border p-3">
							<p className="text-muted-foreground text-xs">
								<Trans>Rejections</Trans>
							</p>
							<p className="mt-1 font-bold text-xl tabular-nums tracking-tight">{data.rejectedTotal}</p>
						</div>
						<div className="rounded-md border border-border p-3">
							<p className="text-muted-foreground text-xs">
								<Trans>Median days to rejection</Trans>
							</p>
							<p className="mt-1 font-bold text-xl tabular-nums tracking-tight">
								{data.medianDaysToRejection === null ? "—" : Math.round(data.medianDaysToRejection * 10) / 10}
							</p>
						</div>
						<div className="rounded-md border border-border p-3">
							<p className="text-muted-foreground text-xs">
								<Trans>Rejected before screening</Trans>
							</p>
							<p className="mt-1 font-bold text-xl tabular-nums tracking-tight">
								{data.rejectedBeforeScreeningShare === null
									? "—"
									: `${Math.round(data.rejectedBeforeScreeningShare * 100)}%`}
							</p>
						</div>
					</div>

					{data.dropByStage.length > 0 && (
						<div className="flex flex-col gap-1.5">
							<p className="font-medium text-xs">
								<Trans>Drop by stage</Trans>
							</p>
							{data.dropByStage.map((row) => (
								<div key={row.stage} className="flex items-center justify-between gap-3 text-xs">
									<span className="min-w-0 truncate">{row.stage}</span>
									<span className="shrink-0 text-muted-foreground tabular-nums">
										{plural(row.count, { one: "# drop", other: "# drops" })}
									</span>
								</div>
							))}
						</div>
					)}

					{data.insufficient && (
						<p className="text-muted-foreground text-xs">
							<Trans>Small sample (n &lt; 5) — read these as anecdotes, not patterns yet.</Trans>
						</p>
					)}
				</div>
			)}
		</InsightCard>
	);
}
