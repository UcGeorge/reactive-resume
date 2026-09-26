import type { MessageDescriptor } from "@lingui/core";
import type { StoryProvenance } from "../queries";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@reactive-resume/ui/components/tooltip";
import { cn } from "@reactive-resume/utils/style";

type ProvenanceMeta = {
	label: MessageDescriptor;
	explainer: MessageDescriptor;
	className: string;
};

// One chip per provenance state, colored by how much trust the numbers deserve. The explainer
// tooltip carries the discipline: only the first two states may back quantified claims.
const PROVENANCE_META: Record<StoryProvenance, ProvenanceMeta> = {
	"resume-verified": {
		label: msg`resume-verified`,
		explainer: msg`Every numeric claim in this story traces back to the linked resume's text.`,
		className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	"user-confirmed": {
		label: msg`user-confirmed`,
		explainer: msg`You explicitly confirmed the figures in this story yourself.`,
		className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	"derived-unverified": {
		label: msg`derived-unverified`,
		explainer: msg`The claims exist only in this story and haven't been confirmed yet — treat the numbers as drafts.`,
		className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
	"user-cannot-confirm": {
		label: msg`user-cannot-confirm`,
		explainer: msg`You said these figures can no longer be verified. This state is durable — use the story as narrative texture, never as a quantified claim.`,
		className: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
	},
};

type ProvenanceChipProps = {
	provenance: StoryProvenance;
	className?: string;
};

export function ProvenanceChip({ provenance, className }: ProvenanceChipProps) {
	const { i18n } = useLingui();
	const meta = PROVENANCE_META[provenance];

	return (
		<Tooltip>
			<TooltipTrigger render={<Badge variant="outline" className={cn("cursor-default", meta.className, className)} />}>
				{i18n.t(meta.label)}
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-72">
				{i18n.t(meta.explainer)}
			</TooltipContent>
		</Tooltip>
	);
}
