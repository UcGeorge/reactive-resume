/**
 * Deterministic enforcement of the evaluation's anti-anchoring rules (ported from
 * career-ops' oferta Block B).
 *
 * Importance is graded from the JD alone, before the resume is ever read, so a model that has
 * just written "strong match" cannot anchor toward rating that requirement important. The
 * gate below is what makes the labelled `inferred` tier safe: importance can only create
 * obligations when it is JD-stated or JD-structural — never from a market-weight guess.
 */

import type { EvaluationRequirement, RequirementImportance, RequirementMatch } from "./types";

export type { EvaluationRequirement, RequirementImportance, RequirementMatch } from "./types";

const IMPORTANCE_ORDER: Record<RequirementImportance, number> = {
	critical: 0,
	high: 1,
	meaningful: 2,
	preferred: 3,
	low_signal: 4,
};

/** Unmet before met within a band: leading with the reader's best news would bury exactly
 * the high-importance gaps the table exists to surface. `na` is a satisfied gate, so it
 * sorts as met; a row not yet filled by the resume pass sits between unmet and met. */
const MATCH_ORDER: Record<RequirementMatch, number> = {
	missing: 0,
	partial: 1,
	strong: 3,
	na: 4,
};

function matchRank(match: RequirementMatch | null): number {
	return match === null ? 2 : MATCH_ORDER[match];
}

/** At most this many rows — a 30-bullet JD otherwise emits a table nobody reads to the end.
 * Retaining every critical/high row outranks the budget. */
export const REQUIREMENT_ROW_BUDGET = 12;

/**
 * Re-assert pass-1 importance over whatever pass 2 returned, and clamp the tiers:
 *
 * - `importance`, `evidenceTier` and `jdSignal` always come from the pass-1 row — pass 2
 *   fills `match` and `evidence` only, and can never revise how much a requirement matters.
 * - An `inferred` row can never be `critical` or `high`: those bands trigger mandatory
 *   interview-risk obligations, and a guess must not manufacture prep work. Clamped to
 *   `meaningful`.
 * - `stated` requires a verbatim JD quote; a `stated` row with no quote is demoted to
 *   `structural` rather than trusted.
 */
export function mergeRequirementPasses(
	passOneRows: readonly EvaluationRequirement[],
	passTwoRows: readonly Pick<EvaluationRequirement, "match" | "evidence">[],
): EvaluationRequirement[] {
	return passOneRows.map((row, index) => {
		const passTwo = passTwoRows[index];
		let { evidenceTier, importance } = row;

		if (evidenceTier === "stated" && (row.jdSignal === null || row.jdSignal.trim() === "")) {
			evidenceTier = "structural";
		}
		if (evidenceTier === "inferred" && (importance === "critical" || importance === "high")) {
			importance = "meaningful";
		}

		return {
			requirement: row.requirement,
			importance,
			evidenceTier,
			jdSignal: evidenceTier === "inferred" ? null : row.jdSignal,
			match: passTwo?.match ?? null,
			evidence: passTwo?.evidence ?? null,
		};
	});
}

/** Sort: importance descending, then unmet before met within a band. */
export function sortRequirements(rows: readonly EvaluationRequirement[]): EvaluationRequirement[] {
	return [...rows].sort(
		(a, b) =>
			IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || matchRank(a.match) - matchRank(b.match),
	);
}

export type RequirementBudgetResult = {
	rows: EvaluationRequirement[];
	/** Lower-importance rows trimmed to fit the budget ("+7 lower-importance requirements not listed"). */
	dropped: number;
};

/**
 * Apply the row budget to an already-sorted table. Every `critical` and `high` row is kept
 * even when that exceeds the budget — a report that silently dropped a must-have to hit a
 * row count would hide exactly the requirement the reader most needs. Only `meaningful` and
 * below are ever trimmed.
 */
export function applyRowBudget(
	rows: readonly EvaluationRequirement[],
	budget = REQUIREMENT_ROW_BUDGET,
): RequirementBudgetResult {
	const mandatory = rows.filter((row) => row.importance === "critical" || row.importance === "high");
	if (mandatory.length >= budget) {
		return { rows: [...mandatory], dropped: rows.length - mandatory.length };
	}

	const kept: EvaluationRequirement[] = [];
	let remaining = budget - mandatory.length;
	for (const row of rows) {
		if (row.importance === "critical" || row.importance === "high") {
			kept.push(row);
			continue;
		}
		if (remaining > 0) {
			kept.push(row);
			remaining -= 1;
		}
	}
	return { rows: kept, dropped: rows.length - kept.length };
}

/** An `inferred` row never contributes to hard stops — same one-way asymmetry as the band
 * clamp: inflated importance on a missing requirement reads as "don't bother applying", and
 * that error costs an application the user should have made. */
export function eligibleForHardStop(row: EvaluationRequirement): boolean {
	return row.evidenceTier !== "inferred";
}

/** The rows whose miss requires a specific interview risk and mitigation. */
export function rowsRequiringMitigation(rows: readonly EvaluationRequirement[]): EvaluationRequirement[] {
	return rows.filter(
		(row) =>
			(row.importance === "critical" || row.importance === "high") &&
			(row.match === "missing" || row.match === "partial"),
	);
}
