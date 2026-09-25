/**
 * SSRF-hardened fetch context — the only transport providers are allowed to use.
 *
 * Ports the semantics of career-ops' `providers/_http.mjs` + `providers/_ip-guard.mjs` (MIT).
 * The threat model: every URL a provider fetches is derived from user-supplied portal config or
 * from fields of an API response the board's host controls, so the transport — not the caller —
 * must guarantee that no request can reach loopback, RFC1918 space, or the cloud metadata
 * endpoint, whatever a hostname resolves to or a server redirects to.
 *
 * Layered guards, cheapest first:
 *   1. scheme  — https only unless `allowHttp` is set; nothing else, ever.
 *   2. host    — optional allowlists (context-wide and per-call) pin the hostname itself.
 *   3. address — an IP-literal hostname is judged directly; a DNS name is resolved and EVERY
 *                returned address must be public (a name answering public-then-private is the
 *                DNS-rebinding pattern, so one private record poisons the whole set).
 *   4. redirect: "error" — a 3xx is a failure, so a server-side redirect cannot point a request
 *                at a private address after the checks above passed the original host.
 *
 * KNOWN LIMITATION (TOCTOU): Node's fetch performs its own DNS lookup at connect time and does
 * not let us pin the address we validated, so a resolver that answers public here and private
 * on fetch's own lookup slips through. career-ops closed that window by monkey-patching
 * `dns.lookup` process-wide and scoping the guard with AsyncLocalStorage — acceptable in a CLI
 * that owns its process, not in a library package loaded next to an app server. This check is
 * therefore a strong filter, not a perfect pin; callers needing a pin should front requests
 * with an egress proxy or an undici Agent with a validating custom lookup.
 */

import type { FetchContext, ScanFetchInit } from "./types";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_PACE_MS = 500;
const DEFAULT_USER_AGENT = "reactive-resume-scanner/1.0 (+https://rxresume.org)";

/**
 * IPv4 ranges that must never be dialled: [network, prefixLength].
 *
 * 169.254.0.0/16 is the one with teeth — 169.254.169.254 is the cloud instance metadata
 * endpoint on AWS/GCP/Azure, the address an SSRF is usually aimed at. The rest are the
 * ordinary private/loopback/reserved space.
 */
const V4_BLOCKED: readonly (readonly [number, number])[] = [
	[0x00_00_00_00, 8], // 0.0.0.0/8       "this network"
	[0x0a_00_00_00, 8], // 10.0.0.0/8      RFC1918
	[0x64_40_00_00, 10], // 100.64.0.0/10  CGNAT
	[0x7f_00_00_00, 8], // 127.0.0.0/8     loopback
	[0xa9_fe_00_00, 16], // 169.254.0.0/16 link-local + cloud metadata
	[0xac_10_00_00, 12], // 172.16.0.0/12  RFC1918
	[0xc0_00_00_00, 24], // 192.0.0.0/24   IETF protocol assignments
	[0xc0_a8_00_00, 16], // 192.168.0.0/16 RFC1918
	[0xc6_12_00_00, 15], // 198.18.0.0/15  benchmarking
	[0xe0_00_00_00, 4], // 224.0.0.0/4     multicast
	[0xf0_00_00_00, 4], // 240.0.0.0/4     reserved (includes 255.255.255.255)
];

/** Dotted-quad → uint32, or null when it is not a well-formed IPv4 literal. */
function v4ToInt(address: string): number | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		// Canonical decimal octets only. A leading zero is rejected because `0177.0.0.1` is octal
		// for 127.0.0.1 in some parsers, and a form this function reads as public while a
		// connector reads as loopback is the whole bypass. The WHATWG URL parser already
		// canonicalizes IPv4-ish hostnames, so this is defence in depth rather than a live path —
		// the right default for a function whose job is to say "safe".
		if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

/**
 * Does this address belong to a range the scanner must never connect to?
 *
 * Accepts both families. An IPv4-mapped or IPv4-compatible IPv6 address is unwrapped and judged
 * as IPv4 — `::ffff:127.0.0.1` is loopback however it is spelled, and treating the two
 * spellings differently is the bypass. Unparseable input is treated as blocked: nothing to
 * validate is not the same as safe.
 */
