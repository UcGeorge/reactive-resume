import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { cn } from "@reactive-resume/utils/style";
import { gapHeatmapQueryOptions } from "../queries";
import { InsightCard } from "./insight-card";

// The skills postings keep asking for that evaluations flagged as gaps, weighted by how much
// they mattered. "Now covered" entries stay visible (struck through) — a closed gap is signal.
export function GapHeatmapCard() {
	const { data, isLoading } = useQuery(gapHeatmapQueryOptions());

	const maxWeight = Math.max(1, ...(data?.heatmap.map((entry) => entry.weight) ?? []));

	return (
		<InsightCard
			title={<Trans>Gap heatmap</Trans>}
			description={
				data && data.evaluations > 0 ? (
					plural(data.evaluations, {
						one: "Recurring skill gaps across # evaluation",
						other: "Recurring skill gaps across # evaluations",
					})
				) : (
					<Trans>Recurring skill gaps across your evaluations</Trans>
				)
			}
		>
			{isLoading || !data ? (
				<Skeleton className="h-32 w-full" />
			) : data.heatmap.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No gaps mapped yet — run evaluations to build your gap map.</Trans>
				</p>
			) : (
				<div className="flex flex-col gap-3">
					{data.heatmap.map((entry) => (
						<div key={entry.skill} className="flex items-center gap-3 text-xs">
							<span
								className={cn(
									"w-36 shrink-0 truncate font-medium",
									entry.nowCovered && "text-muted-foreground line-through",
								)}
								title={entry.skill}
							>
								{entry.skill}
							</span>
							<div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
								<div
									className={cn("h-full rounded-full", entry.nowCovered ? "bg-emerald-500/50" : "bg-amber-500/70")}
									style={{ width: `${Math.max((entry.weight / maxWeight) * 100, 3)}%` }}
								/>
							</div>
							<span className="w-8 text-right text-muted-foreground tabular-nums">{entry.appearances}×</span>
							{entry.nowCovered ? (
								<span className="flex w-24 items-center gap-1 text-emerald-600 dark:text-emerald-400">
									<CheckCircleIcon className="size-3.5" />
									<Trans>now covered</Trans>
								</span>
							) : (
								<span className="w-24" />
							)}
						</div>
					))}
				</div>
			)}
		</InsightCard>
	);
}
