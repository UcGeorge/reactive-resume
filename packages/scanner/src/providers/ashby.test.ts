import type { FetchContext, ScanFetchInit } from "../types";
import { describe, expect, it } from "vitest";
import { ashby, parseCompensation } from "./ashby";

const API_URL = "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true";

function makeCtx(routes: Record<string, unknown>) {
	const calls: { url: string; init: ScanFetchInit | undefined }[] = [];
	const ctx: FetchContext = {
		fetchJson: (url, init) => {
			calls.push({ url, init });
			const fixture = routes[url];
			return fixture === undefined ? Promise.reject(new Error(`no fixture for ${url}`)) : Promise.resolve(fixture);
		},
		fetchText: () => Promise.reject(new Error("unexpected fetchText")),
		sleep: () => Promise.resolve(),
	};
	return { ctx, calls };
}

describe("ashby.detect", () => {
	it("claims jobs.ashbyhq.com board URLs", () => {
		expect(ashby.detect({ company: "Acme", url: "https://jobs.ashbyhq.com/acme" })?.url).toBe(API_URL);
	});

	it("prefers an explicit api URL pinned to api.ashbyhq.com", () => {
		const api = "https://api.ashbyhq.com/posting-api/job-board/acme";
		expect(ashby.detect({ company: "Acme", url: "https://acme.com/careers", api })?.url).toBe(api);
		expect(
			ashby.detect({ company: "Acme", url: "https://acme.com/careers", api: "https://evil.com/board" }),
		).toBeNull();
	});

	it("ignores unrelated URLs", () => {
		expect(ashby.detect({ company: "Acme", url: "https://acme.com/careers" })).toBeNull();
		expect(ashby.detect({ company: "Acme", url: "https://jobs.ashbyhq.com/" })).toBeNull();
	});
});

describe("parseCompensation", () => {
	it("reads the nested tier shape, ignoring equity/bonus components", () => {
		expect(
			parseCompensation({
				compensation: {
					compensationTiers: [
						{
							components: [
								{
									compensationType: "Salary",
									interval: "1 YEAR",
									minValue: 150_000,
									maxValue: 200_000,
									currencyCode: "usd",
								},
								{ compensationType: "EquityPercentage", summary: "0.05% – 0.1%" },
							],
						},
					],
				},
			}),
		).toEqual({ min: 150_000, max: 200_000, currency: "USD" });
	});

	it("annualizes non-yearly intervals", () => {
		expect(
			parseCompensation({
				compensation: {
					compensationTiers: [
						{
							components: [{ compensationType: "Salary", interval: "1 MONTH", minValue: 10_000, currencyCode: "EUR" }],
						},
					],
				},
			}),
		).toEqual({ min: 120_000, max: 120_000, currency: "EUR" });
	});

	it("skips a wider salary component whose interval is unreadable, instead of failing", () => {
		expect(
			parseCompensation({
				compensation: {
					compensationTiers: [
						{
							components: [
								{ compensationType: "Salary", minValue: 0, maxValue: 500_000 }, // no interval — unusable
								{ compensationType: "Salary", interval: "1 YEAR", minValue: 100_000, maxValue: 140_000 },
							],
						},
					],
				},
			}),
		).toEqual({ min: 100_000, max: 140_000, currency: "" });
	});

	it("accepts the legacy flat shape with a default yearly interval", () => {
		expect(parseCompensation({ compensation: { minValue: 90_000, maxValue: 120_000, currency: "gbp" } })).toEqual({
			min: 90_000,
			max: 120_000,
			currency: "GBP",
		});
	});

	it("returns null when there is nothing readable", () => {
		expect(parseCompensation({})).toBeNull();
		expect(parseCompensation({ compensation: {} })).toBeNull();
		expect(
			parseCompensation({
				compensation: { compensationTiers: [{ components: [{ compensationType: "EquityPercentage", minValue: 1 }] }] },
			}),
		).toBeNull();
		// A hostile interval must not resolve through the prototype chain.
		expect(parseCompensation({ compensation: { minValue: 1, interval: "constructor" } })).toBeNull();
	});
});

describe("ashby.fetch", () => {
	it("maps jobs, folding secondary locations and the remote work model into location", async () => {
		const { ctx, calls } = makeCtx({
			[API_URL]: {
				jobs: [
					{
						title: "Staff Engineer",
						jobUrl: "https://jobs.ashbyhq.com/acme/123",
						location: "San Francisco",
						secondaryLocations: [
							{
								location: "Toronto",
								address: { postalAddress: { addressLocality: "Toronto", addressCountry: "Canada" } },
							},
						],
						workplaceType: "Remote",
						isRemote: false,
						descriptionPlain: "Build things.",
						publishedAt: "2026-02-01T00:00:00Z",
						compensation: {
							compensationTiers: [
								{
									components: [
										{
											compensationType: "Salary",
											interval: "1 YEAR",
											minValue: 150_000,
											maxValue: 200_000,
											currencyCode: "USD",
										},
									],
								},
							],
						},
					},
				],
			},
		});
		const jobs = await ashby.fetch({ company: "Acme", url: "https://jobs.ashbyhq.com/acme" }, ctx);
		expect(jobs).toEqual([
			{
				title: "Staff Engineer",
				url: "https://jobs.ashbyhq.com/acme/123",
				company: "Acme",
				location: "San Francisco · Toronto · Canada · Remote",
				description: "Build things.",
				salary: { min: 150_000, max: 200_000, currency: "USD" },
				postedAt: Date.parse("2026-02-01T00:00:00Z"),
			},
		]);
		// The Ashby latency floor demands a longer-than-default timeout on the wire call.
		expect(calls[0]?.init?.timeoutMs).toBe(30_000);
		expect(calls[0]?.init?.allowedHosts).toEqual(["api.ashbyhq.com"]);
	});

	it("does not label an office-anchored hybrid role Remote on isRemote alone", async () => {
		const { ctx } = makeCtx({
			[API_URL]: {
				jobs: [
					{
						title: "Hybrid role",
						jobUrl: "https://jobs.ashbyhq.com/acme/9",
						location: "Berlin",
						workplaceType: "Hybrid",
						isRemote: true,
					},
				],
			},
		});
		const jobs = await ashby.fetch({ company: "Acme", url: "https://jobs.ashbyhq.com/acme" }, ctx);
		expect(jobs[0]?.location).toBe("Berlin");
		expect(jobs[0]?.salary).toBeUndefined();
	});

	it("tolerates an empty board", async () => {
		const { ctx } = makeCtx({ [API_URL]: { jobs: [] } });
		await expect(ashby.fetch({ company: "Acme", url: "https://jobs.ashbyhq.com/acme" }, ctx)).resolves.toEqual([]);
	});
});
