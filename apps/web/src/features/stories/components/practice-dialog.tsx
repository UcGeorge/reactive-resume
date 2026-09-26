import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowRightIcon, CopyIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
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
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";

const practicePromptTemplate = () =>
	t`Run an interview practice session with me for [role] at [company]. Ask one question at a time, listen, then give structured feedback against the posting's vocabulary. Use my story bank (list_stories / match_story_to_question) to suggest which story fits each question, and save_story anything new we uncover — never invent numbers.`;

type PracticeDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

// The agent workspace already carries the interview tools (story list/save, application brief,
// story matcher); threads can't be seeded with an initial message, so practice is: copy this
// prompt, start a thread, paste it as the opener.
export function PracticeDialog({ open, onOpenChange }: PracticeDialogProps) {
	const navigate = useNavigate();
	const [prompt, setPrompt] = useState(practicePromptTemplate);

	// Reset the prompt to the template whenever the dialog opens for a fresh session.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setPrompt(practicePromptTemplate());
	}

	const copy = async () => {
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(prompt);
			toast.add({ type: "success", description: t`Copied to clipboard.` });
		} catch {
			toast.add({ type: "error", description: t`Could not copy to clipboard. Please copy the text manually.` });
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-5 sm:max-w-lg">
				<DialogHeader className="pe-8">
					<DialogTitle>
						<Trans>Practice an interview</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							The agent already knows your story bank. Fill in the role and company, copy the prompt, then paste it as
							the first message of a new thread.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-2">
					<Textarea rows={7} value={prompt} className="text-xs" onChange={(event) => setPrompt(event.target.value)} />
					<Button size="sm" variant="outline" className="justify-self-start" onClick={() => void copy()}>
						<CopyIcon />
						<Trans>Copy prompt</Trans>
					</Button>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={() => {
							onOpenChange(false);
							void navigate({ to: "/agent/new" });
						}}
					>
						<Trans>Open the agent</Trans>
						<ArrowRightIcon />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
