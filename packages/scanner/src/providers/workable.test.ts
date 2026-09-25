import type { FetchContext } from "../types";
import { describe, expect, it } from "vitest";
import { parseWorkableMarkdown, parseWorkableWidget, workable } from "./workable";

const WIDGET_URL = "https://apply.workable.com/api/v1/widget/accounts/acme?details=true";
const FEED_URL = "https://apply.workable.com/acme/jobs.md";

function makeCtx(jsonRoutes: Record<string, unknown>, textRoutes: Record<string, string> = {}) {
	const calls: string[] = [];
	const ctx: FetchContext = {
		fetchJson: (url) => {
			calls.push(url);
			const fixture = jsonRoutes[url];
			return fixture === undefined ? Promise.reject(new Error(`no fixture for ${url}`)) : Promise.resolve(fixture);
		},
		fetchText: (url) => {
			calls.push(url);
			const fixture = textRoutes[url];
			return fixture === undefined ? Promise.reject(new Error(`no fixture for ${url}`)) : Promise.resolve(fixture);
		},
		sleep: () => Promise.resolve(),
	};
	return { ctx, calls };
}

describe("workable.detect", () => {
	it("claims apply.workable.com account URLs", () => {
		expect(workable.detect({ company: "Acme", url: "https://apply.workable.com/acme" })?.url).toBe(WIDGET_URL);
		expect(workable.detect({ company: "Acme", url: "https://apply.workable.com/acme/j/ABC/" })?.url).toBe(WIDGET_URL);
	});

	it("rejects other hosts, slug-less roots, and slugs outside the safe charset", () => {
		expect(workable.detect({ company: "Acme", url: "https://acme.com/careers" })).toBeNull();
		expect(workable.detect({ company: "Acme", url: "https://apply.workable.com/" })).toBeNull();
		// An encoded slash cannot smuggle extra path segments into the API URL.
		expect(workable.detect({ company: "Acme", url: "https://apply.workable.com/acme%2Fetc" })).toBeNull();
		expect(workable.detect({ company: "Acme", url: "http://apply.workable.com/acme" })).toBeNull();
	});
});

describe("parseWorkableWidget", () => {
	const payload = {
		jobs: [
			{
				title: "Product Designer",
				shortlink: "https://apply.workable.com/j/ABC123",
				url: "https://apply.workable.com/acme/j/ABC123/",
				city: "Lisbon",
				country: "Portugal",
				telecommuting: false,
				description: "<p>Design &amp; ship.</p><ul><li>Figma</li></ul>",
				published_on: "2026-03-01",
			},
			{ title: "Remote QA", shortlink: "https://apply.workable.com/j/DEF456", telecommuting: true },
			// Duplicate URL of the first row — dropped.
			{ title: "Product Designer (dup)", shortlink: "https://apply.workable.com/j/ABC123" },
			// Off-domain and non-HTTPS links — dropped, not emitted.
			{ title: "Evil", shortlink: "https://evil.example.com/x", url: "http://apply.workable.com/x" },
			{ title: "   ", shortlink: "https://apply.workable.com/j/GHI789" },
		],
	};

	it("maps titled jobs with validated URLs, plain-text descriptions and postedAt", () => {
		const jobs = parseWorkableWidget(payload, "Acme");
		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toEqual({
			title: "Product Designer",
			url: "https://apply.workable.com/j/ABC123",
			company: "Acme",
			location: "Lisbon, Portugal",
			description: "Design & ship.\n Figma",
			postedAt: Date.parse("2026-03-01"),
		});
		expect(jobs[1]).toMatchObject({ title: "Remote QA", location: "Remote" });
		expect(jobs[1]?.postedAt).toBeUndefined();
	});

	it("returns [] for a payload without a jobs array", () => {
		expect(parseWorkableWidget({ name: "Acme" }, "Acme")).toEqual([]);
		expect(parseWorkableWidget(null, "Acme")).toEqual([]);
	});
});

describe("parseWorkableMarkdown", () => {
	const feed = [
		"| Title | Department | Location | Type | Salary | Posted | Details |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		"| Support Engineer | CS | Porto, Portugal | Full-time | — | 2026-01-01 | [View](https://apply.workable.com/acme/jobs/view/123.md) |",
		"| Evil Row | CS | X | Full-time | — | 2026-01-01 | [View](https://evil.example.com/x.md) |",
		"not a table row",
	].join("\n");

	it("parses table rows, strips the .md suffix, and drops off-domain View links", () => {
		expect(parseWorkableMarkdown(feed, "Acme")).toEqual([
			{
				title: "Support Engineer",
				url: "https://apply.workable.com/acme/jobs/view/123",
				company: "Acme",
				location: "Porto, Portugal",
			},
		]);
	});
});

describe("workable.fetch", () => {
	it("prefers the widget API", async () => {
		const { ctx, calls } = makeCtx({
			[WIDGET_URL]: { jobs: [{ title: "Role", shortlink: "https://apply.workable.com/j/A1" }] },
		});
		const jobs = await workable.fetch({ company: "Acme", url: "https://apply.workable.com/acme" }, ctx);
		expect(jobs).toHaveLength(1);
		expect(calls).toEqual([WIDGET_URL]);
	});

	it("falls back to the markdown feed when the widget API fails", async () => {
		const { ctx, calls } = makeCtx(
			{}, // widget rejects
			{
				[FEED_URL]:
					"| Support Engineer | CS | Porto | Full-time | — | 2026-01-01 | [View](https://apply.workable.com/acme/jobs/view/123.md) |",
			},
		);
		const jobs = await workable.fetch({ company: "Acme", url: "https://apply.workable.com/acme" }, ctx);
		expect(jobs).toEqual([
			{
				title: "Support Engineer",
				url: "https://apply.workable.com/acme/jobs/view/123",
				company: "Acme",
				location: "Porto",
			},
		]);
		expect(calls).toEqual([WIDGET_URL, FEED_URL]);
	});

	it("falls back when the widget payload has no jobs array", async () => {
		const { ctx, calls } = makeCtx({ [WIDGET_URL]: { message: "blocked" } }, { [FEED_URL]: "no rows here" });
		await expect(workable.fetch({ company: "Acme", url: "https://apply.workable.com/acme" }, ctx)).resolves.toEqual([]);
		expect(calls).toEqual([WIDGET_URL, FEED_URL]);
	});
});
