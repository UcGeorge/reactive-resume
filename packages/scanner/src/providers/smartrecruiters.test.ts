import type { FetchContext } from "../types";
import { describe, expect, it } from "vitest";
import { parseSmartRecruitersResponse, SR_PAGE_SIZE, smartrecruiters } from "./smartrecruiters";

const pageUrl = (offset: number): string =>
	`https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;

function makeCtx(routes: Record<string, unknown>, maxPages?: number) {
	const calls: string[] = [];
	const ctx: FetchContext = {
		fetchJson: (url) => {
			calls.push(url);
			const fixture = routes[url];
			return fixture === undefined ? Promise.reject(new Error(`no fixture for ${url}`)) : Promise.resolve(fixture);
		},
		fetchText: () => Promise.reject(new Error("unexpected fetchText")),
		sleep: () => Promise.resolve(),
		...(maxPages === undefined ? {} : { maxPages }),
	};
	return { ctx, calls };
}

const fullPage = {
	content: Array.from({ length: SR_PAGE_SIZE }, (_, index) => ({
		id: String(index),
		name: `Role ${index}`,
		ref: `https://api.smartrecruiters.com/v1/companies/Acme/postings/${index}`,
		location: { city: "Berlin", country: "Germany" },
	})),
};

describe("smartrecruiters.detect", () => {
	it("claims careers/jobs.smartrecruiters.com URLs", () => {
		expect(smartrecruiters.detect({ company: "Acme", url: "https://careers.smartrecruiters.com/Acme" })?.url).toBe(
			pageUrl(0),
		);
		expect(smartrecruiters.detect({ company: "Acme", url: "https://jobs.smartrecruiters.com/Acme" })?.url).toBe(
			pageUrl(0),
		);
	});

	it("lets an explicit api entry pin the slug for a branded careers domain", () => {
		expect(
			smartrecruiters.detect({
				company: "Acme",
				url: "https://jobs.acme-branded.com",
				api: "https://careers.smartrecruiters.com/Acme",
			})?.url,
		).toBe(pageUrl(0));
	});

	it("ignores unrelated URLs", () => {
		expect(smartrecruiters.detect({ company: "Acme", url: "https://acme.com/careers" })).toBeNull();
		expect(smartrecruiters.detect({ company: "Acme", url: "https://careers.smartrecruiters.com/" })).toBeNull();
	});
});

describe("parseSmartRecruitersResponse", () => {
	it("rewrites the api ref to the public posting URL and assembles the location", () => {
		expect(
			parseSmartRecruitersResponse(
				{
					content: [
						{
							id: "744",
							name: "Data Engineer",
							ref: "https://api.smartrecruiters.com/v1/companies/Acme/postings/744",
							location: { city: "Munich", country: "Germany", remote: true },
						},
					],
				},
				"Acme",
			),
		).toEqual([
			{
				title: "Data Engineer",
				url: "https://jobs.smartrecruiters.com/Acme/744-data-engineer",
				company: "Acme",
				location: "Munich, Germany, Remote",
			},
		]);
	});

	it("prefers fullLocation over assembled parts", () => {
		const jobs = parseSmartRecruitersResponse(
			{ content: [{ id: "1", name: "Role", location: { fullLocation: "Berlin, Germany", city: "ignored" } }] },
			"Acme",
		);
		expect(jobs[0]?.location).toBe("Berlin, Germany");
	});

	it("synthesises the public URL from the company name when ref is missing or untrusted", () => {
		const jobs = parseSmartRecruitersResponse(
			{
				content: [
					{ id: "99", name: "Ops Lead" },
					{ id: "77", name: "Evil Ref", ref: "https://evil.example.com/v1/companies/Acme/postings/77" },
				],
			},
			"Acme Corp",
		);
		expect(jobs[0]?.url).toBe("https://jobs.smartrecruiters.com/acme-corp/99-ops-lead");
		expect(jobs[1]?.url).toBe("https://jobs.smartrecruiters.com/acme-corp/77-evil-ref");
	});

	it("returns [] for a payload without content", () => {
		expect(parseSmartRecruitersResponse({ message: "nope" }, "Acme")).toEqual([]);
		expect(parseSmartRecruitersResponse(null, "Acme")).toEqual([]);
	});
});

describe("smartrecruiters.fetch", () => {
	it("pages until a short page, at SR_PAGE_SIZE per request", async () => {
		const { ctx, calls } = makeCtx({
			[pageUrl(0)]: fullPage,
			[pageUrl(SR_PAGE_SIZE)]: { content: [{ id: "last", name: "Final Role" }] },
		});
		const jobs = await smartrecruiters.fetch({ company: "Acme", url: "https://careers.smartrecruiters.com/Acme" }, ctx);
		expect(jobs).toHaveLength(SR_PAGE_SIZE + 1);
		expect(calls).toEqual([pageUrl(0), pageUrl(SR_PAGE_SIZE)]);
	});

	it("stops on an empty page", async () => {
		const { ctx, calls } = makeCtx({ [pageUrl(0)]: fullPage, [pageUrl(SR_PAGE_SIZE)]: { content: [] } });
		const jobs = await smartrecruiters.fetch({ company: "Acme", url: "https://careers.smartrecruiters.com/Acme" }, ctx);
		expect(jobs).toHaveLength(SR_PAGE_SIZE);
		expect(calls).toHaveLength(2);
	});

	it("honors the ctx.maxPages probe hint and stops after one page", async () => {
		const { ctx, calls } = makeCtx({ [pageUrl(0)]: fullPage }, 1);
		const jobs = await smartrecruiters.fetch({ company: "Acme", url: "https://careers.smartrecruiters.com/Acme" }, ctx);
		expect(jobs).toHaveLength(SR_PAGE_SIZE);
		expect(calls).toEqual([pageUrl(0)]);
	});

	it("throws for an entry it cannot derive a slug for", async () => {
		const { ctx } = makeCtx({});
		await expect(smartrecruiters.fetch({ company: "Acme", url: "https://acme.com/careers" }, ctx)).rejects.toThrow(
			/cannot derive API URL/,
		);
	});
});
