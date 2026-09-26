/**
 * Interview story-bank toolkit, ported from career-ops (MIT): the provenance discipline for
 * story claims (`story-provenance-check.mjs`, issue #2947) and the deterministic
 * story <-> behavioural-question matcher (`match-star.mjs`). Claim detection is reused from
 * this package's fact-gate rather than re-ported; each module documents what was ported
 * faithfully versus re-expressed, with the original issue numbers kept in the comments.
 */

export {
	ANSWER_WORD_CEILING,
	ANSWER_WORD_FLOOR,
	BODY_MATCH_WEIGHT,
	formatStoryForAnswer,
	JD_TAG_BOOST,
	type MatchableStory,
	type MatchStoriesInput,
	matchStories,
	STOPWORDS,
	type StoryMatch,
	type StoryScore,
	scoreStory,
	TAG_MATCH_WEIGHT,
	TITLE_THEME_WEIGHT,
	tokenize,
} from "./match";
export {
	canAutoTransition,
	canCiteAsQuantifiedClaim,
	checkStoryProvenance,
	DEFAULT_PROVENANCE_STATE,
	isDurableProvenance,
	isUserDecidedProvenance,
	PROVENANCE_STATES,
	type ProvenanceState,
	type StoryProvenanceInput,
	type StoryProvenanceReport,
	type StoryProvenanceStory,
} from "./provenance";
