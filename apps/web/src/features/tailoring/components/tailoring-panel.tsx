import type {
	AuditReport,
	FactGateReportData,
	ReuseDecision,
	TailoringChange,
	TailoringStatus,
} from "@reactive-resume/schema/career/data";
import type { TailoringRun } from "../queries";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ArrowSquareOutIcon,
	CaretDownIcon,
	CheckCircleIcon,
	MagicWandIcon,
	ShieldCheckIcon,
	SpinnerGapIcon,
	TrashIcon,
	UserFocusIcon,
	WarningIcon,
	XCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@reactive-resume/ui/components/accordion";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@reactive-resume/ui/components/tooltip";
import { cn } from "@reactive-resume/utils/style";
import { useConfirm } from "@/hooks/use-confirm";
import {
	auditTailoringRunMutationOptions,
	discardTailoringRunMutationOptions,
	factCheckMutationOptions,
	isTailoringInFlight,
	tailoringRunsListQueryKey,
	tailoringRunsLiveQueryOptions,
	tailorResumeMutationOptions,
} from "../queries";

const formatDateTime = (value: Date | string) =>
	new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// --- Enum presentation maps (functions so the Lingui macros re-evaluate per render) ---------

const POSITIVE_CHIP = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
const WARNING_CHIP = "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
const DESTRUCTIVE_CHIP = "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
const NEUTRAL_CHIP = "border-border bg-muted text-muted-foreground";

const statusMeta = (status: TailoringStatus) => {
	switch (status) {
		case "complete":
			return { label: t`complete`, className: POSITIVE_CHIP };
		case "failed":
			return { label: t`failed`, className: DESTRUCTIVE_CHIP };
		case "rejected":
			return { label: t`rejected`, className: DESTRUCTIVE_CHIP };
		case "pending":
			return { label: t`planning…`, className: WARNING_CHIP };
		case "planned":
			return { label: t`fact-checking…`, className: WARNING_CHIP };
		case "gated":
			return { label: t`saving…`, className: WARNING_CHIP };
	}
};

// What the server is doing right now, per in-flight status.
const inFlightStepLabel = (status: TailoringStatus) => {
	switch (status) {
		case "planned":
			return t`Compiling the plan and running the fact gate…`;
		case "gated":
			return t`Fact gate passed — saving the tailored copy…`;
		default:
			return t`Planning edits against the posting…`;
	}
};

const reuseDecisionLabel = (decision: ReuseDecision["decision"]) => {
	switch (decision) {
		case "reuse":
			return t`reused`;
		case "reuse-with-edits":
			return t`reused with edits`;
		case "regenerate":
			return t`regenerated`;
	}
};

const auditVerdictMeta = (verdict: AuditReport["rows"][number]["verdict"]) => {
	switch (verdict) {
		case "keep":
			return { label: t`keep`, className: NEUTRAL_CHIP };
		case "cut":
			return { label: t`cut`, className: DESTRUCTIVE_CHIP };
		case "rewrite":
			return { label: t`rewrite`, className: WARNING_CHIP };
	}
};

// The compiler and lint entries in the changelog are machine annotations (dropped operations,
// deterministic cleanups), not the model's tailoring decisions — style them apart.
const changeTone = (section: string) => {
	if (section === "Compiler") {
		return { container: "border-border border-dashed bg-muted/40 text-muted-foreground", badge: NEUTRAL_CHIP };
	}
	if (section === "Lint") {
		return { container: "border-amber-500/40 bg-amber-500/5", badge: WARNING_CHIP };
	}
	return { container: "border-border", badge: "border-border text-muted-foreground" };
};

// --- Panel -----------------------------------------------------------------------------------

type TailoringPanelProps = {
	id: string;
	resumeId: string | null;
	jobDescription: string | null;
	// Tailoring and discarding repoint the application's linked resume; the host surface
	// refreshes its application query here so the Overview tab shows the new link.
	onResumeChanged?: () => void;
};

