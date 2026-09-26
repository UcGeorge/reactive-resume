import type { MessageDescriptor } from "@lingui/core";
import type { FollowUpKind, FollowUpQueueEntry } from "../queries";
import { msg, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	AlarmIcon,
	ArrowsClockwiseIcon,
	BellIcon,
	ChatCircleTextIcon,
	CheckIcon,
	CopyIcon,
	ProhibitIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { STAGES } from "@reactive-resume/schema/applications/data";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@reactive-resume/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@reactive-resume/ui/components/empty";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@reactive-resume/ui/components/tooltip";
import { formatRelativeTime } from "@/libs/locale";
import {
	completeFollowUpMutationOptions,
	dismissFollowUpMutationOptions,
	draftFollowUpMutationOptions,
	followUpsDueCountQueryKey,
	followUpsQueueKey,
	followUpsQueueQueryOptions,
	snoozeFollowUpMutationOptions,
} from "../queries";

const KIND_LABELS: Record<FollowUpKind, MessageDescriptor> = {
	applied_first: msg`First check-in`,
	applied_subsequent: msg`Second check-in`,
	post_interview_thanks: msg`Thank-you note`,
	responded: msg`Reply follow-up`,
	custom: msg`Custom`,
};

const SNOOZE_OPTIONS = [
	{ days: 1, label: msg`1 day` },
	{ days: 3, label: msg`3 days` },
	{ days: 7, label: msg`1 week` },
] as const;

const stageLabel = (status: string) => STAGES.find((stage) => stage.value === status)?.label ?? status;

export function FollowUpsView() {
	const { i18n } = useLingui();
	const queryClient = useQueryClient();

	// Reading the queue recomputes the cadence server-side, so the first load can take a moment.
	const queue = useQuery(followUpsQueueQueryOptions());

	const [draftEntry, setDraftEntry] = useState<FollowUpQueueEntry | null>(null);

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: followUpsQueueKey() });
		void queryClient.invalidateQueries({ queryKey: followUpsDueCountQueryKey() });
	};

	const complete = useMutation(
		completeFollowUpMutationOptions({
			onSuccess: invalidate,
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't complete this follow-up.` }),
		}),
	);
	const snooze = useMutation(
		snoozeFollowUpMutationOptions({
			onSuccess: invalidate,
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't snooze this follow-up.` }),
		}),
	);
	const dismiss = useMutation(
		dismissFollowUpMutationOptions({
			onSuccess: invalidate,
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't dismiss this follow-up.` }),
		}),
	);
	const draft = useMutation(draftFollowUpMutationOptions());

	const relativeTimeFormatter = useMemo(
		() => new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }),
		[i18n.locale],
	);

	// Overdue = due before today; due today = anywhere within today; the rest is upcoming.
	const groups = useMemo(() => {
		const startOfToday = new Date();
		startOfToday.setHours(0, 0, 0, 0);
		const endOfToday = new Date(startOfToday.getTime() + 86_400_000 - 1);

		const overdue: FollowUpQueueEntry[] = [];
		const dueToday: FollowUpQueueEntry[] = [];
		const upcoming: FollowUpQueueEntry[] = [];
		for (const entry of queue.data ?? []) {
			const dueAt = new Date(entry.dueAt);
			if (dueAt < startOfToday) overdue.push(entry);
			else if (dueAt <= endOfToday) dueToday.push(entry);
			else upcoming.push(entry);
		}
		return [
			{ key: "overdue", title: t`Overdue`, tone: "text-rose-600 dark:text-rose-400", entries: overdue },
			{ key: "today", title: t`Due today`, tone: "text-amber-600 dark:text-amber-400", entries: dueToday },
			{ key: "upcoming", title: t`Upcoming`, tone: "text-muted-foreground", entries: upcoming },
		];
	}, [queue.data]);

	const busyId = complete.isPending
		? complete.variables?.id
		: snooze.isPending
			? snooze.variables?.id
			: dismiss.isPending
				? dismiss.variables?.id
				: undefined;

	const openDraft = (entry: FollowUpQueueEntry) => {
		setDraftEntry(entry);
		draft.mutate({ id: entry.id });
	};

	const closeDraft = () => {
		setDraftEntry(null);
		draft.reset();
	};

	if (queue.isPending) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
				<Spinner />
				<p className="text-muted-foreground text-sm">
					<Trans>Checking your applications and computing the follow-up cadence…</Trans>
				</p>
			</div>
		);
	}

	if (queue.isError) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
				<p className="max-w-md text-destructive text-sm">{queue.error.message}</p>
				<Button size="sm" variant="outline" onClick={() => void queue.refetch()}>
					<ArrowsClockwiseIcon />
					<Trans>Try again</Trans>
				</Button>
			</div>
		);
	}

	if ((queue.data?.length ?? 0) === 0) {
		return (
			<Empty className="flex-1">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<BellIcon />
					</EmptyMedia>
					<EmptyTitle>
						<Trans>No follow-ups due</Trans>
					</EmptyTitle>
					<EmptyDescription>
						<Trans>
							Follow-ups appear automatically after you mark an application applied — a first check-in about a week
							later, another one after that, and a thank-you note once you interview. Snoozed follow-ups resurface when
							their snooze lapses.
						</Trans>
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-4">
			{groups.map(
				(group) =>
					group.entries.length > 0 && (
						<section key={group.key} className="flex flex-col gap-2">
							<h3 className={`font-semibold text-xs uppercase tracking-wide ${group.tone}`}>
								{group.title} · {group.entries.length}
							</h3>
							<div className="flex flex-col gap-2">
								{group.entries.map((entry) => (
									<FollowUpRow
										key={entry.id}
										entry={entry}
										kindLabel={i18n.t(KIND_LABELS[entry.kind])}
										relativeTimeFormatter={relativeTimeFormatter}
										busy={busyId === entry.id}
										onDraft={() => openDraft(entry)}
										onComplete={() => complete.mutate({ id: entry.id })}
										onSnooze={(days) =>
											snooze.mutate({ id: entry.id, until: new Date(Date.now() + days * 86_400_000) })
										}
										onDismiss={() => dismiss.mutate({ id: entry.id })}
									/>
								))}
							</div>
						</section>
					),
			)}

			<DraftMessageDialog
				entry={draftEntry}
				pending={draft.isPending}
				error={draft.error?.message ?? null}
				text={draft.data?.text ?? null}
				onRetry={() => draftEntry && draft.mutate({ id: draftEntry.id })}
				onClose={closeDraft}
			/>
		</div>
	);
}

