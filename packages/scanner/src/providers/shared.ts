/**
 * Narrowing and guard helpers shared by the provider adapters.
 *
 * Every provider consumes `unknown` JSON from a host it does not control, so the same handful
 * of defensive moves recur: record/string narrowing, NaN-safe date parsing, and the HTTPS +
 * host-allowlist URL assertion each career-ops provider carried as its own near-identical
 * `assert<Ats>Url` copy. Centralized here for the same reason career-ops centralized its entity
 * decoder — identical guards drift when duplicated.
 */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

/** The value when it is a string, else the fallback — providers map missing titles/urls to "". */
export function stringOr(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** The trimmed string when non-empty, else "". */
export function trimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** NaN-safe Date.parse — a bare `|| undefined` would also coerce a valid epoch 0. */
export function toEpochMs(value: unknown): number | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Assert a URL a provider is about to fetch is HTTPS and on that provider's host allowlist.
 * Runs on the EXACT string that goes over the wire (callers re-assert after appending query
 * params), and complements — not replaces — the context's own per-call `allowedHosts` check:
 * this one produces a provider-prefixed error before any pacing or DNS work happens.
 */
export function assertProviderUrl(providerId: string, url: string, allowedHosts: ReadonlySet<string>): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${providerId}: invalid URL: ${url}`);
	}
	if (parsed.protocol !== "https:") throw new Error(`${providerId}: URL must use HTTPS: ${url}`);
	if (!allowedHosts.has(parsed.hostname)) {
		throw new Error(
			`${providerId}: untrusted hostname "${parsed.hostname}" — must be one of: ${[...allowedHosts].join(", ")}`,
		);
	}
	return url;
}
