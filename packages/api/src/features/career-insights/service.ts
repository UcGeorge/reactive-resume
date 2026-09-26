import type { ApplicationTimelineEntry } from "@reactive-resume/schema/applications/data";
import { and, eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { canonicalize, normalizeForMatching } from "@reactive-resume/resume/ats-pdf/jd";

/**
 * The learning loop (career-ops calibrate / upskill / analyze-patterns, re-expressed over
 * this app's tables). Everything here is deterministic aggregation with honesty rules:
 * in-flight applications are never counted as failures, no rate is shown under the sample
 * floor, and the output is framed as advisory — it never auto-tunes anything.
 */

/** No percentage below this sample size — a 2-of-3 "success rate" is noise wearing a suit. */
export const SAMPLE_FLOOR = 5;

const STAGE_ORDER = ["saved", "applied", "screening", "interview", "offer"] as const;

type StageName = (typeof STAGE_ORDER)[number] | "rejected";

function stageTimes(activity: ApplicationTimelineEntry[]): Map<StageName, Date> {
	const times = new Map<StageName, Date>();
	for (const entry of activity) {
		if (entry.type !== "stage") continue;
		const at = new Date(entry.at);
		const existing = times.get(entry.stage);
		// First time a stage was reached.
		if (!existing || at < existing) times.set(entry.stage, at);
	}
	return times;
}

function furthestStage(times: Map<StageName, Date>): StageName | null {
	for (let index = STAGE_ORDER.length - 1; index >= 0; index -= 1) {
		const stage = STAGE_ORDER[index];
		if (stage && times.has(stage)) return stage;
	}
	return null;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const low = sorted[middle - 1];
	const high = sorted[middle];
	if (sorted.length % 2 === 0 && low !== undefined && high !== undefined) return (low + high) / 2;
	return sorted[middle] ?? null;
}

function daysBetween(from: Date, to: Date): number {
	return (to.getTime() - from.getTime()) / 86_400_000;
}

type ApplicationRow = {
	id: string;
	status: string;
	source: string | null;
	activity: ApplicationTimelineEntry[];
	appliedAt: Date;
};

type EvaluationRow = {
	applicationId: string;
	score: number | null;
	skillGap: { gap: string[] } | null;
	requirements: { requirement: string; importance: string; match: string | null }[] | null;
};

async function loadApplications(userId: string): Promise<ApplicationRow[]> {
	return db
		.select({
			id: schema.application.id,
			status: schema.application.status,
			source: schema.application.source,
			activity: schema.application.activity,
			appliedAt: schema.application.appliedAt,
		})
		.from(schema.application)
		.where(eq(schema.application.userId, userId));
}

async function loadCompleteEvaluations(userId: string): Promise<EvaluationRow[]> {
	return db
		.select({
			applicationId: schema.evaluation.applicationId,
			score: schema.evaluation.score,
			skillGap: schema.evaluation.skillGap,
			requirements: schema.evaluation.requirements,
		})
		.from(schema.evaluation)
		.where(and(eq(schema.evaluation.userId, userId), eq(schema.evaluation.status, "complete")));
}

// --- Calibration --------------------------------------------------------------------

const SCORE_BANDS = [
	{ label: "1.0–1.9", min: 1, max: 2 },
	{ label: "2.0–2.9", min: 2, max: 3 },
	{ label: "3.0–3.9", min: 3, max: 4 },
	{ label: "4.0–4.4", min: 4, max: 4.5 },
	{ label: "4.5–5.0", min: 4.5, max: 5.000_001 },
] as const;

export async function computeCalibration(userId: string) {
	const [applications, evaluations] = await Promise.all([loadApplications(userId), loadCompleteEvaluations(userId)]);
	const byApplication = new Map(applications.map((application) => [application.id, application]));

	// One data point per evaluated application: the latest score against the realized
	// outcome. In-flight applications (not rejected, no interview yet) are EXCLUDED — an
	// application still in play is not a failure, and counting it as one would make every
	// recent score look miscalibrated.
	const points: { score: number; reachedInterview: boolean; reachedOffer: boolean; rejected: boolean }[] = [];
	const seen = new Set<string>();
	for (const evaluation of evaluations) {
		if (evaluation.score === null || seen.has(evaluation.applicationId)) continue;
		seen.add(evaluation.applicationId);
		const application = byApplication.get(evaluation.applicationId);
		if (!application) continue;
		const times = stageTimes(application.activity);
		const reachedInterview = times.has("interview") || times.has("offer");
		const reachedOffer = times.has("offer") || application.status === "offer";
		const rejected = application.status === "rejected";
		const inFlight = !rejected && !reachedInterview;
		if (inFlight) continue;
		points.push({ score: evaluation.score, reachedInterview, reachedOffer, rejected });
	}

	const bands = SCORE_BANDS.map((band) => {
		const inBand = points.filter((point) => point.score >= band.min && point.score < band.max);
		const total = inBand.length;
		const interviews = inBand.filter((point) => point.reachedInterview).length;
		const offers = inBand.filter((point) => point.reachedOffer).length;
		return {
			band: band.label,
			total,
			interviews,
			offers,
			// Below the floor a rate is noise; the UI shows the raw counts instead.
			interviewRate: total >= SAMPLE_FLOOR ? interviews / total : null,
			insufficient: total < SAMPLE_FLOOR,
		};
	});

	return {
		bands,
		settled: points.length,
		excludedInFlight: seen.size - points.length,
		advisory:
			"Calibration compares your evaluation scores with what actually happened. It is advisory: it never changes how future evaluations are scored.",
	};
}

// --- Gap heatmap --------------------------------------------------------------------

export async function computeGapHeatmap(userId: string) {
	const evaluations = await loadCompleteEvaluations(userId);

	// Skills the user's resumes now carry, canonicalized — a gap the user has since closed
	// is shown as covered rather than silently dropped, so progress stays visible.
	const resumes = await db
		.select({ data: schema.resume.data })
		.from(schema.resume)
		.where(eq(schema.resume.userId, userId));
	const covered = new Set<string>();
	for (const resume of resumes) {
		const data = resume.data as { sections?: { skills?: { items?: { name?: string; keywords?: string[] }[] } } };
		for (const item of data.sections?.skills?.items ?? []) {
			for (const value of [item.name ?? "", ...(item.keywords ?? [])]) {
				if (value) covered.add(canonicalize(normalizeForMatching(value).trim()));
			}
		}
	}

	// Weight per evaluation: (5 − score) — a gap on a role you scored 2.0 against says more
	// about the market you want than one on a 4.8. Each gap counts once per evaluation.
	const entries = new Map<string, { skill: string; appearances: number; weight: number }>();
	for (const evaluation of evaluations) {
		const weight = 5 - (evaluation.score ?? 3);
		const gapNames = new Set<string>();
		for (const gap of evaluation.skillGap?.gap ?? []) gapNames.add(gap);
		for (const row of evaluation.requirements ?? []) {
			const unmet = row.match === "missing" || row.match === "partial";
			const important = row.importance === "critical" || row.importance === "high";
			if (unmet && important) gapNames.add(row.requirement);
		}
		for (const name of gapNames) {
			const key = canonicalize(normalizeForMatching(name).trim());
			const entry = entries.get(key) ?? { skill: name, appearances: 0, weight: 0 };
			entry.appearances += 1;
			entry.weight += weight;
			entries.set(key, entry);
		}
	}

	const heatmap = [...entries.entries()]
		.map(([key, entry]) => ({
			skill: entry.skill,
			appearances: entry.appearances,
			weight: Math.round(entry.weight * 10) / 10,
			nowCovered: covered.has(key),
		}))
		.sort((a, b) => b.weight - a.weight)
		.slice(0, 30);

	return { heatmap, evaluations: evaluations.length };
}

// --- Funnel velocity and channels ---------------------------------------------------

export async function computeFunnelVelocity(userId: string) {
	const applications = await loadApplications(userId);

	const transitions: Record<string, number[]> = {
		"applied→screening": [],
		"screening→interview": [],
		"interview→offer": [],
		"applied→rejected": [],
	};

	for (const application of applications) {
		const times = stageTimes(application.activity);
		const applied = times.get("applied");
		const screening = times.get("screening");
		const interview = times.get("interview");
		const offer = times.get("offer");
		const rejectedAt = times.get("rejected" as StageName);
		if (applied && screening) transitions["applied→screening"]?.push(daysBetween(applied, screening));
		if (screening && interview) transitions["screening→interview"]?.push(daysBetween(screening, interview));
		if (interview && offer) transitions["interview→offer"]?.push(daysBetween(interview, offer));
		if (applied && rejectedAt) transitions["applied→rejected"]?.push(daysBetween(applied, rejectedAt));
	}

	return Object.entries(transitions).map(([transition, values]) => ({
		transition,
		count: values.length,
		medianDays: values.length > 0 ? Math.round((median(values) ?? 0) * 10) / 10 : null,
	}));
}

export async function computeChannelStats(userId: string) {
	const applications = await loadApplications(userId);
	const byChannel = new Map<string, { total: number; screening: number; interviews: number; offers: number }>();

	for (const application of applications) {
		const channel = application.source?.trim() || "Direct / unknown";
		const entry = byChannel.get(channel) ?? { total: 0, screening: 0, interviews: 0, offers: 0 };
		entry.total += 1;
		const times = stageTimes(application.activity);
		const furthest = furthestStage(times);
		if (furthest && ["screening", "interview", "offer"].includes(furthest)) entry.screening += 1;
		if (furthest === "interview" || furthest === "offer") entry.interviews += 1;
		if (furthest === "offer") entry.offers += 1;
		byChannel.set(channel, entry);
	}

	return [...byChannel.entries()]
		.map(([channel, entry]) => ({
			channel,
			...entry,
			advanceRate: entry.total >= SAMPLE_FLOOR ? entry.screening / entry.total : null,
			insufficient: entry.total < SAMPLE_FLOOR,
		}))
		.sort((a, b) => b.total - a.total);
}

export async function computeRejectionPatterns(userId: string) {
	const applications = await loadApplications(userId);
	const rejected = applications.filter((application) => application.status === "rejected");

	const latencies: number[] = [];
	let beforeScreening = 0;
	const dropStage = new Map<string, number>();

	for (const application of rejected) {
		const times = stageTimes(application.activity);
		const applied = times.get("applied") ?? application.appliedAt;
		const rejectedAt = times.get("rejected" as StageName);
		if (applied && rejectedAt) latencies.push(daysBetween(applied, rejectedAt));
		const furthest = furthestStage(times) ?? "applied";
		if (furthest === "saved" || furthest === "applied") beforeScreening += 1;
		dropStage.set(furthest, (dropStage.get(furthest) ?? 0) + 1);
	}

	return {
		rejectedTotal: rejected.length,
		medianDaysToRejection: latencies.length > 0 ? Math.round((median(latencies) ?? 0) * 10) / 10 : null,
		rejectedBeforeScreeningShare:
			rejected.length >= SAMPLE_FLOOR ? Math.round((beforeScreening / rejected.length) * 100) / 100 : null,
		dropByStage: [...dropStage.entries()].map(([stage, count]) => ({ stage, count })),
		insufficient: rejected.length < SAMPLE_FLOOR,
	};
}
