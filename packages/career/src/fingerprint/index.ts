/**
 * JD-content fingerprinting: 64-bit SimHash over 3-token shingles of the normalized
 * description text.
 *
 * The same job can enter the pipeline twice before any application exists: once as a direct
 * company listing and once as an agency re-post with the employer name stripped. URL and
 * company+role dedup both miss that pair — but agencies rarely rewrite the requirements text,
 * so a content fingerprint of the JD body catches it. SimHash keeps near-duplicate texts
 * within a few bits of each other, so one 16-hex-char column per row is enough to compare any
 * pair later without storing the body itself.
 *
 * Ported from career-ops' `fingerprint-core.mjs` (MIT). The shingle hash is an FNV-1a pair
 * rather than SHA-1 so this module stays dependency-free and environment-neutral (no
 * `node:crypto`); fingerprints are only ever compared against other fingerprints produced
 * here, so the hash family is an internal detail.
 */

/** Descriptions shorter than this (after normalization) carry too little signal to
 * distinguish real matches from boilerplate — skip them. */
export const FINGERPRINT_MIN_TEXT = 200;

/** Similarity at or above this is reported as a possible cross-listing.
 * 0.92 ≈ at most 5 of 64 SimHash bits differ — near-verbatim bodies. */
export const CROSSLIST_THRESHOLD = 0.92;

/** Only compare against history this recent. */
export const CROSSLIST_WINDOW_DAYS = 90;

/**
 * Normalize JD text for shingling: strip tags/entities/URLs, lowercase, collapse everything
 * non-alphanumeric (unicode-aware) to single spaces.
 */