export function TailoringPanel({ id, resumeId, jobDescription, onResumeChanged }: TailoringPanelProps) {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	// `undefined` means "no explicit choice yet" — the newest run is expanded by default.
	const [expandedId, setExpandedId] = useState<string | null>();

	const list = useQuery(tailoringRunsLiveQueryOptions(id));
	const runs = list.data ?? [];
	const expanded = expandedId === undefined ? (runs[0]?.id ?? null) : expandedId;
	// Server state, not the local mutation: a run started from the copilot, another tab, or
	// before a reload still shows here.
	const activeRun = runs.find((run) => isTailoringInFlight(run.status)) ?? null;

	const invalidateList = () => {
		void queryClient.invalidateQueries({ queryKey: tailoringRunsListQueryKey(id) });
	};

	// A polled run finishing may have relinked the application's resume.
	const activeRunId = activeRun?.id ?? null;
	const prevActiveRef = useRef(activeRunId);
	useEffect(() => {
		const previous = prevActiveRef.current;
		prevActiveRef.current = activeRunId;
		if (previous && !activeRunId) onResumeChanged?.();
	}, [activeRunId, onResumeChanged]);

	const tailor = useMutation(
		tailorResumeMutationOptions({
			// The run row exists moments after the request starts; surface it to every observer.
			onMutate: () => {
				setTimeout(invalidateList, 1500);
			},
			onSuccess: (result) => {
				invalidateList();
				onResumeChanged?.();
				setExpandedId(undefined);
				toast.add({
					type: "success",
					description: result.reused
						? t`Reused "${result.name}" — the posting still matches the existing tailored resume.`
						: t`Created "${result.name}" and linked it to this application.`,
				});
			},
			onError: (error) => {
				invalidateList();
				toast.add({ type: "error", description: error.message || t`Tailoring failed.` });
			},
		}),
	);
	const running = tailor.isPending || activeRun !== null;

	const discard = useMutation(
		discardTailoringRunMutationOptions({
			onSuccess: () => {
				invalidateList();
				onResumeChanged?.();
				toast.add({ type: "success", description: t`Tailored resume discarded — the source resume is linked again.` });
			},
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't discard the tailored resume.` }),
		}),
	);

	const audit = useMutation(
		auditTailoringRunMutationOptions({
			// The report is persisted on the run, so a list refetch renders it inline.
			onSuccess: invalidateList,
			onError: (error) => toast.add({ type: "error", description: error.message || t`The audit failed.` }),
		}),
	);

	const factCheck = useMutation(
		factCheckMutationOptions({
			onSuccess: (report) => {
				invalidateList();
				toast.add(
					report.passed
						? { type: "success", description: t`Fact check passed — every claim is backed by the source resume.` }
						: {
								type: "error",
								description: plural(report.violations.length, {
									one: "Fact check found # violation.",
									other: "Fact check found # violations.",
								}),
							},
				);
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`The fact check failed.` }),
		}),
	);

	const onDiscard = (run: TailoringRun) => {
		void confirm(t`Discard this tailored resume?`, {
			description: t`The tailored copy will be permanently deleted, the application will be linked back to the source resume, and this run will be marked rejected. This can't be undone.`,
			confirmText: t`Discard`,
		}).then((confirmed) => {
			if (confirmed) discard.mutate({ id: run.id });
		});
	};

	const canRun = !!resumeId && !!jobDescription;

	if (list.isLoading) {
		return (
			<div className="flex flex-col gap-3">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="flex items-center gap-1.5 font-medium text-sm">
							<MagicWandIcon className="text-primary" />
							<Trans>Tailored resumes</Trans>
						</p>
						<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
							<Trans>
								Rewords your real experience toward this posting under strict constraints — nothing is invented, every
								claim must pass a hard fact gate against your source resume, and each run is kept as a numbered version
								for this application.
							</Trans>
						</p>
					</div>
					<Button size="sm" className="shrink-0" disabled={!canRun || running} onClick={() => tailor.mutate({ id })}>
						{running ? <SpinnerGapIcon className="animate-spin" /> : <MagicWandIcon />}
						{running ? <Trans>Tailoring…</Trans> : <Trans>Tailor resume</Trans>}
					</Button>
				</div>
				{!canRun && (
					<p className="text-muted-foreground text-xs">
						<Trans>Link a resume and paste the job description (Edit) to tailor a copy for this job.</Trans>
					</p>
				)}
				{running && (
					<div className="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
						<SpinnerGapIcon className="mt-0.5 shrink-0 animate-spin text-primary" />
						<div className="min-w-0 text-xs">
							<p className="font-medium">
								{activeRun ? inFlightStepLabel(activeRun.status) : <Trans>Starting…</Trans>}
							</p>
							<p className="mt-0.5 text-muted-foreground">
								<Trans>
									Reuse check, plan, compile, fact gate — usually a minute or two. You can switch tabs; progress is
									tracked on the server.
								</Trans>
							</p>
						</div>
					</div>
				)}
				{runs.length === 0 && (
					<p className="text-muted-foreground text-xs">
						<Trans>No tailoring runs yet. Each run appears here as a new version.</Trans>
					</p>
				)}
			</section>

			{runs.map((run) => (
				<RunCard
					key={run.id}
					run={run}
					open={run.id === expanded}
					busy={running || discard.isPending}
					auditPending={audit.isPending && audit.variables?.tailoringRunId === run.id}
					factCheckPending={
						factCheck.isPending && !!run.tailoredResumeId && factCheck.variables?.resumeId === run.tailoredResumeId
					}
					discardPending={discard.isPending && discard.variables?.id === run.id}
					onToggle={() => setExpandedId(run.id === expanded ? null : run.id)}
					onAudit={() => audit.mutate({ tailoringRunId: run.id })}
					onFactCheck={() => {
						if (run.tailoredResumeId) factCheck.mutate({ resumeId: run.tailoredResumeId });
					}}
					onDiscard={() => onDiscard(run)}
				/>
			))}
		</div>
	);
}

