/**
 * Content (description-text) exclude filter, ported from career-ops' `scan.mjs` (MIT)
 * `content_filter` negative-list semantics (#734, #3274). The original also carried a `positive`
 * (require-one) list and a `by_title_keyword` override map; this port keeps the exclude-list use,
 * which is the part the scan pipeline applies to every description.
 *
 * Semantics (case-insensitive substring, in order):
 *   - No exclude list configured → all texts pass.
 *   - Empty / whitespace-only / non-string text → PASS. The scanner only sees descriptions a
 *     provider already returns in its list payload; providers without one must never be silently
 *     dropped.
 *   - Any exclude keyword present → reject.
 *
 * A keyword may opt in to boundary-anchored matching with a `word:` or `stem:` prefix (identical
 * to the title filter — see title-keywords.ts). Without a prefix an entry is a plain substring, so
 * a bare `java` rejects every posting mentioning "JavaScript" and `ios` rejects "curiosity";
 * `word:java` / `stem:ios` fix that one entry while leaving the rest of the list untouched
 * (#3274). The substring default is deliberate: flipping it would silently narrow every
 * configured install. Deliberately NO accent folding: the original content filter compares
 * lowercased text as-is, unlike the title filter.
 */

import type { KeywordMatcher } from "./title-keywords";
import { compileContentKeyword } from "./title-keywords";

/** True = the text passes (is not excluded). */
export type ContentFilter = (text: unknown) => boolean;

// Same list normalization as the location filter: tolerate a bare string, drop non-strings,
// lowercase/trim, and drop empties — an empty keyword would otherwise reject every text via
// String.includes("").
function compileContentKeywordList(value: string | readonly string[] | null | undefined): KeywordMatcher[] {
	if (value == null) return [];
	const arr: readonly unknown[] = Array.isArray(value) ? value : [value];
	return arr
		.filter((k): k is string => typeof k === "string")
		.map((k) => k.toLowerCase().trim())
		.filter(Boolean)
		.map(compileContentKeyword);
}

export function buildContentFilter(exclude: string | readonly string[] | null | undefined): ContentFilter {
	const negative = compileContentKeywordList(exclude);
	if (negative.length === 0) return () => true;

	return (text) => {
		if (typeof text !== "string" || text.trim() === "") return true;
		const lower = text.toLowerCase();
		return !negative.some((m) => m(lower));
	};
}
