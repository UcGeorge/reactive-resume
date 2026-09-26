import type { careerFactsProfileSchema } from "@reactive-resume/schema/career/data";
import type z from "zod";

/** One text a claim may be backed by (e.g. the source resume). The evaluation JD archive is
 * never a source of candidate facts — a posting's numbers say nothing about the candidate. */
export type FactGateSource = {
	label: string;
	text: string;
};

/** Per-user allowlist, same semantics as career-ops' `config/cv-facts.json`: allowMetrics /
 * allowFacts accept specific claims absent from the sources; forbiddenPhrases always block;
 * warnPhrases flag without blocking. */
export type FactGateAllowlist = z.input<typeof careerFactsProfileSchema>;

export type FactGateInput = {
	/** The tailored resume's full text (caller flattens ResumeData, e.g. via resumeDataToFactTexts). */
	candidate: string;
	/** Texts that may back a claim. */
	sources: FactGateSource[];
	allow?: FactGateAllowlist;
};

export type FactViolationKind = "metric" | "employer" | "title" | "tool" | "delegated-authorship" | "forbidden-phrase";

export type FactViolation = {
	kind: FactViolationKind;
	claim: string;
	detail: string;
};

export type FactWarningKind = "warn-phrase" | "coverage";

export type FactWarning = {
	kind: FactWarningKind;
	claim: string;
	detail: string;
};

export type FactGateReport = {
	/** False when any violation exists — the caller must block render on `passed: false`. */
	passed: boolean;
	violations: FactViolation[];
	warnings: FactWarning[];
};

/** An explicitly asserted non-metric fact extracted from text. */
export type FactClaim = {
	kind: "employer" | "title" | "tool" | "authorship";
	value: string;
};

/** "The gate could not read this document's counts" — reported, never silently passed. */
export type FactCoverageDiagnosis = {
	reason: "no-count-claims-recognized";
	message: string;
	spans: string[];
};
