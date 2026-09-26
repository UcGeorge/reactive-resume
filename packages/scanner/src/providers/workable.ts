/**
 * Workable provider — the public, no-auth account widget API:
 *
 *   GET https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true
 *   → { name, description, jobs: [{ title, shortcode, shortlink, url, department, city,
 *        state, country, telecommuting, published_on, description, … }] }
 *
 * Ported from career-ops' `providers/workable.mjs` (MIT). The widget API returns the account's
 * FULL posting list in one request and ships `description` + `published_on` for free. The
 * older markdown feed at /<slug>/jobs.md is kept as a FALLBACK only — it cannot be primary: on
 * a large account the bare feed returns a department summary with no job rows (a 259-posting
 * account silently yielded ZERO jobs), it is hard-capped at 30 rows, honours no pagination
 * parameter, and `?department=` segmenting is incomplete.
 *
 * Cloudflare fronts every tenant on apply.workable.com and can block the widget API path for a
 * specific account for hours while the markdown feed keeps returning 200 — so a widget failure
 * falls through to the feed instead of stalling the scan. Requests carry browser-like headers
 * for the same reason. (career-ops additionally serialized ALL Workable requests process-wide;
 * here the context's per-host pacing provides the spacing.)
 */

import type { PortalEntry, ScanJob, ScanProvider } from "../types";
import { decodeEntities } from "../html-to-text";
import { assertProviderUrl, isRecord, trimmedString } from "./shared";

const ALLOWED_WORKABLE_HOSTS: ReadonlySet<string> = new Set(["apply.workable.com"]);
const ALLOWED_WORKABLE_HOSTS_LIST = [...ALLOWED_WORKABLE_HOSTS];

// Workable account slugs are alphanumerics plus - and _ . Anything else is rejected rather
// than interpolated, so a crafted careers URL cannot escape the path (e.g. `..%2f..%2f`) when
// the API URL is built.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Cloudflare challenges plain library user agents on this host; a browser-like UA (with
// matching accept-language/origin) is what the upstream provider shipped after observing that.
const BROWSER_LIKE_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const WORKABLE_HEADERS = {
	"user-agent": BROWSER_LIKE_USER_AGENT,
	"accept-language": "en-US,en;q=0.9",
	origin: "https://apply.workable.com",
};

function assertWorkableUrl(url: string): string {
	return assertProviderUrl("workable", url, ALLOWED_WORKABLE_HOSTS);
}

/** Account slug from the entry's careers URL, or null when the URL is not a Workable board. */
function resolveWorkableSlug(entry: PortalEntry): string | null {
	let parsed: URL;
	try {
		parsed = new URL(entry.url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	if (parsed.hostname !== "apply.workable.com") return null;
	const slug = parsed.pathname.split("/").filter(Boolean)[0];
	if (!slug || !SLUG_RE.test(slug)) return null;
	return slug;
}

const widgetUrlFor = (slug: string): string => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
const feedUrlFor = (slug: string): string => `https://apply.workable.com/${slug}/jobs.md`;

/**
 * Validate a job URL against the Workable allowlist. Off-domain or non-HTTPS entries are
 * dropped (returns null), never emitted — the payload's URLs are host-controlled data.
 */
function safeJobUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:") return null;
		if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) return null;
		return parsed.href;
	} catch {
		return null;
	}
}

/**
 * Location string. The markdown feed rendered "<city>, <country>"; the widget path matches
 * that shape so location filtering behaves identically across both paths.
 */
function formatLocation(job: unknown): string {
	if (!isRecord(job)) return "";
	const joined = [job.city, job.country]
		.map((value) => trimmedString(value))
		.filter(Boolean)
		.join(", ");
	if (joined) return joined;
	return job.telecommuting ? "Remote" : "";
}

/**
 * Strip HTML tags/entities from the widget's rich-text description. Deliberately NOT the
 * shared htmlToText pipeline: this variant preserves line structure (block tags → newlines)
 * and applies no length cap, which is the shape the upstream provider produced and tested.
 */
