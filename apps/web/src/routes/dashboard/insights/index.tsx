import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChartLineUpIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { Separator } from "@reactive-resume/ui/components/separator";
import { CalibrationCard } from "@/features/career-insights/components/calibration-card";
import { ChannelsCard } from "@/features/career-insights/components/channels-card";
import { FunnelVelocityCard } from "@/features/career-insights/components/funnel-velocity-card";
import { GapHeatmapCard } from "@/features/career-insights/components/gap-heatmap-card";
import { RejectionPatternsCard } from "@/features/career-insights/components/rejection-patterns-card";
import { DashboardHeader } from "../-components/header";

export const Route = createFileRoute("/dashboard/insights/")({ component: RouteComponent });

// The learning loop: read-only reports over what has already happened. Everything here is
// advisory — nothing on this page tunes evaluations, scans or follow-ups.
function RouteComponent() {
	return (
		<div className="space-y-4 pb-6">
			<DashboardHeader icon={ChartLineUpIcon} title={t`Insights`} />

			<Separator />

			<p className="text-muted-foreground text-xs">
				<Trans>What your search is teaching you — advisory only, nothing here changes how anything is scored.</Trans>
			</p>

			<div className="grid max-w-6xl gap-4">
				<CalibrationCard />

				<div className="grid gap-4 lg:grid-cols-2">
					<GapHeatmapCard />
					<FunnelVelocityCard />
				</div>

				<ChannelsCard />
				<RejectionPatternsCard />
			</div>
		</div>
	);
}