export function normalizeJdText(text: string | null | undefined): string {
	return String(text ?? "")
		.toLowerCase()
		.replace(/<[^>]*>/g, " ")
		.replace(/&[a-z#0-9]+;/gi, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** 32-bit FNV-1a with a caller-chosen seed, so two seeds give two independent halves. */
function fnv1a32(text: string, seed: number): number {
	let hash = seed | 0;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return hash | 0;
}

/**
 * 64-bit SimHash of a text, as 16 lowercase hex chars — or "" when the normalized text is too
 * short to fingerprint (see FINGERPRINT_MIN_TEXT).
 */
export function fingerprintText(text: string | null | undefined): string {
	const normalized = normalizeJdText(text);
	if (normalized.length < FINGERPRINT_MIN_TEXT) return "";
	const tokens = normalized.split(" ");
	// Length alone can pass on <3 tokens (e.g. an unspaced CJK body normalizes to one giant
	// token). No shingle would ever be hashed, leaving an all-zero hash that similarity()
	// would score 1.0 against every other degenerate body — treat it as unfingerprintable.
	if (tokens.length < 3) return "";

	const weights = new Array<number>(64).fill(0);
	for (let index = 0; index <= tokens.length - 3; index += 1) {
		const shingle = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
		// Two independently-seeded 32-bit FNV-1a hashes act as the shingle's 64-bit hash.
		const hi = fnv1a32(shingle, 0x81_1c_9d_c5);
		const lo = fnv1a32(shingle, 0x01_00_01_93);
		for (let bit = 0; bit < 32; bit += 1) {
			weights[bit] = (weights[bit] ?? 0) + ((hi >>> (31 - bit)) & 1 ? 1 : -1);
			weights[bit + 32] = (weights[bit + 32] ?? 0) + ((lo >>> (31 - bit)) & 1 ? 1 : -1);
		}
	}

	let hex = "";
	for (let nibble = 0; nibble < 16; nibble += 1) {
		let value = 0;
		for (let bit = 0; bit < 4; bit += 1) {
			const weight = weights[nibble * 4 + bit] ?? 0;
			if (weight > 0) value |= 1 << (3 - bit);
		}
		hex += value.toString(16);
	}
	return hex;
}

/** A fingerprint is exactly 16 lowercase hex chars; anything else never matches. */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

/** Set-bit count for every 16-bit value, built once at module load (64 KB). A 64-bit Hamming
 * distance then costs four table lookups, and cross-listing detection compares
 * offers × history rows, so that per-pair cost is multiplied by both list lengths. */
const POPCOUNT16 = (() => {
	const table = new Uint8Array(1 << 16);
	for (let index = 1; index < table.length; index += 1) {
		const half = table[index >> 1] ?? 0;
		table[index] = half + (index & 1);
	}
	return table;
})();

/** Number of set bits in a 32-bit word. Sign is irrelevant: both masks yield a non-negative
 * 0..65535 index, so a negative int32 indexes the table just as correctly. */
function popcount32(value: number): number {
	return (POPCOUNT16[value & 0xff_ff] ?? 0) + (POPCOUNT16[(value >>> 16) & 0xff_ff] ?? 0);
}

type FingerprintHalves = { hi: number; lo: number };

/** Split a fingerprint that has already passed FINGERPRINT_RE into its two 32-bit halves.
 * JS bitwise operators are 32-bit, so the 64-bit value is carried as a pair. */
function splitFingerprint(fingerprint: string): FingerprintHalves {
	return {
		hi: Number.parseInt(fingerprint.slice(0, 8), 16) | 0,
		lo: Number.parseInt(fingerprint.slice(8, 16), 16) | 0,
	};
}

/**
 * Similarity of two fingerprints: 1 − hammingDistance/64. Empty or malformed fingerprints
 * never match (returns 0).
 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
	if (!FINGERPRINT_RE.test(a ?? "") || !FINGERPRINT_RE.test(b ?? "")) return 0;
	const x = splitFingerprint(a as string);
	const y = splitFingerprint(b as string);
	return 1 - (popcount32(x.hi ^ y.hi) + popcount32(x.lo ^ y.lo)) / 64;
}

/**
 * Largest Hamming distance (0..64) that still scores at or above `threshold`, or -1 when no
 * distance does. Derived by evaluating the same `1 - d / 64 >= threshold` comparison the
 * per-pair path runs — for integer d, `d / 64` is exact in binary floating point, so this
 * search reproduces the per-pair accept/reject decision at every threshold, including one
 * landing exactly on a bit boundary. A NaN threshold returns -1 (reject everything).
 */
function maxDistanceFor(threshold: number): number {
	for (let distance = 0; distance <= 64; distance += 1) {
		if (!(1 - distance / 64 >= threshold)) return distance - 1;
	}
	return 64;
}

/**
 * Company key for "different employer" checks. Keeps letters, numbers and combining marks in
 * every script (a bare `[a-z0-9]` strip would delete non-Latin names entirely, silently
 * equating genuinely different employers), lowercased and folded to NFKC.
 */
function companyKey(name: string | null | undefined): string {
	return String(name ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
}

export type CrossListingOffer = {
	url: string;
	company: string;
	title: string;
	fingerprint?: string;
};

export type CrossListingHistoryRow = {
	url: string;
	/** Parseable date string for the row's first-seen date. */
	dateStr: string;
	company: string;
	title: string;
	fingerprint?: string;
};

export type CrossListingMatch<Offer extends CrossListingOffer, Row extends CrossListingHistoryRow> = {
	offer: Offer;
	row: Row;
	score: number;
};

export type FindCrossListingsOptions = {
	today?: Date;
	threshold?: number;
	windowDays?: number;
};

/**
 * Find possible cross-listings: new offers whose fingerprint is near-identical to a recent
 * history row from a DIFFERENT company. Same-company matches are re-posts, not cross-listings
 * — skipped here. Pure function: pass the offers and history rows in. Results best-first.
 */
export function findCrossListings<Offer extends CrossListingOffer, Row extends CrossListingHistoryRow>(
	offers: readonly Offer[],
	historyRows: readonly Row[],
	options: FindCrossListingsOptions = {},
): CrossListingMatch<Offer, Row>[] {
	const threshold = options.threshold ?? CROSSLIST_THRESHOLD;
	const windowDays = options.windowDays ?? CROSSLIST_WINDOW_DAYS;
	const today = options.today ? new Date(options.today) : new Date();
	const cutoff = today.getTime() - windowDays * 86_400_000;
	const maxDistance = maxDistanceFor(threshold);
	// A malformed (or absent) fingerprint on either side scores 0, which is still a match for
	// a caller passing threshold <= 0.
	const zeroScores = 0 >= threshold;

	// One pass over history: the date filter, companyKey and fingerprint split all happen once
	// per row instead of once per (offer, row) pair.
	const recent: { row: Row; key: string; url: string; valid: boolean; hi: number; lo: number }[] = [];
	for (const row of historyRows) {
		if (!row.fingerprint) continue;
		const time = Date.parse(row.dateStr);
		if (Number.isNaN(time) || time < cutoff) continue;
		const valid = FINGERPRINT_RE.test(row.fingerprint);
		const half = valid ? splitFingerprint(row.fingerprint) : null;
		recent.push({
			row,
			key: companyKey(row.company),
			url: row.url,
			valid,
			hi: half ? half.hi : 0,
			lo: half ? half.lo : 0,
		});
	}

	const matches: CrossListingMatch<Offer, Row>[] = [];
	for (const offer of offers) {
		if (!offer.fingerprint) continue;
		const offerCompany = companyKey(offer.company);
		const offerValid = FINGERPRINT_RE.test(offer.fingerprint);
		// Nothing an invalid offer fingerprint is compared against can score above 0, so when 0
		// is below the threshold the whole inner loop is dead.
		if (!offerValid && !zeroScores) continue;
		const half = offerValid ? splitFingerprint(offer.fingerprint) : null;
		const offerHi = half ? half.hi : 0;
		const offerLo = half ? half.lo : 0;
		for (const candidate of recent) {
			if (candidate.key === offerCompany) continue; // re-post, not cross-listing
			if (candidate.url === offer.url) continue;
			let score: number;
			if (offerValid && candidate.valid) {
				const distance = popcount32(offerHi ^ candidate.hi) + popcount32(offerLo ^ candidate.lo);
				// `distance > maxDistance` is exactly `1 - distance / 64 < threshold` by the
				// construction of maxDistanceFor() — no float compare in the hot path.
				if (distance > maxDistance) continue;
				score = 1 - distance / 64;
			} else {
				if (!zeroScores) continue;
				score = 0;
			}
			matches.push({ offer, row: candidate.row, score });
		}
	}
	return matches.sort((a, b) => b.score - a.score);
}
