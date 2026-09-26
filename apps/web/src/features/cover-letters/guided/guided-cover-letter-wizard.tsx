import type { FactGateReportData } from "@reactive-resume/schema/career/data";
import type { Application } from "@/features/applications/types";
import type { GapHandling, GuidedSuggestions } from "./queries";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ArrowsClockwiseIcon,
	CheckCircleIcon,
	CompassIcon,
	FloppyDiskIcon,
	PlusIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { coverLetterTextToHtml } from "@reactive-resume/resume/cover-letter";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Checkbox } from "@reactive-resume/ui/components/checkbox";
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
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { toast } from "@reactive-resume/ui/components/toast";
import { cn } from "@reactive-resume/utils/style";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";
import {
	createCoverLetterMutationOptions,
	draftGuidedCoverLetterMutationOptions,
	suggestAnglesMutationOptions,
} from "./queries";

/**
 * The guided cover-letter intake. Mirrors the API's gates client-side for UX (the server
 * still enforces them): four mandatory prompts of at least 20 characters, a handling choice
 * for every surfaced gap, at least one confirmed keyword and one verbatim achievement.
 * Nothing is persisted until the user saves the drafted letter on the final step.
 */

const STEP_COUNT = 7;
const MIN_ANSWER_LENGTH = 20;

