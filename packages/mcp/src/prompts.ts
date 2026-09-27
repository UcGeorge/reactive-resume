import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";

// ── Shared prompt helpers ────────────────────────────────────────

const resumeIdArg = z
	.string()
	.describe(
		`The ID of the resume. Use \`${T.listResumes}\` to find IDs, or \`${T.createResume}\` to create a new one first.`,
	);

const providerIdArg = z
	.string()
	.optional()
	.describe("Optional AI provider id to serve; omit to serve every connected-agent provider on this account.");

/** Shared prompt titles/descriptions, also consumed by the static MCP server card. */
export const PROMPT_META = {
	build_resume: {
		title: "Build Resume",
		description: "Guide the user step-by-step through building a resume from scratch, section by section.",
	},
	improve_resume: {
		title: "Improve Resume",
		description: "Review resume content and suggest concrete improvements to wording, impact, and structure.",
	},
	review_resume: {
		title: "Review Resume",
		description:
			"Get a structured, professional critique with a scorecard and prioritized recommendations. Read-only: no changes are made.",
	},
	serve_ai_requests: {
		title: "Serve AI Requests",
		description:
			"Turn this session into the model behind a 'Connected agent (MCP)' AI provider: claim queued requests, answer them yourself, repeat.",
	},
} as const;

const RESUME_ID_ARGUMENT = { name: "id", description: "Resume ID.", required: true } as const;
const PROVIDER_ID_ARGUMENT = {
	name: "provider",
	description: "Optional AI provider id to serve; omit to serve every connected-agent provider on this account.",
	required: false,
} as const;

/** Prompt argument metadata for the static server card, mirroring each prompt's `argsSchema`. */
export const PROMPT_ARGUMENTS: Record<
	keyof typeof PROMPT_META,
	readonly { name: string; description: string; required: boolean }[]
> = {
	build_resume: [RESUME_ID_ARGUMENT],
	improve_resume: [RESUME_ID_ARGUMENT],
	review_resume: [RESUME_ID_ARGUMENT],
	serve_ai_requests: [PROVIDER_ID_ARGUMENT],
};

/** The serve loop, as one instruction the agent keeps following until the user stops it. */
function buildServeAiRequestsText(providerId?: string) {
	const claimArgs = providerId ? `\`wait: 25\` and \`providerId: "${providerId}"\`` : "`wait: 25`";

	return [
		'You are now the language model behind a "Connected agent (MCP)" AI provider in Reactive Resume.',
		"Features of the app (evaluations, tailoring, cover letters, imports, chat) queue their model calls for you.",
		"Serve them in a loop until the user tells you to stop:",
		"",
		`1. Call \`${T.claimAiRequest}\` with ${claimArgs}. An empty result means nothing arrived yet; call it again.`,
		"2. Read the claimed request: `system`, `messages` (a message part with a `fileIndex` refers to the attached file resources in order), `tools`, `toolChoice`, `responseFormat` and `maxOutputTokens`.",
		"3. Produce the answer yourself, exactly as the language model would. Do not call other Reactive Resume tools to fulfil it: the requesting feature executes any tool call itself and sends the result back as a new request.",
		`4. Deliver it with \`${T.completeAiRequest}\`: \`{ id, text }\` for a written answer, or \`{ id, toolCalls: [{ toolName, input }] }\` to call one of the request's tools. When \`responseFormat.type\` is "json", \`text\` must be exactly one JSON object with no prose or code fences around it.`,
		`5. If \`${T.completeAiRequest}\` returns a validation error, fix the answer and call it again. If the request cannot be answered, call \`${T.failAiRequest}\` with the reason.`,
		"6. Go back to step 1.",
		"",
		"Keep your own commentary minimal; the answer belongs in the tool call.",
		"Unclaimed requests expire after about two minutes and claimed ones after ten, so do not pause between steps.",
	].join("\n");
}

/** Embeds the resume data and JSON schema as context messages. */
function resumeContext(id: string) {
	return [
		{
			role: "user" as const,
			content: {
				type: "resource" as const,
				resource: {
					uri: `resume://${id}`,
					mimeType: "application/json",
					text: "Current resume data",
				},
			},
		},
		{
			role: "user" as const,
			content: {
				type: "resource" as const,
				resource: {
					uri: "resume://_meta/schema",
					mimeType: "application/json",
					text: "Resume data JSON Schema: use this to understand valid paths and types for JSON Patch operations",
				},
			},
		},
	];
}

const PATCH_REFERENCE = [
	"## JSON Patch Reference",
	"",
	`Use the \`${T.patchResume}\` tool for every change. Common operations:`,
	"",
	"| Action | Operation |",
	"|--------|-----------|",
	'| Change name | `{ "op": "replace", "path": "/basics/name", "value": "Jane Doe" }` |',
	'| Update headline | `{ "op": "replace", "path": "/basics/headline", "value": "Senior Engineer" }` |',
	'| Replace summary | `{ "op": "replace", "path": "/summary/content", "value": "<p>Experienced...</p>" }` |',
	'| Add experience | `{ "op": "add", "path": "/sections/experience/items/-", "value": { ...full item } }` |',
	'| Remove skill at index 2 | `{ "op": "remove", "path": "/sections/skills/items/2" }` |',
	'| Update specific field | `{ "op": "replace", "path": "/sections/experience/items/0/company", "value": "New Corp" }` |',
	'| Change template | `{ "op": "replace", "path": "/metadata/template", "value": "bronzor" }` |',
	'| Change primary color | `{ "op": "replace", "path": "/metadata/design/colors/primary", "value": "rgba(37, 99, 235, 1)" }` |',
	'| Hide a section | `{ "op": "replace", "path": "/sections/interests/hidden", "value": true }` |',
	"",
	"Rules:",
	"- New item IDs must be valid UUIDs (format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`).",
	"- HTML content fields (`description`, `summary.content`) must use valid HTML: `<p>`, `<ul>`/`<li>`, `<strong>`, `<em>`.",
	"- Every `website` field is an object: `{ url: string, label: string }`.",
].join("\n");

