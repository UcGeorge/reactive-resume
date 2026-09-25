/**
 * The two posting-legitimacy signals that are pure arithmetic on the posting's own stated
 * numbers — no jurisdiction lookup, no legal threshold, no statute. Everything ambiguous is
 * skipped (returns null), never guessed: absence of a signal is not a verdict.
 *
 * Ported from career-ops' oferta Block G signals 13–14. Phrasing discipline carries over:
 * findings state observable facts about the posting's numbers, never a legal conclusion.
 */

export type CompensationBounds = {
	/** Lower bound, already normalized to the same period and currency as `upper`. */
	lower: number;
	upper: number;
	/** ISO-ish currency label, only used for rendering the note. */
	currency: string;
	/** The period both bounds are stated in, for the note. */
	period: string;
};

export type PayRangeWidthFinding = {
	width: number;
	/** The `width > 0.5 × lower` ratio that fired. */
	ratio: number;
	note: string;
};

/**
 * "Unusually wide" range heuristic: flag when the range's width (top minus bottom) exceeds
 * half of its own bottom bound. Requires both bounds present, same currency/period, and a
 * strictly positive lower bound — anything else skips (null) rather than guessing. Not a
 * legal cap; it implies no jurisdiction's disclosure law was consulted.
 */
export function payRangeWidthSignal(bounds: CompensationBounds): PayRangeWidthFinding | null {
	const { lower, upper } = bounds;
	if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
	if (lower <= 0 || upper <= lower) return null;

	const width = upper - lower;
	if (width <= 0.5 * lower) return null;

	const ratio = width / lower;
	return {
		width,
		ratio,
		note:
			`This advertised range is ${bounds.currency} ${width.toLocaleString("en-US")} wide on a ` +
			`${bounds.currency} ${lower.toLocaleString("en-US")} floor (${bounds.period}) — more than half the floor. ` +
			"Unusually wide ranges often mean the actual band for the level is undecided or the posting is " +
			"templated/aggregated; consider asking the recruiter for the real band for this level. " +
			"This is a general heuristic applied to the posting's own numbers, not a legal threshold, " +
			"and it is an observation about the posting, not legal advice.",
	};
}

/** Fall back to 52 weeks × 40 hours only when the JD states no hours figure. */
export const DEFAULT_ANNUAL_HOURS = 2080;

export type FixedCompensation = {
	/** A guaranteed, fixed cash amount — never a range, bonus, commission or allowance. */
	amount: number;
	period: "hourly" | "monthly" | "annual";
	currency: string;
	/** Weekly hours the JD itself states, when it does. */
	statedHoursPerWeek?: number | undefined;
};

export type HourlyRateFinding = {
	hourly: number;
	/** Which hours figure the conversion used — always disclosed. */
	hoursBasis: "jd-stated" | "2080-fallback" | "already-hourly";
	note: string;
};

/**
 * Convert a fixed cash amount into a comparable hourly rate. Never asserts or compares
 * against any minimum-wage figure — that question belongs to a lawyer or an official source.
 * Returns null (skip) when the amount is not positive or the hours figure is unusable.
 */
export function hourlyRateSignal(compensation: FixedCompensation): HourlyRateFinding | null {
	const { amount, period, currency } = compensation;
	if (!Number.isFinite(amount) || amount <= 0) return null;

	if (period === "hourly") {
		return {
			hourly: amount,
			hoursBasis: "already-hourly",
			note: `The posting's fixed compensation is already stated hourly: ${currency} ${amount.toLocaleString("en-US")}/hour.`,
		};
	}

	const statedHours = compensation.statedHoursPerWeek;
	if (statedHours !== undefined && (!Number.isFinite(statedHours) || statedHours <= 0)) return null;

	const annualHours = statedHours === undefined ? DEFAULT_ANNUAL_HOURS : statedHours * 52;
	const annualAmount = period === "monthly" ? amount * 12 : amount;
	const hourly = annualAmount / annualHours;
	const hoursBasis = statedHours === undefined ? "2080-fallback" : "jd-stated";

	return {
		hourly,
		hoursBasis,
		note:
			`Converted the posting's fixed ${period} compensation (${currency} ${amount.toLocaleString("en-US")}) to about ` +
			`${currency} ${hourly.toFixed(2)}/hour using ` +
			(hoursBasis === "jd-stated"
				? `the JD's own stated ${statedHours} hours/week.`
				: "the conservative 2080 hours/year fallback (52 weeks × 40 hours) because the JD states no hours figure.") +
			" Whether this satisfies any minimum-wage requirement is a question for a lawyer or an official source.",
	};
}
