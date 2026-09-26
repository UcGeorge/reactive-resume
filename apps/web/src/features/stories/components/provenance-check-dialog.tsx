import type { Story, StoryProvenance } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowUpIcon, CheckCircleIcon, InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { checkProvenanceMutationOptions, storiesListQueryKey, updateStoryMutationOptions } from "../queries";
import { ProvenanceChip } from "./provenance-chip";

// Higher = more trusted. Only used to decide whether the suggested state is an UPGRADE the
// user may apply — a differing-but-lower suggestion stays informational (the server never
// suggests below current, this is a client-side guard, not policy).
const PROVENANCE_RANK: Record<StoryProvenance, number> = {
	"derived-unverified": 0,
	"user-cannot-confirm": 1,
	"user-confirmed": 2,
	"resume-verified": 3,
};

type ProvenanceCheckDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	story: Story | null;
};

export function ProvenanceCheckDialog({ open, onOpenChange, story }: ProvenanceCheckDialogProps) {
	const queryClient = useQueryClient();

	const check = useMutation(
		checkProvenanceMutationOptions({
			onError: (error) => toast.add({ type: "error", description: error.message || t`The provenance check failed.` }),
		}),
	);

	const apply = useMutation(
		updateStoryMutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({ queryKey: storiesListQueryKey() });
				toast.add({ type: "success", description: t`Provenance updated.` });
				onOpenChange(false);
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't apply the suggestion.` }),
		}),
	);

	// Re-run the deterministic check each time the dialog opens for a story.
	const storyId = story?.id ?? null;
	const { reset: resetCheck, mutate: runCheck } = check;
	useEffect(() => {
		if (open && storyId) {
			resetCheck();
			runCheck({ id: storyId });
		}
	}, [open, storyId, resetCheck, runCheck]);

	const report = check.data;
	const isUpgrade =
		story && report && report.suggested !== story.provenance
			? PROVENANCE_RANK[report.suggested] > PROVENANCE_RANK[story.provenance]
			: false;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-5 sm:max-w-lg">
				<DialogHeader className="pe-8">
					<DialogTitle>
						<Trans>Check provenance</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							A deterministic re-check of this story's numeric claims against its linked source resume. Nothing is
							changed unless you apply the suggestion.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{check.isPending || !story ? (
					<div className="flex items-center justify-center py-10">
						<Spinner />
					</div>
				) : report ? (
					<div className="flex flex-col gap-4 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-muted-foreground text-xs">
								<Trans>Current</Trans>
							</span>
							<ProvenanceChip provenance={story.provenance} />
							<span className="text-muted-foreground text-xs">
								<Trans>Suggested</Trans>
							</span>
							<ProvenanceChip provenance={report.suggested} />
						</div>

						{report.verifiedClaims.length > 0 && (
							<div className="grid gap-1.5">
								<p className="font-medium text-xs">
									<Trans>Verified claims</Trans>
								</p>
								<ul className="grid gap-1">
									{report.verifiedClaims.map((claim) => (
										<li key={claim} className="flex items-start gap-2">
											<CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
											<span>{claim}</span>
										</li>
									))}
								</ul>
							</div>
						)}

						{report.unverifiedClaims.length > 0 && (
							<div className="grid gap-1.5">
								<p className="font-medium text-xs">
									<Trans>Unverified claims</Trans>
								</p>
								<ul className="grid gap-1">
									{report.unverifiedClaims.map((claim) => (
										<li key={claim} className="flex items-start gap-2">
											<WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
											<span>{claim}</span>
										</li>
									))}
								</ul>
							</div>
						)}

						{report.reasons.length > 0 && (
							<div className="grid gap-1.5">
								<p className="font-medium text-xs">
									<Trans>Notes</Trans>
								</p>
								<ul className="grid gap-1">
									{report.reasons.map((reason) => (
										<li key={reason} className="flex items-start gap-2 text-muted-foreground">
											<InfoIcon className="mt-0.5 size-4 shrink-0" />
											<span>{reason}</span>
										</li>
									))}
								</ul>
							</div>
						)}

						{report.suggested !== story.provenance && !isUpgrade && (
							<p className="text-muted-foreground text-xs">
								<Trans>The differing suggestion is informational only — downgrades are never applied from here.</Trans>
							</p>
						)}
					</div>
				) : null}

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						<Trans>Close</Trans>
					</Button>
					{isUpgrade && story && report && (
						<Button
							disabled={apply.isPending}
							onClick={() => apply.mutate({ id: story.id, provenance: report.suggested })}
						>
							{apply.isPending ? <Spinner /> : <ArrowUpIcon />}
							<Trans>Apply suggested</Trans>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
