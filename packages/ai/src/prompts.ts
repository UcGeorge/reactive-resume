import { readFileSync } from "node:fs";

const readPrompt = (filename: string) => {
	return readFileSync(new URL(`./prompts/${filename}`, import.meta.url), "utf-8");
};

// ponytail: single template with per-source substitutions; produced text is identical per source type
const parserTemplate = readPrompt("parser-system.md");

type ParserVars = {
	FORMAT_HEADER: string;
	FORMAT_NOUN: string;
	ALLOWED_INPUT: string;
	URL_CLAUSE: string;
	EXTRA_RULES: string;
	FALLBACK_CLAUSE: string;
};

function makeParserPrompt(vars: ParserVars): string {
	return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), parserTemplate);
}

const pdfParserSystemPrompt = makeParserPrompt({
	FORMAT_HEADER: "PDF files",
	FORMAT_NOUN: "PDF",
	ALLOWED_INPUT:
		"- Use only the visible content from the attached PDF document.\n- Ignore OCR noise, watermarks, repeated headers/footers, and broken line wraps.",
	URL_CLAUSE: "full URLs that are explicitly present",
	EXTRA_RULES: "",
	FALLBACK_CLAUSE: "PDF is low quality or partially unreadable",
});

const docxParserSystemPrompt = makeParserPrompt({
	FORMAT_HEADER: "Microsoft Word files (DOC/DOCX)",
	FORMAT_NOUN: "document",
	ALLOWED_INPUT:
		"- Use only visible, intended content from the attached document.\n- Ignore hidden text, comments, track changes, revision history, document metadata, and layout artifacts.",
	URL_CLAUSE: "URLs explicitly visible in document content",
	EXTRA_RULES:
		"- Lists and tables: extract visible text faithfully; preserve relationships in section fields.\n- Headers/footers: include only if they contain real resume data.\n",
	FALLBACK_CLAUSE: "document is malformed or partially unreadable",
});

const atsReviewSystemPrompt = readPrompt("ats-review-system.md");
const atsReviewUserPromptTemplate = readPrompt("ats-review-user.md");
const chatSystemPromptTemplate = readPrompt("chat-system.md");
const docxParserUserPrompt = readPrompt("docx-parser-user.md");
const pdfParserUserPrompt = readPrompt("pdf-parser-user.md");

// Deep JD evaluation (career): two-pass anti-anchoring plus strategy and legitimacy passes.
const evaluationPass1SystemPrompt = readPrompt("evaluation-pass1-system.md");
const evaluationPass2SystemPrompt = readPrompt("evaluation-pass2-system.md");
const evaluationStrategySystemPrompt = readPrompt("evaluation-strategy-system.md");
const evaluationLegitimacySystemPrompt = readPrompt("evaluation-legitimacy-system.md");

// Tailoring (career): the constrained mutation plan and the adversarial reviewer audit.
const tailoringPlanSystemPrompt = readPrompt("tailoring-plan-system.md");
const hmAuditSystemPrompt = readPrompt("hm-audit-system.md");

// Guided cover letters (career): the gated four-prompt drafting pass.
const coverLetterGuidedSystemPrompt = readPrompt("cover-letter-guided-system.md");

export {
	atsReviewSystemPrompt,
	atsReviewUserPromptTemplate,
	chatSystemPromptTemplate,
	coverLetterGuidedSystemPrompt,
	docxParserSystemPrompt,
	docxParserUserPrompt,
	evaluationLegitimacySystemPrompt,
	evaluationPass1SystemPrompt,
	evaluationPass2SystemPrompt,
	evaluationStrategySystemPrompt,
	hmAuditSystemPrompt,
	pdfParserSystemPrompt,
	pdfParserUserPrompt,
	tailoringPlanSystemPrompt,
};