// --- Run card --------------------------------------------------------------------------------

type RunCardProps = {
	run: TailoringRun;
	open: boolean;
	busy: boolean;
	auditPending: boolean;
	factCheckPending: boolean;
	discardPending: boolean;
	onToggle: () => void;
	onAudit: () => void;
	onFactCheck: () => void;
	onDiscard: () => void;
};

function RunCard({
	run,
	open,
	busy,
	auditPending,
	factCheckPending,
	discardPending,
	onToggle,
	onAudit,
	onFactCheck,
	onDiscard,
}: RunCardProps) {
	const status = statusMeta(run.status);
	return (
		<div className="overflow-hidden rounded-xl border border-border">
			<button
				type="button"
				className="flex w-full flex-wrap items-center gap-1.5 p-3 text-left hover:bg-muted/40"
				onClick={onToggle}
			>
				<Badge variant="outline" className="border-border tabular-nums">
					v{run.version}
				</Badge>
				<Badge variant="outline" className={status.className}>
					{status.label}
				</Badge>
				<span className="text-muted-foreground text-xs tabular-nums">{formatDateTime(run.createdAt)}</span>
				{run.reuseDecision && <ReuseChip decision={run.reuseDecision} />}
				{run.factGateReport && <FactGateChip report={run.factGateReport} />}
				{run.auditReport && <AuditChip report={run.auditReport} />}
				<CaretDownIcon
					className={cn("ms-auto shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
				/>
			</button>

			{open && (
				<div className="flex flex-col gap-4 border-border border-t p-3">
					{run.status === "failed" && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
							<p className="font-medium text-destructive text-xs">
								<Trans>Tailoring failed</Trans>
							</p>
							<p className="wrap-break-word mt-1 text-muted-foreground text-xs">
								{run.error || t`Something went wrong during the run.`}
							</p>
						</div>
					)}

					{run.changes && run.changes.length > 0 && <ChangesSection changes={run.changes} />}

					{run.factGateReport && <FactGateSection report={run.factGateReport} />}

					{run.reuseDecision && <ReuseDecisionSection decision={run.reuseDecision} />}

					{run.status === "complete" && (
						<div className="flex flex-wrap items-center gap-1.5">
							{run.tailoredResumeId && (
								<Button
									size="sm"
									variant="outline"
									nativeButton={false}
									render={<Link to="/builder/$resumeId" params={{ resumeId: run.tailoredResumeId }} />}
								>
									<ArrowSquareOutIcon />
									<Trans>Open tailored resume</Trans>
								</Button>
							)}
							<Button size="sm" variant="outline" disabled={busy || auditPending} onClick={onAudit}>
								{auditPending ? <SpinnerGapIcon className="animate-spin" /> : <UserFocusIcon />}
								{run.auditReport ? <Trans>Re-run audit</Trans> : <Trans>Run audit</Trans>}
							</Button>
							{run.tailoredResumeId && (
								<Button size="sm" variant="outline" disabled={busy || factCheckPending} onClick={onFactCheck}>
									{factCheckPending ? <SpinnerGapIcon className="animate-spin" /> : <ShieldCheckIcon />}
									<Trans>Re-check facts</Trans>
								</Button>
							)}
							<Button
								size="sm"
								variant="ghost"
								className="ms-auto text-destructive"
								disabled={busy || discardPending}
								onClick={onDiscard}
							>
								{discardPending ? <SpinnerGapIcon className="animate-spin" /> : <TrashIcon />}
								<Trans>Discard</Trans>
							</Button>
						</div>
					)}
					{auditPending && (
						<p className="text-muted-foreground text-xs">
							<Trans>An adversarial hiring-manager review of every bullet — this can take up to a minute.</Trans>
						</p>
					)}

					{run.auditReport && <AuditReportSection report={run.auditReport} />}

					<ArchivedJd jd={run.jdArchived} />
				</div>
			)}
		</div>
	);
}

// --- Header chips ----------------------------------------------------------------------------

function ReuseChip({ decision }: { decision: ReuseDecision }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						className={cn(
							"inline-flex cursor-default items-center gap-1 rounded-full border px-2 py-0.5 text-xs tabular-nums",
							decision.decision === "regenerate" ? NEUTRAL_CHIP : POSITIVE_CHIP,
						)}
					/>
				}
			>
				{reuseDecisionLabel(decision.decision)} · {decision.score.toFixed(2)}
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-72 whitespace-pre-wrap">
				{decision.reason}
			</TooltipContent>
		</Tooltip>
	);
}

