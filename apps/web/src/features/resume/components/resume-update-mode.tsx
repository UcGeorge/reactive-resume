import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId } from "react";
import { Label } from "@reactive-resume/ui/components/label";
import { Switch } from "@reactive-resume/ui/components/switch";
import { useConfirm } from "@/hooks/use-confirm";

type ResumeUpdateModeProps = {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
};

export function ResumeUpdateMode({ checked, disabled, onCheckedChange }: ResumeUpdateModeProps) {
	const id = useId();
	const confirm = useConfirm();

	return (
		<div className="flex items-center gap-2">
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={async (next) => {
					if (!next) return onCheckedChange(false);
					const accepted = await confirm(t`Update this resume in place?`, {
						description: t`AI changes will modify the selected resume directly instead of creating a separate copy. Other applications and shared links using this resume will show those changes too. Review the changes carefully. You can use version history or the agent's undo controls to recover earlier content.`,
						confirmText: t`Update in place`,
						cancelText: t`Keep creating a copy`,
					});
					if (accepted) onCheckedChange(true);
				}}
			/>
			<Label htmlFor={id} className="text-xs">
				<Trans>Update existing resume in place</Trans>
			</Label>
		</div>
	);
}
