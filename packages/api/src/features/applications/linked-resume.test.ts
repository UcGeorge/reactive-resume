import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB layer; under test is the batching and null handling, not SQL.
const dbMock = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/db/schema", () => ({ resume: { id: "id", name: "name", userId: "user_id" } }));
vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => a,
	eq: (...a: unknown[]) => a,
	inArray: (...a: unknown[]) => a,
}));

const { withResumeName, withResumeNames } = await import("./linked-resume");

const selectReturning = (rows: unknown[]) => ({ from: () => ({ where: () => Promise.resolve(rows) }) });

beforeEach(() => {
	dbMock.select.mockReset();
});

describe("withResumeNames", () => {
	it("attaches names with one lookup; unlinked or deleted resumes resolve to null", async () => {
		dbMock.select.mockReturnValue(selectReturning([{ id: "r1", name: "Backend CV" }]));
		const rows = await withResumeNames("user-1", [
			{ id: "a", resumeId: "r1" },
			{ id: "b", resumeId: null },
			{ id: "c", resumeId: "r-deleted" },
			{ id: "d", resumeId: "r1" },
		]);
		expect(rows.map((row) => row.resumeName)).toEqual(["Backend CV", null, null, "Backend CV"]);
		expect(dbMock.select).toHaveBeenCalledTimes(1);
	});

	it("skips the query when no row links a resume", async () => {
		const rows = await withResumeNames("user-1", [{ id: "a", resumeId: null }]);
		expect(rows).toEqual([{ id: "a", resumeId: null, resumeName: null }]);
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it("resolves a single row", async () => {
		dbMock.select.mockReturnValue(selectReturning([{ id: "r1", name: "Backend CV" }]));
		await expect(withResumeName("user-1", { id: "a", resumeId: "r1" })).resolves.toEqual({
			id: "a",
			resumeId: "r1",
			resumeName: "Backend CV",
		});
	});
});