function FactGateChip({ report }: { report: FactGateReportData }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
				report.passed ? POSITIVE_CHIP : DESTRUCTIVE_CHIP,
			)}
		>
			{report.passed ? (
				<>
					<CheckCircleIcon weight="fill" className="size-3.5" />
					<Trans>fact gate</Trans>
				</>
			) : (
				<>
					<XCircleIcon weight="fill" className="size-3.5" />
					{plural(report.violations.length, { one: "# fact violation", other: "# fact violations" })}
				</>
			)}
		</span>
	);
}

function AuditChip({ report }: { report: AuditReport }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						className={cn(
							"inline-flex cursor-default items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
							report.wouldAdvance ? POSITIVE_CHIP : DESTRUCTIVE_CHIP,
						)}
					/>
				}
			>
				{report.wouldAdvance ? (
					<CheckCircleIcon weight="fill" className="size-3.5" />
				) : (
					<XCircleIcon weight="fill" className="size-3.5" />
				)}
				<Trans>audit</Trans>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-72 whitespace-pre-wrap">
				{report.reason}
			</TooltipContent>
		</Tooltip>
	);
}

// --- Changes ---------------------------------------------------------------------------------

function ChangesSection({ changes }: { changes: TailoringChange[] }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t`Changes`} />
			<div className="flex flex-col gap-2">
				{changes.map((change, index) => {
					const tone = changeTone(change.section);
					return (
						<div
							key={`${change.section}-${index}`}
							className={cn("flex flex-col gap-1 rounded-lg border p-2.5 text-xs", tone.container)}
						>
							<div className="flex items-start justify-between gap-2">
								<span className="wrap-break-word font-medium">{change.change}</span>
								<Badge variant="outline" className={cn("shrink-0", tone.badge)}>
									{change.section}
								</Badge>
							</div>
							<p className="text-muted-foreground">{change.why}</p>
						</div>
					);
				})}
			</div>
		</section>
	);
}