type GuidedCoverLetterWizardProps = {
	application: Application;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function GuidedCoverLetterWizard({ application, open, onOpenChange }: GuidedCoverLetterWizardProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const [step, setStep] = useState(0);
	const [research, setResearch] = useState("");
	const [keywords, setKeywords] = useState<string[]>([]);
	const [customKeywords, setCustomKeywords] = useState<string[]>([]);
	const [keywordDraft, setKeywordDraft] = useState("");
	const [gapAnswers, setGapAnswers] = useState<Record<string, GapHandling>>({});
	const [whyCompany, setWhyCompany] = useState("");
	const [problem, setProblem] = useState("");
	const [approach, setApproach] = useState("");
	const [tone, setTone] = useState("");
	const [recipient, setRecipient] = useState("");
	const [selectedAchievements, setSelectedAchievements] = useState<string[]>([]);
	const [achievementSearch, setAchievementSearch] = useState("");

	const suggest = useMutation(
		suggestAnglesMutationOptions({
			// Preselect every suggested keyword; the user prunes rather than rebuilds.
			onSuccess: (result) => setKeywords(result.keywords.slice(0, 25)),
		}),
	);
	const suggestions: GuidedSuggestions | undefined = suggest.data;

	const draft = useMutation(draftGuidedCoverLetterMutationOptions());

	const save = useMutation(
		createCoverLetterMutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({ queryKey: orpc.coverLetters.list.key() });
				toast.add({
					type: "success",
					description: t`Cover letter saved.`,
					actionProps: {
						children: t`Open Cover Letters`,
						onClick: () => void navigate({ to: "/dashboard/cover-letters" }),
					},
				});
				onOpenChange(false);
			},
			onError: (error) =>
				toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't save the cover letter.`) }),
		}),
	);

	// Auto-run the analysis once when the wizard first opens (ref-guarded against StrictMode).
	const { mutate: runSuggest } = suggest;
	const suggestStarted = useRef(false);
	useEffect(() => {
		if (!open || suggestStarted.current) return;
		suggestStarted.current = true;
		runSuggest({ applicationId: application.id });
	}, [open, runSuggest, application.id]);

	const gaps = suggestions?.gaps ?? [];
	const promptsReady =
		[whyCompany, problem, approach].every((answer) => answer.trim().length >= MIN_ANSWER_LENGTH) &&
		tone.trim().length >= 3;

	// Next-gates per step, in step order. The last step has no Next.
	const gates = [
		!!suggestions,
		true,
		keywords.length >= 1,
		gaps.every((gap) => !!gapAnswers[gap]),
		promptsReady,
		selectedAchievements.length >= 1,
		false,
	];

	const runDraft = () => {
		draft.mutate({
			applicationId: application.id,
			research: research.trim() ? research.trim() : null,
			keywords: keywords.slice(0, 25),
			gapAnswers: gaps.map((gap) => ({ gap, handling: gapAnswers[gap] ?? "omit" })),
			whyCompany: whyCompany.trim(),
			problem: problem.trim(),
			approach: approach.trim(),
			tone: tone.trim(),
			selectedAchievements: selectedAchievements.slice(0, 10),
			...(recipient.trim() ? { recipient: recipient.trim() } : {}),
		});
	};

	const next = () => {
		if (step === 5) {
			setStep(6);
			runDraft();
			return;
		}
		setStep((current) => Math.min(current + 1, STEP_COUNT - 1));
	};

	const saveLetter = () => {
		if (!draft.data) return;
		save.mutate({
			name: `${application.company} — ${application.role}`.slice(0, 100),
			content: coverLetterTextToHtml(draft.data.letter),
			...(recipient.trim() ? { recipient: recipient.trim() } : {}),
			applicationId: application.id,
			...(application.resumeId ? { resumeId: application.resumeId } : {}),
		});
	};

	const toggleKeyword = (keyword: string) =>
		setKeywords((current) =>
			current.includes(keyword)
				? current.filter((entry) => entry !== keyword)
				: current.length < 25
					? [...current, keyword]
					: current,
		);

	const addCustomKeyword = () => {
		const keyword = keywordDraft.trim();
		if (!keyword) return;
		setKeywordDraft("");
		if (!customKeywords.includes(keyword) && !(suggestions?.keywords ?? []).includes(keyword)) {
			setCustomKeywords((current) => [...current, keyword]);
		}
		setKeywords((current) => (current.includes(keyword) || current.length >= 25 ? current : [...current, keyword]));
	};

	const toggleAchievement = (achievement: string) =>
		setSelectedAchievements((current) =>
			current.includes(achievement)
				? current.filter((entry) => entry !== achievement)
				: current.length < 10
					? [...current, achievement]
					: current,
		);

	const stepTitles = [
		t`Getting ready`,
		t`Company research`,
		t`Keywords`,
		t`Gaps`,
		t`Your answers`,
		t`Achievements`,
		t`Draft`,
	];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<CompassIcon className="size-5 text-primary" />
						<Trans>Guided cover letter</Trans>
					</DialogTitle>
					<DialogDescription>
						{t`Step ${step + 1} of ${STEP_COUNT}`} · {stepTitles[step]} — {application.company} · {application.role}
					</DialogDescription>
				</DialogHeader>

				{/* progress */}
				<div className="flex gap-1">
					{stepTitles.map((title, index) => (
						<span key={title} className={cn("h-1 flex-1 rounded-full", index <= step ? "bg-primary" : "bg-muted")} />
					))}
				</div>

				<div className="-mx-1 max-h-[60vh] overflow-y-auto px-1 py-1">
					{step === 0 && (
						<IntroStep
							pending={suggest.isPending}
							error={suggest.error ? getReadableErrorMessage(suggest.error, t`The analysis failed.`) : null}
							suggestions={suggestions}
							onRetry={() => runSuggest({ applicationId: application.id })}
						/>
					)}

					{step === 1 && <ResearchStep research={research} onChange={setResearch} />}

					{step === 2 && (
						<KeywordsStep
							suggested={[...(suggestions?.keywords ?? []), ...customKeywords]}
							selected={keywords}
							draft={keywordDraft}
							onDraftChange={setKeywordDraft}
							onToggle={toggleKeyword}
							onAdd={addCustomKeyword}
						/>
					)}

					{step === 3 && (
						<GapsStep
							gaps={gaps}
							answers={gapAnswers}
							onAnswer={(gap, handling) => setGapAnswers((current) => ({ ...current, [gap]: handling }))}
						/>
					)}

					{step === 4 && (
						<PromptsStep
							suggestions={suggestions}
							whyCompany={whyCompany}
							problem={problem}
							approach={approach}
							tone={tone}
							recipient={recipient}
							onWhyCompanyChange={setWhyCompany}
							onProblemChange={setProblem}
							onApproachChange={setApproach}
							onToneChange={setTone}
							onRecipientChange={setRecipient}
						/>
					)}

					{step === 5 && (
						<AchievementsStep
							candidates={suggestions?.achievements ?? []}
							selected={selectedAchievements}
							search={achievementSearch}
							onSearchChange={setAchievementSearch}
							onToggle={toggleAchievement}
						/>
					)}

					{step === 6 && (
						<DraftStep
							pending={draft.isPending}
							error={draft.error ? getReadableErrorMessage(draft.error, t`Drafting failed.`) : null}
							result={draft.data ?? null}
							onRetry={runDraft}
						/>
					)}
				</div>

				<DialogFooter className="gap-2">
					{step > 0 && (
						<Button
							type="button"
							variant="outline"
							className="me-auto"
							disabled={draft.isPending || save.isPending}
							onClick={() => setStep((current) => Math.max(current - 1, 0))}
						>
							<Trans>Back</Trans>
						</Button>
					)}
					{step < 6 ? (
						<Button type="button" disabled={!gates[step]} onClick={next}>
							{step === 5 ? <Trans>Draft the letter</Trans> : <Trans>Next</Trans>}
						</Button>
					) : (
						<>
							<Button type="button" variant="outline" disabled={draft.isPending || save.isPending} onClick={runDraft}>
								<ArrowsClockwiseIcon />
								<Trans>Redraft</Trans>
							</Button>
							<Button type="button" disabled={!draft.data || draft.isPending || save.isPending} onClick={saveLetter}>
								{save.isPending ? <Spinner /> : <FloppyDiskIcon />}
								<Trans>Save to Cover Letters</Trans>
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// --- Step 1: intro + analysis ----------------------------------------------------------------

type IntroStepProps = {
	pending: boolean;
	error: string | null;
	suggestions: GuidedSuggestions | undefined;
	onRetry: () => void;
};

function IntroStep({ pending, error, suggestions, onRetry }: IntroStepProps) {
	return (
		<div className="flex flex-col gap-4">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Answer a few short prompts about this role. The letter is drafted only from your answers and from bullet
					points taken verbatim from your linked resume — and nothing is saved until you approve it at the end.
				</Trans>
			</p>

			{pending && (
				<div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground text-sm">
					<Spinner />
					<Trans>Analyzing the posting and your resume…</Trans>
				</div>
			)}

			{error && (
				<div className="flex flex-col gap-3">
					{/* The server's message says exactly what's missing (job description, resume, AI provider). */}
					<p className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-destructive text-sm">
						{error}
					</p>
					<Button size="sm" variant="outline" className="self-start" onClick={onRetry}>
						<ArrowsClockwiseIcon />
						<Trans>Try again</Trans>
					</Button>
				</div>
			)}

			{suggestions && (
				<div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-700 text-sm dark:text-emerald-300">
					<CheckCircleIcon weight="fill" className="size-4 shrink-0" />
					<span>
						{plural(suggestions.keywords.length, { one: "# keyword", other: "# keywords" })},{" "}
						{plural(suggestions.gaps.length, { one: "# gap", other: "# gaps" })},{" "}
						{plural(suggestions.achievements.length, {
							one: "# achievement candidate",
							other: "# achievement candidates",
						})}{" "}
						<Trans>found. Continue when you're ready.</Trans>
					</span>
				</div>
			)}
		</div>
	);
}

// --- Step 2: research ------------------------------------------------------------------------

function ResearchStep({ research, onChange }: { research: string; onChange: (value: string) => void }) {
	const id = useId();
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={id}>
				<Trans>What is this company working on right now?</Trans>
			</Label>
			<Textarea
				id={id}
				rows={5}
				value={research}
				placeholder={t`Optional — paste a line from their blog, a recent launch, a funding note…`}
				onChange={(event) => onChange(event.target.value)}
			/>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Optional, but it makes the opening concrete: a letter grounded in something the company actually shipped or
					announced beats a generic introduction. Paste a sentence or two — only what you paste here is used.
				</Trans>
			</p>
		</div>
	);
}

// --- Step 3: keywords ------------------------------------------------------------------------

type KeywordsStepProps = {
	suggested: string[];
	selected: string[];
	draft: string;
	onDraftChange: (value: string) => void;
	onToggle: (keyword: string) => void;
	onAdd: () => void;
};

function KeywordsStep({ suggested, selected, draft, onDraftChange, onToggle, onAdd }: KeywordsStepProps) {
	return (
		<div className="flex flex-col gap-3">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Confirm the terms the letter should speak to. Deselect anything that doesn't apply to you — keep at least one.
				</Trans>
			</p>
			<div className="flex flex-wrap gap-1.5">
				{suggested.map((keyword) => (
					<Chip key={keyword} active={selected.includes(keyword)} onClick={() => onToggle(keyword)}>
						{keyword}
					</Chip>
				))}
			</div>
			<div className="flex gap-2">
				<Input
					value={draft}
					placeholder={t`Add your own keyword…`}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							onAdd();
						}
					}}
				/>
				<Button type="button" variant="outline" disabled={!draft.trim()} onClick={onAdd}>
					<PlusIcon />
					<Trans>Add</Trans>
				</Button>
			</div>
			<p className="text-muted-foreground text-xs">
				{plural(selected.length, { one: "# keyword selected", other: "# keywords selected" })} (max 25)
			</p>
		</div>
	);
}

