/** Follow-up cadence windows, in whole days. Field-for-field the original's `DEFAULT_CADENCE`
 * keys (`applied_first`, `applied_subsequent`, `applied_max_followups`, `responded_initial`,
 * `responded_subsequent`, `interview_thankyou`), renamed to this package's camelCase. */
export type CadenceConfig = {
	/** Days after the application before the first applied-stage follow-up. */
	appliedFirstDays: number;
	/** Days after the last sent applied-stage follow-up before the next one. */
	appliedSubsequentDays: number;
	/** Sent applied-stage follow-ups after which the application is cold — no more are scheduled. */
	maxApplied: number;
	/** Days after a company response before the reply touch ("urgent" in the original's urgency model). */
	respondedInitialDays: number;
	/** Days after the last touch before the next responded-cadence touch (also the post-thank-you
	 * interview cadence — the original: "after the thank-you … subsequent touches follow the
	 * responded cadence"). */
	respondedSubsequentDays: number;
	/** Days after an interview before the thank-you note. */
	interviewThankYouDays: number;
};

/** What a scheduled follow-up is for. `custom` is never produced by `nextFollowUp` — it is the
 * user's own row (the analog of the original's hand-written pin lines), and only participates
 * through the blocking rules. Post-thank-you interview touches are kind `responded`, because the
 * original routes them through the responded cadence. */
export type FollowUpKind = "applied_first" | "applied_subsequent" | "post_interview_thanks" | "responded" | "custom";

/** A follow-up row already stored for the application. `done` rows are the analog of the
 * original's sent-follow-up log (their `dueAt` stands in for the sent date, the only date the
 * row model carries); `pending`/`snoozed` rows are open schedule entries; `dismissed` rows are
 * follow-ups the user threw away. */
export type ExistingFollowUp = {
	kind: FollowUpKind;
	dueAt: Date;
	status: "pending" | "done" | "snoozed" | "dismissed";
};

/** One entry of the application's timeline: a stage transition or a free-form note. Notes are
 * ignored by the cadence — see the module header on what replaced the original's note-mining. */
export type TimelineEntry = { type: "stage"; stage: string; at: Date } | { type: "note"; text: string; at: Date };

export type NextFollowUpInput = {
	/** The application's current stage ("saved" | "applied" | "screening" | "interview" | "offer"
	 * | "rejected"; compared case-insensitively, unknown values are simply not actionable). */
	status: string;
	/** The application's timeline; only `stage` entries are read, as cadence anchors. */
	timeline: readonly TimelineEntry[];
	/** Follow-up rows already stored for this application. */
	existing: readonly ExistingFollowUp[];
	/** Overrides merged over `DEFAULT_CADENCE`; an entry that is not a non-negative integer keeps
	 * the default, like the original's profile/CLI override validation (#2401, #3196). */
	cadence?: Partial<CadenceConfig>;
	/** The evaluation instant. Scheduling never reads it — a computed dueAt in the past is
	 * reported as-is, matching the original — it only flavors `reason` with "already due". */
	now: Date;
};

/** The one follow-up the cadence would schedule next, or null when nothing should be scheduled
 * (terminal/unknown stage, an open row, the cap, a dismissal, or an unusable anchor date). */
export type NextFollowUp = {
	kind: FollowUpKind;
	dueAt: Date;
	reason: string;
};
