/**
 * Follow-up cadence, ported from career-ops' `followup-cadence.mjs` (MIT) — the
 * `computeNextFollowupDate` / `computeUrgency` rules re-shaped as one pure function over this
 * app's data model: a stage enum, a timeline of stage entries, and stored follow-up rows.
 *
 * What is ported faithfully:
 *   - The default cadence table (modes/followup.md "Cadence Rules Reference"): applied — first
 *     follow-up 7 days after applying, then every 7 days, at most 2 before the application is
 *     cold; responded — reply within 1 day, then every 3 days, no limit; interview — thank-you
 *     within 1 day, then every 3 days, no limit. Post-thank-you interview touches follow the
 *     RESPONDED cadence, exactly as the original comments it ("After the thank-you is logged,
 *     subsequent touches follow the responded cadence"), so they are scheduled as kind
 *     "responded".
 *   - Actionability: only applied/responded/interview states get follow-ups (the original's
 *     ACTIONABLE_STATUSES). career-ops' Applied/Responded/Interview map to this app's
 *     applied/screening/interview — screening counts as "responded" because a company response
 *     is what moves an application there. rejected and offer (like the original's rejected /
 *     offer / hired / discarded) and saved (no submission yet) schedule nothing.
 *   - Clock restarts from the last touch: a logged follow-up clears overdue and the next touch
 *     is `last + subsequent` (per-state), with a `done` row's `dueAt` standing in for the sent
 *     date the original logged.
 *   - The cold cap counts SENT follow-ups only: `done` applied-kind rows, never dismissed ones —
 *     the original counted rows of its append-only sent log, and a dismissed row was never sent.
 *   - Override validation (#2401/#3196 defect class): a cadence override that is not a
 *     non-negative integer silently keeps the default, the same fate the original gave a
 *     malformed profile value or `--applied-days 1.5` — 0 is valid, like the original's
 *     `positiveInteger` / `parseAppliedDaysOverride('0')`.
 *   - Past due dates are NOT clamped to now: the original returns `appDate + N` however long ago
 *     that is and lets urgency call it overdue. `now` only flavors the reason text, the way the
 *     original's `computeUrgency` reported urgent/overdue/waiting alongside the date.
 *   - Impossible dates degrade to null, never crash (the original's parseDate/addDays null
 *     chain): an invalid anchor or row date is skipped, and no schedulable anchor means null.
 *   - Day arithmetic is UTC calendar-day based (setUTCDate), the original's deliberate choice
 *     (#3070) — here on full timestamps, so the anchor's time-of-day is preserved instead of
 *     truncated to the markdown tracker's day strings.
 *   - There is no weekend or business-day handling; the original has none.
 *
 * What is re-expressed rather than ported:
 *   - Anchors come from timeline stage entries, not from tracker parsing. The original mined the
 *     Notes column for "Applied YYYY-MM-DD" (with `~` estimates, cross-reference and
 *     requisition-hash heuristics — #2607/#4084/#4143) because the tracker had no per-stage
 *     dates, and fell back to the evaluation-date column; it anchored responded/interview on the
 *     APPLICATION date as a proxy for the same reason. This timeline types every transition with
 *     its own date, so the applied cadence anchors on the latest "applied" stage entry, the
 *     responded cadence on the latest "screening" entry, and the thank-you on the latest
 *     "interview" entry — the dates the original's proxies were standing in for. A row in an
 *     actionable stage whose timeline lacks the matching entry yields null, the analog of the
 *     original skipping a row with no parseable date. Note entries are never read.
 *   - Status aliases: the original derived its alias map from templates/states.yml rather than
 *     hand-copying it (#2704, "one file and every consumer follows"). Here the stage enum IS the
 *     single source, so there is no alias table to derive — stages compare case-insensitively
 *     and anything else is not actionable.
 *   - Pins (`- next #N …`) and retire directives (`- cleared #N …`) become row statuses. A
 *     `pending` row is the schedule entry itself, so no second one is proposed; a `snoozed` row
 *     is the user's deferral — like a pin it outranks the computed cadence until it resolves. A
 *     `dismissed` row is the retire analog: the same kind is not re-proposed at or before the
 *     dismissed date (ties favor the dismissal, the original's same-day rule), and the cadence
 *     revives only when the schedule moves past it — a later touch or a later anchor, mirroring
 *     "a follow-up logged after the retirement resumes the normal schedule".
 *   - The applied cap and anchor read applied-kind rows only; responded/interview touches count
 *     any `done` row on/after their stage anchor. The original counted every logged follow-up
 *     per application because its log had no kinds; kinds scope the same rules to the phase they
 *     belong to, so an applied-era nudge cannot satisfy the reply a fresh response calls for.
 *   - Contact extraction, `via` agency routing, report-path resolution and the urgency SORT are
 *     presentation concerns of the original's CLI dashboard and stay behind.
 */