// --- Step 4: gaps ----------------------------------------------------------------------------

const GAP_OPTIONS: Array<{ value: GapHandling; label: () => string }> = [
	{ value: "address", label: () => t`Address head-on` },
	{ value: "adjacent", label: () => t`Lead with adjacent experience` },
	{ value: "omit", label: () => t`Leave it out` },
];

type GapsStepProps = {
	gaps: string[];
	answers: Record<string, GapHandling>;
	onAnswer: (gap: string, handling: GapHandling) => void;
};

function GapsStep({ gaps, answers, onAnswer }: GapsStepProps) {
	const groupId = useId();

	if (gaps.length === 0) {
		return (
			<p className="rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground text-sm">
				<Trans>No gaps surfaced between the posting and your resume — continue to the next step.</Trans>
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<p className="text-muted-foreground text-sm">
				<Trans>
					The posting asks for things your resume doesn't show. Decide how the letter should handle each one.
				</Trans>
			</p>
			{gaps.map((gap, index) => (
				<fieldset key={gap} className="flex flex-col gap-2 rounded-lg border border-border p-3">
					<legend className="sr-only">{gap}</legend>
					<span className="font-medium text-sm">{gap}</span>
					<div className="flex flex-wrap gap-x-4 gap-y-1.5">
						{GAP_OPTIONS.map((option) => (
							<label key={option.value} className="flex cursor-pointer items-center gap-1.5 text-sm">
								<input
									type="radio"
									name={`${groupId}-gap-${index}`}
									className="accent-primary"
									checked={answers[gap] === option.value}
									onChange={() => onAnswer(gap, option.value)}
								/>
								{option.label()}
							</label>
						))}
					</div>
				</fieldset>
			))}
		</div>
	);
}

// --- Step 5: the four prompts ----------------------------------------------------------------

type PromptsStepProps = {
	suggestions: GuidedSuggestions | undefined;
	whyCompany: string;
	problem: string;
	approach: string;
	tone: string;
	recipient: string;
	onWhyCompanyChange: (value: string) => void;
	onProblemChange: (value: string) => void;
	onApproachChange: (value: string) => void;
	onToneChange: (value: string) => void;
	onRecipientChange: (value: string) => void;
};

function PromptsStep({
	suggestions,
	whyCompany,
	problem,
	approach,
	tone,
	recipient,
	onWhyCompanyChange,
	onProblemChange,
	onApproachChange,
	onToneChange,
	onRecipientChange,
}: PromptsStepProps) {
	const recipientId = useId();
	return (
		<div className="flex flex-col gap-5">
			<PromptField
				label={t`Why this company?`}
				value={whyCompany}
				angles={suggestions?.angles.whyCompany ?? []}
				onChange={onWhyCompanyChange}
			/>
			<PromptField
				label={t`What problem would you solve for them?`}
				value={problem}
				angles={suggestions?.angles.problem ?? []}
				onChange={onProblemChange}
			/>
			<PromptField
				label={t`How would you approach it?`}
				value={approach}
				angles={suggestions?.angles.approach ?? []}
				onChange={onApproachChange}
			/>

			<div className="flex flex-col gap-2">
				<Label>
					<Trans>Tone</Trans>
				</Label>
				<div className="flex flex-wrap gap-1.5">
					{(suggestions?.angles.tone ?? []).map((suggestion) => (
						<Chip key={suggestion} active={tone === suggestion} onClick={() => onToneChange(suggestion)}>
							{suggestion}
						</Chip>
					))}
				</div>
				<Input
					value={tone}
					placeholder={t`e.g. direct and technical`}
					onChange={(event) => onToneChange(event.target.value)}
				/>
			</div>

			<div className="flex flex-col gap-2">
				<Label htmlFor={recipientId}>
					<Trans>Recipient (optional)</Trans>
				</Label>
				<Input
					id={recipientId}
					value={recipient}
					placeholder={t`e.g. Jane Doe, Head of Engineering`}
					onChange={(event) => onRecipientChange(event.target.value)}
				/>
			</div>
		</div>
	);
}

type PromptFieldProps = {
	label: string;
	value: string;
	angles: string[];
	onChange: (value: string) => void;
};

function PromptField({ label, value, angles, onChange }: PromptFieldProps) {
	const id = useId();
	const remaining = MIN_ANSWER_LENGTH - value.trim().length;
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={id}>{label}</Label>
			{angles.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{angles.map((angle) => (
						<Chip key={angle} active={value === angle} onClick={() => onChange(angle)}>
							{angle}
						</Chip>
					))}
				</div>
			)}
			<Textarea id={id} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
			{remaining > 0 && (
				<p className="text-muted-foreground text-xs">
					{plural(remaining, {
						one: "At least a sentence — # more character to go.",
						other: "At least a sentence — # more characters to go.",
					})}
				</p>
			)}
		</div>
	);
}

