import type { Story, StoryProvenance } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";
import { Combobox } from "@/components/ui/combobox";
import { orpc } from "@/libs/orpc/client";
import { createStoryMutationOptions, storiesListQueryKey, updateStoryMutationOptions } from "../queries";
import { TagListField } from "./tag-list-field";

const NO_RESUME = "__none__";

type StarField = "situation" | "task" | "action" | "result" | "reflection";

const starFields = (): { key: StarField; label: string; placeholder: string }[] => [
	{ key: "situation", label: t`Situation`, placeholder: t`The context — team, product, constraint…` },
	{ key: "task", label: t`Task`, placeholder: t`What you were responsible for…` },
	{ key: "action", label: t`Action`, placeholder: t`What you actually did, step by step…` },
	{ key: "result", label: t`Result`, placeholder: t`What changed — outcomes, numbers you can stand behind…` },
	{ key: "reflection", label: t`Reflection`, placeholder: t`What you learned or would do differently…` },
];

type FormState = {
	title: string;
	theme: string;
	situation: string;
	task: string;
	action: string;
	result: string;
	reflection: string;
	tags: string[];
	provenance: StoryProvenance;
	sourceResumeId: string | null;
};

const emptyForm: FormState = {
	title: "",
	theme: "",
	situation: "",
	task: "",
	action: "",
	result: "",
	reflection: "",
	tags: [],
	provenance: "derived-unverified",
	sourceResumeId: null,
};

const formFromStory = (story: Story): FormState => ({
	title: story.title,
	theme: story.theme,
	situation: story.situation,
	task: story.task,
	action: story.action,
	result: story.result,
	reflection: story.reflection,
	tags: story.tags,
	provenance: story.provenance,
	sourceResumeId: story.sourceResumeId,
});

type StoryEditorDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The story being edited, or null to create a new one. */
	story: Story | null;
};

export function StoryEditorDialog({ open, onOpenChange, story }: StoryEditorDialogProps) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState<FormState>(emptyForm);

	// Reset the form to the story (or a blank draft) whenever the dialog opens.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setForm(story ? formFromStory(story) : emptyForm);
	}

	const { data: resumes, isLoading: isLoadingResumes } = useQuery(
		orpc.resume.list.queryOptions({ input: { sort: "lastUpdatedAt", tags: [] } }),
	);

	const invalidate = () => void queryClient.invalidateQueries({ queryKey: storiesListQueryKey() });

	const create = useMutation(
		createStoryMutationOptions({
			onSuccess: () => {
				invalidate();
				toast.add({ type: "success", description: t`Story added to your bank.` });
				onOpenChange(false);
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't save the story.` }),
		}),
	);

	const update = useMutation(
		updateStoryMutationOptions({
			onSuccess: () => {
				invalidate();
				toast.add({ type: "success", description: t`Story updated.` });
				onOpenChange(false);
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't save the story.` }),
		}),
	);

	const pending = create.isPending || update.isPending;
	const canSubmit = form.title.trim().length > 0 && !pending;

	const submit = () => {
		if (!canSubmit) return;
		const payload = {
			title: form.title.trim(),
			theme: form.theme,
			situation: form.situation,
			task: form.task,
			action: form.action,
			result: form.result,
			reflection: form.reflection,
			tags: form.tags,
			provenance: form.provenance,
			sourceResumeId: form.sourceResumeId,
		};
		if (story) update.mutate({ id: story.id, ...payload });
		else create.mutate(payload);
	};

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const provenanceOptions: { value: StoryProvenance; label: string }[] = [
		{ value: "resume-verified", label: t`resume-verified` },
		{ value: "user-confirmed", label: t`user-confirmed` },
		{ value: "derived-unverified", label: t`derived-unverified` },
		{ value: "user-cannot-confirm", label: t`user-cannot-confirm` },
	];

	const resumeOptions = [
		{ value: NO_RESUME, label: t`No source resume` },
		...(resumes?.map((resume) => ({
			value: resume.id,
			label: resume.name,
			keywords: [resume.name, resume.slug, ...resume.tags],
		})) ?? []),
	];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-5 sm:max-w-2xl">
				<DialogHeader className="pe-8">
					<DialogTitle>{story ? <Trans>Edit story</Trans> : <Trans>New story</Trans>}</DialogTitle>
					<DialogDescription>
						<Trans>
							One real project or role per story, told as Situation, Task, Action, Result and Reflection. Never invent
							numbers — mark anything unconfirmed as derived-unverified.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="-me-2 flex max-h-[60vh] flex-col gap-4 overflow-y-auto pe-2">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label className="text-muted-foreground text-xs">
								<Trans>Title</Trans>
							</Label>
							<Input value={form.title} onChange={(event) => set("title", event.target.value)} />
						</div>
						<div className="grid gap-1.5">
							<Label className="text-muted-foreground text-xs">
								<Trans>Theme</Trans>
							</Label>
							<Input
								value={form.theme}
								placeholder={t`e.g. leadership, incident response…`}
								onChange={(event) => set("theme", event.target.value)}
							/>
						</div>
					</div>

					{starFields().map((field) => (
						<div key={field.key} className="grid gap-1.5">
							<Label className="text-muted-foreground text-xs">{field.label}</Label>
							<Textarea
								rows={3}
								value={form[field.key]}
								placeholder={field.placeholder}
								onChange={(event) => set(field.key, event.target.value)}
							/>
						</div>
					))}

					<div className="grid gap-1.5">
						<Label className="text-muted-foreground text-xs">
							<Trans>Tags</Trans>
						</Label>
						<TagListField
							value={form.tags}
							placeholder={t`Topics this story answers best — "conflict", "scaling"…`}
							onChange={(tags) => set("tags", tags)}
						/>
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid content-start gap-1.5">
							<Label className="text-muted-foreground text-xs">
								<Trans>Provenance</Trans>
							</Label>
							<Combobox
								value={form.provenance}
								showClear={false}
								options={provenanceOptions}
								onValueChange={(value) => set("provenance", value ?? "derived-unverified")}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>user-cannot-confirm is durable — the check never changes it.</Trans>
							</p>
						</div>
						<div className="grid content-start gap-1.5">
							<Label className="text-muted-foreground text-xs">
								<Trans>Source resume</Trans>
							</Label>
							<Combobox
								value={form.sourceResumeId ?? NO_RESUME}
								showClear={false}
								options={resumeOptions}
								disabled={isLoadingResumes}
								placeholder={isLoadingResumes ? t`Loading resumes…` : t`Choose a resume`}
								onValueChange={(value) => set("sourceResumeId", value && value !== NO_RESUME ? value : null)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>The provenance check verifies numeric claims against this resume.</Trans>
							</p>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button disabled={!canSubmit} onClick={submit}>
						{pending && <Spinner />}
						{story ? <Trans>Save changes</Trans> : <Trans>Add story</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
