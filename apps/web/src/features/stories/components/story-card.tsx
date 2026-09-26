import type { Story } from "../queries";
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { PencilSimpleIcon, SealQuestionIcon, TrashIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { formatRelativeTime } from "@/libs/locale";
import { ProvenanceChip } from "./provenance-chip";

type StoryCardProps = {
	story: Story;
	onEdit: (story: Story) => void;
	onDelete: (story: Story) => void;
	onCheckProvenance: (story: Story) => void;
};

export function StoryCard({ story, onEdit, onDelete, onCheckProvenance }: StoryCardProps) {
	const { i18n } = useLingui();
	const relativeTimeFormatter = useMemo(
		() => new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }),
		[i18n.locale],
	);

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border p-4">
			<div className="flex items-start justify-between gap-2">
				<h3 className="min-w-0 font-semibold text-sm leading-snug">{story.title}</h3>
				<div className="flex shrink-0 items-center">
					<Button size="icon-sm" variant="ghost" title={t`Edit story`} onClick={() => onEdit(story)}>
						<PencilSimpleIcon />
					</Button>
					<Button size="icon-sm" variant="ghost" title={t`Check provenance`} onClick={() => onCheckProvenance(story)}>
						<SealQuestionIcon />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						title={t`Delete story`}
						className="hover:text-destructive"
						onClick={() => onDelete(story)}
					>
						<TrashIcon />
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-1.5">
				{story.theme && <Badge variant="secondary">{story.theme}</Badge>}
				<ProvenanceChip provenance={story.provenance} />
			</div>

			{story.situation && <p className="line-clamp-3 text-muted-foreground text-xs">{story.situation}</p>}

			{story.tags.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{story.tags.map((tag) => (
						<span key={tag} className="rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs">
							{tag}
						</span>
					))}
				</div>
			)}

			<p className="mt-auto text-muted-foreground text-xs">
				{plural(story.timesUsed, { one: "Used # time", other: "Used # times" })}
				{story.lastUsedAt && (
					<>
						{" · "}
						<Trans>last used {formatRelativeTime(story.lastUsedAt, relativeTimeFormatter)}</Trans>
					</>
				)}
			</p>
		</div>
	);
}
