import type { Story } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { toast } from "@reactive-resume/ui/components/toast";
import { matchStoriesMutationOptions } from "../queries";
import { ProvenanceChip } from "./provenance-chip";

type FindStoryBoxProps = {
	onOpenStory: (story: Story) => void;
};

// "Which story answers this question?" — the deterministic matcher, ranked with its reasons
// shown so the choice is explainable, not oracular.
export function FindStoryBox({ onOpenStory }: FindStoryBoxProps) {
	const [question, setQuestion] = useState("");

	const match = useMutation(
		matchStoriesMutationOptions({
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't match stories.` }),
		}),
	);

	const canSearch = question.trim().length >= 3 && !match.isPending;

	const search = () => {
		if (!canSearch) return;
		match.mutate({ question: question.trim() });
	};

	const results = match.data;

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-4">
			<div className="grid gap-1.5">
				<p className="font-medium text-sm">
					<Trans>Find a story</Trans>
				</p>
				<p className="text-muted-foreground text-xs">
					<Trans>Paste an interview question and get your bank ranked against it.</Trans>
				</p>
			</div>

			<div className="flex gap-2">
				<Input
					value={question}
					placeholder={t`e.g. Tell me about a time you disagreed with a decision…`}
					onChange={(event) => setQuestion(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							search();
						}
					}}
				/>
				<Button className="shrink-0" disabled={!canSearch} onClick={search}>
					{match.isPending ? <Spinner /> : <MagnifyingGlassIcon />}
					<Trans>Match</Trans>
				</Button>
			</div>

			{results && (
				<div className="flex flex-col gap-2">
					{results.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No story in your bank matches that question yet.</Trans>
						</p>
					) : (
						results.map((result) => (
							<div key={result.id} className="flex flex-col gap-1.5 rounded-md border border-border p-3">
								<div className="flex items-start justify-between gap-2">
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<span className="font-medium text-sm">{result.story.title}</span>
										<Badge variant="secondary" className="tabular-nums">
											<Trans>score {result.score}</Trans>
										</Badge>
										<ProvenanceChip provenance={result.story.provenance} />
									</div>
									<Button size="sm" variant="outline" className="shrink-0" onClick={() => onOpenStory(result.story)}>
										<Trans>Open</Trans>
									</Button>
								</div>
								{result.reasons.length > 0 && (
									<p className="text-muted-foreground text-xs">{result.reasons.join(" · ")}</p>
								)}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
