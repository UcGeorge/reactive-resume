import type { MessageDescriptor } from "@lingui/core";
import type { DiscoveredJob, DiscoveredJobStatus } from "../queries";
import { msg, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ArrowSquareOutIcon, BuildingsIcon, CaretDownIcon, TrayIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@reactive-resume/ui/components/empty";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@reactive-resume/ui/components/tooltip";
import { cn } from "@reactive-resume/utils/style";
import { applicationsListQueryKey } from "@/features/applications/queries";
import { formatRelativeTime } from "@/libs/locale";
import {
	bulkDismissJobsMutationOptions,
	discoveredJobsKey,
	discoveredJobsQueryOptions,
	discoveryStatusQueryKey,
	dismissJobMutationOptions,
	importJobMutationOptions,
	markJobSeenMutationOptions,
} from "../queries";

const STATUS_CHIPS = [
	{ value: "new", label: msg`New` },
	{ value: "seen", label: msg`Seen` },
	{ value: "dismissed", label: msg`Dismissed` },
	{ value: "imported", label: msg`Imported` },
	{ value: "expired", label: msg`Expired` },
] as const satisfies { value: DiscoveredJobStatus; label: MessageDescriptor }[];

function formatSalary(salary: NonNullable<DiscoveredJob["salary"]>) {
	const format = (amount: number) => {
		try {
			return new Intl.NumberFormat(
				undefined,
				salary.currency
					? { style: "currency", currency: salary.currency, maximumFractionDigits: 0 }
					: { maximumFractionDigits: 0 },
			).format(amount);
		} catch {
			// An unrecognized currency code shouldn't hide the number.
			return `${salary.currency ?? ""} ${amount}`.trim();
		}
	};
	if (salary.min != null && salary.max != null) {
		return salary.min === salary.max ? format(salary.min) : `${format(salary.min)} – ${format(salary.max)}`;
	}
	if (salary.min != null) return t`From ${format(salary.min)}`;
	if (salary.max != null) return t`Up to ${format(salary.max)}`;
	return null;
}

type InboxViewProps = {
	status: DiscoveredJobStatus;
	watchedCount: number;
	newCount: number;
	onStatusChange: (status: DiscoveredJobStatus) => void;
	onGoToCompanies: () => void;
};

export function InboxView({ status, watchedCount, newCount, onStatusChange, onGoToCompanies }: InboxViewProps) {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();

	const jobsQuery = useQuery(discoveredJobsQueryOptions(status));
	const jobs = jobsQuery.data ?? [];

	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [expandedId, setExpandedId] = useState<string | null>(null);
	// Jobs imported in this session, so the row can flip to "Open application" without a list
	// refetch (a refetch would drop the row from the current chip and lose the user's place).
	const [imported, setImported] = useState<Record<string, string>>({});

	// Drop selected rows that left the current list so the bulk bar never counts hidden rows.
	useEffect(() => {
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const visible = new Set(jobs.map((job) => job.id));
			const next = new Set([...prev].filter((id) => visible.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [jobs]);

	const invalidateLists = () => {
		void queryClient.invalidateQueries({ queryKey: discoveredJobsKey() });
		void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() });
	};

	// Fire-and-forget: reading a job shouldn't interrupt reading it. Only the unread count is
	// refreshed — the row stays in the current list until the next natural refetch.
	const markSeen = useMutation(
		markJobSeenMutationOptions({
			onSuccess: () => void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() }),
		}),
	);

	const dismiss = useMutation(
		dismissJobMutationOptions({
			onSuccess: invalidateLists,
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't dismiss the job.` }),
		}),
	);

	const bulkDismiss = useMutation(
		bulkDismissJobsMutationOptions({
			onSuccess: (result) => {
				invalidateLists();
				setSelected(new Set());
				toast.add({
					type: "success",
					description: plural(result.dismissed, { one: "Dismissed # job.", other: "Dismissed # jobs." }),
				});
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Bulk dismiss failed.` }),
		}),
	);

	const importJob = useMutation(
		importJobMutationOptions({
			onSuccess: (result, variables) => {
				// Keep the row in place (no list invalidation) and flip its action to "Open application".
				setImported((prev) => ({ ...prev, [variables.id]: result.applicationId }));
				void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() });
				void queryClient.invalidateQueries({ queryKey: applicationsListQueryKey() });
				toast.add({ type: "success", description: t`Imported to Applications.` });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Import failed.` }),
		}),
	);

	const toggleExpanded = (job: DiscoveredJob) => {
		setExpandedId((prev) => (prev === job.id ? null : job.id));
		if (job.status === "new" && !markSeen.isPending) markSeen.mutate({ id: job.id });
	};

	const toggleSelected = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			{/* Status chips */}
			<div className="flex flex-wrap items-center gap-1.5">
				{STATUS_CHIPS.map((chip) => (
					<Button
						key={chip.value}
						size="xs"
						variant={status === chip.value ? "secondary" : "outline"}
						onClick={() => onStatusChange(chip.value)}
					>
						{i18n.t(chip.label)}
						{chip.value === "new" && newCount > 0 && <span className="tabular-nums">({newCount})</span>}
					</Button>
				))}
			</div>

			{/* Bulk-action bar */}
			{selected.size > 0 && (
				<div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
					<p className="text-sm">{plural(selected.size, { one: "# job selected", other: "# jobs selected" })}</p>
					<Button
						size="sm"
						variant="destructive"
						className="ms-auto"
						disabled={bulkDismiss.isPending}
						onClick={() => bulkDismiss.mutate({ ids: [...selected] })}
					>
						{bulkDismiss.isPending && <Spinner />}
						<Trans>Dismiss selected</Trans>
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
						<Trans>Clear</Trans>
					</Button>
				</div>
			)}

			{jobsQuery.isLoading ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : jobs.length === 0 ? (
				watchedCount === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<BuildingsIcon />
							</EmptyMedia>
							<EmptyTitle>
								<Trans>Watch a company to start discovering jobs</Trans>
							</EmptyTitle>
							<EmptyDescription>
								<Trans>
									The scanner checks the careers pages of companies you watch and surfaces new postings that match your
									filters.
								</Trans>
							</EmptyDescription>
						</EmptyHeader>
						<Button onClick={onGoToCompanies}>
							<BuildingsIcon />
							<Trans>Go to Companies</Trans>
						</Button>
					</Empty>
				) : (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<TrayIcon />
							</EmptyMedia>
							<EmptyTitle>
								{status === "new" ? (
									<Trans>The scanner hasn't matched anything yet</Trans>
								) : (
									<Trans>Nothing here</Trans>
								)}
							</EmptyTitle>
							<EmptyDescription>
								{status === "new" ? (
									<Trans>Run a scan, or loosen the title and location filters in Settings.</Trans>
								) : (
									<Trans>No jobs with this status.</Trans>
								)}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				)
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
					{jobs.map((job) => (
						<JobRow
							key={job.id}
							job={job}
							expanded={expandedId === job.id}
							selected={selected.has(job.id)}
							applicationId={job.applicationId ?? imported[job.id] ?? null}
							importPending={importJob.isPending && importJob.variables?.id === job.id}
							dismissPending={dismiss.isPending && dismiss.variables?.id === job.id}
							onToggleExpanded={() => toggleExpanded(job)}
							onToggleSelected={() => toggleSelected(job.id)}
							onImport={() => importJob.mutate({ id: job.id })}
							onDismiss={() => dismiss.mutate({ id: job.id })}
						/>
					))}
				</div>
			)}
		</div>
	);
}