// --- Fact gate -------------------------------------------------------------------------------

function FactGateSection({ report }: { report: FactGateReportData }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t`Fact gate`} />
			{report.passed ? (
				<div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-emerald-700 text-xs dark:text-emerald-300">
					<CheckCircleIcon weight="fill" className="size-4 shrink-0" />
					<Trans>Passed — every claim in the tailored resume is backed by the source resume.</Trans>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{report.violations.map((violation, index) => (
						<FactFinding
							key={`${violation.claim}-${index}`}
							finding={violation}
							className="border-rose-500/30 bg-rose-500/5"
							badgeClassName={DESTRUCTIVE_CHIP}
						/>
					))}
				</div>
			)}
			{report.warnings.length > 0 && (
				<Accordion className="rounded-lg border border-border px-3">
					<AccordionItem value="fact-warnings">
						<AccordionTrigger className="text-muted-foreground">
							{plural(report.warnings.length, { one: "# warning", other: "# warnings" })}
						</AccordionTrigger>
						<AccordionContent className="flex flex-col gap-2">
							{report.warnings.map((warning, index) => (
								<FactFinding
									key={`${warning.claim}-${index}`}
									finding={warning}
									className="border-amber-500/30 bg-amber-500/5"
									badgeClassName={WARNING_CHIP}
								/>
							))}
						</AccordionContent>
					</AccordionItem>
				</Accordion>
			)}
		</section>
	);
}

type FactFindingProps = {
	finding: FactGateReportData["violations"][number];
	className: string;
	badgeClassName: string;
};

function FactFinding({ finding, className, badgeClassName }: FactFindingProps) {
	return (
		<div className={cn("flex flex-col gap-1 rounded-lg border p-2.5 text-xs", className)}>
			<div className="flex items-start justify-between gap-2">
				<span className="wrap-break-word font-medium">{finding.claim}</span>
				<Badge variant="outline" className={cn("shrink-0", badgeClassName)}>
					{finding.kind}
				</Badge>
			</div>
			<p className="text-muted-foreground">{finding.detail}</p>
		</div>
	);
}

// --- Reuse decision --------------------------------------------------------------------------

function ReuseDecisionSection({ decision }: { decision: ReuseDecision }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t`Reuse decision`} />
			<div className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-xs">
				<div className="flex items-center gap-1.5">
					<Badge variant="outline" className={decision.decision === "regenerate" ? NEUTRAL_CHIP : POSITIVE_CHIP}>
						{reuseDecisionLabel(decision.decision)}
					</Badge>
					<span className="text-muted-foreground tabular-nums">
						<Trans>JD similarity:</Trans> {decision.score.toFixed(2)}
					</span>
				</div>
				<p className="text-muted-foreground">{decision.reason}</p>
			</div>
		</section>
	);
}

// --- Audit report ----------------------------------------------------------------------------

function AuditReportSection({ report }: { report: AuditReport }) {
	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t`Hiring-manager audit`} />
			<p className="text-muted-foreground text-xs">
				<span className="font-medium text-foreground">
					<Trans>Persona:</Trans>
				</span>{" "}
				{report.persona} · <Trans>tier</Trans> {report.tier}
			</p>

			<div
				className={cn(
					"flex flex-col gap-1 rounded-lg border p-2.5 text-xs",
					report.wouldAdvance ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/5",
				)}
			>
				<p
					className={cn(
						"font-medium",
						report.wouldAdvance ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300",
					)}
				>
					{report.wouldAdvance ? <Trans>Would advance: yes</Trans> : <Trans>Would advance: no</Trans>}
				</p>
				<p className="text-muted-foreground">{report.reason}</p>
			</div>

			{report.incomplete && (
				<div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
					<WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
					<p className="text-amber-700 dark:text-amber-300">
						<Trans>The reviewer returned fewer rows than bullets — this is a partial audit.</Trans>
					</p>
				</div>
			)}

			<NoteLine label={t`Scope read`} text={report.scopeRead} />

			{report.rows.length > 0 && <AuditRowsTable rows={report.rows} />}
		</section>
	);
}

