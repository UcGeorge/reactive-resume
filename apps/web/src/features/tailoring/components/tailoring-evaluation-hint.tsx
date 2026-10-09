import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { evaluationsListQueryOptions } from "@/features/evaluations/queries";

type TailoringEvaluationHintProps = { applicationId: string };

export function TailoringEvaluationHint({ applicationId }: TailoringEvaluationHintProps) {
	const evaluations = useQuery(evaluationsListQueryOptions(applicationId));
	if (!evaluations.isSuccess) return null;
	const hasEvaluation = evaluations.data.some((evaluation) => evaluation.status === "complete");

	return (
		<p className="text-muted-foreground text-xs">
			{hasEvaluation ? (
				<Trans>Tailoring will use your latest completed evaluation, including gaps and recommendations.</Trans>
			) : (
				<Trans>Tailoring works best after a full evaluation identifies gaps. You can still tailor without one.</Trans>
			)}
		</p>
	);
}
