/**
 * Provider plugin contract for the job-board scanner layer.
 *
 * Ported from career-ops' `providers/_types.js` (MIT), where the same contract lived as
 * documentation-only JSDoc typedefs over plain ESM and was enforced at runtime by scan.mjs
 * (id present, fetch is a function, fetch returns an array). Here the compiler enforces the
 * shapes; the zod schemas remain for the two boundaries the compiler cannot see — portal
 * entries read from user configuration, and job rows crossing a storage or process boundary.
 */
import { z } from "zod";

/**
 * Annualized compensation, attached ONLY when the source exposes real figures — never inferred.
 * At least one of min/max is expected; providers normalize a one-sided range where they can.
 * `currency` is the source's currency string upper-cased by providers; it is deliberately not
 * validated as an ISO code (consumers compare it case-insensitively and tolerate junk).
 */
export const scanSalarySchema = z.object({
	min: z.number().optional(),
	max: z.number().optional(),
	currency: z.string().optional(),
});

export type ScanSalary = z.infer<typeof scanSalarySchema>;

/**
 * Normalized job posting — the unit of currency throughout the scanner.
 *
 * `url` is required and absolute: it is the default dedup key. `company` and `location` may be
 * empty when the source cannot expose them at the list level; they are populated downstream.
 * `description` is present ONLY when the provider's list payload carries it for free — the
 * scanner is zero-token, so no provider issues per-job detail requests just to fill it.
 * `postedAt` is epoch milliseconds, omitted when the source has no usable date, so "no signal"
 * stays distinguishable from a real timestamp.
 */
export const scanJobSchema = z.object({
	title: z.string(),
	url: z.string(),
	company: z.string(),
	location: z.string(),
	description: z.string().optional(),
	postedAt: z.number().optional(),
	salary: scanSalarySchema.optional(),
});

export type ScanJob = z.infer<typeof scanJobSchema>;

/**
 * A watched company's careers/API portal.
 *
 * `url` is the public careers page (career-ops' `careers_url`) and is what URL-pattern
 * detection reads. `api` optionally pins the ATS API endpoint directly and takes precedence in
 * every provider's detect() — it lets an entry keep a human-facing branded page as `url` while
 * still naming the board (the greenhouse/ashby/lever `api:` precedence rule). `provider` is an
 * explicit provider id that bypasses detection entirely, for boards behind a branded domain no
 * URL pattern should ever claim.
 */
export const portalEntrySchema = z.object({
	company: z.string(),
	url: z.string(),
	api: z.string().optional(),
	provider: z.string().optional(),
});

export type PortalEntry = z.infer<typeof portalEntrySchema>;

/**
 * Per-request options layered over the platform RequestInit. `redirect` and `signal` are
 * accepted but always overridden by the fetch context: redirects are never followed and the
 * timeout is context-owned, so a provider cannot opt out of either guard.
 */
export type ScanFetchInit = RequestInit & {
	/** Overrides the context timeout for this call — some boards (Ashby, Lever) sit on a ~10s+ server-side latency floor. */
	timeoutMs?: number;
	/**
	 * Hosts this call may ever reach, matched case-insensitively against the URL hostname.
	 * A provider passes its ATS host allowlist here so a crafted entry URL can never point its
	 * requests elsewhere (mirrors career-ops' per-provider assert*Url guards).
	 */
	allowedHosts?: readonly string[];
};

/**
 * What the scanner hands to provider.fetch(). fetchJson/fetchText are the ONLY sanctioned
 * transports — providers never call bare fetch, so the SSRF guards, pacing and size caps in
 * `context.ts` apply uniformly. `maxPages` is a pagination hint (a portal health probe passes
 * 1); a paginating provider SHOULD stop after that many pages. `sleep` is the pacing clock,
 * injectable so tests never wall-clock wait.
 */
export type FetchContext = {
	fetchJson(url: string, init?: ScanFetchInit): Promise<unknown>;
	fetchText(url: string, init?: ScanFetchInit): Promise<string>;
	maxPages?: number;
	sleep(ms: number): Promise<void>;
};

/**
 * Returned by detect() when a provider claims an entry. `url` is informational (it names the
 * API endpoint the claim resolved to); routing only checks for a non-null return.
 */
export type DetectHit = { url: string };

/**
 * The provider contract.
 *
 * `detect` claims an entry from its URL shape. A branded or unrecognizable domain must NOT be
 * matched by URL-pattern detection — such boards are reachable only through an explicit
 * `entry.provider` id, so a provider never claims an entry the user did not point at it.
 * `dedupKey` optionally returns a provider-scoped identifier more precise than URL
 * normalization (e.g. a requisition id shared by several URLs of one tenant); null tells the
 * caller to fall back to its URL-based key.
 */
export type ScanProvider = {
	id: string;
	detect(entry: PortalEntry): DetectHit | null;
	fetch(entry: PortalEntry, ctx: FetchContext): Promise<ScanJob[]>;
	dedupKey?(job: ScanJob): string | null;
};
