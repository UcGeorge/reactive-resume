import { describe, expect, it } from "vitest";
import {
	CROSSLIST_THRESHOLD,
	FINGERPRINT_MIN_TEXT,
	findCrossListings,
	fingerprintText,
	normalizeJdText,
	similarity,
} from "./index";

/** A realistic JD-sized body: long enough to fingerprint, with distinct sentences. */
function longText(seed: string): string {
	return Array.from(
		{ length: 30 },
		(_, index) => `${seed} engineering requirement number ${index} covers platform reliability and delivery`,
	).join(". ");
}

describe("normalizeJdText", () => {
	it("strips tags, entities and urls, lowercases, and collapses punctuation", () => {
		expect(normalizeJdText("<p>Senior&nbsp;Engineer</p> — apply at https://example.com/jobs !")).toBe(
			"senior engineer apply at",
		);
	});

	it("keeps unicode letters and numbers", () => {
		expect(normalizeJdText("Développeur backend 3+ ans")).toBe("développeur backend 3 ans");
	});

	it("handles null and undefined", () => {
		expect(normalizeJdText(null)).toBe("");
		expect(normalizeJdText(undefined)).toBe("");
	});
});

describe("fingerprintText", () => {
	it("returns 16 lowercase hex chars for a substantial text", () => {
		expect(fingerprintText(longText("acme"))).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic", () => {
		expect(fingerprintText(longText("acme"))).toBe(fingerprintText(longText("acme")));
	});

	it("returns empty for text below the minimum length", () => {
		expect(fingerprintText("too short to matter")).toBe("");
		expect(fingerprintText("x".repeat(FINGERPRINT_MIN_TEXT))).toBe(""); // one giant token: < 3 tokens
	});

	it("returns empty for a degenerate body that normalizes to fewer than 3 tokens", () => {
		// Long enough overall, but only two tokens — no shingle could ever be hashed.
		const twoTokens = `${"a".repeat(150)} ${"b".repeat(150)}`;
		expect(fingerprintText(twoTokens)).toBe("");
	});

	it("ignores markup differences (same body, different tags)", () => {
		const body = longText("acme");
		expect(fingerprintText(`<div><p>${body}</p></div>`)).toBe(fingerprintText(body));
	});
});

describe("similarity", () => {
	it("scores identical fingerprints at 1", () => {
		const fp = fingerprintText(longText("acme"));
		expect(similarity(fp, fp)).toBe(1);
	});

	it("scores near-duplicate bodies close to 1", () => {
		const a = fingerprintText(longText("acme"));
		const b = fingerprintText(`${longText("acme")}. One extra closing sentence about benefits.`);
		expect(similarity(a, b)).toBeGreaterThanOrEqual(CROSSLIST_THRESHOLD);
	});

	it("scores unrelated bodies well below the cross-listing threshold", () => {
		const a = fingerprintText(longText("distributed systems kafka"));
		const b = fingerprintText(
			Array.from(
				{ length: 40 },
				(_, index) => `completely different marketing copy variant ${index} about brand storytelling and design`,
			).join(". "),
		);
		expect(similarity(a, b)).toBeLessThan(CROSSLIST_THRESHOLD);
	});

	it("returns 0 for malformed or empty fingerprints", () => {
		const fp = fingerprintText(longText("acme"));
		expect(similarity("", fp)).toBe(0);
		expect(similarity("not-a-fingerprint", fp)).toBe(0);
		expect(similarity(null, fp)).toBe(0);
		expect(similarity(fp, undefined)).toBe(0);
	});
});

describe("findCrossListings", () => {
	const body = longText("platform");
	const fp = fingerprintText(body);
	const today = new Date("2026-06-01T00:00:00Z");

	const offer = { url: "https://jobs.example.com/a", company: "Acme", title: "Engineer", fingerprint: fp };

	it("reports a near-identical body from a different company", () => {
		const row = {
			url: "https://boards.example.com/b",
			dateStr: "2026-05-20",
			company: "Recruiting GmbH",
			title: "Engineer",
			fingerprint: fp,
		};
		const matches = findCrossListings([offer], [row], { today });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.score).toBe(1);
	});

	it("skips same-company matches (re-posts, not cross-listings)", () => {
		const row = {
			url: "https://boards.example.com/b",
			dateStr: "2026-05-20",
			company: "ACME", // case/punctuation-insensitive key
			title: "Engineer",
			fingerprint: fp,
		};
		expect(findCrossListings([offer], [row], { today })).toHaveLength(0);
	});

	it("keys non-Latin company names distinctly instead of collapsing them", () => {
		const rowA = {
			url: "https://boards.example.com/jp",
			dateStr: "2026-05-20",
			company: "アクメ株式会社",
			title: "Engineer",
			fingerprint: fp,
		};
		// A different non-Latin employer with the same body must still be reported.
		const jpOffer = { ...offer, company: "グロベックス合同会社" };
		expect(findCrossListings([jpOffer], [rowA], { today })).toHaveLength(1);
		// The same non-Latin employer must be skipped as a re-post.
		const sameOffer = { ...offer, company: "アクメ株式会社" };
		expect(findCrossListings([sameOffer], [rowA], { today })).toHaveLength(0);
	});

	it("ignores history outside the window", () => {
		const row = {
			url: "https://boards.example.com/b",
			dateStr: "2025-01-01",
			company: "Recruiting GmbH",
			title: "Engineer",
			fingerprint: fp,
		};
		expect(findCrossListings([offer], [row], { today })).toHaveLength(0);
	});

	it("ignores rows with unparseable dates and missing fingerprints", () => {
		const rows = [
			{ url: "https://x/1", dateStr: "not a date", company: "Other", title: "E", fingerprint: fp },
			{ url: "https://x/2", dateStr: "2026-05-20", company: "Other", title: "E" },
		];
		expect(findCrossListings([offer], rows, { today })).toHaveLength(0);
	});

	it("skips a pair sharing the same url", () => {
		const row = {
			url: offer.url,
			dateStr: "2026-05-20",
			company: "Recruiting GmbH",
			title: "Engineer",
			fingerprint: fp,
		};
		expect(findCrossListings([offer], [row], { today })).toHaveLength(0);
	});

	it("sorts matches best-first", () => {
		const near = fingerprintText(`${body}. One extra closing sentence about benefits and remote work policy.`);
		const rows = [
			{ url: "https://x/near", dateStr: "2026-05-20", company: "Other A", title: "E", fingerprint: near },
			{ url: "https://x/exact", dateStr: "2026-05-20", company: "Other B", title: "E", fingerprint: fp },
		];
		const matches = findCrossListings([offer], rows, { today, threshold: 0.5 });
		expect(matches.length).toBe(2);
		expect(matches[0]?.row.url).toBe("https://x/exact");
		expect(matches[0]?.score ?? 0).toBeGreaterThanOrEqual(matches[1]?.score ?? 0);
	});

	it("accept/reject at the threshold matches the similarity() comparison exactly", () => {
		const near = fingerprintText(`${body}. One extra closing sentence about benefits and remote work policy.`);
		const row = { url: "https://x/near", dateStr: "2026-05-20", company: "Other", title: "E", fingerprint: near };
		const score = similarity(fp, near);
		// Threshold exactly at the pair's score: the pair must be accepted (>=).
		expect(findCrossListings([offer], [row], { today, threshold: score })).toHaveLength(1);
		// Threshold one bit tighter: rejected.
		expect(findCrossListings([offer], [row], { today, threshold: score + 1 / 64 })).toHaveLength(0);
	});
});
