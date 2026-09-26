import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { EnvelopeSimpleIcon, LinkBreakIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { toast } from "@reactive-resume/ui/components/toast";
import { Combobox } from "@/components/ui/combobox";
import { CoverLetterEditorDialog } from "@/features/cover-letters/editor-dialog";
import { orpc } from "@/libs/orpc/client";

const formatDate = (value: Date | string) =>
	new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

type LinkedCoverLettersProps = {
	applicationId: string;
};

/**
 * The in-app cover letters written for this application (their `sourceApplicationId` points
 * here — set by the copilot and guided flows, or linked from this picker). The PDF attachment
 * field beside this is upstream's separate "file you actually sent" record.
 */
export function LinkedCoverLetters({ applicationId }: LinkedCoverLettersProps) {
	const queryClient = useQueryClient();
	const [openId, setOpenId] = useState<string | null>(null);

	const linked = useQuery(orpc.coverLetters.list.queryOptions({ input: { applicationId, limit: 50, offset: 0 } }));
	const all = useQuery(orpc.coverLetters.list.queryOptions({ input: { limit: 100, offset: 0 } }));

	const link = useMutation(
		orpc.coverLetters.linkApplication.mutationOptions({
			onSuccess: (_letter, variables) => {
				void queryClient.invalidateQueries({ queryKey: orpc.coverLetters.key() });
				toast.add({
					type: "success",
					description: variables.applicationId
						? t`Cover letter linked to this application.`
						: t`Cover letter unlinked from this application.`,
				});
			},
			onError: (error) =>
				toast.add({ type: "error", description: error.message || t`Couldn't update the cover letter link.` }),
		}),
	);

	const letters = linked.data?.items ?? [];
	const linkedIds = new Set(letters.map((letter) => letter.id));
	const options = (all.data?.items ?? [])
		.filter((letter) => !linkedIds.has(letter.id))
		.map((letter) => ({ value: letter.id, label: letter.name }));

	return (
		<div className="flex flex-col gap-2">
			{letters.map((letter) => {
				const unlinking = link.isPending && link.variables?.id === letter.id;
				return (
					<div key={letter.id} className="flex items-center gap-2 rounded-lg border border-border p-2.5">
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-3 text-left"
							onClick={() => setOpenId(letter.id)}
						>
							<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
								<EnvelopeSimpleIcon />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm">{letter.name}</span>
								<span className="block text-muted-foreground text-xs">
									<Trans>Cover letter · updated {formatDate(letter.updatedAt)}</Trans>
								</span>
							</span>
						</button>
						<Button
							variant="ghost"
							size="sm"
							className="shrink-0 text-muted-foreground"
							disabled={link.isPending}
							title={t`Unlink from this application`}
							onClick={() => link.mutate({ id: letter.id, applicationId: null })}
						>
							{unlinking ? <SpinnerGapIcon className="animate-spin" /> : <LinkBreakIcon />}
							<Trans>Unlink</Trans>
						</Button>
					</div>
				);
			})}

			{letters.length === 0 && !linked.isLoading && (
				<p className="text-muted-foreground text-sm">
					<Trans>No cover letter written for this application yet.</Trans>
				</p>
			)}

			<Combobox
				className="w-full"
				value={null}
				options={options}
				placeholder={t`Link an existing cover letter`}
				emptyMessage={t`No other cover letters yet.`}
				disabled={link.isPending}
				onValueChange={(value) => {
					if (value) link.mutate({ id: value, applicationId });
				}}
			/>

			{openId && <CoverLetterEditorDialog letterId={openId} onClose={() => setOpenId(null)} />}
		</div>
	);
}