// --- Step 6: achievements --------------------------------------------------------------------

type AchievementsStepProps = {
	candidates: string[];
	selected: string[];
	search: string;
	onSearchChange: (value: string) => void;
	onToggle: (achievement: string) => void;
};

function AchievementsStep({ candidates, selected, search, onSearchChange, onToggle }: AchievementsStepProps) {
	const idBase = useId();
	const query = search.trim().toLowerCase();
	const visible = query ? candidates.filter((candidate) => candidate.toLowerCase().includes(query)) : candidates;

	return (
		<div className="flex flex-col gap-3">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Pick the bullet points the letter may cite — taken word-for-word from your linked resume, so it can't claim
					anything you didn't. Select at least one.
				</Trans>
			</p>
			{candidates.length === 0 ? (
				<p className="rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground text-sm">
					<Trans>
						No bullet points were found in the linked resume. Add achievement bullets to the resume first — the letter
						can only cite what the resume states.
					</Trans>
				</p>
			) : (
				<>
					{candidates.length > 8 && (
						<Input
							value={search}
							placeholder={t`Search achievements…`}
							onChange={(event) => onSearchChange(event.target.value)}
						/>
					)}
					<div className="flex flex-col gap-1.5">
						{visible.map((candidate) => (
							<label
								key={candidate}
								htmlFor={`${idBase}-${candidates.indexOf(candidate)}`}
								className={cn(
									"flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors",
									selected.includes(candidate) ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/50",
								)}
							>
								<Checkbox
									id={`${idBase}-${candidates.indexOf(candidate)}`}
									className="mt-0.5"
									checked={selected.includes(candidate)}
									onCheckedChange={() => onToggle(candidate)}
								/>
								<span>{candidate}</span>
							</label>
						))}
					</div>
					<p className="text-muted-foreground text-xs">
						{plural(selected.length, { one: "# achievement selected", other: "# achievements selected" })} (max 10)
					</p>
				</>
			)}
		</div>
	);
}