type FollowUpRowProps = {
	entry: FollowUpQueueEntry;
	kindLabel: string;
	relativeTimeFormatter: Intl.RelativeTimeFormat;
	busy: boolean;
	onDraft: () => void;
	onComplete: () => void;
	onSnooze: (days: number) => void;
	onDismiss: () => void;
};

function FollowUpRow({
	entry,
	kindLabel,
	relativeTimeFormatter,
	busy,
	onDraft,
	onComplete,
	onSnooze,
	onDismiss,
}: FollowUpRowProps) {
	const { i18n } = useLingui();
	const absoluteDue = new Date(entry.dueAt).toLocaleDateString(i18n.locale, { dateStyle: "full" });

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card p-3">
			<div className="min-w-0 flex-1">
				{/* Same pattern as Discover's "Open application": the Applications page opens the
				    detail sheet from the ?applicationId= search param. */}
				<Link
					to="/dashboard/applications"
					search={{ view: "followups", applicationId: entry.application.id }}
					className="block truncate text-sm hover:text-primary"
				>
					<span className="font-medium">{entry.application.company}</span>
					<span className="text-muted-foreground"> · {entry.application.role}</span>
				</Link>
				<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
					<Badge variant="outline">{kindLabel}</Badge>
					<Badge variant="outline" className="text-muted-foreground">
						{stageLabel(entry.application.status)}
					</Badge>
					<Tooltip>
						<TooltipTrigger render={<span className="cursor-default text-muted-foreground" />}>
							{formatRelativeTime(entry.dueAt, relativeTimeFormatter)}
						</TooltipTrigger>
						<TooltipContent side="bottom">{absoluteDue}</TooltipContent>
					</Tooltip>
					{entry.note && <span className="min-w-0 truncate text-muted-foreground">{entry.note}</span>}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				<Button size="sm" variant="outline" disabled={busy} onClick={onDraft}>
					<ChatCircleTextIcon />
					<Trans>Draft message</Trans>
				</Button>
				<Button size="icon-sm" variant="ghost" title={t`Complete`} disabled={busy} onClick={onComplete}>
					<CheckIcon />
					<span className="sr-only">
						<Trans>Complete</Trans>
					</span>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button size="icon-sm" variant="ghost" title={t`Snooze`} disabled={busy}>
								<AlarmIcon />
								<span className="sr-only">
									<Trans>Snooze</Trans>
								</span>
							</Button>
						}
					/>
					<DropdownMenuContent align="end">
						{SNOOZE_OPTIONS.map((option) => (
							<DropdownMenuItem key={option.days} onClick={() => onSnooze(option.days)}>
								{i18n.t(option.label)}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<Button size="icon-sm" variant="ghost" title={t`Dismiss`} disabled={busy} onClick={onDismiss}>
					<ProhibitIcon />
					<span className="sr-only">
						<Trans>Dismiss</Trans>
					</span>
				</Button>
			</div>
		</div>
	);
}

type DraftMessageDialogProps = {
	entry: FollowUpQueueEntry | null;
	pending: boolean;
	error: string | null;
	text: string | null;
	onRetry: () => void;
	onClose: () => void;
};

function DraftMessageDialog({ entry, pending, error, text, onRetry, onClose }: DraftMessageDialogProps) {
	const copy = useCallback(async () => {
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(text ?? "");
			toast.add({ type: "success", description: t`Copied to clipboard.` });
		} catch {
			toast.add({ type: "error", description: t`Could not copy to clipboard. Please copy the text manually.` });
		}
	}, [text]);

	return (
		<Dialog open={!!entry} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<Trans>Follow-up message</Trans>
					</DialogTitle>
					<DialogDescription>
						{entry ? `${entry.application.company} · ${entry.application.role}` : ""}
					</DialogDescription>
				</DialogHeader>

				{pending ? (
					<div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
						<Spinner />
						<Trans>Drafting your message…</Trans>
					</div>
				) : error ? (
					<div className="flex flex-col gap-3">
						{/* The server's message says exactly what's missing (e.g. no AI provider) — show it verbatim. */}
						<p className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-destructive text-sm">
							{error}
						</p>
						<Button size="sm" variant="outline" className="self-start" onClick={onRetry}>
							<ArrowsClockwiseIcon />
							<Trans>Try again</Trans>
						</Button>
					</div>
				) : (
					<p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed">
						{text}
					</p>
				)}

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
					{text && !pending && !error && (
						<Button type="button" onClick={() => void copy()}>
							<CopyIcon />
							<Trans>Copy to clipboard</Trans>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