type JobRowProps = {
	job: DiscoveredJob;
	expanded: boolean;
	selected: boolean;
	applicationId: string | null;
	importPending: boolean;
	dismissPending: boolean;
	onToggleExpanded: () => void;
	onToggleSelected: () => void;
	onImport: () => void;
	onDismiss: () => void;
};

function JobRow({
	job,
	expanded,
	selected,
	applicationId,
	importPending,
	dismissPending,
	onToggleExpanded,
	onToggleSelected,
	onImport,
	onDismiss,
}: JobRowProps) {
	const { i18n } = useLingui();
	const relativeTimeFormatter = useMemo(
		() => new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }),
		[i18n.locale],
	);

	const salary = job.salary ? formatSalary(job.salary) : null;
	const detailParts = [
		job.company,
		job.location,
		salary,
		job.postedAt
			? t`Posted ${formatRelativeTime(job.postedAt, relativeTimeFormatter)}`
			: t`First seen ${formatRelativeTime(job.firstSeenAt, relativeTimeFormatter)}`,
	].filter(Boolean);

	return (
		<div className={cn("rounded-xl border border-border", expanded && "bg-muted/20")}>
			<div className="flex items-start gap-3 p-3">
				<Checkbox checked={selected} aria-label={t`Select job`} className="mt-1" onCheckedChange={onToggleSelected} />

				{/* Clicking the body expands the description (and marks the job seen). */}
				{/* biome-ignore lint/a11y/useSemanticElements: the row body nests the posting <a>, so it can't itself be a <button>; it stays keyboard-operable via role + tabIndex + onKeyDown. */}
				<div
					role="button"
					tabIndex={0}
					className="min-w-0 flex-1 cursor-pointer outline-none"
					onClick={onToggleExpanded}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							onToggleExpanded();
						}
					}}
				>
					<div className="flex flex-wrap items-center gap-1.5">
						<a
							href={job.url}
							target="_blank"
							rel="noreferrer noopener"
							className="inline-flex min-w-0 items-center gap-1 font-medium text-sm hover:underline"
							onClick={(event) => event.stopPropagation()}
						>
							<span className="truncate">{job.title}</span>
							<ArrowSquareOutIcon className="size-3.5 shrink-0 text-muted-foreground" />
						</a>
						{job.flags?.repost && (
							<Badge
								variant="outline"
								className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
							>
								<Trans>Repost</Trans>
							</Badge>
						)}
						{job.flags?.crosslist &&
							(job.flags.note ? (
								<Tooltip>
									<TooltipTrigger
										render={
											<Badge
												variant="outline"
												className="cursor-default border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
											/>
										}
									>
										<Trans>Cross-listed</Trans>
									</TooltipTrigger>
									<TooltipContent side="bottom" className="max-w-72 whitespace-pre-wrap">
										{job.flags.note}
									</TooltipContent>
								</Tooltip>
							) : (
								<Badge
									variant="outline"
									className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
								>
									<Trans>Cross-listed</Trans>
								</Badge>
							))}
						{job.status === "expired" && (
							<Badge variant="outline" className="border-border text-muted-foreground">
								<Trans>Expired</Trans>
							</Badge>
						)}
					</div>
					<p className="mt-0.5 truncate text-muted-foreground text-xs">{detailParts.join(" · ")}</p>
				</div>

				<div className="flex shrink-0 items-center gap-1.5">
					{applicationId ? (
						<Button
							size="sm"
							variant="outline"
							nativeButton={false}
							render={<Link to="/dashboard/applications" search={{ applicationId }} />}
						>
							<ArrowSquareOutIcon />
							<Trans>Open application</Trans>
						</Button>
					) : (
						<Button size="sm" disabled={importPending} onClick={onImport}>
							{importPending && <Spinner />}
							<Trans>Import to Applications</Trans>
						</Button>
					)}
					{job.status !== "dismissed" && !applicationId && (
						<Button size="sm" variant="ghost" disabled={dismissPending} onClick={onDismiss}>
							{dismissPending && <Spinner />}
							<Trans>Dismiss</Trans>
						</Button>
					)}
					<Button
						size="icon-sm"
						variant="ghost"
						aria-expanded={expanded}
						title={expanded ? t`Collapse` : t`Expand`}
						onClick={onToggleExpanded}
					>
						<CaretDownIcon className={cn("text-muted-foreground transition-transform", expanded && "rotate-180")} />
					</Button>
				</div>
			</div>

			{expanded && (
				<div className="border-border border-t p-3">
					{job.description ? (
						<pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-muted-foreground text-xs leading-relaxed">
							{job.description}
						</pre>
					) : (
						<p className="text-muted-foreground text-xs">
							<Trans>No description was captured for this posting — open the link for details.</Trans>
						</p>
					)}
				</div>
			)}
		</div>
	);
}