export function isBlockedAddress(address: string): boolean {
	const raw = address.trim();
	if (!raw) return true;

	// Strip an RFC 4007 zone id (fe80::1%eth0) before parsing.
	const addr = (raw.split("%")[0] ?? raw).toLowerCase();

	const asV4 = v4ToInt(addr);
	if (asV4 !== null) {
		return V4_BLOCKED.some(([net, bits]) => {
			const mask = bits === 0 ? 0 : (0xff_ff_ff_ff << (32 - bits)) >>> 0;
			return (asV4 & mask) >>> 0 === net;
		});
	}

	if (!addr.includes(":")) return true; // neither v4 nor v6 — refuse to guess

	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
	const tail = addr.slice(addr.lastIndexOf(":") + 1);
	if (tail.includes(".")) {
		const embedded = v4ToInt(tail);
		return embedded === null ? true : isBlockedAddress(tail);
	}
	// The same two forms written in hex, which is how the URL parser prints them:
	// `new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`.
	const hexEmbedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
	if (hexEmbedded?.[1] !== undefined && hexEmbedded[2] !== undefined) {
		const high = Number.parseInt(hexEmbedded[1], 16);
		const low = Number.parseInt(hexEmbedded[2], 16);
		return isBlockedAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
	}

	if (addr === "::" || addr === "::1") return true; // unspecified, loopback
	if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
	if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
	if (/^ff/.test(addr)) return true; // ff00::/8 multicast
	return false;
}

/**
 * A non-2xx response. Carries the status and the raw Retry-After header so a future retry
 * layer can classify (429/5xx retryable, other 4xx not) without string-matching messages.
 */
