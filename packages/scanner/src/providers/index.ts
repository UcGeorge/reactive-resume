/**
 * Wave-1 providers, in resolution order.
 *
 * career-ops loaded providers from disk in alphabetical file order so that detect() priority
 * is deterministic across machines; a static array keeps the same order (and the determinism)
 * without runtime directory scanning — a TypeScript package has no reason to discover its own
 * modules. Adding a provider = add the module and slot it into this array alphabetically.
 */
import type { ScanProvider } from "../types";
import { ashby } from "./ashby";
import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import { smartrecruiters } from "./smartrecruiters";
import { workable } from "./workable";

export const providers: readonly ScanProvider[] = [ashby, greenhouse, lever, smartrecruiters, workable];

export { ashby, greenhouse, lever, smartrecruiters, workable };
