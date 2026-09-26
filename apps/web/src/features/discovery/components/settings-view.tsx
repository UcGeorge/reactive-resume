import type { ReactNode } from "react";
import type { ScannerSettings } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FloppyDiskIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { Switch } from "@reactive-resume/ui/components/switch";
import { toast } from "@reactive-resume/ui/components/toast";
import { scannerSettingsQueryKey, scannerSettingsQueryOptions, updateScannerSettingsMutationOptions } from "../queries";
import { KeywordListField } from "./keyword-list-field";

export function SettingsView() {
	const queryClient = useQueryClient();
	const settingsQuery = useQuery(scannerSettingsQueryOptions());

	// The form owns a local copy once settings load; the server's resolved response replaces it
	// on save so prefix normalization or clamping done server-side is reflected immediately.
	const [form, setForm] = useState<ScannerSettings | null>(null);
	if (form === null && settingsQuery.data) setForm(structuredClone(settingsQuery.data));

	const update = useMutation(
		updateScannerSettingsMutationOptions({
			onSuccess: (resolved) => {
				setForm(structuredClone(resolved));
				queryClient.setQueryData(scannerSettingsQueryKey(), resolved);
				toast.add({ type: "success", description: t`Scanner settings saved.` });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't save the settings.` }),
		}),
	);

	if (!form) {
		return (
			<div className="flex flex-col gap-3">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	const setTitleFilter = (patch: Partial<ScannerSettings["titleFilter"]>) =>
		setForm({ ...form, titleFilter: { ...form.titleFilter, ...patch } });
	const setLocationFilter = (patch: Partial<ScannerSettings["locationFilter"]>) =>
		setForm({ ...form, locationFilter: { ...form.locationFilter, ...patch } });

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
			<SettingsSection
				title={t`Title filter`}
				description={t`Keywords match job titles as substrings. Prefix a keyword with word: for whole-word matching or stem: for stem matching, and join keywords with + to require all of them at once (an AND-group).`}
			>
				<SettingsField label={t`Include titles matching`}>
					<KeywordListField
						value={form.titleFilter.positive}
						placeholder={t`e.g. engineer, word:go, backend+senior`}
						onChange={(positive) => setTitleFilter({ positive })}
					/>
				</SettingsField>
				<SettingsField label={t`Exclude titles matching`}>
					<KeywordListField
						value={form.titleFilter.negative}
						placeholder={t`e.g. intern, staffing`}
						onChange={(negative) => setTitleFilter({ negative })}
					/>
				</SettingsField>
			</SettingsSection>

			<SettingsSection
				title={t`Location filter`}
				description={t`Postings are kept when their location matches an allow entry and dropped on a block entry. Hard blocks always win, and always-allow entries rescue a posting even when it was blocked.`}
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<SettingsField label={t`Allow`}>
						<KeywordListField
							value={form.locationFilter.allow}
							placeholder={t`e.g. Remote, Berlin, EU`}
							onChange={(allow) => setLocationFilter({ allow })}
						/>
					</SettingsField>
					<SettingsField label={t`Block`}>
						<KeywordListField
							value={form.locationFilter.block}
							placeholder={t`e.g. On-site, US only`}
							onChange={(block) => setLocationFilter({ block })}
						/>
					</SettingsField>
					<SettingsField label={t`Always allow`}>
						<KeywordListField
							value={form.locationFilter.alwaysAllow}
							onChange={(alwaysAllow) => setLocationFilter({ alwaysAllow })}
						/>
					</SettingsField>
					<SettingsField label={t`Hard block`}>
						<KeywordListField
							value={form.locationFilter.blockHard}
							onChange={(blockHard) => setLocationFilter({ blockHard })}
						/>
					</SettingsField>
				</div>
				<div className="flex items-center gap-2">
					<Switch
						size="sm"
						checked={form.locationFilter.strict}
						aria-label={t`Strict location filtering`}
						onCheckedChange={(strict) => setLocationFilter({ strict })}
					/>
					<div>
						<p className="text-sm">
							<Trans>Strict</Trans>
						</p>
						<p className="text-muted-foreground text-xs">
							<Trans>Also drop postings whose location doesn't match any allow entry, instead of keeping them.</Trans>
						</p>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t`Content excludes`}
				description={t`Skip postings whose description contains any of these phrases (e.g. security clearance requirements).`}
			>
				<KeywordListField
					value={form.contentExclude}
					placeholder={t`e.g. security clearance`}
					onChange={(contentExclude) => setForm({ ...form, contentExclude })}
				/>
			</SettingsSection>

			<SettingsSection
				title={t`Repeat cooldown`}
				description={t`Don't re-surface a company + title you already applied to within this window.`}
			>
				<div className="flex items-center gap-2">
					<Input
						type="number"
						min={0}
						max={365}
						className="w-24"
						value={form.cooldownDays}
						onChange={(event) => {
							const days = Number(event.target.value);
							if (Number.isFinite(days))
								setForm({ ...form, cooldownDays: Math.min(365, Math.max(0, Math.trunc(days))) });
						}}
					/>
					<span className="text-muted-foreground text-sm">
						<Trans>days</Trans>
					</span>
				</div>
			</SettingsSection>

			<SettingsSection
				title={t`Company blacklist`}
				description={t`Companies that never surface in your inbox (a do-not-apply list).`}
			>
				<KeywordListField
					value={form.blacklist}
					placeholder={t`Add a company name…`}
					onChange={(blacklist) => setForm({ ...form, blacklist })}
				/>
			</SettingsSection>

			<div className="flex justify-end">
				<Button disabled={update.isPending} onClick={() => update.mutate(form)}>
					{update.isPending ? <Spinner /> : <FloppyDiskIcon />}
					<Trans>Save settings</Trans>
				</Button>
			</div>
		</div>
	);
}

type SettingsSectionProps = {
	title: string;
	description: string;
	children: ReactNode;
};

function SettingsSection({ title, description, children }: SettingsSectionProps) {
	return (
		<section className="flex flex-col gap-3 rounded-xl border border-border p-4">
			<div>
				<h2 className="font-medium text-sm">{title}</h2>
				<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">{description}</p>
			</div>
			{children}
		</section>
	);
}

type SettingsFieldProps = {
	label: string;
	children: ReactNode;
};

function SettingsField({ label, children }: SettingsFieldProps) {
	return (
		<div className="grid content-start gap-1.5">
			<Label className="text-muted-foreground text-xs">{label}</Label>
			{children}
		</div>
	);
}
