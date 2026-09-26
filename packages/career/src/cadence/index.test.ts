import type { ExistingFollowUp, NextFollowUpInput, TimelineEntry } from "./index";
import { describe, expect, it } from "vitest";
import { DEFAULT_CADENCE, nextFollowUp } from "./index";

// Test cases translated from career-ops (MIT): tests/followup-cadence.test.mjs (the responded
// branch, #2268 cadence-config pinning, #3199 override effect) and test-all.mjs section 12
// ("Follow-up cadence logic": the urgency decision tree, next-date scheduling, impossible-date
// degradation, profile overrides, pin and retire directive semantics). Cases tied to the
// original's tracker/notes parsing (parseAppliedDate and its cross-reference heuristics,
// parseFollowups table/bullet formats, pin-line regexes, CLI flags, profile.yml loading) are not
// portable: the timeline types every stage transition with its own date and follow-ups are rows,
// so the rules those parsers fed are exercised directly here.

const d = (iso: string) => new Date(iso);

const stage = (name: string, at: string): TimelineEntry => ({ type: "stage", stage: name, at: d(at) });
const note = (text: string, at: string): TimelineEntry => ({ type: "note", text, at: d(at) });
const row = (kind: ExistingFollowUp["kind"], dueAt: Date, status: ExistingFollowUp["status"]): ExistingFollowUp => ({
	kind,
	dueAt,
	status,
});

const NOW = d("2026-07-01T12:00:00Z");

const base = (over: Partial<NextFollowUpInput> = {}): NextFollowUpInput => ({
	status: "applied",
	timeline: [stage("saved", "2026-04-20T10:00:00Z"), stage("applied", "2026-05-01T09:00:00Z")],
	existing: [],
	now: NOW,
	...over,
});

describe("DEFAULT_CADENCE", () => {
	it("matches the original's cadence table (applied 7/7 max 2, responded 1/3, thank-you 1)", () => {
		expect(DEFAULT_CADENCE).toEqual({
			appliedFirstDays: 7,
			appliedSubsequentDays: 7,
			maxApplied: 2,
			respondedInitialDays: 1,
			respondedSubsequentDays: 3,
			interviewThankYouDays: 1,
		});
	});
});