export class HttpError extends Error {
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(status: number, statusText: string, retryAfter: string | null) {
		super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
		this.name = "HttpError";
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export type FetchContextOptions = {
	/** Permit plain http URLs. Default false: HTTPS only. */
	allowHttp?: boolean;
	/** Per-request timeout in ms (AbortSignal.timeout). Default 15s; a call's `timeoutMs` overrides it. */
	timeoutMs?: number;
	/** Reject a response body larger than this many bytes. Default 5 MiB. */
	maxBodyBytes?: number;
	/** Minimum spacing between consecutive requests to the same host. Default 500ms; 0 disables. */
	paceMs?: number;
	/** User-Agent sent when the caller supplies none. */
	userAgent?: string;
	/** Context-wide host allowlist, checked in addition to any per-call `allowedHosts`. */
	allowedHosts?: readonly string[];
	/** Pagination hint surfaced as ctx.maxPages (a health probe passes 1). */
	maxPages?: number;
	/**
	 * Hostname → addresses, for the pre-connect address check. Default: node:dns/promises
	 * lookup with `all: true`. Injectable so tests exercise the guard without real DNS.
	 */
	resolve?: (hostname: string) => Promise<string[]>;
	/** Pacing clock (default setTimeout). Injectable so tests never wall-clock wait. */
	sleep?: (ms: number) => Promise<void>;
	/** Time source for pacing (default Date.now). Injectable for deterministic pacing tests. */
	now?: () => number;
};

async function defaultResolve(hostname: string): Promise<string[]> {
	// `all: true` matters: validating only the first address would let a rebinding name hide a
	// private record behind a public one. lookup (not resolve4/6) mirrors what fetch's connector
	// consults, /etc/hosts included.
	const records = await lookup(hostname, { all: true });
	return records.map((record) => record.address);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Build the FetchContext handed to providers. All requests made through it share one pacing
 * ledger, one guard configuration and one User-Agent — which is why providers receive a
 * context instead of calling fetch themselves.
 */
export function createFetchContext(options: FetchContextOptions = {}): FetchContext {
	const allowHttp = options.allowHttp ?? false;
	const contextTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
	const resolveAddresses = options.resolve ?? defaultResolve;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;

	function assertScheme(url: URL): void {
		if (url.protocol === "https:") return;
		if (allowHttp && url.protocol === "http:") return;
		throw new Error(`scanner: refusing non-${allowHttp ? "http(s)" : "https"} URL: ${url.href}`);
	}

	function assertHostAllowed(rawHostname: string, callAllowlist: readonly string[] | undefined): void {
		// URL.hostname is already lowercased for DNS names, but the allowlist entries are
		// caller-written — compare both sides folded.
		const hostname = rawHostname.toLowerCase();
		for (const list of [options.allowedHosts, callAllowlist]) {
			if (!list) continue;
			if (!list.some((host) => host.toLowerCase() === hostname)) {
				throw new Error(`scanner: host "${hostname}" is not in the allowed host list`);
			}
		}
	}

	async function assertPublicDestination(hostname: string): Promise<void> {
		// URL.hostname wraps an IPv6 literal in brackets ("[::1]") — strip them before family
		// detection so the literal is judged directly, with no DNS round-trip at all.
		const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
		if (isIP(bare) !== 0) {
			if (isBlockedAddress(bare)) {
				throw new Error(`scanner: refusing to connect to ${hostname}: non-public address`);
			}
			return;
		}
		let addresses: string[];
		try {
			addresses = await resolveAddresses(bare);
		} catch (error) {
			throw new Error(`scanner: DNS lookup failed for ${hostname}`, { cause: error });
		}
		if (addresses.length === 0) {
			throw new Error(`scanner: DNS lookup for ${hostname} returned no addresses`);
		}
		// ANY private record fails the whole name (DNS-rebinding caution — see module header).
		const blocked = addresses.find((address) => isBlockedAddress(address));
		if (blocked !== undefined) {
			throw new Error(`scanner: refusing to connect to ${hostname}: resolves to non-public address ${blocked}`);
		}
	}

	// Per-host pacing ledger: the next timestamp at which a request to a host may start. The
	// slot is reserved BEFORE sleeping, so concurrent callers to one host stack up at paceMs
	// intervals instead of all sleeping once and then firing together.
	const nextSlotByHost = new Map<string, number>();
	async function pace(hostname: string): Promise<void> {
		if (paceMs <= 0) return;
		const current = now();
		const slot = Math.max(current, nextSlotByHost.get(hostname) ?? 0);
		nextSlotByHost.set(hostname, slot + paceMs);
		if (slot > current) await sleep(slot - current);
	}

	async function readBodyCapped(response: Response): Promise<string> {
		// A truthful Content-Length lets us refuse before reading; a lying or absent one is
		// caught by the streamed count below, so this is a shortcut, not the guard.
		const declared = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declared) && declared > maxBodyBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`scanner: response exceeds ${maxBodyBytes}-byte body cap`);
		}
		const reader = response.body?.getReader();
		if (!reader) {
			// No stream (null body / exotic test double): fall back to text() with a post-hoc cap.
			const text = await response.text();
			if (text.length > maxBodyBytes) throw new Error(`scanner: response exceeds ${maxBodyBytes}-byte body cap`);
			return text;
		}
		// Stream and count, aborting past the cap — a body must never be buffered whole before
		// the size check. The context timeout still covers this read: the request signal aborts
		// in-flight reads, so a server that sends headers and then stalls the body cannot hang
		// the caller past the deadline.
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > maxBodyBytes) throw new Error(`scanner: response exceeds ${maxBodyBytes}-byte body cap`);
				chunks.push(value);
			}
		} finally {
			reader.cancel().catch(() => undefined);
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(merged);
	}

	async function requestText(rawUrl: string, init: ScanFetchInit = {}): Promise<string> {
		const { allowedHosts, timeoutMs, headers, ...platformInit } = init;
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new Error(`scanner: invalid URL: ${rawUrl}`);
		}
		assertScheme(url);
		assertHostAllowed(url.hostname, allowedHosts);
		await assertPublicDestination(url.hostname);
		await pace(url.hostname);

		// Defaults go through Headers so a caller's override wins whatever its capitalization —
		// an object spread only replaces an identical key, and fetch JOINS a caller's
		// 'User-Agent' with a default 'user-agent' into one comma-separated value.
		const requestHeaders = new Headers(headers);
		if (!requestHeaders.has("user-agent")) requestHeaders.set("user-agent", userAgent);
		// accept-encoding pinned to the codecs undici decodes correctly. Left unset, Node
		// negotiates zstd, and at least one large board's zstd response comes back TRUNCATED at
		// 1024 bytes with a 200 status — surfacing as an unrelated-looking JSON parse error.
		if (!requestHeaders.has("accept-encoding")) requestHeaders.set("accept-encoding", "gzip, deflate, br");

		// `redirect` and `signal` are set AFTER the caller's init is spread: following a 3xx
		// would re-open the SSRF hole the address check just closed, so neither is overridable.
		const response = await fetch(url.href, {
			...platformInit,
			headers: requestHeaders,
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs ?? contextTimeoutMs),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new HttpError(response.status, response.statusText, response.headers.get("retry-after"));
		}
		return readBodyCapped(response);
	}

	async function fetchJson(rawUrl: string, init?: ScanFetchInit): Promise<unknown> {
		const text = await requestText(rawUrl, init);
		// The content-type header is deliberately not consulted: ATS endpoints serve JSON as
		// text/plain and text/html in the wild, and a header can no more be trusted than the
		// body it describes. Parse-or-throw is the only honest contract.
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			throw new Error(`scanner: response from ${rawUrl} is not valid JSON`, { cause: error });
		}
	}

	const context: FetchContext = {
		fetchJson,
		fetchText: (rawUrl, init) => requestText(rawUrl, init),
		sleep,
	};
	if (options.maxPages !== undefined) context.maxPages = options.maxPages;
	return context;
}

/**
 * Constrain a context so every request through it must land on one of `hosts` — the wrapper
 * form of the per-call `allowedHosts` option, for handing a provider a context it cannot
 * broaden. When a call carries its own allowlist the two are intersected, so a wrapped context
 * can only ever narrow further, never escape.
 */
export function withAllowedHosts(context: FetchContext, hosts: readonly string[]): FetchContext {
	const constrain = (init?: ScanFetchInit): ScanFetchInit => ({
		...init,
		allowedHosts: init?.allowedHosts
			? init.allowedHosts.filter((candidate) => hosts.some((host) => host.toLowerCase() === candidate.toLowerCase()))
			: hosts,
	});
	return {
		...context,
		fetchJson: (url, init) => context.fetchJson(url, constrain(init)),
		fetchText: (url, init) => context.fetchText(url, constrain(init)),
	};
}
