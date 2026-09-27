import type { MessageDescriptor } from "@lingui/core";
import type { AiFeature } from "@reactive-resume/ai/types";
import { msg } from "@lingui/core/macro";

type AiFeatureCopy = {
	label: MessageDescriptor;
	description: MessageDescriptor;
};

/** How each routable AI feature is named and explained in Settings → Integrations. */
export const AI_FEATURE_COPY: Record<AiFeature, AiFeatureCopy> = {
	default: {
		label: msg`Default`,
		description: msg`Used by every feature without a route of its own.`,
	},
	chat: {
		label: msg`Agent chat`,
		description: msg`Agent threads and the in-resume assistant.`,
	},
	import: {
		label: msg`Resume import`,
		description: msg`Parsing PDF and Word files into resume data.`,
	},
	"ats-review": {
		label: msg`ATS review`,
		description: msg`Qualitative review of the text extracted from a resume.`,
	},
	autofill: {
		label: msg`Application autofill`,
		description: msg`Filling an application from a job posting or URL.`,
	},
	evaluation: {
		label: msg`Job evaluation`,
		description: msg`Multi-pass evaluation of a posting against your profile.`,
	},
	tailoring: {
		label: msg`Tailoring`,
		description: msg`Tailored resume copies and their bullet audit.`,
	},
	"cover-letter": {
		label: msg`Cover letters`,
		description: msg`Guided angles and drafts.`,
	},
	outreach: {
		label: msg`Outreach`,
		description: msg`Recruiter messages and follow-up drafts.`,
	},
	stories: {
		label: msg`Story bank`,
		description: msg`Suggesting interview stories from a resume.`,
	},
};
