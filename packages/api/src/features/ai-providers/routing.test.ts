import { describe, expect, it } from "vitest";
import { AI_FEATURES } from "@reactive-resume/ai/types";
import { listRouteStatuses, resolveFeatureProviderId, routeStatus } from "./routing";

function provider(id: string, overrides: Partial<{ enabled: boolean; testStatus: string; createdAt: Date }> = {}) {
	return {
		id,
		enabled: true,
		testStatus: "success",
		createdAt: new Date("2026-07-01T00:00:00Z"),
		...overrides,
	};
}

const older = provider("older", { createdAt: new Date("2026-06-01T00:00:00Z") });
const newer = provider("newer");
const broken = provider("broken", { testStatus: "failure", enabled: false });

describe("routeStatus", () => {
	it("is unset without a row, removed when the provider was deleted, ok when runnable", () => {
		expect(routeStatus(undefined, [newer])).toBe("unset");
		expect(routeStatus({ feature: "chat", aiProviderId: null }, [newer])).toBe("removed");
		expect(routeStatus({ feature: "chat", aiProviderId: "newer" }, [newer])).toBe("ok");
		expect(routeStatus({ feature: "chat", aiProviderId: "broken" }, [broken])).toBe("unavailable");
		expect(routeStatus({ feature: "chat", aiProviderId: "gone" }, [newer])).toBe("unavailable");
	});
});

describe("resolveFeatureProviderId", () => {
	it("uses the feature's own route first", () => {
		const routes = [
			{ feature: "chat", aiProviderId: "newer" },
			{ feature: "default", aiProviderId: "older" },
		];

		expect(resolveFeatureProviderId("chat", routes, [older, newer])).toEqual({
			providerId: "newer",
			source: "feature",
		});
	});

	it("falls back to the default route with a warning when the feature route cannot run", () => {
		const routes = [
			{ feature: "chat", aiProviderId: "broken" },
			{ feature: "default", aiProviderId: "older" },
		];

		expect(resolveFeatureProviderId("chat", routes, [older, broken])).toEqual({
			providerId: "older",
			source: "default",
			warning: "unavailable",
		});
	});

	it("reports a removed feature route while falling back", () => {
		const routes = [{ feature: "evaluation", aiProviderId: null }];

		expect(resolveFeatureProviderId("evaluation", routes, [newer, older])).toEqual({
			providerId: "older",
			source: "fallback",
			warning: "removed",
		});
	});

	it("falls back to the oldest runnable provider when nothing is routed", () => {
		expect(resolveFeatureProviderId("stories", [], [newer, broken, older])).toEqual({
			providerId: "older",
			source: "fallback",
		});
	});

	it("resolves the default feature through the default route only", () => {
		const routes = [{ feature: "default", aiProviderId: "newer" }];

		expect(resolveFeatureProviderId("default", routes, [older, newer])).toEqual({
			providerId: "newer",
			source: "default",
		});
	});

	it("gives null when no provider can run", () => {
		expect(resolveFeatureProviderId("chat", [{ feature: "chat", aiProviderId: "broken" }], [broken])).toEqual({
			providerId: null,
			source: "fallback",
			warning: "unavailable",
		});
	});
});

describe("listRouteStatuses", () => {
	it("returns one row per feature in declaration order with the effective provider", () => {
		const routes = [{ feature: "chat", aiProviderId: "broken" }];
		const rows = listRouteStatuses(routes, [older, broken]);

		expect(rows.map((row) => row.feature)).toEqual([...AI_FEATURES]);
		expect(rows.find((row) => row.feature === "chat")).toEqual({
			feature: "chat",
			aiProviderId: "broken",
			status: "unavailable",
			effectiveProviderId: "older",
			source: "fallback",
		});
		expect(rows.find((row) => row.feature === "import")).toMatchObject({
			aiProviderId: null,
			status: "unset",
			effectiveProviderId: "older",
		});
	});
});