// ── Prompt Registration ──────────────────────────────────────────

export function registerPrompts(server: McpServer) {
	// ── Build Resume ─────────────────────────────────────────────
	server.registerPrompt(
		"build_resume",
		{
			...PROMPT_META.build_resume,
			argsSchema: { id: resumeIdArg },
		},
		({ id }) => ({
			messages: [
				...resumeContext(id),
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: [
							"You are an expert resume writer. Help me build my resume step by step.",
							"",
							"## Process",
							"",
							"1. **Basics** — Ask for: full name, headline/job title, email, phone, location, website.",
							"2. **Summary** — Help me write a compelling 2-3 sentence professional summary.",
							"3. **Experience** — Walk through each role: company, position, period, key accomplishments.",
							"4. **Education** — Degree, school, graduation date, relevant coursework/honors.",
							"5. **Skills** — Categorize technical and soft skills with proficiency levels.",
							"6. **Other sections** — Projects, certifications, languages, volunteer work, etc.",
							"7. **Design** — Offer to adjust template, typography, and color scheme.",
							"",
							"For each section, ask targeted questions, draft the content, and wait for my approval before applying.",
							"Do NOT fabricate any information. Use only what I provide or explicitly ask you to generate.",
							"",
							PATCH_REFERENCE,
							"",
							"The resume data and schema are attached above. Start with step 1.",
						].join("\n"),
					},
				},
			],
		}),
	);

	// ── Improve Resume ───────────────────────────────────────────
	server.registerPrompt(
		"improve_resume",
		{
			...PROMPT_META.improve_resume,
			argsSchema: { id: resumeIdArg },
		},
		({ id }) => ({
			messages: [
				...resumeContext(id),
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: [
							"You are an expert resume writer and career coach. Review my resume and help me improve it.",
							"",
							"## Analysis Framework",
							"",
							"Go through each section and identify:",
							"- **Weak bullet points** — lacking metrics, impact, or specificity",
							"- **Passive voice** — replace with strong action verbs (Led, Built, Designed, Increased...)",
							"- **Vague descriptions** — make concrete with specific technologies, team sizes, outcomes",
							"- **Missing quantification** — add numbers, percentages, dollar amounts where possible",
							"- **Structural issues** — inconsistent formatting, poor section ordering, missing sections",
							"- **Redundancies** — repetitive content that dilutes impact",
							"",
							"## Process",
							"",
							"1. Start with an **overall assessment** (strengths + key areas to improve).",
							"2. Work through improvements **one section at a time**.",
							"3. For each suggestion, explain the **rationale** and show the before/after.",
							`4. Wait for my **approval** before applying changes via \`${T.patchResume}\`.`,
							"5. Do NOT fabricate information. Suggest improvements based on what exists, and ask me for missing details.",
							"",
							PATCH_REFERENCE,
						].join("\n"),
					},
				},
			],
		}),
	);

	// ── Review Resume ────────────────────────────────────────────
	server.registerPrompt(
		"review_resume",
		{
			...PROMPT_META.review_resume,
			argsSchema: { id: resumeIdArg },
		},
		({ id }) => ({
			messages: [
				...resumeContext(id),
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: [
							"You are a professional resume reviewer and career advisor. Provide a thorough critique.",
							"",
							"## Evaluation Dimensions (score each 1-10)",
							"",
							"| Dimension | What to evaluate |",
							"|-----------|-----------------|",
							"| **Completeness** | Are all important sections filled in? Any critical gaps? |",
							"| **Impact** | Do bullet points demonstrate results with metrics and outcomes? |",
							"| **Clarity** | Is the writing clear, concise, and free of unnecessary jargon? |",
							"| **Formatting** | Is the layout consistent? Are sections well-organized? |",
							"| **ATS Compatibility** | Will it parse well through Applicant Tracking Systems? |",
							"| **Keywords** | Are relevant industry keywords present and naturally integrated? |",
							"| **Length** | Is the resume an appropriate length for the experience level? |",
							"",
							"## Output Format",
							"",
							"1. **Scorecard** — Score each dimension (1-10) with a brief justification.",
							"2. **Overall Score** — Weighted average of all dimensions.",
							"3. **Top 5 Recommendations** — Prioritized by impact, with specific actionable suggestions.",
							"4. **Strengths** — What's working well and should be preserved.",
							"",
							`This is a **read-only review**. Do NOT call \`${T.patchResume}\` or make any changes.`,
							"Format the review as a clear, structured report.",
						].join("\n"),
					},
				},
			],
		}),
	);

	// ── Serve AI Requests ────────────────────────────────────────
	server.registerPrompt(
		"serve_ai_requests",
		{
			...PROMPT_META.serve_ai_requests,
			argsSchema: { provider: providerIdArg },
		},
		({ provider }) => ({
			messages: [
				{
					role: "user" as const,
					content: { type: "text" as const, text: buildServeAiRequestsText(provider) },
				},
			],
		}),
	);
}
