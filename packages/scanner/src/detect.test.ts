import type { PortalEntry, ScanProvider } from "./types";
import { describe, expect, it } from "vitest";
import { detectProvider } from "./detect";

const entry = (overrides: Partial<PortalEntry>): PortalEntry => ({
	company: "Acme",
	url: "https://acme.com/careers",
	...overrides,
});

describe("detectProvider", () => {
	it("routes each wave-1 ATS by its careers URL shape", () => {
		const cases: [string, string][] = [
			["https://boards.greenhouse.io/acme", "greenhouse"],
			["https://jobs.ashbyhq.com/acme", "ashby"],
			["https://jobs.lever.co/acme", "lever"],
			["https://apply.workable.com/acme", "workable"],
			["https://careers.smartrecruiters.com/Acme", "smartrecruiters"],
		];
		for (const [url, expected] of cases) {
			expect(detectProvider(entry({ url }))?.provider.id, url).toBe(expected);
		}
	});

	it("returns the API URL the winning provider's claim resolved to", () => {
		expect(detectProvider(entry({ url: "https://jobs.lever.co/acme" }))?.url).toBe(
			"https://api.lever.co/v0/postings/acme",
		);
	});

	it("returns null when nothing claims the entry", () => {
		expect(detectProvider(entry({}))).toBeNull();
	});

	it("honors an explicit provider id before any detection", () => {
		// The URL would auto-detect as greenhouse; the explicit id must win anyway.
		const match = detectProvider(entry({ url: "https://boards.greenhouse.io/acme", provider: "lever" }));
		expect(match?.provider.id).toBe("lever");
		// lever.detect can't derive an API URL from a greenhouse page, so the claim URL falls
		// back to what the entry names.
		expect(match?.url).toBe("https://boards.greenhouse.io/acme");
	});

	it("degrades an unknown explicit provider id to null instead of misrouting", () => {
		expect(detectProvider(entry({ url: "https://boards.greenhouse.io/acme", provider: "workday" }))).toBeNull();
	});

	it("treats a throwing detect() as no claim and keeps the chain alive", () => {
		const exploding: ScanProvider = {
			id: "exploding",
			detect: () => {
				throw new Error("boom");
			},
			fetch: () => Promise.resolve([]),
		};
		const claiming: ScanProvider = {
			id: "claiming",
			detect: () => ({ url: "https://api.example.com/jobs" }),
			fetch: () => Promise.resolve([]),
		};
		const match = detectProvider(entry({}), [exploding, claiming]);
		expect(match?.provider.id).toBe("claiming");
		expect(match?.url).toBe("https://api.example.com/jobs");
	});
});
