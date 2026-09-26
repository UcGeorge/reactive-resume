import type { ScanResult, WatchedCompany } from "../queries";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ArrowsClockwiseIcon, BuildingsIcon, FlaskIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@reactive-resume/ui/components/empty";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { Switch } from "@reactive-resume/ui/components/switch";
import { toast } from "@reactive-resume/ui/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@reactive-resume/ui/components/tooltip";
import { useConfirm } from "@/hooks/use-confirm";
import { formatRelativeTime } from "@/libs/locale";
import {
	deleteWatchedCompanyMutationOptions,
	discoveredJobsKey,
	discoveryStatusQueryKey,
	scanNowMutationOptions,
	testWatchedCompanyMutationOptions,
	updateWatchedCompanyMutationOptions,
	watchedCompaniesQueryKey,
	watchedCompaniesQueryOptions,
} from "../queries";
import { WatchCompanyDialog } from "./watch-company-dialog";

export const scanResultToast = (result: ScanResult, companyName: string) => {
	if (result.status === "ok") {
		toast.add({
			type: "success",
			description: t`${companyName}: fetched ${result.fetched} postings, ${result.matched} matched, ${result.added} new.`,
		});
		return;
	}
	toast.add({
		type: "error",
		description:
			result.status === "unsupported"
				? t`${companyName}: this careers site isn't supported yet.`
				: t`${companyName}: ${result.error ?? t`scan failed.`}`,
	});
};

export function CompaniesView() {
	const confirm = useConfirm();
	const queryClient = useQueryClient();
	const [watchOpen, setWatchOpen] = useState(false);

	const companiesQuery = useQuery(watchedCompaniesQueryOptions());
	const companies = companiesQuery.data ?? [];

	const invalidateCompanies = () => {
		void queryClient.invalidateQueries({ queryKey: watchedCompaniesQueryKey() });
		void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() });
	};

	// A test/scan is a live fetch that also upserts jobs, so the inbox lists refresh too.
	const invalidateAfterScan = () => {
		invalidateCompanies();
		void queryClient.invalidateQueries({ queryKey: discoveredJobsKey() });
	};

	const update = useMutation(
		updateWatchedCompanyMutationOptions({
			onSuccess: invalidateCompanies,
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't update the watch.` }),
		}),
	);

	const remove = useMutation(
		deleteWatchedCompanyMutationOptions({
			onSuccess: () => {
				invalidateCompanies();
				toast.add({ type: "success", description: t`Company removed from your watches.` });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't delete the watch.` }),
		}),
	);

	const test = useMutation(
		testWatchedCompanyMutationOptions({
			onSuccess: (result) => {
				invalidateAfterScan();
				scanResultToast(result, companies.find((company) => company.id === result.watchedCompanyId)?.name ?? "");
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`The test failed.` }),
		}),
	);

	const scan = useMutation(
		scanNowMutationOptions({
			onSuccess: ({ results }) => {
				invalidateAfterScan();
				for (const result of results) {
					scanResultToast(result, companies.find((company) => company.id === result.watchedCompanyId)?.name ?? "");
				}
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`The scan failed.` }),
		}),
	);

	const onDelete = (company: WatchedCompany) => {
		void confirm(t`Stop watching ${company.name}?`, {
			description: t`The watch and its scan history are removed. Jobs already discovered stay in your inbox.`,
			confirmText: t`Delete`,
		}).then((confirmed) => {
			if (confirmed) remove.mutate({ id: company.id });
		});
	};

	if (companiesQuery.isLoading) {
		return (
			<div className="flex flex-col gap-2">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<p className="text-muted-foreground text-sm">
					{plural(companies.length, { one: "# watched company", other: "# watched companies" })}
				</p>
				<Button size="sm" onClick={() => setWatchOpen(true)}>
					<PlusIcon />
					<Trans>Watch a company</Trans>
				</Button>
			</div>

			{companies.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<BuildingsIcon />
						</EmptyMedia>
						<EmptyTitle>
							<Trans>Watch your first company</Trans>
						</EmptyTitle>
						<EmptyDescription>
							<Trans>
								Paste a careers page URL and the scanner will check it for new postings that match your filters.
							</Trans>
						</EmptyDescription>
					</EmptyHeader>
					<Button onClick={() => setWatchOpen(true)}>
						<PlusIcon />
						<Trans>Watch a company</Trans>
					</Button>
				</Empty>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
					{companies.map((company) => (
						<CompanyRow
							key={company.id}
							company={company}
							testPending={test.isPending && test.variables?.id === company.id}
							scanPending={scan.isPending && scan.variables?.watchedCompanyId === company.id}
							deletePending={remove.isPending && remove.variables?.id === company.id}
							onToggleEnabled={(enabled) => update.mutate({ id: company.id, enabled })}
							onTest={() => test.mutate({ id: company.id })}
							onScan={() => scan.mutate({ watchedCompanyId: company.id })}
							onDelete={() => onDelete(company)}
						/>
					))}
				</div>
			)}

			<WatchCompanyDialog open={watchOpen} onOpenChange={setWatchOpen} />
		</div>
	);
}

