/**
 * SmartRecruiters provider — the public postings API, paged.
 *
 * Ported from career-ops' `providers/smartrecruiters.mjs` (MIT). Auto-detects from careers
 * URLs shaped `https://(careers|jobs).smartrecruiters.com/<slug>`; an explicit `entry.api`
 * pointing at either careers host pins the slug for boards behind a branded custom domain.
 *
 * The list payload carries NO description body. (career-ops offered opt-in per-posting detail
 * enrichment via `fetchDetails`/`detailLimit` board config; that needs a per-entry config
 * surface this package does not define yet, so wave 1 ships list-only.)
 */
import type { PortalEntry, ScanJob, ScanProvider } from "../types";
import { assertProviderUrl, isRecord, stringOr } from "./shared";

const ALLOWED_SMARTRECRUITERS_HOSTS: ReadonlySet<string> = new Set(["api.smartrecruiters.com"]);
const ALLOWED_SMARTRECRUITERS_HOSTS_LIST = [...ALLOWED_SMARTRECRUITERS_HOSTS];
const SR_CAREERS_HOSTS: ReadonlySet<string> = new Set(["careers.smartrecruiters.com", "jobs.smartrecruiters.com"]);
export const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50; // safety cap (5000 postings @ 100/page)

function assertSmartRecruitersUrl(url: string): string {
	return assertProviderUrl("smartrecruiters", url, ALLOWED_SMARTRECRUITERS_HOSTS);
}

function resolveSlug(entry: PortalEntry): string | null {
	// entry.api takes precedence over the careers URL (mirrors greenhouse/ashby) so a branded
	// page can stay as `url` while the SmartRecruiters slug is pinned via
	// `api: https://careers.smartrecruiters.com/<slug>`.
	for (const raw of [entry.api, entry.url]) {
		if (typeof raw !== "string" || !raw) continue;
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			continue;
		}
		if (parsed.protocol !== "https:") continue;
		if (!SR_CAREERS_HOSTS.has(parsed.hostname)) continue;
		const slug = parsed.pathname.split("/").filter(Boolean)[0];
		if (slug) return slug;
	}
	return null;
}

function buildPostingsUrl(slug: string, offset: number): string {
	return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
}

const slugify = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * Parse a SmartRecruiters /postings response. Exported for unit tests.
 *
 * SmartRecruiters returns:
 *   { content: [{ id, name, ref, location: { fullLocation?, city?, region?, country?, remote? } }] }
 *
 * - location: prefer `fullLocation`; else assemble city/region/country (skipping empties);
 *   append "Remote" when `location.remote` is true.
 * - url: `ref` is an `api.smartrecruiters.com/v1/companies/<slug>/postings/<id>` URL —
 *   rewritten to the public `jobs.smartrecruiters.com/<slug>/<id>-<title-slug>`. The public
 *   site has no `/postings/` segment; carrying it over yields a 404 that reads downstream as
 *   an expired posting. SmartRecruiters resolves the page by id alone, so the trailing title
 *   slug is cosmetic. When `ref` is missing or untrusted, the same shape is synthesised from
 *   the slugified company name + posting id.
 */
export function parseSmartRecruitersResponse(json: unknown, companyName: string): ScanJob[] {
	const items = isRecord(json) ? json.content : undefined;
	if (!Array.isArray(items)) return [];
	return items.map((rawItem): ScanJob => {
		const item = isRecord(rawItem) ? rawItem : {};
		const loc = isRecord(item.location) ? item.location : {};
		const fullLocation =
			stringOr(loc.fullLocation) ||
			[loc.city, loc.region, loc.country]
				.map((part) => stringOr(part))
				.filter(Boolean)
				.join(", ");
		const location = [fullLocation, loc.remote ? "Remote" : ""].filter(Boolean).join(", ");
		const slugified = slugify(stringOr(item.name));
		let url = "";
		if (typeof item.ref === "string") {
			let parsedRef: URL | null;
			try {
				parsedRef = new URL(item.ref);
			} catch {
				parsedRef = null;
			}
			if (
				parsedRef &&
				parsedRef.protocol === "https:" &&
				parsedRef.hostname === "api.smartrecruiters.com" &&
				parsedRef.pathname.startsWith("/v1/companies/")
			) {
				// /v1/companies/<slug>/postings/<id> → <slug>, <id>
				const [refSlug, postings, refId] = parsedRef.pathname.slice("/v1/companies/".length).split("/").filter(Boolean);
				if (refSlug && postings === "postings" && refId) {
					url = `https://jobs.smartrecruiters.com/${refSlug}/${refId}${slugified ? `-${slugified}` : ""}`;
				}
			}
		}
		const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : "";
		if (!url && id) {
			const companySlug = slugify(companyName);
			if (companySlug) {
				url = `https://jobs.smartrecruiters.com/${companySlug}/${id}${slugified ? `-${slugified}` : ""}`;
			}
		}
		return { title: stringOr(item.name), url, company: companyName, location };
	});
}

export const smartrecruiters: ScanProvider = {
	id: "smartrecruiters",

	detect(entry) {
		const slug = resolveSlug(entry);
		return slug ? { url: buildPostingsUrl(slug, 0) } : null;
	},

	async fetch(entry, ctx) {
		const slug = resolveSlug(entry);
		if (!slug) throw new Error(`smartrecruiters: cannot derive API URL for ${entry.company}`);

		// Honor the ctx.maxPages pagination hint (a portal health probe passes 1); a real sweep
		// keeps the SR_MAX_PAGES safety cap so one giant board cannot run away with the sweep.
		const hinted =
			typeof ctx.maxPages === "number" && Number.isInteger(ctx.maxPages) && ctx.maxPages > 0
				? ctx.maxPages
				: Number.POSITIVE_INFINITY;
		const pageLimit = Math.min(SR_MAX_PAGES, hinted);

		const all: ScanJob[] = [];
		for (let page = 0; page < pageLimit; page += 1) {
			const apiUrl = assertSmartRecruitersUrl(buildPostingsUrl(slug, page * SR_PAGE_SIZE));
			const json = await ctx.fetchJson(apiUrl, { allowedHosts: ALLOWED_SMARTRECRUITERS_HOSTS_LIST });
			const parsed = parseSmartRecruitersResponse(json, entry.company);
			if (parsed.length === 0) break;
			all.push(...parsed);
			if (parsed.length < SR_PAGE_SIZE) break; // last page (short)
		}
		return all;
	},
};
