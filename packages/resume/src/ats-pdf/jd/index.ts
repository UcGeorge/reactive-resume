/**
 * The deterministic JD-matching toolkit, exported as its own subpath so other domain packages
 * (career evaluation, skill-gap classification) reuse one tokenizer, one alias table and one
 * matcher instead of growing drifting copies.
 */

export type { JdMatchOptions } from "./match";
export { canonicalize, SKILL_SURFACE_FORMS, surfaceFormsOf } from "./aliases";
export { matchJobDescription } from "./match";
export { buildNgrams, isKnownSkillForm, MAX_NGRAM_LENGTH } from "./ngrams";
export { normalizeForMatching } from "./normalize";
export { stemFreeText } from "./stem";
export { splitIntoRuns, tokenize } from "./tokenize";