function StatusBadge({ company }: { company: WatchedCompany }) {
	switch (company.lastStatus) {
		case "ok":
			return (
				<Badge
					variant="outline"
					className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
				>
					<Trans>ok</Trans>
				</Badge>
			);
		case "error":
			return (
				<Tooltip>
					<TooltipTrigger
						render={
							<Badge
								variant="outline"
								className="cursor-default border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
							/>
						}
					>
						<Trans>error</Trans>
					</TooltipTrigger>
					<TooltipContent side="bottom" className="max-w-72 whitespace-pre-wrap">
						{company.lastError ?? t`The last scan failed.`}
					</TooltipContent>
				</Tooltip>
			);
		case "unsupported":
			return (
				<Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
					<Trans>unsupported board</Trans>
				</Badge>
			);
		default:
			return (
				<Badge variant="outline" className="border-border text-muted-foreground">
					<Trans>never scanned</Trans>
				</Badge>
			);
	}
}

type CompanyRowProps = {
	company: WatchedCompany;
	testPending: boolean;
	scanPending: boolean;
	deletePending: boolean;
	onToggleEnabled: (enabled: boolean) => void;
	onTest: () => void;
	onScan: () => void;
	onDelete: () => void;
};

function CompanyRow({
	company,
	testPending,
	scanPending,
	deletePending,
	onToggleEnabled,
	onTest,
	onScan,
	onDelete,
}: CompanyRowProps) {
	const { i18n } = useLingui();
	const relativeTimeFormatter = useMemo(
		() => new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }),
		[i18n.locale],
	);
	const busy = testPending || scanPending || deletePending;

	return (
		<div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
			<div className="min-w-0 flex-1 basis-56">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-sm">{company.name}</span>
					{company.provider && (
						<Badge variant="outline" className="border-border text-muted-foreground">
							{company.provider}
						</Badge>
					)}
					<StatusBadge company={company} />
				</div>
				<p className="mt-0.5 truncate text-muted-foreground text-xs">
					<a href={company.careersUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">
						{company.careersUrl}
					</a>
					{" · "}
					{company.lastScanAt ? (
						<Trans>last scan {formatRelativeTime(company.lastScanAt, relativeTimeFormatter)}</Trans>
					) : (
						<Trans>never scanned</Trans>
					)}
				</p>
			</div>

			<div className="flex shrink-0 items-center gap-1.5">
				<Switch
					size="sm"
					checked={company.enabled}
					aria-label={t`Enable scanning for ${company.name}`}
					onCheckedChange={onToggleEnabled}
				/>
				<Button size="sm" variant="outline" disabled={busy} onClick={onTest}>
					{testPending ? <Spinner /> : <FlaskIcon />}
					<Trans>Test</Trans>
				</Button>
				<Button size="sm" variant="outline" disabled={busy || !company.enabled} onClick={onScan}>
					{scanPending ? <Spinner /> : <ArrowsClockwiseIcon />}
					<Trans>Scan</Trans>
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					className="text-destructive"
					title={t`Delete watch`}
					disabled={busy}
					onClick={onDelete}
				>
					{deletePending ? <Spinner /> : <TrashIcon />}
				</Button>
			</div>
		</div>
	);
}
