import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import { Label } from "@reactive-resume/ui/components/label";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { Combobox } from "@/components/ui/combobox";
import { orpc } from "@/libs/orpc/client";
import { storiesListQueryKey, suggestStoriesFromResumeMutationOptions } from "../queries";

type SuggestFromResumeDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function SuggestFromResumeDialog({ open, onOpenChange }: SuggestFromResumeDialogProps) {
	const queryClient = useQueryClient();
	const [resumeId, setResumeId] = useState<string | null>(null);

	// Reset the picker whenever the dialog opens for a fresh run.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setResumeId(null);
	}

	const { data: resumes, isLoading: isLoadingResumes } = useQuery(
		orpc.resume.list.queryOptions({ input: { sort: "lastUpdatedAt", tags: [] } }),
	);

	const suggest = useMutation(
		suggestStoriesFromResumeMutationOptions({
			onSuccess: ({ created }) => {
				void queryClient.invalidateQueries({ queryKey: storiesListQueryKey() });
				toast.add({
					type: "success",
					description:
						created > 0
							? plural(created, {
									one: "# story drafted from the resume — review and confirm its numbers.",
									other: "# stories drafted from the resume — review and confirm their numbers.",
								})
							: t`No story candidates were found in that resume.`,
				});
				onOpenChange(false);
			},
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't suggest stories from the resume.` }),
		}),
	);

	const resumeOptions =
		resumes?.map((resume) => ({
			value: resume.id,
			label: resume.name,
			keywords: [resume.name, resume.slug, ...resume.tags],
		})) ?? [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-5 sm:max-w-md">
				<DialogHeader className="pe-8">
					<DialogTitle>
						<Trans>Suggest stories from a resume</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							AI extracts STAR+R candidates grounded in the resume's real projects. They arrive as derived-unverified
							drafts — nothing counts as a fact until you confirm it.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-1.5">
					<Label className="text-muted-foreground text-xs">
						<Trans>Resume</Trans>
					</Label>
					<Combobox
						value={resumeId}
						options={resumeOptions}
						disabled={isLoadingResumes || suggest.isPending}
						placeholder={isLoadingResumes ? t`Loading resumes…` : t`Choose a resume`}
						onValueChange={setResumeId}
					/>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button disabled={!resumeId || suggest.isPending} onClick={() => resumeId && suggest.mutate({ resumeId })}>
						{suggest.isPending ? <Spinner /> : <SparkleIcon />}
						{suggest.isPending ? <Trans>Extracting…</Trans> : <Trans>Suggest stories</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
