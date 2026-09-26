import { beforeEach, describe, expect, it, vi } from "vitest";

describe("background work lifetime", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("registers detached work with the configured platform hook", async () => {
		const { configureBackgroundWorkLifetime, runDetached } = await import("./lifetime");
		const waitUntil = vi.fn();
		configureBackgroundWorkLifetime(waitUntil);
		runDetached(Promise.resolve());
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
	});

	it("still runs the work, guarded, when no hook is configured", async () => {
		const { runDetached } = await import("./lifetime");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let settled = false;
		runDetached(
			Promise.resolve().then(() => {
				settled = true;
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(true);
		// A rejection must never escape as an unhandled rejection.
		runDetached(Promise.reject(new Error("boom")));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consoleError).toHaveBeenCalledTimes(1);
		consoleError.mockRestore();
	});
});
