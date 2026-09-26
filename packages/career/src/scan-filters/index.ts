/**
 * Scan filtering, ported from career-ops (MIT): the title-keyword compiler (`word:` / `stem:`
 * prefixes, Unicode-aware anchoring, accent folding, AND-groups), the tiered location filter, the
 * description-text exclude filter, and the re-apply cooldown rule. Each module documents what was
 * ported faithfully versus re-expressed, with the original issue numbers kept in the comments.
 */

export { buildContentFilter, type ContentFilter } from "./content";
export {
	addDays,
	type CooldownInput,
	companiesMatch,
	cooldownBlocked,
	type PriorApplication,
} from "./cooldown";
export {
	buildLocationFilter,
	type LocationFilter,
	type LocationFilterConfig,
	locationHintFromUrl,
	REMOTE_NEGATED_RE,
	REMOTE_TITLE_RE,
	titleSignalsRemote,
	USPS_STATES,
} from "./location";
export {
	AND_SEPARATOR,
	buildTitleFilter,
	buildTitleFilterWithOverride,
	compileContentKeyword,
	compileKeyword,
	compilePositiveKeyword,
	foldAccents,
	type KeywordMatcher,
	STEM_PREFIX,
	type TitleFilter,
	type TitleFilterConfig,
	WORD_PREFIX,
} from "./title-keywords";
