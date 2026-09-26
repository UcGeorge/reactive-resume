import type { ScanResult } from "../queries";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CheckCircleIcon, WarningIcon, XCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@reactive-resume/ui/components/accordion";
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
import { toast } from "@reactive-resume/ui/components/toast";
import {
	createWatchedCompanyMutationOptions,
	discoveredJobsKey,
	discoveryStatusQueryKey,
	testWatchedCompanyMutationOptions,
	watchedCompaniesQueryKey,
} from "../queries";
import { KeywordListField } from "./keyword-list-field";

type WatchCompanyDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function WatchCompanyDialog({ open, onOpenChange }: WatchCompanyDialogProps) {
	const queryClient = useQueryClient();

	const [name, setName] = useState("");
	const [careersUrl, setCareersUrl] = useState("");
	const [positive, setPositive] = useState<string[]>([]);
	const [negative, setNegative] = useState<string[]>([]);
	const [testResult, setTestResult] = useState<ScanResult | null>(null);

	// Reset the form whenever the dialog opens for a fresh watch.
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setName("");
			setCareersUrl("");
			setPositive([]);
			setNegative([]);
			setTestResult(null);
		}
	}

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: watchedCompaniesQueryKey() });
		void queryClient.invalidateQueries({ queryKey: discoveryStatusQueryKey() });
	};

	// The onboarding moment: right after creating the watch, run one live fetch against the
	// board and show the outcome inline — "does this work, and how many postings?".
	const test = useMutation(
		testWatchedCompanyMutationOptions({
			onSuccess: (result) => {
				setTestResult(result);
				invalidate();
				void queryClient.invalidateQueries({ queryKey: discoveredJobsKey() });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`The test scan failed.` }),
		}),
	);

	const create = useMutation(
		createWatchedCompanyMutationOptions({
			onSuccess: (row) => {
				invalidate();
				test.mutate({ id: row.id });
			},
			onError: (error) => toast.add({ type: "error", description: error.message || t`Couldn't watch the company.` }),
		}),
	);

	const created = create.isSuccess;
	const pending = create.isPending || test.isPending;
	const canSubmit = !!name.trim() && careersUrl.trim().startsWith("https://") && !pending && !created;

	const submit = () => {
		if (!canSubmit) return;
		create.mutate({
			name: name.trim(),
			careersUrl: careersUrl.trim(),
			...(positive.length > 0 || negative.length > 0 ? { titleFilterOverride: { positive, negative } } : {}),
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-5 sm:max-w-lg">
				<DialogHeader className="pe-8">
					<DialogTitle>
						<Trans>Watch a company</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Point the scanner at a careers page. It's tested immediately so you know the board works before the
							background scans start.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="grid gap-1.5">
						<Label className="text-muted-foreground text-xs">
							<Trans>Company name</Trans>
						</Label>
						<Input value={name} disabled={created} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="grid gap-1.5">
						<Label className="text-muted-foreground text-xs">
							<Trans>Careers page URL</Trans>
						</Label>
						<Input
							type="url"
							value={careersUrl}
							placeholder="https://…"
							disabled={created}
							onChange={(event) => setCareersUrl(event.target.value)}
						/>
					</div>

					{!created && (
						<Accordion className="rounded-lg border border-border border-dashed px-3">
							<AccordionItem value="title-filter-override">
								<AccordionTrigger className="text-muted-foreground">
									<Trans>Title filter override (advanced)</Trans>
								</AccordionTrigger>
								<AccordionContent className="flex flex-col gap-3">
									<p className="text-muted-foreground text-xs">
										<Trans>
											Only for this company, replacing your global title filter. Keywords match as substrings; prefix
											with word: or stem: for whole-word or stem matching, and join keywords with + to require all of
											them.
										</Trans>
									</p>
									<div className="grid gap-1.5">
										<Label className="text-muted-foreground text-xs">
											<Trans>Include titles matching</Trans>
										</Label>
										<KeywordListField value={positive} onChange={setPositive} />
									</div>
									<div className="grid gap-1.5">
										<Label className="text-muted-foreground text-xs">
											<Trans>Exclude titles matching</Trans>
										</Label>
										<KeywordListField value={negative} onChange={setNegative} />
									</div>
								</AccordionContent>
							</AccordionItem>
						</Accordion>
					)}

					{test.isPending && (
						<div className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-muted-foreground text-xs">
							<Spinner />
							<Trans>Testing the board — this does a live fetch and can take a few seconds…</Trans>
						</div>
					)}

					{testResult && <TestResultPanel result={testResult} />}
				</div>

				<DialogFooter>
					{created ? (
						<Button onClick={() => onOpenChange(false)}>
							<Trans>Done</Trans>
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								<Trans>Cancel</Trans>
							</Button>
							<Button disabled={!canSubmit} onClick={submit}>
								{pending && <Spinner />}
								<Trans>Watch & test</Trans>
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function TestResultPanel({ result }: { result: ScanResult }) {
	if (result.status === "ok") {
		return (
			<div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-emerald-700 text-xs dark:text-emerald-300">
				<CheckCircleIcon weight="fill" className="mt-0.5 size-4 shrink-0" />
				<p>
					<Trans>
						The board works — fetched {result.fetched} postings, {result.matched} matched your filters, {result.added}{" "}
						added to your inbox.
					</Trans>
				</p>
			</div>
		);
	}
	if (result.status === "unsupported") {
		return (
			<div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-amber-700 text-xs dark:text-amber-300">
				<WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0" />
				<p>
					<Trans>
						This careers site isn't supported yet. The watch is saved, so it will start working if support for the board
						is added.
					</Trans>
				</p>
			</div>
		);
	}
	return (
		<div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-rose-700 text-xs dark:text-rose-300">
			<XCircleIcon weight="fill" className="mt-0.5 size-4 shrink-0" />
			<p>{result.error ?? t`The test scan failed.`}</p>
		</div>
	);
}