import type {
	CadenceConfig,
	ExistingFollowUp,
	FollowUpKind,
	NextFollowUp,
	NextFollowUpInput,
	TimelineEntry,
} from "./types";

export type {
	CadenceConfig,
	ExistingFollowUp,
	FollowUpKind,
	NextFollowUp,
	NextFollowUpInput,
	TimelineEntry,
} from "./types";

// The original's DEFAULT_CADENCE, key for key (applied_first 7, applied_subsequent 7,
// applied_max_followups 2, responded_initial 1, responded_subsequent 3, interview_thankyou 1).
export const DEFAULT_CADENCE: CadenceConfig = {
	appliedFirstDays: 7,
	appliedSubsequentDays: 7,
	maxApplied: 2,
	respondedInitialDays: 1,
	respondedSubsequentDays: 3,
	interviewThankYouDays: 1,
};

// --- Config resolution ----------------------------------------------------------------

// The original's resolveCadenceConfig merge (defaults, then overrides), with its
// positiveInteger validation: a value that is not a non-negative integer is treated as absent
// and keeps the default. Whole-integer, not a truncating parse — parseInt('1.5') is 1 and
// parseInt('10days') is 10, the silent-wrong-answer shape #2401/#3196 closed; here the
// numeric analog rejects 1.5, NaN and Infinity the same way. Zero is valid ("0" passed
// parseAppliedDaysOverride), and negatives are not ("no negative window").
function resolveCadence(overrides: Partial<CadenceConfig> | undefined): CadenceConfig {
	const cadence = { ...DEFAULT_CADENCE };
	if (!overrides) return cadence;
	for (const key of Object.keys(DEFAULT_CADENCE) as (keyof CadenceConfig)[]) {
		const value = overrides[key];
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) cadence[key] = value;
	}
	return cadence;
}

// --- Date helpers ---------------------------------------------------------------------

// An Invalid Date is TRUTHY, the exact trap the original's parseDate guards against
// (2026-13-45 matched its regex, slipped `if (!date)`, and addDays().toISOString() threw,
// killing the whole analysis over one bad row). Every date read from the input passes
// through this check so a bad row degrades instead of crashing.
function isUsableDate(date: Date): boolean {
	return date instanceof Date && !Number.isNaN(date.getTime());
}

