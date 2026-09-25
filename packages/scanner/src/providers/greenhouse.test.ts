import type { FetchContext } from "../types";
import { describe, expect, it } from "vitest";
import { buildOfficeMap, greenhouse, isWorkModelOnly, officesUrlFor } from "./greenhouse";

const LIST_URL = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";
const OFFICES_URL = "https://boards-api.greenhouse.io/v1/boards/acme/offices";

/** JSON-route fake context: URL → fixture, recording every URL fetched. */
function makeCtx(routes: Record<string, unknown>) {
	const calls: string[] = [];
	const ctx: FetchContext = {
		fetchJson: (url) => {
			calls.push(url);
			const fixture = routes[url];
			return fixture === undefined ? Promise.reject(new Error(`no fixture for ${url}`)) : Promise.resolve(fixture);
		},
		fetchText: () => Promise.reject(new Error("unexpected fetchText")),
		sleep: () => Promise.resolve(),
	};
	return { ctx, calls };
}

describe("greenhouse.detect", () => {
	it("claims boards.greenhouse.io and job-boards(.eu).greenhouse.io careers URLs", () => {
		for (const url of [
			"https://boards.greenhouse.io/acme",
			"https://job-boards.greenhouse.io/acme",
			"https://job-boards.eu.greenhouse.io/acme",
		]) {
			expect(greenhouse.detect({ company: "Acme", url })?.url, url).toBe(
				"https://boards-api.greenhouse.io/v1/boards/acme/jobs",
			);
		}
	});

	it("prefers an explicit api URL and validates its host", () => {
		const api = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";
		expect(greenhouse.detect({ company: "Acme", url: "https://acme.com/careers", api })?.url).toBe(api);
		// An api URL on a foreign host must not be claimed (assert throws → detect null).
		expect(
			greenhouse.detect({ company: "Acme", url: "https://acme.com/careers", api: "https://evil.com/jobs" }),
		).toBeNull();
	});

	it("ignores unrelated URLs, including greenhouse-lookalike paths on foreign hosts", () => {
		expect(greenhouse.detect({ company: "Acme", url: "https://acme.com/careers" })).toBeNull();
		expect(greenhouse.detect({ company: "Acme", url: "https://evil.com/boards.greenhouse.io/acme" })).toBeNull();
	});
});

describe("isWorkModelOnly / officesUrlFor", () => {
	it("flags work-model-only strings and leaves geographic ones alone", () => {
		expect(isWorkModelOnly("Hybrid")).toBe(true);
		expect(isWorkModelOnly("Distributed; Hybrid")).toBe(true);
		expect(isWorkModelOnly("Hybrid - London")).toBe(false);
		expect(isWorkModelOnly("Remote (Canada)")).toBe(false);
		expect(isWorkModelOnly("")).toBe(false);
		expect(isWorkModelOnly(undefined)).toBe(false);
	});

	it("derives the offices endpoint only from a /jobs board URL", () => {
		expect(officesUrlFor("https://boards-api.greenhouse.io/v1/boards/acme/jobs")).toBe(OFFICES_URL);
		expect(officesUrlFor("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true")).toBe(OFFICES_URL);
		expect(officesUrlFor("https://boards-api.greenhouse.io/v1/boards/acme/jobs/123")).toBeNull();
	});
});

describe("greenhouse.fetch", () => {
	it("maps the jobs payload, decoding double-encoded bodies and dropping url-less rows", async () => {
		const { ctx, calls } = makeCtx({
			[LIST_URL]: {
				jobs: [
					{
						id: 1,
						title: "Platform Engineer",
						absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
						location: { name: "Berlin" },
						content: "&lt;p&gt;Build &amp;amp; run the pipeline&lt;/p&gt;",
						first_published: "2026-01-05T00:00:00Z",
					},
					{ id: 2, title: "No URL row", location: { name: "Nowhere" } },
				],
			},
		});
		const jobs = await greenhouse.fetch({ company: "Acme", url: "https://boards.greenhouse.io/acme" }, ctx);
		expect(jobs).toEqual([
			{
				title: "Platform Engineer",
				url: "https://boards.greenhouse.io/acme/jobs/1",
				company: "Acme",
				location: "Berlin",
				description: "Build & run the pipeline",
				postedAt: Date.parse("2026-01-05T00:00:00Z"),
			},
		]);
		// One request, with content=true — no per-job fetches, no /offices for a board with real cities.
		expect(calls).toEqual([LIST_URL]);
	});

	it("enriches work-model-only locations from /offices, sorted for stability", async () => {
		const { ctx, calls } = makeCtx({
			[LIST_URL]: {
				jobs: [
					{
						id: 7,
						title: "SRE",
						absolute_url: "https://boards.greenhouse.io/acme/jobs/7",
						location: { name: "Hybrid" },
					},
				],
			},
			[OFFICES_URL]: {
				offices: [
					{ name: "London", departments: [{ jobs: [{ id: 7 }] }] },
					{ name: "Berlin", departments: [{ jobs: [{ id: 7 }] }], children: [] },
				],
			},
		});
		const jobs = await greenhouse.fetch({ company: "Acme", url: "https://boards.greenhouse.io/acme" }, ctx);
		expect(jobs[0]?.location).toBe("Hybrid · Berlin · London");
		expect(calls).toEqual([LIST_URL, OFFICES_URL]);
	});

	it("keeps the bare work-model location when the /offices lookup fails", async () => {
		const { ctx } = makeCtx({
			[LIST_URL]: {
				jobs: [
					{
						id: 7,
						title: "SRE",
						absolute_url: "https://boards.greenhouse.io/acme/jobs/7",
						location: { name: "Hybrid" },
					},
				],
			},
			// no OFFICES_URL fixture → the enrichment fetch rejects
		});
		const jobs = await greenhouse.fetch({ company: "Acme", url: "https://boards.greenhouse.io/acme" }, ctx);
		expect(jobs[0]?.location).toBe("Hybrid");
	});

	it("walks nested office children when building the office map", () => {
		const map = buildOfficeMap({
			offices: [{ name: "EMEA", departments: [], children: [{ name: "Paris", departments: [{ jobs: [{ id: 9 }] }] }] }],
		});
		expect(map.get(9)).toEqual(new Set(["Paris"]));
	});

	it("throws for an entry it cannot derive an API URL for", async () => {
		const { ctx } = makeCtx({});
		await expect(greenhouse.fetch({ company: "Acme", url: "https://acme.com/careers" }, ctx)).rejects.toThrow(
			/cannot derive API URL/,
		);
	});
});