function toPlainText(html: unknown): string {
	if (typeof html !== "string" || !html) return "";
	return decodeEntities(
		html
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Parse the widget API payload. Exported for unit tests.
 *
 * `shortlink` is the canonical public permalink; `url` is on the same host. Either is fine,
 * both are validated; duplicates (by URL) and untitled rows are skipped.
 */
export function parseWorkableWidget(payload: unknown, companyName: string): ScanJob[] {
	if (!isRecord(payload) || !Array.isArray(payload.jobs)) return [];
	const jobs: ScanJob[] = [];
	const seen = new Set<string>();
	for (const raw of payload.jobs) {
		if (!isRecord(raw)) continue;
		const title = trimmedString(raw.title);
		if (!title) continue;

		const url = safeJobUrl(raw.shortlink) ?? safeJobUrl(raw.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);

		const description = toPlainText(raw.description);
		const publishedOn = typeof raw.published_on === "string" ? raw.published_on : "";
		const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
		const stamp = Date.parse(publishedOn || createdAt);

		jobs.push({
			title,
			url,
			company: companyName,
			location: formatLocation(raw),
			...(description ? { description } : {}),
			...(Number.isFinite(stamp) ? { postedAt: stamp } : {}),
		});
	}
	return jobs;
}

/**
 * Parse Workable's public markdown feed — the fallback path (see the header for why it cannot
 * be primary). Exported for unit tests. The feed exposes a table:
 *
 *   | Title | Department | Location | Type | Salary | Posted | Details |
 *
 * where `Details` holds a markdown link `[View](https://apply.workable.com/<slug>/jobs/view/<id>.md)`.
 * Off-domain or non-HTTPS [View] links are skipped, not emitted.
 */
export function parseWorkableMarkdown(text: string, companyName: string): ScanJob[] {
	if (typeof text !== "string") return [];
	const jobs: ScanJob[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("|") || !line.includes("[View]")) continue;
		const cols = line.split("|").map((col) => col.trim());
		// Cols: ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
		if (cols.length < 8) continue;
		const title = cols[1];
		if (!title || title === "Title") continue;
		const location = cols[3] ?? "";
		const urlMatch = /\[View\]\(([^)]+)\)/.exec(line);
		let url = urlMatch?.[1] ?? "";
		if (url.endsWith(".md")) url = url.slice(0, -3);
		if (!url) continue; // malformed [View] link — no resolvable URL

		const safe = safeJobUrl(url);
		if (!safe) continue;

		jobs.push({ title, url: safe, location, company: companyName });
	}
	return jobs;
}

export const workable: ScanProvider = {
	id: "workable",

	detect(entry) {
		const slug = resolveWorkableSlug(entry);
		return slug ? { url: widgetUrlFor(slug) } : null;
	},

	async fetch(entry, ctx) {
		const slug = resolveWorkableSlug(entry);
		if (!slug) throw new Error(`workable: cannot derive feed URL for ${entry.company}`);
		const headers = { ...WORKABLE_HEADERS, referer: `https://apply.workable.com/${slug}/` };

		// Primary: widget API. Any failure — or a payload without a jobs array — falls through
		// to the markdown feed rather than failing the account outright.
		try {
			const payload = await ctx.fetchJson(assertWorkableUrl(widgetUrlFor(slug)), {
				allowedHosts: ALLOWED_WORKABLE_HOSTS_LIST,
				headers,
			});
			if (isRecord(payload) && Array.isArray(payload.jobs)) {
				return parseWorkableWidget(payload, entry.company);
			}
		} catch {
			// fall through to the markdown feed
		}

		const text = await ctx.fetchText(assertWorkableUrl(feedUrlFor(slug)), {
			allowedHosts: ALLOWED_WORKABLE_HOSTS_LIST,
			headers,
		});
		return parseWorkableMarkdown(text, entry.company);
	},
};
