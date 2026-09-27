import type { AgentQueueCallOptions } from "./serialize";
import { describe, expect, it } from "vitest";
import { serializeCallOptions, toGenerateResult, toStreamParts } from "./serialize";

describe("serializeCallOptions", () => {
	it("merges system messages, indexes files and drops provider options", () => {
		const payload = serializeCallOptions({
			prompt: [
				{ role: "system", content: "Be brief." },
				{ role: "system", content: "Answer in English.", providerOptions: { anthropic: { cacheControl: {} } } },
				{
					role: "user",
					content: [
						{ type: "text", text: "Parse this.", providerOptions: { openai: {} } },
						{ type: "file", data: "QUJD", mediaType: "application/pdf", filename: "resume.pdf" },
						{ type: "file", data: new Uint8Array([104, 105]), mediaType: "text/plain" },
						{ type: "file", data: new URL("https://example.test/cv.pdf"), mediaType: "application/pdf" },
					],
				},
			],
			maxOutputTokens: 256,
		});

		expect(payload.system).toBe("Be brief.\n\nAnswer in English.");
		expect(payload.files).toEqual([
			{ mediaType: "application/pdf", filename: "resume.pdf", data: "QUJD" },
			{ mediaType: "text/plain", data: "aGk=" },
		]);
		expect(payload.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Parse this." },
					{ type: "file", fileIndex: 0, mediaType: "application/pdf", filename: "resume.pdf" },
					{ type: "file", fileIndex: 1, mediaType: "text/plain" },
					{ type: "file", url: "https://example.test/cv.pdf", mediaType: "application/pdf" },
				],
			},
		]);
		expect(payload.maxOutputTokens).toBe(256);
		expect(JSON.stringify(payload)).not.toContain("providerOptions");
	});

	it("keeps tool calls and results so the agent sees the whole loop", () => {
		const payload = serializeCallOptions({
			prompt: [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "Need the resume." },
						{ type: "tool-call", toolCallId: "call-1", toolName: "read_resume", input: { id: "r1" } },
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call-1",
							toolName: "read_resume",
							output: { type: "json", value: { name: "Ada" }, providerOptions: { x: {} } },
						},
						{ type: "tool-approval-response", approvalId: "a1", approved: false, reason: "no" },
					],
				},
			],
			tools: [
				{ type: "function", name: "read_resume", description: "Read", inputSchema: { type: "object" } },
				{ type: "provider", id: "openai.web_search", name: "web_search", args: {} },
			],
			toolChoice: { type: "auto" },
			responseFormat: { type: "json", schema: { type: "object" } },
		});

		expect(payload.messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "Need the resume." },
					{ type: "tool-call", toolCallId: "call-1", toolName: "read_resume", input: { id: "r1" } },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "read_resume",
						output: { type: "json", value: { name: "Ada" } },
					},
					{ type: "tool-approval-response", approvalId: "a1", approved: false, reason: "no" },
				],
			},
		]);
		expect(payload.tools).toEqual([{ name: "read_resume", description: "Read", inputSchema: { type: "object" } }]);
		expect(payload.toolChoice).toEqual({ type: "auto" });
		expect(payload.responseFormat).toEqual({ type: "json", schema: { type: "object" } });
		expect(payload.files).toBeUndefined();
	});
});

describe("toGenerateResult", () => {
	it("maps text and tool calls with stop or tool-calls finish reasons", () => {
		const textOnly = toGenerateResult({ text: "Hello" }, { id: "req-1", modelId: "claude-code" });
		expect(textOnly.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(textOnly.finishReason).toEqual({ unified: "stop", raw: undefined });
		expect(textOnly.response).toMatchObject({ id: "req-1", modelId: "claude-code" });
		expect(textOnly.warnings).toEqual([]);

		const withCalls = toGenerateResult(
			{ text: "Reading.", toolCalls: [{ toolName: "read_resume", input: { id: "r1" } }] },
			{ id: "req-2", modelId: "codex" },
		);
		expect(withCalls.finishReason.unified).toBe("tool-calls");
		expect(withCalls.content[1]).toMatchObject({ type: "tool-call", toolName: "read_resume", input: '{"id":"r1"}' });
		expect((withCalls.content[1] as { toolCallId: string }).toolCallId).toBeTruthy();
	});
});

describe("toStreamParts", () => {
	it("replays a whole result as an ordered stream", () => {
		const result = toGenerateResult(
			{ text: "Reading.", toolCalls: [{ toolName: "read_resume", input: { id: "r1" } }] },
			{ id: "req-2", modelId: "codex" },
		);
		const parts = toStreamParts(result);
		const toolCallId = (result.content[1] as { toolCallId: string }).toolCallId;

		expect(parts.map((part) => part.type)).toEqual([
			"stream-start",
			"response-metadata",
			"text-start",
			"text-delta",
			"text-end",
			"tool-input-start",
			"tool-input-delta",
			"tool-input-end",
			"tool-call",
			"finish",
		]);
		expect(parts[3]).toEqual({ type: "text-delta", id: "text-0", delta: "Reading." });
		expect(parts[5]).toEqual({ type: "tool-input-start", id: toolCallId, toolName: "read_resume" });
		expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
	});
});

// Type-level guard: the serializer must accept whatever the SDK hands a v3 model.
const _options: AgentQueueCallOptions = { prompt: [] };
void _options;
