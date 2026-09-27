import { t } from "@lingui/core/macro";
import { InfoIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { Separator } from "@reactive-resume/ui/components/separator";
import { AboutSettingsPage } from "@/features/settings/pages/about";
import { DashboardHeader } from "../-components/header";

export const Route = createFileRoute("/dashboard/settings/about")({
	component: RouteComponent,
});

function RouteComponent() {
	return (
		<div className="space-y-4">
			<DashboardHeader icon={InfoIcon} title={t`About`} />

			<Separator />

			<AboutSettingsPage />
		</div>
	);
}
