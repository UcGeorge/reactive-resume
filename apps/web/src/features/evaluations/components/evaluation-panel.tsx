import type { EvaluationBlocks, EvaluationRequirement, SkillGapResult } from "@reactive-resume/schema/career/data";
import type { Evaluation } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	CircleDashedIcon,
	FlagIcon,
	GaugeIcon,
	MinusCircleIcon,
	SpinnerGapIcon,
	WarningIcon,
	WarningOctagonIcon,
	XCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	deleteEvaluationMutationOptions,
	evaluationQueryKey,
	evaluationQueryOptions,
	evaluationsListQueryKey,
	evaluationsListQueryOptions,
	retryEvaluationMutationOptions,
	startEvaluationMutationOptions,
} from "../queries";

// 4.0 is the apply line: at or above it the banner gets the positive accent.
const APPLY_LINE = 4;
const POLL_INTERVAL_MS = 2500;

type RiskLevel = EvaluationBlocks["confidence"];
type LegitimacySignal = EvaluationBlocks["legitimacySignals"][number];

const isInFlight = (status: Evaluation["status"]) => status === "pending" || status === "running";

const formatDateTime = (value: Date | string) =>
	new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// --- Enum presentation maps (functions so the Lingui macros re-evaluate per render) ---------

const importanceMeta = (importance: EvaluationRequirement["importance"]) => {
	switch (importance) {
		case "critical":
			return { label: t`critical`, className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300" };
		case "high":
			return {
				label: t`high`,
				className: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
			};
		case "meaningful":
			return {
				label: t`meaningful`,
				className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
			};
		case "preferred":
			return { label: t`preferred`, className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" };
		case "low_signal":
			return { label: t`low signal`, className: "border-border bg-muted text-muted-foreground" };
	}
};

const evidenceTierLabel = (tier: EvaluationRequirement["evidenceTier"]) => {
	switch (tier) {
		case "stated":
			return t`stated`;
		case "structural":
			return t`structural`;
		case "inferred":
			return t`inferred`;
	}
};

const matchMeta = (match: EvaluationRequirement["match"]) => {
	switch (match) {
		case "strong":
			return { label: t`strong`, icon: CheckCircleIcon, className: "text-emerald-600 dark:text-emerald-400" };
		case "partial":
			return { label: t`partial`, icon: WarningIcon, className: "text-amber-600 dark:text-amber-400" };
		case "missing":
			return { label: t`missing`, icon: XCircleIcon, className: "text-rose-600 dark:text-rose-400" };
		case "na":
			return { label: t`n/a`, icon: MinusCircleIcon, className: "text-muted-foreground" };
		default:
			return null;
	}
};

const decisionMeta = (decision: EvaluationBlocks["finalDecision"]) => {
	switch (decision) {
		case "apply":
			return {
				label: t`Apply`,
				className: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
			};
		case "consider":
			return {
				label: t`Consider`,
				className: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
			};
		case "research_first":
			return { label: t`Research first`, className: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300" };
		case "skip":
			return { label: t`Skip`, className: "border-border bg-muted text-muted-foreground" };
	}
};

const legitimacyMeta = (legitimacy: NonNullable<Evaluation["legitimacy"]>) => {
	switch (legitimacy) {
		case "high_confidence":
			return {
				label: t`Legitimacy: high confidence`,
				className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
			};
		case "proceed_with_caution":
			return {
				label: t`Legitimacy: proceed with caution`,
				className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
			};
		case "suspicious":
			return {
				label: t`Legitimacy: suspicious`,
				className: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
			};
	}
};

const riskLevelLabel = (level: RiskLevel) => {
	switch (level) {
		case "low":
			return t`low`;
		case "medium":
			return t`medium`;
		case "high":
			return t`high`;
	}
};

const workAuthLabel = (workAuth: NonNullable<Evaluation["workAuth"]>) => {
	switch (workAuth) {
		case "sponsors":
			return t`Sponsors visas`;
		case "not_needed":
			return t`No sponsorship needed`;
		case "unstated":
			return t`Sponsorship unstated`;
		case "no_sponsorship":
			return t`No sponsorship`;
	}
};

const signalStatusMeta = (status: LegitimacySignal["status"]) => {
	switch (status) {
		case "ok":
			return { label: t`ok`, icon: CheckCircleIcon, className: "text-emerald-600 dark:text-emerald-400" };
		case "caution":
			return { label: t`caution`, icon: WarningIcon, className: "text-amber-600 dark:text-amber-400" };
		case "flag":
			return { label: t`flag`, icon: FlagIcon, className: "text-rose-600 dark:text-rose-400" };
		case "not_evaluated":
			return { label: t`not evaluated`, icon: CircleDashedIcon, className: "text-muted-foreground/70" };
	}
};

// --- Panel -----------------------------------------------------------------------------------

type EvaluationPanelProps = {
	application: { id: string; resumeId: string | null; jobDescription: string | null };
};

export function EvaluationPanel({ application }: EvaluationPanelProps) {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const list = useQuery(evaluationsListQueryOptions(application.id));
	const evaluations = list.data ?? [];
	const activeId =
		(selectedId && evaluations.some((e) => e.id === selectedId) ? selectedId : null) ?? evaluations[0]?.id ?? null;

	// Poll the active evaluation while the background run is still working.
	const detail = useQuery({
		...evaluationQueryOptions(activeId ?? ""),
		enabled: !!activeId,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status && isInFlight(status) ? POLL_INTERVAL_MS : false;
		},
	});

	const invalidateList = () => {
		void queryClient.invalidateQueries({ queryKey: evaluationsListQueryKey(application.id) });
	};

	// Keep the history list (status/score chips) in sync once a polled run finishes.
	const detailStatus = detail.data?.status;
	const prevStatusRef = useRef(detailStatus);
	useEffect(() => {
		const previous = prevStatusRef.current;
		prevStatusRef.current = detailStatus;
		if (previous && isInFlight(previous) && (detailStatus === "complete" || detailStatus === "failed")) {
			void queryClient.invalidateQueries({ queryKey: evaluationsListQueryKey(application.id) });
		}
	}, [detailStatus, queryClient, application.id]);

	const start = useMutation(
		startEvaluationMutationOptions({
			onSuccess: (evaluation) => {
				invalidateList();
				setSelectedId(evaluation.id);
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't start the evaluation.` }),
		}),
	);

	const retry = useMutation(
		retryEvaluationMutationOptions({
			onSuccess: (evaluation) => {
				invalidateList();
				void queryClient.invalidateQueries({ queryKey: evaluationQueryKey(evaluation.id) });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't retry the evaluation.` }),
		}),
	);

	const remove = useMutation(
		deleteEvaluationMutationOptions({
			onSuccess: () => {
				invalidateList();
				setSelectedId(null);
			},
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't delete the evaluation.` }),
		}),
	);

	const onDelete = (id: string) => {
		void confirm(t`Delete this evaluation?`, {
			description: t`The report and its archived job description snapshot will be permanently deleted.`,
			confirmText: t`Delete`,
		}).then((confirmed) => {
			if (confirmed) remove.mutate({ id });
		});
	};

	const canRun = !!application.resumeId && !!application.jobDescription;

	if (list.isLoading) {
		return (
			<div className="flex flex-col gap-3">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	if (evaluations.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 rounded-xl border border-border border-dashed p-6 text-center">
				<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
					<GaugeIcon className="size-5" />
				</span>
				<p className="font-medium text-sm">
					<Trans>Deep JD evaluation</Trans>
				</p>
				<p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
					<Trans>
						Runs a multi-pass analysis of this posting against your linked resume: a requirement-by-requirement match
						table, level and compensation strategy, legitimacy screening, interview prep, and a 1–5 verdict where 4.0 is
						the apply line. The job description is archived verbatim with the report.
					</Trans>
				</p>
				<Button
					size="sm"
					disabled={!canRun || start.isPending}
					onClick={() => start.mutate({ applicationId: application.id })}
				>
					{start.isPending ? <SpinnerGapIcon className="animate-spin" /> : <GaugeIcon />}
					<Trans>Run full evaluation</Trans>
				</Button>
				{!canRun && (
					<p className="text-muted-foreground text-xs">
						<Trans>Link a resume and paste the job description (Edit) to run an evaluation.</Trans>
					</p>
				)}
			</div>
		);
	}

	const evaluation =
		detail.data?.id === activeId ? detail.data : (evaluations.find((e) => e.id === activeId) ?? evaluations[0]);
	const busy = start.isPending || retry.isPending || remove.isPending;

	return (
		<div className="flex flex-col gap-4">
			{/* history + actions */}
			<div className="flex flex-wrap items-center gap-1.5">
				{evaluations.length > 1 &&
					evaluations.map((row) => {
						const active = row.id === evaluation.id;
						return (
							<span
								key={row.id}
								className={cn(
									"inline-flex items-center overflow-hidden rounded-full border text-xs",
									active ? "border-primary/50 bg-primary/10" : "border-border",
								)}
							>
								<button
									type="button"
									className={cn(
										"px-2 py-1 tabular-nums",
										active ? "font-medium" : "text-muted-foreground hover:text-foreground",
									)}
									onClick={() => setSelectedId(row.id)}
								>
									{formatDateTime(row.createdAt)}
									{row.score != null ? ` · ${row.score.toFixed(1)}` : ""}
								</button>
								<button
									type="button"
									title={t`Delete evaluation`}
									disabled={busy}
									className="ps-0.5 pe-2 text-muted-foreground hover:text-destructive disabled:opacity-40"
									onClick={() => onDelete(row.id)}
								>
									<XIcon className="size-3" />
								</button>
							</span>
						);
					})}
				<span className="ms-auto inline-flex items-center gap-1">
					<Button
						size="sm"
						variant="outline"
						disabled={!canRun || busy || isInFlight(evaluation.status)}
						onClick={() => start.mutate({ applicationId: application.id })}
					>
						{start.isPending ? <SpinnerGapIcon className="animate-spin" /> : <ArrowClockwiseIcon />}
						<Trans>Run again</Trans>
					</Button>
					{evaluations.length === 1 && (
						<Button
							size="sm"
							variant="ghost"
							className="text-destructive"
							disabled={busy}
							onClick={() => onDelete(evaluation.id)}
						>
							<Trans>Delete</Trans>
						</Button>
					)}
				</span>
			</div>

			{isInFlight(evaluation.status) && (
				<>
					<div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
						<SpinnerGapIcon className="size-5 shrink-0 animate-spin text-primary" />
						<div className="text-sm">
							<p className="font-medium">
								{evaluation.status === "pending" ? (
									<Trans>Evaluation queued…</Trans>
								) : (
									<Trans>Evaluation running…</Trans>
								)}
							</p>
							<p className="text-muted-foreground text-xs">
								<Trans>The multi-pass analysis usually takes a minute. The skill gap below is already final.</Trans>
							</p>
						</div>
					</div>
					<SkillGapSection skillGap={evaluation.skillGap} />
				</>
			)}

			{evaluation.status === "failed" && (
				<div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
					<p className="font-medium text-destructive text-sm">
						<Trans>Evaluation failed</Trans>
					</p>
					<p className="wrap-break-word text-muted-foreground text-xs">
						{evaluation.error || t`Something went wrong during the run.`}
					</p>
					<div>
						<Button size="sm" variant="outline" disabled={busy} onClick={() => retry.mutate({ id: evaluation.id })}>
							{retry.isPending ? <SpinnerGapIcon className="animate-spin" /> : <ArrowClockwiseIcon />}
							<Trans>Retry</Trans>
						</Button>
					</div>
				</div>
			)}

			{evaluation.status === "complete" && <EvaluationReport evaluation={evaluation} />}

			<ArchivedJd jd={evaluation.jdArchived} />
		</div>
	);
}

// --- Report ----------------------------------------------------------------------------------

type EvaluationReportProps = { evaluation: Evaluation };

function EvaluationReport({ evaluation }: EvaluationReportProps) {
	const blocks = evaluation.blocks;
	return (
		<div className="flex flex-col gap-4">
			<ScoreBanner evaluation={evaluation} />

			{blocks && blocks.hardStops.length > 0 && (
				<div className="flex flex-col gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5">
					<p className="flex items-center gap-1.5 font-medium text-destructive text-sm">
						<WarningOctagonIcon />
						<Trans>Hard stops</Trans>
					</p>
					<ul className="list-disc space-y-1 ps-5 text-xs">
						{blocks.hardStops.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</div>
			)}

			{evaluation.requirements && evaluation.requirements.length > 0 && (
				<section className="flex flex-col gap-2">
					<SectionHeading title={t`Requirements`} />
					<RequirementTable requirements={evaluation.requirements} />
				</section>
			)}

			<SkillGapSection skillGap={evaluation.skillGap} />

			{blocks && blocks.gaps.length > 0 && (
				<section className="flex flex-col gap-2">
					<SectionHeading title={t`Gaps & mitigations`} />
					<div className="flex flex-col gap-2">
						{blocks.gaps.map((gap) => {
							const importance = importanceMeta(gap.importance);
							return (
								<div
									key={gap.requirement}
									className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-xs"
								>
									<div className="flex items-start justify-between gap-2">
										<span className="font-medium">{gap.requirement}</span>
										<Badge variant="outline" className={cn("shrink-0", importance.className)}>
											{importance.label}
										</Badge>
									</div>
									<p className="text-muted-foreground">
										<span className="font-medium text-foreground">
											<Trans>Risk:</Trans>
										</span>{" "}
										{gap.risk}
									</p>
									<p className="text-muted-foreground">
										<span className="font-medium text-foreground">
											<Trans>Mitigation:</Trans>
										</span>{" "}
										{gap.mitigation}
									</p>
								</div>
							);
						})}
					</div>
				</section>
			)}

			{blocks && <ReportDetails evaluation={evaluation} blocks={blocks} />}
		</div>
	);
}

function ScoreBanner({ evaluation }: { evaluation: Evaluation }) {
	const blocks = evaluation.blocks;
	const score = evaluation.score;
	const aboveLine = score != null && score >= APPLY_LINE;
	const decision = blocks ? decisionMeta(blocks.finalDecision) : null;
	const legitimacy = evaluation.legitimacy ? legitimacyMeta(evaluation.legitimacy) : null;
	return (
		<div
			className={cn(
				"flex flex-col gap-3 rounded-xl border p-4",
				aboveLine ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-muted/30",
			)}
		>
			<div className="flex items-center gap-4">
				<div className="shrink-0 text-center">
					<span
						className={cn("font-bold text-4xl tabular-nums", aboveLine && "text-emerald-600 dark:text-emerald-400")}
					>
						{score != null ? score.toFixed(1) : "—"}
					</span>
					<span className="text-muted-foreground text-sm">/5</span>
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-1.5">
						{decision && (
							<Badge variant="outline" className={decision.className}>
								{decision.label}
							</Badge>
						)}
						{legitimacy && (
							<Badge variant="outline" className={legitimacy.className}>
								{legitimacy.label}
							</Badge>
						)}
						{blocks && (
							<Badge variant="outline" className="border-border text-muted-foreground">
								<Trans>Confidence:</Trans> {riskLevelLabel(blocks.confidence)}
							</Badge>
						)}
						{evaluation.archetype && (
							<Badge variant="outline" className="border-border text-muted-foreground">
								{evaluation.archetype}
							</Badge>
						)}
					</div>
					<p className={cn("text-xs", aboveLine ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
						{aboveLine ? <Trans>At or above the 4.0 apply line.</Trans> : <Trans>Below the 4.0 apply line.</Trans>}
					</p>
				</div>
			</div>
			{blocks?.nextAction && (
				<p className="text-sm">
					<span className="font-medium">
						<Trans>Next action:</Trans>
					</span>{" "}
					{blocks.nextAction}
				</p>
			)}
		</div>
	);
}

// --- Requirement table -----------------------------------------------------------------------

function RequirementTable({ requirements }: { requirements: EvaluationRequirement[] }) {
	return (
		<>
			{/* Wide layout: the full five-column table. */}
			<div className="hidden overflow-hidden rounded-lg border border-border sm:block">
				<table className="w-full table-fixed border-collapse text-xs">
					<colgroup>
						<col className="w-[26%]" />
						<col className="w-[19%]" />
						<col className="w-[15%]" />
						<col className="w-[20%]" />
						<col className="w-[20%]" />
					</colgroup>
					<thead>
						<tr className="border-border border-b bg-muted/50 text-start text-muted-foreground">
							<th className="p-2 text-start font-medium">
								<Trans>Requirement</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Importance</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Match</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>JD signal</Trans>
							</th>
							<th className="p-2 text-start font-medium">
								<Trans>Evidence</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{requirements.map((requirement, index) => (
							<tr
								key={`${requirement.requirement}-${index}`}
								className="border-border border-b align-top last:border-b-0"
							>
								<td className="wrap-break-word p-2">{requirement.requirement}</td>
								<td className="p-2">
									<ImportanceBadge requirement={requirement} />
								</td>
								<td className="p-2">
									<MatchCell match={requirement.match} />
								</td>
								<td className="p-2">
									<JdSignal jdSignal={requirement.jdSignal} />
								</td>
								<td className="p-2">
									{requirement.evidence ? (
										<ExpandableText text={requirement.evidence} />
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Narrow layout: stacked cards, the three decisive columns first. */}
			<div className="flex flex-col gap-2 sm:hidden">
				{requirements.map((requirement, index) => (
					<div
						key={`${requirement.requirement}-${index}`}
						className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5 text-xs"
					>
						<p className="font-medium">{requirement.requirement}</p>
						<div className="flex flex-wrap items-center gap-1.5">
							<ImportanceBadge requirement={requirement} />
							<MatchCell match={requirement.match} />
						</div>
						{requirement.jdSignal && (
							<p className="text-muted-foreground">
								<span className="font-medium text-foreground">
									<Trans>JD signal:</Trans>
								</span>{" "}
								{requirement.jdSignal}
							</p>
						)}
						{requirement.evidence && (
							<div className="text-muted-foreground">
								<span className="font-medium text-foreground">
									<Trans>Evidence:</Trans>
								</span>{" "}
								<ExpandableText text={requirement.evidence} inline />
							</div>
						)}
					</div>
				))}
			</div>
		</>
	);
}

function ImportanceBadge({ requirement }: { requirement: EvaluationRequirement }) {
	const meta = importanceMeta(requirement.importance);
	const inferred = requirement.evidenceTier === "inferred";
	return (
		<Badge
			variant="outline"
			className={cn(
				"whitespace-normal",
				inferred ? "border-border bg-transparent text-muted-foreground/80" : meta.className,
			)}
		>
			{meta.label} ({evidenceTierLabel(requirement.evidenceTier)})
		</Badge>
	);
}

function MatchCell({ match }: { match: EvaluationRequirement["match"] }) {
	const meta = matchMeta(match);
	if (!meta) return <span className="text-muted-foreground">—</span>;
	const Icon = meta.icon;
	return (
		<span className={cn("inline-flex items-center gap-1", meta.className)}>
			<Icon weight="fill" className="size-3.5 shrink-0" />
			{meta.label}
		</span>
	);
}

function JdSignal({ jdSignal }: { jdSignal: string | null }) {
	if (!jdSignal) return <span className="text-muted-foreground">—</span>;
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="block cursor-default truncate text-muted-foreground" />}>
				{jdSignal}
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-72 whitespace-pre-wrap">
				{jdSignal}
			</TooltipContent>
		</Tooltip>
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

// --- Skill gap (deterministic, shown while running and in the final report) ------------------

function SkillGapSection({ skillGap }: { skillGap: SkillGapResult | null }) {
	if (!skillGap) return null;
	const empty = skillGap.existing.length === 0 && skillGap.supportedByResume.length === 0 && skillGap.gap.length === 0;
	return (
		<section className="flex flex-col gap-2">
			<SectionHeading title={t`Skill gap`} />
			{skillGap.lowConfidence && (
				<div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
					<WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
					<div>
						<p className="font-medium text-amber-700 dark:text-amber-300">
							<Trans>Low confidence — this is not a clean result</Trans>
						</p>
						<p className="mt-0.5 text-amber-700/90 dark:text-amber-300/90">{skillGap.lowConfidence.message}</p>
					</div>
				</div>
			)}
			{empty && !skillGap.lowConfidence && (
				<p className="text-muted-foreground text-xs">
					<Trans>No skill requirements were extracted from the posting.</Trans>
				</p>
			)}
			<ChipGroup
				label={t`Already in your skills`}
				items={skillGap.existing}
				className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
			/>
			<ChipGroup
				label={t`Supported by your resume`}
				items={skillGap.supportedByResume}
				className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
			/>
			<ChipGroup
				label={t`Missing from your resume`}
				items={skillGap.gap}
				className="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
			/>
		</section>
	);
}

type ChipGroupProps = { label: string; items: string[]; className: string };

function ChipGroup({ label, items, className }: ChipGroupProps) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-xs">{label}</span>
			<div className="flex flex-wrap gap-1">
				{items.map((item) => (
					<span key={item} className={cn("rounded-full border px-2 py-0.5 text-xs", className)}>
						{item}
					</span>
				))}
			</div>
		</div>
	);
}

// --- Collapsible detail sections -------------------------------------------------------------

type ReportDetailsProps = { evaluation: Evaluation; blocks: EvaluationBlocks };

function ReportDetails({ evaluation, blocks }: ReportDetailsProps) {
	return (
		<Accordion className="rounded-lg border border-border px-3">
			<AccordionItem value="role-summary">
				<AccordionTrigger>
					<Trans>Role summary</Trans>
				</AccordionTrigger>
				<AccordionContent className="flex flex-col gap-2 text-xs">
					<p className="whitespace-pre-wrap">{blocks.roleSummary.summary}</p>
					{evaluation.workAuth && (
						<p>
							<span className="font-medium">
								<Trans>Work authorization:</Trans>
							</span>{" "}
							{workAuthLabel(evaluation.workAuth)}
						</p>
					)}
					{blocks.roleSummary.geoNote && <NoteLine label={t`Location`} text={blocks.roleSummary.geoNote} />}
					{blocks.roleSummary.workAuthNote && (
						<NoteLine label={t`Work auth note`} text={blocks.roleSummary.workAuthNote} />
					)}
				</AccordionContent>
			</AccordionItem>

			<AccordionItem value="level-strategy">
				<AccordionTrigger>
					<Trans>Level & positioning</Trans>
				</AccordionTrigger>
				<AccordionContent className="flex flex-col gap-2 text-xs">
					<NoteLine label={t`Assessment`} text={blocks.levelStrategy.assessment} />
					<NoteLine label={t`Positioning`} text={blocks.levelStrategy.positioning} />
				</AccordionContent>
			</AccordionItem>

			<AccordionItem value="compensation">
				<AccordionTrigger>
					<Trans>Compensation</Trans>
				</AccordionTrigger>
				<AccordionContent className="flex flex-col gap-2 text-xs">
					{evaluation.advertisedComp && <NoteLine label={t`Advertised`} text={evaluation.advertisedComp} />}
					<p className="whitespace-pre-wrap">{blocks.compensation.notes}</p>
					{blocks.compensation.reliability && (
						<NoteLine label={t`Reliability`} text={blocks.compensation.reliability} />
					)}
					{blocks.reportsTo && <NoteLine label={t`Reports to`} text={blocks.reportsTo} />}
					{blocks.via && <NoteLine label={t`Via`} text={blocks.via} />}
				</AccordionContent>
			</AccordionItem>

			{blocks.customizationPlan.length > 0 && (
				<AccordionItem value="customization-plan">
					<AccordionTrigger>
						<Trans>Customization plan</Trans>
					</AccordionTrigger>
					<AccordionContent className="flex flex-col gap-2 text-xs">
						{blocks.customizationPlan.map((item) => (
							<NoteLine key={item.area} label={item.area} text={item.recommendation} />
						))}
					</AccordionContent>
				</AccordionItem>
			)}

			{blocks.interviewPlan.length > 0 && (
				<AccordionItem value="interview-plan">
					<AccordionTrigger>
						<Trans>Interview plan</Trans>
					</AccordionTrigger>
					<AccordionContent className="flex flex-col gap-2.5 text-xs">
						{blocks.interviewPlan.map((item) => (
							<div key={item.question} className="flex flex-col gap-0.5">
								<p className="font-medium">{item.question}</p>
								<p className="text-muted-foreground">{item.competency}</p>
								{item.hint && (
									<p className="text-muted-foreground italic">
										<Trans>Hint:</Trans> {item.hint}
									</p>
								)}
							</div>
						))}
					</AccordionContent>
				</AccordionItem>
			)}

			{blocks.legitimacySignals.length > 0 && (
				<AccordionItem value="legitimacy-signals">
					<AccordionTrigger>
						<Trans>Legitimacy signals</Trans>
					</AccordionTrigger>
					<AccordionContent className="flex flex-col gap-2 text-xs">
						{blocks.legitimacySignals.map((signal) => {
							const meta = signalStatusMeta(signal.status);
							const Icon = meta.icon;
							const notEvaluated = signal.status === "not_evaluated";
							return (
								<div
									key={signal.signal}
									className={cn("flex items-start gap-2", notEvaluated && "text-muted-foreground/70")}
								>
									<Icon
										weight={notEvaluated ? "regular" : "fill"}
										className={cn("mt-0.5 size-3.5 shrink-0", meta.className)}
									/>
									<div className="min-w-0">
										<p className={cn(!notEvaluated && "font-medium")}>
											{signal.signal}
											<span className={cn("ms-1.5 font-normal", meta.className)}>({meta.label})</span>
										</p>
										{signal.note && <p className="text-muted-foreground">{signal.note}</p>}
									</div>
								</div>
							);
						})}
						{blocks.riskSummary.items.length > 0 && (
							<p className="text-muted-foreground">
								<span className="font-medium text-foreground">
									<Trans>Risk ({riskLevelLabel(blocks.riskSummary.level)}):</Trans>
								</span>{" "}
								{blocks.riskSummary.items.join(" · ")}
							</p>
						)}
						{blocks.riskSummary.notEvaluated.length > 0 && (
							<p className="text-muted-foreground/70">
								<Trans>Not evaluated:</Trans> {blocks.riskSummary.notEvaluated.join(" · ")}
							</p>
						)}
					</AccordionContent>
				</AccordionItem>
			)}

			{blocks.draftAnswers && blocks.draftAnswers.length > 0 && (
				<AccordionItem value="draft-answers">
					<AccordionTrigger>
						<Trans>Draft answers</Trans>
					</AccordionTrigger>
					<AccordionContent className="flex flex-col gap-2.5 text-xs">
						{blocks.draftAnswers.map((item) => (
							<div key={item.question} className="flex flex-col gap-0.5">
								<p className="font-medium">{item.question}</p>
								<p className="whitespace-pre-wrap text-muted-foreground">{item.answer}</p>
							</div>
						))}
					</AccordionContent>
				</AccordionItem>
			)}

			{(blocks.topStrengths.length > 0 || blocks.softGaps.length > 0) && (
				<AccordionItem value="strengths-gaps">
					<AccordionTrigger>
						<Trans>Strengths & soft gaps</Trans>
					</AccordionTrigger>
					<AccordionContent className="flex flex-col gap-2 text-xs">
						{blocks.topStrengths.length > 0 && (
							<div>
								<p className="font-medium">
									<Trans>Top strengths</Trans>
								</p>
								<ul className="mt-1 list-disc space-y-0.5 ps-5">
									{blocks.topStrengths.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ul>
							</div>
						)}
						{blocks.softGaps.length > 0 && (
							<div>
								<p className="font-medium">
									<Trans>Soft gaps</Trans>
								</p>
								<ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted-foreground">
									{blocks.softGaps.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ul>
							</div>
						)}
					</AccordionContent>
				</AccordionItem>
			)}
		</Accordion>
	);
}

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

function NoteLine({ label, text }: { label: string; text: string }) {
	return (
		<p className="whitespace-pre-wrap text-muted-foreground">
			<span className="font-medium text-foreground">{label}:</span> {text}
		</p>
	);
}

function SectionHeading({ title }: { title: string }) {
	return <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>;
}