describe("applied cadence", () => {
	it("fresh applied schedules applied_first exactly appliedFirstDays after the applied entry", () => {
		// Original: computeNextFollowupDate('applied', '2026-05-01', null, 0) === '2026-05-08'
		// and addDays boundary check (test-all section 12). The anchor's time-of-day rides along.
		const result = nextFollowUp(base({ now: d("2026-05-02T00:00:00Z") }));
		expect(result?.kind).toBe("applied_first");
		expect(result?.dueAt.toISOString()).toBe("2026-05-08T09:00:00.000Z");
	});

	it("within the window the follow-up is scheduled, not already due (urgency 'waiting')", () => {
		// Original: computeUrgency('applied', 3, null, 0) === 'waiting'.
		const result = nextFollowUp(base({ now: d("2026-05-04T09:00:00Z") }));
		expect(result?.reason).not.toContain("Already due");
	});

	it("past the window the follow-up reports already due, with the dueAt NOT clamped to now", () => {
		// Original: computeUrgency('applied', 7, null, 0) === 'overdue', and the computed next
		// date stays appDate + applied_first however far in the past — urgency carries the
		// overdue-ness, the date is never rewritten.
		const result = nextFollowUp(base({ now: d("2026-06-30T00:00:00Z") }));
		expect(result?.dueAt.toISOString()).toBe("2026-05-08T09:00:00.000Z");
		expect(result?.reason).toContain("Already due.");
	});

	it("due exactly now is due (the original's >= overdue boundary)", () => {
		const result = nextFollowUp(base({ now: d("2026-05-08T09:00:00Z") }));
		expect(result?.reason).toContain("Already due.");
	});

	it("one sent follow-up schedules applied_subsequent exactly appliedSubsequentDays after it", () => {
		// Original: followupCount > 0 → lastFollowupDate + applied_subsequent.
		const result = nextFollowUp(
			base({ existing: [row("applied_first", d("2026-05-08T09:00:00Z"), "done")], now: d("2026-05-10T00:00:00Z") }),
		);
		expect(result?.kind).toBe("applied_subsequent");
		expect(result?.dueAt.toISOString()).toBe("2026-05-15T09:00:00.000Z");
	});

	it("anchors the subsequent follow-up on the LATEST sent applied-stage row", () => {
		const result = nextFollowUp(
			base({
				existing: [
					row("applied_subsequent", d("2026-05-20T09:00:00Z"), "done"),
					row("applied_first", d("2026-05-08T09:00:00Z"), "done"),
				],
				cadence: { maxApplied: 3 },
			}),
		);
		expect(result?.dueAt.toISOString()).toBe("2026-05-27T09:00:00.000Z");
	});

	it("returns null at maxApplied sent follow-ups (cold)", () => {
		// Original: computeNextFollowupDate('applied', appDate, null, 2) === null, and
		// analyzeFromContent classifying the app 'cold' at applied_max_followups (#2123).
		const result = nextFollowUp(
			base({
				existing: [
					row("applied_first", d("2026-05-08T09:00:00Z"), "done"),
					row("applied_subsequent", d("2026-05-15T09:00:00Z"), "done"),
				],
			}),
		);
		expect(result).toBeNull();
	});

	it("the cap counts SENT applied-kind rows only — dismissed rows were never sent", () => {
		// The dismissed row also may not suppress: the proposal (done + 7d = 2026-05-15) is
		// strictly later than the dismissal, so the schedule has moved past it.
		const result = nextFollowUp(
			base({
				existing: [
					row("applied_first", d("2026-05-08T09:00:00Z"), "done"),
					row("applied_subsequent", d("2026-05-10T09:00:00Z"), "dismissed"),
				],
			}),
		);
		expect(result?.kind).toBe("applied_subsequent");
		expect(result?.dueAt.toISOString()).toBe("2026-05-15T09:00:00.000Z");
	});

	it("a sent row with an unusable date still counts toward the cap but anchors nothing → null", () => {
		// Original: computeNextFollowupDate('applied', '2026-05-01', '2026-13-45', 1) degrades
		// to null through addDays(parseDate(bad)) — no crash, and no re-proposed first nudge
		// for a follow-up that WAS sent.
		const result = nextFollowUp(base({ existing: [row("applied_first", d("invalid"), "done")] }));
		expect(result).toBeNull();
	});

	it("returns null when the timeline has no applied stage entry", () => {
		// The analog of the original skipping a row whose applied date cannot be resolved
		// (`if (!appDate) continue`).
		expect(nextFollowUp(base({ timeline: [stage("saved", "2026-04-20T10:00:00Z")] }))).toBeNull();
	});

	it("an invalid applied-entry date degrades to null, no crash", () => {
		// Original: parseDate rejects impossible calendar dates (2026-13-45) so one bad row
		// cannot kill the analysis.
		expect(nextFollowUp(base({ timeline: [stage("applied", "invalid")] }))).toBeNull();
	});

	it("a re-entry into applied restarts the clock from the latest applied entry", () => {
		const result = nextFollowUp(
			base({
				timeline: [
					stage("applied", "2026-06-10T09:00:00Z"),
					stage("applied", "2026-05-01T09:00:00Z"),
					stage("rejected", "2026-05-20T09:00:00Z"),
				],
			}),
		);
		expect(result?.dueAt.toISOString()).toBe("2026-06-17T09:00:00.000Z");
	});

	it("note entries never anchor the cadence, whatever they say", () => {
		// The original mined notes for "Applied YYYY-MM-DD" (#2607/#4084); here the stage entry
		// is the system of record and notes are inert.
		const result = nextFollowUp(base({ timeline: [note("Applied 2026-04-01", "2026-04-01T09:00:00Z")] }));
		expect(result).toBeNull();
	});

	it("timeline stage names compare case-insensitively", () => {
		const result = nextFollowUp(base({ timeline: [stage("Applied", "2026-05-01T09:00:00Z")] }));
		expect(result?.kind).toBe("applied_first");
	});
});

