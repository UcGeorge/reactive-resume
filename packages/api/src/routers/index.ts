import { agentRouter } from "../features/agent/router";
import { aiRouter } from "../features/ai/router";
import { aiProvidersRouter } from "../features/ai-providers/router";
import { aiRequestsRouter } from "../features/ai-requests/router";
import { applicationsRouter } from "../features/applications/router";
import { authRouter } from "../features/auth/router";
import { careerInsightsRouter } from "../features/career-insights/router";
import { coverLettersRouter } from "../features/cover-letters/router";
import { discoveryRouter } from "../features/discovery/router";
import { evaluationsRouter } from "../features/evaluations/router";
import { flagsRouter } from "../features/flags/router";
import { followUpsRouter } from "../features/follow-ups/router";
import { resumeRouter } from "../features/resume/router";
import { statisticsRouter } from "../features/statistics/router";
import { storageRouter } from "../features/storage/router";
import { storiesRouter } from "../features/stories/router";

export default {
	ai: aiRouter,
	aiProviders: aiProvidersRouter,
	aiRequests: aiRequestsRouter,
	agent: agentRouter,
	applications: applicationsRouter,
	auth: authRouter,
	careerInsights: careerInsightsRouter,
	coverLetters: coverLettersRouter,
	discovery: discoveryRouter,
	evaluations: evaluationsRouter,
	flags: flagsRouter,
	followUps: followUpsRouter,
	resume: resumeRouter,
	statistics: statisticsRouter,
	stories: storiesRouter,
	storage: storageRouter,
};