function AuditRowsTable({ rows }: { rows: AuditReport["rows"] }) {
	return (
		<>
			{/* Wide layout: the full audit table. */}
			<div className="hidden overflow-hidden rounded-lg border border-border sm:block">
				<table className="w-full table-fixed border-collapse text-xs">
					<colgroup>
						<col className="w-[7%]" />
						<col className="w-[31%]" />
						<col className="w-[14%]" />
						<col className="w-[26%]" />
						<col className="w-[22%]" />
					</colgroup>
					<thead>
						<tr className="border-border border-b bg-muted/50 text-start text-muted-foreground">
							<th className="p-2 text-start font-medium">#</th>
							<th className="p-2 text-start font-medium">
								<Trans>Bullet</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Verdict</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Why</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Rewrite</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const verdict = auditVerdictMeta(row.verdict);
							return (
								<tr key={row.index} className="border-border border-b align-top last:border-b-0">
									<td className="p-2 text-muted-foreground tabular-nums">{row.index + 1}</td>
									<td className="p-2">
										<ExpandableText text={row.bullet} />
									</td>
									<td className="p-2">
										<Badge variant="outline" className={verdict.className}>
											{verdict.label}
										</Badge>
									</td>
									<td className="wrap-break-word p-2 text-muted-foreground">{row.why}</td>
									<td className="p-2">
										{row.rewrite ? (
											<ExpandableText text={row.rewrite} />
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{/* Narrow layout: stacked cards. */}
			<div className="flex flex-col gap-2 sm:hidden">
				{rows.map((row) => {
					const verdict = auditVerdictMeta(row.verdict);
					return (
						<div key={row.index} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5 text-xs">
							<div className="flex items-start justify-between gap-2">
								<span className="text-muted-foreground tabular-nums">#{row.index + 1}</span>
								<Badge variant="outline" className={cn("shrink-0", verdict.className)}>
									{verdict.label}
								</Badge>
							</div>
							<ExpandableText text={row.bullet} />
							<p className="text-muted-foreground">{row.why}</p>
							{row.rewrite && (
								<div className="text-muted-foreground">
									<span className="font-medium text-foreground">
										<Trans>Rewrite:</Trans>
									</span>{" "}
									<ExpandableText text={row.rewrite} inline />
								</div>
							)}
						</div>
					);
				})}
			</div>
		</>
	);
}

// --- Shared bits -----------------------------------------------------------------------------

function ArchivedJd({ jd }: { jd: string }) {
	return (
		<Accordion className="rounded-lg border border-border border-dashed px-3">
			<AccordionItem value="archived-jd">
				<AccordionTrigger className="text-muted-foreground">
					<Trans>Archived job description</Trans>
				</AccordionTrigger>
				<AccordionContent>
					<pre className="max-h-80 overflow-y-auto whitespace-pre-wrap font-mono text-muted-foreground text-xs leading-relaxed">
						{jd}
					</pre>
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);
}

type ExpandableTextProps = { text: string; inline?: boolean };

function ExpandableText({ text, inline }: ExpandableTextProps) {
	const [expanded, setExpanded] = useState(false);
	return (
		<button
			type="button"
			title={expanded ? t`Collapse` : t`Expand`}
			className={cn(
				"wrap-break-word text-start text-muted-foreground hover:text-foreground",
				inline ? "inline" : "block w-full",
				!expanded && "line-clamp-2",
			)}
			onClick={() => setExpanded((value) => !value)}
		>
			{text}
		</button>
	);
}

function NoteLine({ label, text }: { label: string; text: string }) {
	return (
		<p className="whitespace-pre-wrap text-muted-foreground text-xs">
			<span className="font-medium text-foreground">{label}:</span> {text}
		</p>
	);
}

function SectionHeading({ title }: { title: string }) {
	return <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>;
}