describe("cadence config overrides", () => {
	it("honors a full override set", () => {
		// Original: resolveCadenceConfig reads profile.yml overrides (applied_first 11,
		// applied_subsequent 5, max 4, responded 2/6, thank-you 3 — test-all section 12).
		const cadence = {
			appliedFirstDays: 11,
			appliedSubsequentDays: 5,
			maxApplied: 4,
			respondedInitialDays: 2,
			respondedSubsequentDays: 6,
			interviewThankYouDays: 3,
		};
		const first = nextFollowUp(base({ cadence }));
		expect(first?.dueAt.toISOString()).toBe("2026-05-12T09:00:00.000Z");
		const subsequent = nextFollowUp(
			base({ cadence, existing: [row("applied_first", d("2026-05-12T09:00:00Z"), "done")] }),
		);
		expect(subsequent?.dueAt.toISOString()).toBe("2026-05-17T09:00:00.000Z");
	});

	it("a raised maxApplied keeps scheduling past the default cap", () => {
		// Original: the custom-cadence profile fixture sets applied_max_followups 5 (#2268 suite).
		const result = nextFollowUp(
			base({
				cadence: { maxApplied: 5 },
				existing: [
					row("applied_first", d("2026-05-08T09:00:00Z"), "done"),
					row("applied_subsequent", d("2026-05-15T09:00:00Z"), "done"),
				],
			}),
		);
		expect(result?.kind).toBe("applied_subsequent");
	});

	it("zero is a valid window (parseAppliedDaysOverride('0') is 0)", () => {
		const result = nextFollowUp(base({ cadence: { appliedFirstDays: 0 } }));
		expect(result?.dueAt.toISOString()).toBe("2026-05-01T09:00:00.000Z");
	});

	it("a malformed override keeps the default instead of taking a truncated effect", () => {
		// Original: positiveInteger treats NaN/negative as absent, and the whole-string flag
		// match rejects '1.5' rather than truncating it to 1 (#2401/#3196 defect class;
		// "resolveCadenceConfig falls back to the default when the override is rejected").
		for (const bad of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = nextFollowUp(base({ cadence: { appliedFirstDays: bad } }));
			expect(result?.dueAt.toISOString(), String(bad)).toBe("2026-05-08T09:00:00.000Z");
		}
	});

	it("a malformed profile-shaped override object falls back to the defaults wholesale", () => {
		// Original: "follow-up cadence ignores malformed optional profile config".
		const result = nextFollowUp(base({ cadence: { appliedFirstDays: -1, maxApplied: -1 } }));
		expect(result?.dueAt.toISOString()).toBe("2026-05-08T09:00:00.000Z");
	});
});

describe("terminal and unknown stages", () => {
	const timeline = [
		stage("applied", "2026-05-01T09:00:00Z"),
		stage("screening", "2026-05-10T09:00:00Z"),
		stage("interview", "2026-05-20T09:00:00Z"),
	];

	it("rejected schedules nothing", () => {
		expect(nextFollowUp(base({ status: "rejected", timeline }))).toBeNull();
	});

	it("offer schedules nothing (never in the original's ACTIONABLE_STATUSES)", () => {
		expect(nextFollowUp(base({ status: "offer", timeline }))).toBeNull();
	});

	it("saved schedules nothing (no submission yet)", () => {
		expect(nextFollowUp(base({ status: "saved", timeline: [stage("saved", "2026-04-20T09:00:00Z")] }))).toBeNull();
	});

	it("an unknown stage string schedules nothing", () => {
		expect(nextFollowUp(base({ status: "mülakat", timeline }))).toBeNull();
	});

	it("the current stage compares case-insensitively", () => {
		// Original: normalizeStatus folds case before matching ('**Applied** 2026-05-01' →
		// 'applied'); the alias table itself does not port — the stage enum is the single
		// source here, the same one-source rule that motivated deriving it (#2704).
		expect(nextFollowUp(base({ status: " Applied " }))?.kind).toBe("applied_first");
	});
});

