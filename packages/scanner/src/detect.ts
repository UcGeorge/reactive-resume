/**
 * Provider routing — which provider handles a portal entry.
 *
 * Ports the resolution order of career-ops' `providers/_registry.mjs` (MIT), minus the pieces
 * that don't exist here: no `local-parser` special case (no exec-a-local-command provider in
 * this package) and no disk loading (see providers/index.ts). The order that remains:
 *
 *   1. An explicit `entry.provider` id wins and bypasses detect() entirely — the escape hatch
 *      for boards behind branded domains no URL pattern should ever claim.
 *   2. Otherwise each provider's detect() runs in registry order; first hit wins.
 *
 * A detect() that throws is treated as "no claim" rather than failing the whole chain — one
 * provider's bug must not make every other board undetectable.
 */

import type { PortalEntry, ScanProvider } from "./types";
import { providers } from "./providers/index";

export type ProviderMatch = { provider: ScanProvider; url: string };

function safeDetectUrl(provider: ScanProvider, entry: PortalEntry): string | null {
	try {
		return provider.detect(entry)?.url ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the provider (and the API URL its claim points at) for a portal entry, or null when
 * no provider recognizes it — including when `entry.provider` names an id that isn't
 * registered, so a typo degrades to "unrecognized" instead of routing somewhere wrong.
 *
 * `registry` is injectable for tests and for callers composing their own provider set; it
 * defaults to the package's wave-1 list.
 */
export function detectProvider(
	entry: PortalEntry,
	registry: readonly ScanProvider[] = providers,
): ProviderMatch | null {
	if (entry.provider) {
		const provider = registry.find((candidate) => candidate.id === entry.provider);
		if (!provider) return null;
		// The claim URL is informational; when detect() can't derive one (explicit routing
		// exists precisely for undetectable boards) fall back to what the entry itself names.
		const url = safeDetectUrl(provider, entry) ?? entry.api ?? entry.url;
		return { provider, url };
	}
	for (const provider of registry) {
		const url = safeDetectUrl(provider, entry);
		if (url !== null) return { provider, url };
	}
	return null;
}