// UTC calendar-day arithmetic, the original's addDays (#3070): setUTCDate so month and year
// roll correctly. On a full timestamp the time-of-day rides along unchanged.
function addDays(date: Date, days: number): Date {
	const result = new Date(date.getTime());
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

/** The UTC day of `date`, for reason strings. */
function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

// --- Anchor and row selection ---------------------------------------------------------

/** The `at` of the LATEST stage entry for `stage` (compared case-insensitively), or null.
 * Latest, not first: a typed timeline has one entry per transition, and a re-entry into a
 * stage restarts its clock — the same effect as the original's followup-seed re-seeding an
 * application that turns Applied again. Invalid dates are skipped (degrade, don't crash). */
function latestStageAt(timeline: readonly TimelineEntry[], stage: string): Date | null {
	let latest: Date | null = null;
	for (const entry of timeline) {
		if (entry.type !== "stage") continue;
		if (entry.stage.trim().toLowerCase() !== stage) continue;
		if (!isUsableDate(entry.at)) continue;
		if (latest === null || entry.at.getTime() > latest.getTime()) latest = entry.at;
	}
	return latest;
}

/** The row with the latest dueAt. Callers guarantee `rows` is non-empty and every dueAt usable. */
function latestByDueAt(rows: readonly ExistingFollowUp[]): ExistingFollowUp {
	let latest = rows[0] as ExistingFollowUp;
	for (const row of rows) {
		if (row.dueAt.getTime() > latest.dueAt.getTime()) latest = row;
	}
	return latest;
}

/** Whether the user already dismissed this proposal: a dismissed row of the SAME kind due at
 * or after the computed date. The retire-directive analog — re-creating the row the user threw
 * away would make dismissal impossible, and the tie favors the dismissal exactly as the
 * original's same-day tie favors the retirement (isRetired: "log a final follow-up, then
 * retire"). A proposal strictly LATER than every same-kind dismissal goes through, which is
 * the revival rule: a later touch or a later stage anchor moves the schedule past the
 * dismissal, like a follow-up logged after a `cleared` directive resuming the cadence. */
function dismissedAtOrAfter(existing: readonly ExistingFollowUp[], kind: FollowUpKind, dueAt: Date): boolean {
	return existing.some(
		(row) =>
			row.status === "dismissed" &&
			row.kind === kind &&
			isUsableDate(row.dueAt) &&
			row.dueAt.getTime() >= dueAt.getTime(),
	);
}

// --- The cadence ----------------------------------------------------------------------

const APPLIED_KINDS: readonly FollowUpKind[] = ["applied_first", "applied_subsequent"];

/**
 * The one follow-up the cadence would schedule next for this application, or null.
 *
 * The decision order mirrors the original's analysis loop: actionability first (its
 * ACTIONABLE_STATUSES gate), then open rows (its pins outranking the computed schedule), then
 * the per-state rule (computeNextFollowupDate), then the dismissal check (its retirement
 * outranking everything a computed date could say). A returned dueAt may be in the past —
 * that means "already due", never an error, matching the original reporting a long-overdue
 * next date rather than clamping it to today.
 */
export function nextFollowUp(input: NextFollowUpInput): NextFollowUp | null {
	const cadence = resolveCadence(input.cadence);
	const stage = input.status.trim().toLowerCase();

	// Terminal and unknown stages schedule nothing. offer joins rejected here without an
	// explicit callout in the original: its ACTIONABLE_STATUSES simply never included
	// offer/hired, so an offer-stage application already got no automated follow-ups.
	if (stage !== "applied" && stage !== "screening" && stage !== "interview") return null;

	// An open row blocks a new one. pending: the schedule entry already exists, and proposing
	// another would duplicate it. snoozed: the user's deferral — the pin analog — holds until
	// it resolves ("a pin takes precedence over the computed cadence").
	if (input.existing.some((row) => row.status === "pending" || row.status === "snoozed")) return null;

	const done = input.existing.filter((row) => row.status === "done");

	let candidate: NextFollowUp;
	if (stage === "applied") {
		const appliedDone = done.filter((row) => APPLIED_KINDS.includes(row.kind));
		// The cold cap: applied_max_followups SENT applied-stage follow-ups and the application
		// stops being nudged (the original suggests closing it instead). A sent follow-up with
		// an unusable date still counts — it was sent; only its date is lost.
		if (appliedDone.length >= cadence.maxApplied) return null;
		if (appliedDone.length === 0) {
			const appliedAt = latestStageAt(input.timeline, "applied");
			if (appliedAt === null) return null;
			candidate = {
				kind: "applied_first",
				dueAt: addDays(appliedAt, cadence.appliedFirstDays),
				reason:
					`Applied ${isoDay(appliedAt)} with no follow-up sent yet; ` +
					`the first nudge is due ${cadence.appliedFirstDays} day(s) after the application.`,
			};
		} else {
			// last + applied_subsequent, from the last SENT applied-stage follow-up. Nothing can
			// be anchored on a sent row whose date is unusable: the original's
			// addDays(parseDate(bad)) chain returned null here rather than crashing or
			// re-proposing the first nudge for a follow-up that WAS sent ("computeNextFollowupDate
			// degrades to null on an impossible logged date (no crash)").
			const usable = appliedDone.filter((row) => isUsableDate(row.dueAt));
			if (usable.length === 0) return null;
			const last = latestByDueAt(usable);
			candidate = {
				kind: "applied_subsequent",
				dueAt: addDays(last.dueAt, cadence.appliedSubsequentDays),
				reason:
					`${appliedDone.length} of ${cadence.maxApplied} applied-stage follow-ups sent; ` +
					`the next is due ${cadence.appliedSubsequentDays} day(s) after the last one (${isoDay(last.dueAt)}).`,
			};
		}
	} else if (stage === "screening") {
		const respondedAt = latestStageAt(input.timeline, "screening");
		if (respondedAt === null) return null;
		// Touches on/after the response. Any done kind counts — the original restarts the clock
		// from the last logged follow-up whatever it was — but an applied-era nudge from before
		// the response belongs to the applied cadence and cannot satisfy the reply this state
		// calls for (the anchor scoping the original's application-date proxy could not do).
		const touches = done.filter((row) => isUsableDate(row.dueAt) && row.dueAt.getTime() >= respondedAt.getTime());
		if (touches.length === 0) {
			candidate = {
				kind: "responded",
				dueAt: addDays(respondedAt, cadence.respondedInitialDays),
				reason:
					`The company responded (screening since ${isoDay(respondedAt)}); ` +
					`the responded cadence asks for a reply within ${cadence.respondedInitialDays} day(s).`,
			};
		} else {
			const last = latestByDueAt(touches);
			candidate = {
				kind: "responded",
				dueAt: addDays(last.dueAt, cadence.respondedSubsequentDays),
				reason:
					`Last touch ${isoDay(last.dueAt)}; ` +
					`the responded cadence re-touches every ${cadence.respondedSubsequentDays} day(s), no limit.`,
			};
		}
	} else {
		const interviewAt = latestStageAt(input.timeline, "interview");
		if (interviewAt === null) return null;
		// Touches on/after the LATEST interview entry: a thank-you sent for an earlier round
		// does not cover a new one, so a fresh interview entry schedules a fresh thank-you.
		const touches = done.filter((row) => isUsableDate(row.dueAt) && row.dueAt.getTime() >= interviewAt.getTime());
		if (touches.length === 0) {
			candidate = {
				kind: "post_interview_thanks",
				dueAt: addDays(interviewAt, cadence.interviewThankYouDays),
				reason:
					`Interview on ${isoDay(interviewAt)}; ` +
					`a thank-you is due within ${cadence.interviewThankYouDays} day(s).`,
			};
		} else {
			// "After the thank-you is logged, subsequent touches follow the responded cadence"
			// (modes/followup.md: "Every 3 days · No limit") — hence kind "responded".
			const last = latestByDueAt(touches);
			candidate = {
				kind: "responded",
				dueAt: addDays(last.dueAt, cadence.respondedSubsequentDays),
				reason:
					`Post-interview touch logged ${isoDay(last.dueAt)}; ` +
					`later touches follow the responded cadence, every ${cadence.respondedSubsequentDays} day(s).`,
			};
		}
	}

	if (dismissedAtOrAfter(input.existing, candidate.kind, candidate.dueAt)) return null;

	// The original never clamps a past date — urgency reports it overdue instead. The reason
	// carries that classification (computeUrgency's `>=` boundary: due exactly now is due).
	if (isUsableDate(input.now) && candidate.dueAt.getTime() <= input.now.getTime()) {
		candidate.reason += " Already due.";
	}
	return candidate;
}
