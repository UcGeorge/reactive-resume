import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const mocks = vi.hoisted(() => ({
	evaluation: vi.fn(),
	generateJson: vi.fn(),
	resolveModel: vi.fn(),
	application: { getById: vi.fn(), update: vi.fn(), addNote: vi.fn() },
	resume: { getById: vi.fn(), create: vi.fn(), patch: vi.fn(), delete: vi.fn(), versions: { snapshot: vi.fn() } },
	tailoring: {
		failStaleRuns: vi.fn(),
		inFlightForApplication: vi.fn(),
		latestForApplication: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		getById: vi.fn(),
		findByTailoredResume: vi.fn(),
	},
}));
vi.mock("@reactive-resume/db/client", () => ({
	db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: mocks.evaluation }) }) }) }) },
}));
vi.mock("../ai/generate-json", () => ({ generateJson: mocks.generateJson }));
vi.mock("../ai/resolve-model", () => ({ resolveModelForFeature: mocks.resolveModel }));
vi.mock("../applications/service", () => ({ applicationService: mocks.application }));
vi.mock("../resume/service", () => ({ resumeService: mocks.resume }));
vi.mock("../evaluations/service", () => ({ evaluationsService: { getCareerProfile: async () => null } }));
vi.mock("./service", () => ({ tailoringService: mocks.tailoring }));

const { runTailoring, discardTailoringRun } = await import("./pipeline");
const input = { applicationId: "app", userId: "user", locale: "en-US" };
const source = {
	id: "source",
	name: "My resume",
	tags: [],
	isLocked: false,
	data: structuredClone(defaultResumeData),
	updatedAt: new Date("2026-01-01"),
};
const jd = "We are hiring a software engineer to build reliable applications and work with customers.";
const previous = {
	id: "previous",
	status: "complete",
	tailoredResumeId: "copy",
	sourceResumeId: "source",
	evaluationId: null,
	jdArchived: jd,
	version: 1,
	factGateReport: null,
	createdAt: new Date("2026-02-01"),
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.application.getById.mockResolvedValue({
		id: "app",
		resumeId: "source",
		jobDescription: jd,
		company: "Acme",
		role: "Engineer",
	});
	mocks.resume.getById.mockResolvedValue(source);
	mocks.resume.create.mockResolvedValue("new-copy");
	mocks.evaluation.mockResolvedValue([]);
	mocks.tailoring.latestForApplication.mockResolvedValue(null);
	mocks.tailoring.update.mockResolvedValue(undefined);
	mocks.tailoring.create.mockResolvedValue({ id: "run", version: 2 });
	mocks.resolveModel.mockResolvedValue({ model: {} });
	mocks.generateJson.mockResolvedValue({ changes: [], operations: [] });
});

