import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { MCP_TOOL_NAME as T } from "./mcp-tool-names";
import { PROMPT_ARGUMENTS, PROMPT_META } from "./prompts";
import { TOOL_META } from "./tool-meta";

/** Shared server identity for both the live MCP server and the static server card. */
export function buildMcpServerInfo(version: string, appUrl: string) {
	const origin = appUrl.replace(/\/$/, "");

	return {
		name: "reactive-resume",
		version,
		title: "Reactive Resume",
		websiteUrl: origin,
		description:
			"Reactive Resume is a resume builder and job-search workspace. Use this MCP server to manage resumes, cover letters and applications with an LLM of your choice, or to serve the app's AI requests from your own agent.",
		icons: [
			{ src: `${origin}/icon/light.svg`, mimeType: "image/svg+xml", theme: "light" as const },
			{ src: `${origin}/icon/dark.svg`, mimeType: "image/svg+xml", theme: "dark" as const },
		],
	};
}

/**
 * Static MCP server card (SEP-1649 / well-known `mcp/server-card.json`).
 * Kept in sync with `registerTools`, `registerResources`, and `registerPrompts`.
 *
 * Some registries only surface the `resources` array in their UI, not `resourceTemplates`.
 * The parameterized resume URI is therefore duplicated here so discovery matches the live template.
 */
export function buildMcpServerCard(appVersion: string, appUrl: string) {
	// ponytail: derived from TOOL_META; title/description/inputSchema/annotations declared once
	const tools = Object.entries(TOOL_META).map(([name, { title, description, inputSchema, annotations }]) => ({
		name,
		title,
		description,
		inputSchema: toJsonSchemaCompat(inputSchema),
		annotations,
	}));

	const prompts = (Object.keys(PROMPT_META) as (keyof typeof PROMPT_META)[]).map((name) => ({
		name,
		...PROMPT_META[name],
		arguments: [...PROMPT_ARGUMENTS[name]],
	}));

	const resources = [
		{
			name: "resume-schema",
			title: "Resume Data JSON Schema",
			uri: "resume://_meta/schema",
			description: [
				"The JSON Schema describing the complete resume data structure.",
				"Reference when generating JSON Patch operations so paths and value types are valid.",
			].join(" "),
			mimeType: "application/json",
		},
		{
			name: "resume",
			title: "Resume Data",
			uri: "resume://{id}",
			description: [
				"Full resume JSON for one resume. Substitute a real ID for `{id}` (UUID from your account).",
				"On the wire this is a resource template (`resources/templates/list`), not a row in `resources/list`.",
				`Discover IDs with \`${T.listResumes}\`; read via \`resources/read\` on e.g. \`resume://<id>\` or use \`${T.getResume}\`.`,
			].join(" "),
			mimeType: "application/json",
		},
	];

	const resourceTemplates = [
		{
			name: "resume",
			title: "Resume Data",
			uriTemplate: "resume://{id}",
			description: "Full resume data as JSON. Discover IDs with the list tool; read via resources/read or read_resume.",
			mimeType: "application/json",
		},
	];

	return {
		/**
		 * Optional session fields for gateways. OAuth is primary; API key is optional for clients that support custom headers.
		 */
		configurationSchema: {
			type: "object",
			properties: {
				apiKey: {
					type: "string",
					title: "API key",
					description:
						"Optional. Create a key under Account → API Keys. Forwarded as the x-api-key header when not using OAuth.",
					"x-from": { header: "x-api-key" },
				},
			},
		},
		serverInfo: buildMcpServerInfo(appVersion, appUrl),
		tools,
		prompts,
		resources,
		resourceTemplates,
		authentication: {
			required: true,
			schemes: ["oauth2", "bearer"],
		},
	};
}
