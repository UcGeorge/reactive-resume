import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: { CRON_SECRET: undefined as string | undefined },
	runScheduledScans: vi.fn(),
	runFollowUpsDaily: vi.fn(),
}));

vi.mock("@reactive-resume/env/server", () => ({ env: mocks.env }));
vi.mock("@reactive-resume/api/features/jobs/scheduled", () => ({
	runScheduledScans: mocks.runScheduledScans,
	runFollowUpsDaily: mocks.runFollowUpsDaily,
}));

function request(bearer?: string) {
	return new Request("https://resume.test/api/cron/scanner", {
		headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
	});
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.env.CRON_SECRET = undefined;
});

describe("cron endpoints", () => {
	it("refuses every request when CRON_SECRET is not configured", async () => {
		const { handleCronFollowUps, handleCronScanner } = await import("./cron");
		expect((await handleCronScanner(request())).status).toBe(401);
		expect((await handleCronFollowUps(request("anything"))).status).toBe(401);
		expect(mocks.runScheduledScans).not.toHaveBeenCalled();
		expect(mocks.runFollowUpsDaily).not.toHaveBeenCalled();
	});

	it("refuses a wrong or missing bearer token", async () => {
		mocks.env.CRON_SECRET = "cron-secret-value-long";
		const { handleCronScanner } = await import("./cron");
		expect((await handleCronScanner(request())).status).toBe(401);
		expect((await handleCronScanner(request("wrong"))).status).toBe(401);
		expect(mocks.runScheduledScans).not.toHaveBeenCalled();
	});

	it("runs the scheduled work with the correct bearer token", async () => {
		mocks.env.CRON_SECRET = "cron-secret-value-long";
		mocks.runScheduledScans.mockResolvedValue({ users: 3 });
		mocks.runFollowUpsDaily.mockResolvedValue(undefined);
		const { handleCronFollowUps, handleCronScanner } = await import("./cron");

		const scan = await handleCronScanner(request("cron-secret-value-long"));
		expect(scan.status).toBe(200);
		expect(await scan.json()).toEqual({ ok: true, users: 3 });

		const followUps = await handleCronFollowUps(request("cron-secret-value-long"));
		expect(followUps.status).toBe(200);
		expect(mocks.runFollowUpsDaily).toHaveBeenCalledTimes(1);
	});
});
