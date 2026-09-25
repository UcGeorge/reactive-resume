import type { FetchContext, ScanFetchInit } from "../types";
import { describe, expect, it } from "vitest";
import { lever } from "./lever";

const API_URL = "https://api.lever.co/v0/postings/acme";

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

describe("lever.detect", () => {
	it("claims jobs.lever.co and routes the EU host to the EU API", () => {
		expect(lever.detect({ company: "Acme", url: "https://jobs.lever.co/acme" })?.url).toBe(API_URL);
		expect(lever.detect({ company: "Acme", url: "https://jobs.eu.lever.co/acme" })?.url).toBe(
			"https://api.eu.lever.co/v0/postings/acme",
		);
	});

	it("prefers an explicit api URL pinned to the Lever API hosts", () => {
		expect(lever.detect({ company: "Acme", url: "https://acme.com/careers", api: API_URL })?.url).toBe(API_URL);
		expect(
			lever.detect({ company: "Acme", url: "https://acme.com/careers", api: "https://evil.com/v0/postings/acme" }),
		).toBeNull();
	});

	it("ignores unrelated URLs and slug-less board roots", () => {
		expect(lever.detect({ company: "Acme", url: "https://acme.com/careers" })).toBeNull();
		expect(lever.detect({ company: "Acme", url: "https://jobs.lever.co/" })).toBeNull();
	});
});

describe("lever.fetch", () => {
	it("maps postings, merging allLocations into the location string case-insensitively", async () => {
		const { ctx, calls } = makeCtx({
			[API_URL]: [
				{
					text: "Backend Engineer",
					hostedUrl: "https://jobs.lever.co/acme/uuid-1",
					categories: { location: "Barcelona", allLocations: ["barcelona", "Montevideo"] },
					descriptionPlain: "Own the API surface.",
					createdAt: 1_760_000_000_000,
				},
				{ text: "No extras", hostedUrl: "https://jobs.lever.co/acme/uuid-2", categories: {} },
			],
		});
		const jobs = await lever.fetch({ company: "Acme", url: "https://jobs.lever.co/acme" }, ctx);
		expect(jobs).toEqual([
			{
				title: "Backend Engineer",
				url: "https://jobs.lever.co/acme/uuid-1",
				company: "Acme",
				location: "Barcelona; Montevideo",
				description: "Own the API surface.",
				postedAt: 1_760_000_000_000,
			},
			{
				title: "No extras",
				url: "https://jobs.lever.co/acme/uuid-2",
				company: "Acme",
				location: "",
				description: "",
			},
		]);
		// One-response board-wide feed: bespoke timeout, pinned hosts.
		expect(calls[0]?.init?.timeoutMs).toBe(30_000);
		expect(calls[0]?.init?.allowedHosts).toEqual(["api.lever.co", "api.eu.lever.co"]);
	});

	it("returns [] for a non-array payload instead of throwing", async () => {
		const { ctx } = makeCtx({ [API_URL]: { error: "board disabled" } });
		await expect(lever.fetch({ company: "Acme", url: "https://jobs.lever.co/acme" }, ctx)).resolves.toEqual([]);
	});
});
