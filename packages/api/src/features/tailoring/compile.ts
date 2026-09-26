import type { JsonPatchOperation } from "@reactive-resume/resume/patch";
import type { EvaluationRequirement, TailoringChange, TailoringOperation } from "@reactive-resume/schema/career/data";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { canonicalize, normalizeForMatching } from "@reactive-resume/resume/ats-pdf/jd";
import { htmlToMarkdown } from "@reactive-resume/resume/markdown";
import { generateId } from "@reactive-resume/utils/string";

/**
 * The deterministic half of tailoring: the LLM proposes constrained mutations, this compiler
 * decides which are lawful and turns them into JSON Patch. career-ops needed a payload
 * schema plus an HTML builder for this role; here `ResumeData` is the payload and the PDF
 * renderer is the builder, so the compiler's job is the allowlist and the skills-source rule.
 */

// Paths a `set` may touch: prose surfaces only. Structure, dates, employers and titles are
// not tailorable — rewording happens inside descriptions, never on the facts around them.
const SET_PATH_RE =
	/^\/(?:basics\/headline|summary\/content|sections\/(?:experience|education|projects|skills|languages|interests|awards|certifications|publications|volunteer|references)\/items\/\d+\/description|sections\/experience\/items\/\d+\/roles\/\d+\/description)$/;

const HIDE_PATH_RE = /^\/sections\/[a-z]+\/items\/\d+$/;
const MOVE_ARRAY_RE = /^\/sections\/[a-z]+\/items$/;

export type CompiledPlan = {
	operations: JsonPatchOperation[];
	/** Ops the compiler refused, with the reason — recorded, never silent. */
	dropped: { operation: TailoringOperation; reason: string }[];
};

function arrayLengthAt(data: ResumeData, arrayPath: string): number | null {
	const segments = arrayPath.split("/").filter(Boolean);
	let current: unknown = data;
	for (const segment of segments) {
		if (typeof current !== "object" || current === null) return null;
		current = (current as Record<string, unknown>)[segment];
	}
	return Array.isArray(current) ? current.length : null;
}

/** A skill may be added only when the resume already carries it: exact/canonical membership
 * in the deterministic skill-gap's existing∪supported buckets. */
function skillAllowed(name: string, allowedSkills: readonly string[]): boolean {
	const target = canonicalize(normalizeForMatching(name).trim());
	return allowedSkills.some((allowed) => canonicalize(normalizeForMatching(allowed).trim()) === target);
}

export function compileTailoringPlan(
	data: ResumeData,
	plan: readonly TailoringOperation[],
	allowedSkills: readonly string[],
): CompiledPlan {
	const operations: JsonPatchOperation[] = [];
	const dropped: CompiledPlan["dropped"] = [];

	for (const operation of plan) {
		switch (operation.kind) {
			case "set": {
				if (!SET_PATH_RE.test(operation.path)) {
					dropped.push({ operation, reason: `Path not tailorable: ${operation.path}` });
					break;
				}
				operations.push({ op: "replace", path: operation.path, value: operation.value });
				break;
			}
			case "move": {
				if (!MOVE_ARRAY_RE.test(operation.arrayPath)) {
					dropped.push({ operation, reason: `Not a reorderable items array: ${operation.arrayPath}` });
					break;
				}
				const length = arrayLengthAt(data, operation.arrayPath);
				if (length === null || operation.from >= length || operation.to >= length) {
					dropped.push({ operation, reason: "Move index out of range." });
					break;
				}
				if (operation.from === operation.to) break;
				operations.push({
					op: "move",
					from: `${operation.arrayPath}/${operation.from}`,
					path: `${operation.arrayPath}/${operation.to}`,
				});
				break;
			}
			case "hide": {
				if (!HIDE_PATH_RE.test(operation.path)) {
					dropped.push({ operation, reason: `Not a hideable item: ${operation.path}` });
					break;
				}
				operations.push({ op: "replace", path: `${operation.path}/hidden`, value: true });
				break;
			}
			case "add-skill": {
				if (!skillAllowed(operation.name, allowedSkills)) {
					dropped.push({
						operation,
						reason: `"${operation.name}" is not in the resume's existing/supported skills — a gap skill can never be added.`,
					});
					break;
				}
				const alreadyListed = data.sections.skills.items.some(
					(item) =>
						canonicalize(normalizeForMatching(item.name).trim()) ===
						canonicalize(normalizeForMatching(operation.name).trim()),
				);
				if (alreadyListed) {
					dropped.push({ operation, reason: `"${operation.name}" is already a named skill.` });
					break;
				}
				operations.push({
					op: "add",
					path: "/sections/skills/items/-",
					value: {
						id: generateId(),
						hidden: false,
						icon: "",
						iconColor: "",
						name: operation.name,
						proficiency: "",
						level: 0,
						keywords: operation.keywords,
					},
				});
				break;
			}
		}
	}

	return { operations, dropped };
}

/**
 * The six-second clarity gate as a lint: the top third must make the target role, the
 * strongest fit, and the proof obvious. Warnings, never blockers.
 */
export function sixSecondLint(
	data: ResumeData,
	requirements: readonly EvaluationRequirement[] | null,
): TailoringChange[] {
	const warnings: TailoringChange[] = [];

	const summaryText = htmlToMarkdown(data.summary.content).trim();
	if (summaryText.length === 0) {
		warnings.push({
			section: "Lint",
			change: "The summary is empty.",
			why: "The six-second scan starts there — it should answer what role this person targets and why.",
		});
	} else if (summaryText.split(/[.!?]\s/).length > 5) {
		warnings.push({
			section: "Lint",
			change: "The summary runs past ~4 sentences.",
			why: "A recruiter reads 3-4 keyword-dense lines; more gets skimmed past.",
		});
	}

	const visibleSkills = data.sections.skills.items.filter((item) => !item.hidden);
	if (visibleSkills.length > 0 && (visibleSkills.length < 6 || visibleSkills.length > 12)) {
		warnings.push({
			section: "Lint",
			change: `${visibleSkills.length} visible skills.`,
			why: "A 6-8 item competency picture scans best; a wall of skills reads as noise.",
		});
	}

	const critical = (requirements ?? []).filter((row) => row.importance === "critical" || row.importance === "high");
	if (critical.length > 0) {
		const firstExperience = data.sections.experience.items.find((item) => !item.hidden);
		const topText = normalizeForMatching(
			[
				data.basics.headline,
				summaryText,
				firstExperience ? htmlToMarkdown(firstExperience.description) : "",
				...(firstExperience?.roles.slice(0, 1).map((role) => htmlToMarkdown(role.description)) ?? []),
			].join("\n"),
		);
		const addressed = critical.some((row) =>
			normalizeForMatching(row.requirement)
				.split(/\s+/)
				.filter((token) => token.length > 3)
				.some((token) => topText.includes(token)),
		);
		if (!addressed) {
			warnings.push({
				section: "Lint",
				change: "The top third does not visibly address any critical/high requirement.",
				why: "The first screen should show proof points mapped to the posting's highest-risk requirements.",
			});
		}
	}

	return warnings;
}