describe("tailoring destinations", () => {
	it("creates a separate copy by default", async () => {
		const result = await runTailoring(input);
		expect(result.resumeId).toBe("new-copy");
		expect(mocks.resume.create).toHaveBeenCalledOnce();
		expect(mocks.resume.patch).not.toHaveBeenCalled();
	});

	it("patches the currently linked resume with a concurrency guard and recovery snapshot", async () => {
		mocks.tailoring.latestForApplication.mockResolvedValue(previous);
		mocks.application.getById.mockResolvedValue({
			resumeId: "copy",
			jobDescription: jd,
			company: "Acme",
			role: "Engineer",
		});
		mocks.resume.getById.mockResolvedValue({ ...source, id: "copy" });
		const result = await runTailoring({ ...input, updateInPlace: true });
		expect(mocks.resume.getById).toHaveBeenCalledWith({ id: "copy", userId: "user" });
		expect(mocks.resume.patch).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "copy",
				expectedUpdatedAt: source.updatedAt,
				beforeVersionLabel: "Before tailoring run",
			}),
		);
		expect(mocks.resume.create).not.toHaveBeenCalled();
		expect(result).toMatchObject({ resumeId: "copy", name: source.name, updatedInPlace: true, reused: false });
	});

	it("rejects locked in-place destinations before invoking the model", async () => {
		mocks.resume.getById.mockResolvedValue({ ...source, isLocked: true });
		await expect(runTailoring({ ...input, updateInPlace: true })).rejects.toMatchObject({ code: "RESUME_LOCKED" });
		expect(mocks.generateJson).not.toHaveBeenCalled();
	});

	it("records a failed run when a concurrent edit prevents the patch", async () => {
		mocks.resume.patch.mockRejectedValue(new Error("The resume changed"));
		await expect(runTailoring({ ...input, updateInPlace: true })).rejects.toThrow("The resume changed");
		expect(mocks.resume.create).not.toHaveBeenCalled();
		expect(mocks.tailoring.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
	});

	it("protects in-place updates when discarding an older run that created the copy", async () => {
		mocks.tailoring.getById.mockResolvedValue(previous);
		mocks.tailoring.findByTailoredResume.mockResolvedValue({ ...previous, sourceResumeId: "copy" });
		await expect(discardTailoringRun({ id: "previous", userId: "user" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.resume.delete).not.toHaveBeenCalled();
	});

	it("never deletes an in-place resume through discard", async () => {
		mocks.tailoring.getById.mockResolvedValue({ ...previous, sourceResumeId: "copy" });
		await expect(discardTailoringRun({ id: "previous", userId: "user" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.resume.delete).not.toHaveBeenCalled();
	});
});

describe("evaluation context", () => {
	it("includes gaps, mitigations, evidence and recommendations, bypassing reuse for a newer evaluation", async () => {
		mocks.tailoring.latestForApplication.mockResolvedValue(previous);
		const evaluation = {
			id: "new-evaluation",
			resumeId: "source",
			jdArchived: jd,
			score: 3.5,
			requirements: [
				{ requirement: "Leadership", importance: "high", match: "partial", evidence: "Mentored teammates" },
			],
			blocks: {
				gaps: [{ requirement: "Leadership", risk: "Unclear scope", mitigation: "Highlight mentoring" }],
				customizationPlan: [{ area: "Experience", recommendation: "Lead with mentoring" }],
				levelStrategy: { positioning: "Hands-on lead" },
				topStrengths: ["Customer focus"],
			},
			skillGap: { gap: ["Kubernetes"] },
		};
		mocks.evaluation.mockResolvedValue([evaluation]);
		await runTailoring(input);
		const prompt = mocks.generateJson.mock.calls[0]?.[1].prompt;
		for (const text of [
			"Unclear scope",
			"Highlight mentoring",
			"Lead with mentoring",
			"Mentored teammates",
			"Hands-on lead",
			"Customer focus",
			"Kubernetes",
		]) {
			expect(prompt).toContain(text);
		}
		expect(mocks.tailoring.create).toHaveBeenCalledWith(expect.objectContaining({ evaluationId: "new-evaluation" }));
	});

	it("regenerates after an evaluation is retried under the same ID", async () => {
		mocks.tailoring.latestForApplication.mockResolvedValue({ ...previous, evaluationId: "evaluation" });
		mocks.evaluation.mockResolvedValue([{ id: "evaluation", updatedAt: new Date("2026-03-01") }]);
		const result = await runTailoring(input);
		expect(result.reused).toBe(false);
		expect(mocks.generateJson).toHaveBeenCalledOnce();
		expect(mocks.tailoring.create).toHaveBeenCalledWith(
			expect.objectContaining({
				reuseDecision: expect.objectContaining({ decision: "regenerate" }),
			}),
		);
	});

	it("still tailors without an evaluation", async () => {
		await runTailoring(input);
		expect(mocks.generateJson.mock.calls[0]?.[1].prompt).not.toContain("LATEST COMPLETED EVALUATION");
	});

	it("preserves evaluation provenance when reusing a copy", async () => {
		mocks.tailoring.latestForApplication.mockResolvedValue({ ...previous, evaluationId: "evaluation" });
		mocks.evaluation.mockResolvedValue([{ id: "evaluation" }]);
		const result = await runTailoring(input);
		expect(result.reused).toBe(true);
		expect(mocks.generateJson).not.toHaveBeenCalled();
		expect(mocks.tailoring.create).toHaveBeenCalledWith(expect.objectContaining({ evaluationId: "evaluation" }));
	});
});