// --- Step 7: draft ---------------------------------------------------------------------------

type DraftStepProps = {
	pending: boolean;
	error: string | null;
	result: { letter: string; words: number; factGate: FactGateReportData } | null;
	onRetry: () => void;
};

function DraftStep({ pending, error, result, onRetry }: DraftStepProps) {
	if (pending) {
		return (
			<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
				<Spinner />
				<Trans>Drafting your letter…</Trans>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-col gap-3">
				<p className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-destructive text-sm">
					{error}
				</p>
				<Button size="sm" variant="outline" className="self-start" onClick={onRetry}>
					<ArrowsClockwiseIcon />
					<Trans>Try again</Trans>
				</Button>
			</div>
		);
	}

	if (!result) return null;

	const findings = [...result.factGate.violations, ...result.factGate.warnings];

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<Badge variant="outline" className="text-muted-foreground">
					{plural(result.words, { one: "# word", other: "# words" })}
				</Badge>
				<p className="text-muted-foreground text-xs">
					<Trans>This draft isn't saved yet — it becomes a cover letter only when you save it below.</Trans>
				</p>
			</div>

			<p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed">
				{result.letter}
			</p>

			{findings.length > 0 && (
				<div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
					<div className="flex items-center gap-2 text-amber-700 text-sm dark:text-amber-300">
						<WarningIcon weight="fill" className="size-4 shrink-0" />
						<span className="font-medium">
							<Trans>Check these claims before saving</Trans>
						</span>
					</div>
					<p className="text-muted-foreground text-xs">
						<Trans>
							The fact check flagged lines it couldn't trace back to your resume. You approve the letter by saving it —
							edit your answers and redraft, or save anyway if you know a claim is true.
						</Trans>
					</p>
					{findings.map((finding, index) => (
						<div
							key={`${finding.claim}-${index}`}
							className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs"
						>
							<div className="flex items-start justify-between gap-2">
								<span className="wrap-break-word font-medium">{finding.claim}</span>
								<Badge
									variant="outline"
									className="shrink-0 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
								>
									{finding.kind}
								</Badge>
							</div>
							<p className="text-muted-foreground">{finding.detail}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// --- Shared chip -----------------------------------------------------------------------------

type ChipProps = {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
};

function Chip({ active, onClick, children }: ChipProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-start text-xs transition-colors",
				active
					? "border-primary/50 bg-primary/10 text-primary"
					: "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
			)}
		>
			<span className="line-clamp-2">{children}</span>
			{active && <XIcon className="size-3 shrink-0" />}
		</button>
	);
}
