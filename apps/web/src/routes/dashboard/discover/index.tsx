import { msg, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	ArrowsClockwiseIcon,
	BinocularsIcon,
	BuildingsIcon,
	FadersIcon,
	ProhibitIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import z from "zod";
import { Button } from "@reactive-resume/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@reactive-resume/ui/components/empty";
import { Separator } from "@reactive-resume/ui/components/separator";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@reactive-resume/ui/components/tabs";
import { toast } from "@reactive-resume/ui/components/toast";
import { CompaniesView, scanResultToast } from "@/features/discovery/components/companies-view";
import { InboxView } from "@/features/discovery/components/inbox-view";
import { SettingsView } from "@/features/discovery/components/settings-view";
import {
	discoveredJobsKey,
	discoveryStatusQueryKey,
	discoveryStatusQueryOptions,
	scanNowMutationOptions,
	watchedCompaniesQueryKey,
	watchedCompaniesQueryOptions,
} from "@/features/discovery/queries";
import { formatRelativeTime } from "@/libs/locale";
import { DashboardHeader } from "../-components/header";

const searchSchema = z.object({
	view: z.enum(["inbox", "companies", "settings"]).default("inbox"),
	status: z.enum(["new", "seen", "dismissed", "imported", "expired"]).default("new"),
});
type Search = z.output<typeof searchSchema>;
const defaultSearch: Search = { view: "inbox", status: "new" };

export const Route = createFileRoute("/dashboard/discover/")({
	component: RouteComponent,
	validateSearch: searchSchema,
	search: { middlewares: [stripSearchParams(defaultSearch)] },
});

function RouteComponent() {
	const { i18n } = useLingui();
	const { view, status } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const queryClient = useQueryClient();

	const statusQuery = useQuery(discoveryStatusQueryOptions());
	// Also feeds the Companies view (shared cache); here it maps scan results to company names.
	const companiesQuery = useQuery(watchedCompaniesQueryOptions());

	const relativeTimeFormatter = useMemo(
		() => new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }),
		[i18n.locale],
	);

	const setUrlSearch = (patch: Partial<Search>) => void navigate({ search: (prev: Search) => ({ ...prev, ...patch }) });

	const scanNow = useMutation(
		scanNowMutationOptions({
			onSuccess: ({ results }) => {
				void queryClient.invalidateQueries({ queryKey: discoveredJobsKey() });
				void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() });
				void queryClient.invalidateQueries({ queryKey: watchedCompaniesQueryKey() });

				const matched = results.reduce((sum, result) => sum + result.matched, 0);
				const added = results.reduce((sum, result) => sum + result.added, 0);
				toast.add({ type: "success", description: t`Scan complete — ${matched} matched, ${added} new.` });
				// Per-company failures surface individually so a broken board is never silent.
				for (const result of results.filter((result) => result.status !== "ok")) {
					scanResultToast(
						result,
						companiesQuery.data?.find((company) => company.id === result.watchedCompanyId)?.name ?? "",
					);
				}
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`The scan failed.` }),
		}),
	);

	const enabled = statusQuery.data?.enabled ?? true;
	const watchedCount = statusQuery.data?.watchedCount ?? 0;
	const newCount = statusQuery.data?.newCount ?? 0;
	const lastScanAt = statusQuery.data?.lastScanAt ?? null;

	return (
		<div className="flex h-[calc(100dvh-2rem)] flex-col gap-4">
			<DashboardHeader
				className="max-sm:flex-col max-sm:gap-y-3"
				icon={BinocularsIcon}
				title={t`Discover`}
				actions={
					enabled ? (
						<Button size="sm" disabled={scanNow.isPending || watchedCount === 0} onClick={() => scanNow.mutate({})}>
							{scanNow.isPending ? <Spinner /> : <ArrowsClockwiseIcon />}
							{scanNow.isPending ? <Trans>Scanning…</Trans> : <Trans>Scan now</Trans>}
						</Button>
					) : undefined
				}
			/>

			<Separator />

			{statusQuery.data && !enabled ? (
				<Empty className="flex-1">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ProhibitIcon />
						</EmptyMedia>
						<EmptyTitle>
							<Trans>The job scanner is disabled on this server</Trans>
						</EmptyTitle>
						<EmptyDescription>
							<Trans>
								The operator turned the scanner off with the FLAG_DISABLE_JOB_SCANNER flag. Ask them to enable it to
								watch company careers pages and discover new postings here.
							</Trans>
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<div className="flex items-center gap-2">
						<p className="min-w-0 truncate text-muted-foreground text-sm">
							{plural(watchedCount, { one: "Watching # company", other: "Watching # companies" })}
							{" · "}
							{lastScanAt ? (
								<Trans>last scan {formatRelativeTime(lastScanAt, relativeTimeFormatter)}</Trans>
							) : (
								<Trans>no scans yet</Trans>
							)}
						</p>

						<Tabs className="ms-auto shrink-0" value={view}>
							<TabsList>
								<TabsTrigger
									value="inbox"
									title={i18n.t(msg`Inbox`)}
									nativeButton={false}
									render={<Link to="." search={(p: Search) => ({ ...p, view: "inbox" })} />}
								>
									<TrayIcon />
									<span className="sr-only">{i18n.t(msg`Inbox`)}</span>
								</TabsTrigger>
								<TabsTrigger
									value="companies"
									title={i18n.t(msg`Companies`)}
									nativeButton={false}
									render={<Link to="." search={(p: Search) => ({ ...p, view: "companies" })} />}
								>
									<BuildingsIcon />
									<span className="sr-only">{i18n.t(msg`Companies`)}</span>
								</TabsTrigger>
								<TabsTrigger
									value="settings"
									title={i18n.t(msg`Settings`)}
									nativeButton={false}
									render={<Link to="." search={(p: Search) => ({ ...p, view: "settings" })} />}
								>
									<FadersIcon />
									<span className="sr-only">{i18n.t(msg`Settings`)}</span>
								</TabsTrigger>
							</TabsList>
						</Tabs>
					</div>

					<div className="flex min-h-0 flex-1 flex-col">
						{view === "inbox" && (
							<InboxView
								status={status}
								watchedCount={watchedCount}
								newCount={newCount}
								onStatusChange={(next) => setUrlSearch({ status: next })}
								onGoToCompanies={() => setUrlSearch({ view: "companies" })}
							/>
						)}
						{view === "companies" && <CompaniesView />}
						{view === "settings" && <SettingsView />}
					</div>
				</>
			)}
		</div>
	);
}