describe("open rows block new ones", () => {
	it("a pending follow-up means no duplicate is proposed", () => {
		const result = nextFollowUp(base({ existing: [row("applied_first", d("2026-05-08T09:00:00Z"), "pending")] }));
		expect(result).toBeNull();
	});

	it("a snoozed follow-up defers — no new one until it resolves", () => {
		// The pin analog: resolveNextOverride gives an active pin precedence over the computed
		// cadence until a follow-up logged after it resumes the schedule.
		const result = nextFollowUp(base({ existing: [row("applied_first", d("2026-06-20T09:00:00Z"), "snoozed")] }));
		expect(result).toBeNull();
	});

	it("a pending custom row blocks too (the hand-written pin's row form)", () => {
		const result = nextFollowUp(base({ existing: [row("custom", d("2026-07-10T09:00:00Z"), "pending")] }));
		expect(result).toBeNull();
	});

	it("done and dismissed rows do not block by mere existence", () => {
		const result = nextFollowUp(
			base({
				existing: [
					row("applied_first", d("2026-05-08T09:00:00Z"), "done"),
					row("custom", d("2026-05-02T09:00:00Z"), "dismissed"),
				],
			}),
		);
		expect(result?.kind).toBe("applied_subsequent");
	});
});

describe("responded cadence (screening)", () => {
	const timeline = [stage("applied", "2026-05-01T09:00:00Z"), stage("screening", "2026-06-30T09:00:00Z")];

	it("first touch after a response is due respondedInitialDays after the screening entry", () => {
		// Original (tests/followup-cadence.test.mjs): "responded, no prior follow-up uses
		// responded_initial" — before that fix the initial window was only read by
		// computeUrgency and never reached the scheduled date.
		const result = nextFollowUp(base({ status: "screening", timeline }));
		expect(result?.kind).toBe("responded");
		expect(result?.dueAt.toISOString()).toBe("2026-07-01T09:00:00.000Z");
	});

	it("within the initial window the reply is scheduled, not already due (urgency 'urgent')", () => {
		// Original: computeUrgency('responded', 0, null, 0) === 'urgent' — the reply is wanted
		// within a day, so its date sits in the near future rather than overdue.
		const result = nextFollowUp(base({ status: "screening", timeline, now: d("2026-06-30T12:00:00Z") }));
		expect(result?.reason).not.toContain("Already due");
	});

	it("a logged touch clears overdue and restarts the clock at respondedSubsequentDays", () => {
		// Original: "responded, with prior follow-up uses responded_subsequent" and
		// computeUrgency('responded', 5, 1, 1) === 'waiting' (a logged follow-up clears overdue).
		const result = nextFollowUp(
			base({
				status: "screening",
				timeline,
				existing: [row("responded", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-02T09:00:00Z"),
			}),
		);
		expect(result?.kind).toBe("responded");
		expect(result?.dueAt.toISOString()).toBe("2026-07-04T09:00:00.000Z");
		expect(result?.reason).not.toContain("Already due");
	});

	it("re-overdue respondedSubsequentDays after the last touch", () => {
		// Original: computeUrgency('responded', 5, 3, 1) === 'overdue'.
		const result = nextFollowUp(
			base({
				status: "screening",
				timeline,
				existing: [row("responded", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-04T09:00:00Z"),
			}),
		);
		expect(result?.reason).toContain("Already due.");
	});

	it("the initial touch never lands after the overdue threshold", () => {
		// Original: "initial next follow-up is not later than the overdue threshold" — a date
		// meant to trigger 'overdue' cannot sit beyond the threshold that declares it.
		const initial = nextFollowUp(base({ status: "screening", timeline }));
		const threshold = d("2026-06-30T09:00:00Z").getTime() + DEFAULT_CADENCE.respondedSubsequentDays * 86_400_000;
		expect(initial !== null && initial.dueAt.getTime() <= threshold).toBe(true);
	});

	it("an applied-era nudge from before the response does not satisfy the reply", () => {
		// Re-expression: the original anchored 'responded' on the application date and restarted
		// the clock from ANY last follow-up, so a stale applied nudge could stand in for the
		// reply a fresh response calls for. The screening entry scopes which touches belong to
		// the responded phase.
		const result = nextFollowUp(
			base({
				status: "screening",
				timeline,
				existing: [row("applied_first", d("2026-05-08T09:00:00Z"), "done")],
			}),
		);
		expect(result?.dueAt.toISOString()).toBe("2026-07-01T09:00:00.000Z");
	});

	it("any done row on/after the response counts as a touch, custom included", () => {
		// Original semantic: the clock restarts from the last logged follow-up whatever it was.
		const result = nextFollowUp(
			base({
				status: "screening",
				timeline,
				existing: [row("custom", d("2026-07-02T09:00:00Z"), "done")],
			}),
		);
		expect(result?.dueAt.toISOString()).toBe("2026-07-05T09:00:00.000Z");
	});

	it("returns null when the timeline has no screening entry", () => {
		expect(nextFollowUp(base({ status: "screening" }))).toBeNull();
	});
});

describe("interview cadence", () => {
	const timeline = [
		stage("applied", "2026-05-01T09:00:00Z"),
		stage("screening", "2026-05-10T09:00:00Z"),
		stage("interview", "2026-06-30T09:00:00Z"),
	];

	it("schedules the thank-you exactly interviewThankYouDays after the interview entry", () => {
		// Original: computeNextFollowupDate('interview', '2026-05-01', null, 0) === '2026-05-02'
		// — anchored on the application date only as a proxy, because the tracker had no
		// per-stage dates; the interview stage entry is the date that proxy stood in for
		// (modes/followup.md: "Interview | 1 day after (thank-you)").
		const result = nextFollowUp(base({ status: "interview", timeline }));
		expect(result?.kind).toBe("post_interview_thanks");
		expect(result?.dueAt.toISOString()).toBe("2026-07-01T09:00:00.000Z");
	});

	it("past the thank-you window with none sent it is already due", () => {
		// Original: computeUrgency('interview', 1, null, 0) === 'overdue'.
		const result = nextFollowUp(base({ status: "interview", timeline, now: d("2026-07-01T09:00:00Z") }));
		expect(result?.reason).toContain("Already due.");
	});

	it("after the thank-you, touches follow the responded cadence as kind 'responded'", () => {
		// Original: computeNextFollowupDate('interview', '2026-05-01', '2026-05-02', 1) ===
		// '2026-05-05' — "After the thank-you is logged, subsequent touches follow the responded
		// cadence (modes/followup.md: 'Every 3 days · No limit')".
		const result = nextFollowUp(
			base({
				status: "interview",
				timeline,
				existing: [row("post_interview_thanks", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-01T12:00:00Z"),
			}),
		);
		expect(result?.kind).toBe("responded");
		expect(result?.dueAt.toISOString()).toBe("2026-07-04T09:00:00.000Z");
	});

	it("a logged thank-you clears overdue; the cadence lapses again after respondedSubsequentDays", () => {
		// Original: computeUrgency('interview', 5, 0, 1) === 'waiting' and
		// computeUrgency('interview', 9, 4, 1) === 'overdue'.
		const cleared = nextFollowUp(
			base({
				status: "interview",
				timeline,
				existing: [row("post_interview_thanks", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-01T10:00:00Z"),
			}),
		);
		expect(cleared?.reason).not.toContain("Already due");
		const lapsed = nextFollowUp(
			base({
				status: "interview",
				timeline,
				existing: [row("post_interview_thanks", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-05T09:00:00Z"),
			}),
		);
		expect(lapsed?.reason).toContain("Already due.");
	});

	it("a fresh interview entry schedules a fresh thank-you — an old round's does not cover it", () => {
		const twoRounds = [...timeline, stage("interview", "2026-07-10T09:00:00Z")];
		const result = nextFollowUp(
			base({
				status: "interview",
				timeline: twoRounds,
				existing: [row("post_interview_thanks", d("2026-07-01T09:00:00Z"), "done")],
				now: d("2026-07-10T12:00:00Z"),
			}),
		);
		expect(result?.kind).toBe("post_interview_thanks");
		expect(result?.dueAt.toISOString()).toBe("2026-07-11T09:00:00.000Z");
	});

	it("returns null when the timeline has no interview entry", () => {
		expect(nextFollowUp(base({ status: "interview" }))).toBeNull();
	});
});

describe("dismissal (the retire-directive analog)", () => {
	// Original retire semantics (test-all section 12, isRetired): the directive drops the
	// application out of the cadence, a same-day tie favors the retirement, and a follow-up
	// logged after it revives the schedule.

	it("a dismissed row of the same kind at the proposed date suppresses it (tie favors the dismissal)", () => {
		const result = nextFollowUp(base({ existing: [row("applied_first", d("2026-05-08T09:00:00Z"), "dismissed")] }));
		expect(result).toBeNull();
	});

	it("a dismissed row later than the proposal suppresses it too", () => {
		const result = nextFollowUp(base({ existing: [row("applied_first", d("2026-06-01T09:00:00Z"), "dismissed")] }));
		expect(result).toBeNull();
	});

	it("a touch logged after the dismissal revives the cadence", () => {
		// The proposal moves to lastTouch + subsequent, strictly past the dismissal — the
		// original's "re-engaging a retired application resumes its normal cadence with no
		// bookkeeping".
		const timeline = [stage("applied", "2026-05-01T09:00:00Z"), stage("screening", "2026-06-01T09:00:00Z")];
		const suppressed = nextFollowUp(
			base({ status: "screening", timeline, existing: [row("responded", d("2026-06-02T09:00:00Z"), "dismissed")] }),
		);
		expect(suppressed).toBeNull();
		const revived = nextFollowUp(
			base({
				status: "screening",
				timeline,
				existing: [
					row("responded", d("2026-06-02T09:00:00Z"), "dismissed"),
					row("responded", d("2026-06-05T09:00:00Z"), "done"),
				],
			}),
		);
		expect(revived?.dueAt.toISOString()).toBe("2026-06-08T09:00:00.000Z");
	});

	it("a fresh interview anchor revives a dismissed thank-you", () => {
		const timeline = [stage("applied", "2026-05-01T09:00:00Z"), stage("interview", "2026-06-15T09:00:00Z")];
		const suppressed = nextFollowUp(
			base({
				status: "interview",
				timeline,
				existing: [row("post_interview_thanks", d("2026-06-16T09:00:00Z"), "dismissed")],
			}),
		);
		expect(suppressed).toBeNull();
		const revived = nextFollowUp(
			base({
				status: "interview",
				timeline: [...timeline, stage("interview", "2026-06-25T09:00:00Z")],
				existing: [row("post_interview_thanks", d("2026-06-16T09:00:00Z"), "dismissed")],
			}),
		);
		expect(revived?.kind).toBe("post_interview_thanks");
		expect(revived?.dueAt.toISOString()).toBe("2026-06-26T09:00:00.000Z");
	});

	it("a dismissal of a different kind does not suppress the proposal", () => {
		const result = nextFollowUp(base({ existing: [row("custom", d("2026-06-01T09:00:00Z"), "dismissed")] }));
		expect(result?.kind).toBe("applied_first");
	});
});
