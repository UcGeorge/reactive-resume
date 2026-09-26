import type { Story } from "@/features/stories/queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatsCircleIcon, MicrophoneStageIcon, PlusIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@reactive-resume/ui/components/empty";
import { Separator } from "@reactive-resume/ui/components/separator";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { FindStoryBox } from "@/features/stories/components/find-story-box";
import { PracticeDialog } from "@/features/stories/components/practice-dialog";
import { ProvenanceCheckDialog } from "@/features/stories/components/provenance-check-dialog";
import { StoryCard } from "@/features/stories/components/story-card";
import { StoryEditorDialog } from "@/features/stories/components/story-editor-dialog";
import { SuggestFromResumeDialog } from "@/features/stories/components/suggest-from-resume-dialog";
import { deleteStoryMutationOptions, storiesListQueryKey, storiesListQueryOptions } from "@/features/stories/queries";
import { useConfirm } from "@/hooks/use-confirm";
import { DashboardHeader } from "../-components/header";

export const Route = createFileRoute("/dashboard/interviews/")({ component: RouteComponent });

function RouteComponent() {
	const confirm = useConfirm();
	const queryClient = useQueryClient();

	const storiesQuery = useQuery(storiesListQueryOptions());
	const stories = storiesQuery.data ?? [];

	const [editorOpen, setEditorOpen] = useState(false);
	const [editorStory, setEditorStory] = useState<Story | null>(null);
	const [checkOpen, setCheckOpen] = useState(false);
	const [checkStory, setCheckStory] = useState<Story | null>(null);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const [practiceOpen, setPracticeOpen] = useState(false);

	const remove = useMutation(
		deleteStoryMutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({ queryKey: storiesListQueryKey() });
				toast.add({ type: "success", description: t`Story deleted.` });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't delete the story.` }),
		}),
	);

	const openEditor = (story: Story | null) => {
		setEditorStory(story);
		setEditorOpen(true);
	};

	const openCheck = (story: Story) => {
		setCheckStory(story);
		setCheckOpen(true);
	};

	const onDelete = (story: Story) => {
		void confirm(t`Delete "${story.title}"?`, {
			description: t`The story is removed from your bank. This cannot be undone.`,
			confirmText: t`Delete`,
		}).then((confirmed) => {
			if (confirmed) remove.mutate({ id: story.id });
		});
	};

	return (
		<div className="space-y-4 pb-6">
			<DashboardHeader
				className="max-sm:flex-col max-sm:gap-y-3"
				icon={ChatsCircleIcon}
				title={t`Interviews`}
				actions={
					<>
						<Button size="sm" variant="outline" onClick={() => setSuggestOpen(true)}>
							<SparkleIcon />
							<Trans>Suggest from resume</Trans>
						</Button>
						<Button size="sm" variant="outline" onClick={() => setPracticeOpen(true)}>
							<MicrophoneStageIcon />
							<Trans>Practice</Trans>
						</Button>
						<Button size="sm" onClick={() => openEditor(null)}>
							<PlusIcon />
							<Trans>New story</Trans>
						</Button>
					</>
				}
			/>

			<Separator />

			<FindStoryBox onOpenStory={openEditor} />

			{storiesQuery.isLoading ? (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					<Skeleton className="h-44 w-full" />
					<Skeleton className="h-44 w-full" />
					<Skeleton className="h-44 w-full" />
				</div>
			) : stories.length === 0 ? (
				<Empty className="py-16">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ChatsCircleIcon />
						</EmptyMedia>
						<EmptyTitle>
							<Trans>Your story bank is empty</Trans>
						</EmptyTitle>
						<EmptyDescription>
							<Trans>
								Stories are reusable STAR+R answers grounded in what you actually did. Add one yourself or extract
								drafts from a resume — every draft stays derived-unverified until you confirm its numbers, and a number
								you can't confirm stays marked that way for good.
							</Trans>
						</EmptyDescription>
					</EmptyHeader>
					<div className="flex flex-wrap justify-center gap-2">
						<Button variant="outline" onClick={() => setSuggestOpen(true)}>
							<SparkleIcon />
							<Trans>Suggest from resume</Trans>
						</Button>
						<Button onClick={() => openEditor(null)}>
							<PlusIcon />
							<Trans>New story</Trans>
						</Button>
					</div>
				</Empty>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{stories.map((story) => (
						<StoryCard
							key={story.id}
							story={story}
							onEdit={openEditor}
							onDelete={onDelete}
							onCheckProvenance={openCheck}
						/>
					))}
				</div>
			)}

			<StoryEditorDialog open={editorOpen} story={editorStory} onOpenChange={setEditorOpen} />
			<ProvenanceCheckDialog open={checkOpen} story={checkStory} onOpenChange={setCheckOpen} />
			<SuggestFromResumeDialog open={suggestOpen} onOpenChange={setSuggestOpen} />
			<PracticeDialog open={practiceOpen} onOpenChange={setPracticeOpen} />
		</div>
	);
}
