import { describe, expect, it } from "vitest";
import { portalEntrySchema, scanJobSchema } from "./types";

describe("portalEntrySchema", () => {
	it("accepts a minimal entry and one with the optional routing fields", () => {
		expect(portalEntrySchema.parse({ company: "Acme", url: "https://boards.greenhouse.io/acme" })).toEqual({
			company: "Acme",
			url: "https://boards.greenhouse.io/acme",
		});
		expect(
			portalEntrySchema.safeParse({
				company: "Acme",
				url: "https://acme.com/careers",
				api: "https://api.lever.co/v0/postings/acme",
				provider: "lever",
			}).success,
		).toBe(true);
	});

	it("rejects an entry missing its company or url", () => {
		expect(portalEntrySchema.safeParse({ url: "https://x.example" }).success).toBe(false);
		expect(portalEntrySchema.safeParse({ company: "Acme" }).success).toBe(false);
	});
});

describe("scanJobSchema", () => {
	it("accepts a job with and without the optional fields", () => {
		expect(
			scanJobSchema.safeParse({ title: "Engineer", url: "https://x.example/1", company: "Acme", location: "" }).success,
		).toBe(true);
		expect(
			scanJobSchema.safeParse({
				title: "Engineer",
				url: "https://x.example/1",
				company: "Acme",
				location: "Berlin",
				description: "Build things.",
				postedAt: 1_760_000_000_000,
				salary: { min: 100_000, max: 140_000, currency: "EUR" },
			}).success,
		).toBe(true);
	});

	it("rejects a salary with the wrong shape", () => {
		expect(
			scanJobSchema.safeParse({
				title: "Engineer",
				url: "https://x.example/1",
				company: "Acme",
				location: "",
				salary: { min: "lots" },
			}).success,
		).toBe(false);
	});
});
