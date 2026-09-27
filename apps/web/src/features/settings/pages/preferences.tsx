import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { Label } from "@reactive-resume/ui/components/label";
import { LocaleCombobox } from "@/features/locale/combobox";
import { ThemeCombobox } from "@/features/theme/combobox";

export function PreferencesSettingsPage() {
	return (
		<m.div
			initial={{ y: -20 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
			className="grid max-w-xl gap-6 will-change-[transform,opacity]"
		>
			<div className="grid gap-1.5">
				<Label className="mb-0.5">
					<Trans>Theme</Trans>
				</Label>
				<ThemeCombobox />
			</div>

			<div className="grid gap-1.5">
				<Label className="mb-0.5">
					<Trans>Language</Trans>
				</Label>
				<LocaleCombobox />
			</div>
		</m.div>
	);
}
