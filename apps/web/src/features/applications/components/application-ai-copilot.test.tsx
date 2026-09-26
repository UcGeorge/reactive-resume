// @vitest-environment happy-dom

import type { Application } from "../types";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ draft: vi.fn(), other: vi.fn(), tailoringRuns: vi.fn() }));
type MockEditorDialogProps = { letterId: string };
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		applications: {
			ai: {
				matchScore: { mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.other }) },
				tailorResume: { mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.other }) },
				draftMessage: { mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.draft }) },
			},
		},
		coverLetters: { list: { key: () => ["cover-letters"] } },
		evaluations: {
			start: { mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.other }) },
			listByApplication: { queryKey: () => ["evaluations"] },
			tailoringRuns: {
				list: {
					queryOptions: () => ({
						queryKey: ["tailoring-runs"],
						queryFn: async () => (await mocks.tailoringRuns()) ?? [],
					}),
					queryKey: () => ["tailoring-runs"],
				},
				get: { queryOptions: () => ({}), queryKey: () => [] },
				discard: { mutationOptions: (options: object) => options },
				audit: { mutationOptions: (options: object) => options },
			},
			factCheck: { mutationOptions: (options: object) => options },
		},
	},
}));
vi.mock("@/features/cover-letters/editor-dialog", () => ({
	CoverLetterEditorDialog: ({ letterId }: MockEditorDialogProps) => <div role="dialog">Saved letter {letterId}</div>,
}));

const { ApplicationAiCopilot } = await import("./application-ai-copilot");
const application: Application = {
	id: "application",
	company: "Example",
	role: "Engineer",
	location: null,
	salary: null,
	status: "saved",
	archived: false,
	resumeId: null,
	source: null,
	sourceUrl: null,
	jobDescription: null,
	matchScore: null,
	aiMetadata: null,
	notes: null,
	resumeFileUrl: null,
	resumeFileName: null,
	coverLetterUrl: null,
	coverLetterName: null,
	followUpAt: null,
	followUpNote: null,
	tags: [],
	contacts: [],
	activity: [],
	appliedAt: new Date(),
	createdAt: new Date(),
	updatedAt: new Date(),
};

beforeAll(() => i18n.loadAndActivate({ locale: "en", messages: {} }));
beforeEach(() => vi.resetAllMocks());

function draftRequest() {
	let resolve!: (result: { text: string; coverLetterId?: string }) => void;
	const promise = new Promise<{ text: string; coverLetterId?: string }>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function renderCopilot(subject: Application = application) {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
			<I18nProvider i18n={i18n}>
				<ApplicationAiCopilot application={subject} />
			</I18nProvider>
		</QueryClientProvider>,
	);
}

it("shows a tailoring run already in flight on the server after a fresh mount", async () => {
	mocks.tailoringRuns.mockResolvedValue([{ id: "run", status: "planned" }]);
	renderCopilot({ ...application, resumeId: "resume", jobDescription: "A posting" });
	const tailor = screen.getByRole("button", { name: /Tailor my resume/ });
	await waitFor(() => expect(tailor).toBeDisabled());
	expect(tailor).toHaveTextContent(/Tailoring in progress/);
	await userEvent.click(tailor);
	expect(mocks.other).not.toHaveBeenCalled();
});

it.each(["cover-letter", "follow-up"] as const)(
	"blocks both draft actions while the first %s is pending",
	async (kind) => {
		const request = draftRequest();
		mocks.draft.mockReturnValue(request.promise);
		renderCopilot();
		const coverLetter = screen.getByRole("button", { name: /Draft a cover letter/ });
		const followUp = screen.getByRole("button", { name: /Draft a follow-up/ });
		await userEvent.click(kind === "cover-letter" ? coverLetter : followUp);
		await waitFor(() => expect(mocks.draft).toHaveBeenCalledTimes(1));
		expect(coverLetter).toBeDisabled();
		expect(followUp).toBeDisabled();
		await userEvent.click(coverLetter);
		await userEvent.click(followUp);
		expect(mocks.draft).toHaveBeenCalledTimes(1);
		await act(async () =>
			request.resolve(
				kind === "cover-letter" ? { text: "Letter", coverLetterId: "letter-one" } : { text: "Follow-up" },
			),
		);
		if (kind === "cover-letter") expect(await screen.findByRole("dialog")).toHaveTextContent("letter-one");
		else expect(await screen.findByText("Follow-up")).toBeVisible();
		expect(coverLetter).toBeEnabled();
		expect(followUp).toBeEnabled();
	},
);

it("prevents duplicate saved letters after an earlier follow-up completed", async () => {
	mocks.draft.mockResolvedValueOnce({ text: "Earlier follow-up" });
	const request = draftRequest();
	mocks.draft.mockReturnValueOnce(request.promise);
	renderCopilot();
	const coverLetter = screen.getByRole("button", { name: /Draft a cover letter/ });
	const followUp = screen.getByRole("button", { name: /Draft a follow-up/ });
	await userEvent.click(followUp);
	await screen.findByText("Earlier follow-up");
	await userEvent.click(coverLetter);
	await waitFor(() => expect(mocks.draft).toHaveBeenCalledTimes(2));
	expect(coverLetter).toBeDisabled();
	expect(followUp).toBeDisabled();
	await userEvent.click(coverLetter);
	expect(mocks.draft).toHaveBeenCalledTimes(2);
	await act(async () => request.resolve({ text: "Saved letter", coverLetterId: "letter-two" }));
	expect(await screen.findByRole("dialog")).toHaveTextContent("letter-two");
	expect(screen.queryByText("Earlier follow-up")).not.toBeInTheDocument();
});
