import type { AiRequestFile, AiRequestPayload, AiRequestResult } from "@reactive-resume/db/schema";
import type { LanguageModel } from "ai";
import { generateId } from "@reactive-resume/utils/string";

/**
 * The AI SDK accepts a plain object implementing the v3 language-model spec and adapts it at
 * runtime. `ai` does not re-export the spec's part types, so they are derived from the model
 * union here instead of adding a dependency on `@ai-sdk/provider`.
 */
export type AgentQueueModel = Extract<LanguageModel, { specificationVersion: "v3" }>;
export type AgentQueueCallOptions = Parameters<AgentQueueModel["doGenerate"]>[0];
export type AgentQueueGenerateResult = Awaited<ReturnType<AgentQueueModel["doGenerate"]>>;
export type AgentQueueStreamPart =
	Awaited<ReturnType<AgentQueueModel["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never;

type PromptMessage = AgentQueueCallOptions["prompt"][number];
type PromptPart = Extract<PromptMessage, { role: "assistant" }>["content"][number];
type FilePart = Extract<PromptPart, { type: "file" }>;

const EMPTY_USAGE: AgentQueueGenerateResult["usage"] = {
	inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function toBase64(data: FilePart["data"]): string {
	return typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("base64");
}

function withoutProviderOptions<T extends object>(value: T): Omit<T, "providerOptions"> {
	const { providerOptions: _providerOptions, ...rest } = value as T & { providerOptions?: unknown };
	return rest;
}

/**
 * Flattens a language-model call into the JSON a connected agent reads. System messages are
 * merged into `system`, file bytes move into `files` (referenced by index), and every
 * `providerOptions` is dropped: the agent is the provider now.
 */
export function serializeCallOptions(options: AgentQueueCallOptions): AiRequestPayload {
	const files: AiRequestFile[] = [];
	const systemParts: string[] = [];
	const messages: AiRequestPayload["messages"] = [];

	const fileReference = (part: FilePart): Record<string, unknown> => {
		if (part.data instanceof URL) {
			return {
				type: "file",
				url: part.data.href,
				mediaType: part.mediaType,
				...(part.filename ? { filename: part.filename } : {}),
			};
		}

		files.push({
			mediaType: part.mediaType,
			...(part.filename ? { filename: part.filename } : {}),
			data: toBase64(part.data),
		});

		return {
			type: "file",
			fileIndex: files.length - 1,
			mediaType: part.mediaType,
			...(part.filename ? { filename: part.filename } : {}),
		};
	};

	const serializePart = (part: PromptPart | Extract<PromptMessage, { role: "tool" }>["content"][number]) => {
		switch (part.type) {
			case "text":
			case "reasoning":
				return { type: part.type, text: part.text };
			case "file":
				return fileReference(part);
			case "tool-call":
				return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
			case "tool-result":
				return {
					type: "tool-result",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					output: withoutProviderOptions(part.output),
				};
			case "tool-approval-response":
				return {
					type: "tool-approval-response",
					approvalId: part.approvalId,
					approved: part.approved,
					...(part.reason ? { reason: part.reason } : {}),
				};
		}
	};

	for (const message of options.prompt) {
		if (message.role === "system") {
			systemParts.push(message.content);
			continue;
		}

		messages.push({ role: message.role, content: message.content.map((part) => serializePart(part)) });
	}

	const tools = (options.tools ?? []).flatMap((tool) =>
		tool.type === "function"
			? [
					{
						name: tool.name,
						...(tool.description ? { description: tool.description } : {}),
						inputSchema: tool.inputSchema,
						...(tool.inputExamples ? { inputExamples: tool.inputExamples } : {}),
					},
				]
			: [],
	);

	return {
		...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
		messages,
		...(tools.length > 0 ? { tools } : {}),
		...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
		...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
		...(files.length > 0 ? { files } : {}),
		...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
	};
}

/** Maps a completed request back into the spec's generate result. */
export function toGenerateResult(
	result: AiRequestResult,
	meta: { id: string; modelId: string },
): AgentQueueGenerateResult {
	const toolCalls = result.toolCalls ?? [];
	const content: AgentQueueGenerateResult["content"] = [];

	if (result.text) content.push({ type: "text", text: result.text });

	for (const call of toolCalls) {
		content.push({
			type: "tool-call",
			toolCallId: generateId(),
			toolName: call.toolName,
			input: JSON.stringify(call.input),
		});
	}

	return {
		content,
		finishReason: { unified: toolCalls.length > 0 ? "tool-calls" : "stop", raw: undefined },
		usage: EMPTY_USAGE,
		response: { id: meta.id, modelId: meta.modelId, timestamp: new Date() },
		warnings: [],
	};
}

/** Replays a complete result as a stream: the agent answers whole, the SDK still expects parts. */
export function toStreamParts(result: AgentQueueGenerateResult): AgentQueueStreamPart[] {
	const parts: AgentQueueStreamPart[] = [{ type: "stream-start", warnings: result.warnings }];

	if (result.response) parts.push({ type: "response-metadata", ...result.response });

	for (const [index, item] of result.content.entries()) {
		if (item.type === "text") {
			const id = `text-${index}`;
			parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: item.text }, { type: "text-end", id });
			continue;
		}

		if (item.type === "tool-call") {
			parts.push(
				{ type: "tool-input-start", id: item.toolCallId, toolName: item.toolName },
				{ type: "tool-input-delta", id: item.toolCallId, delta: item.input },
				{ type: "tool-input-end", id: item.toolCallId },
				item,
			);
		}
	}

	parts.push({ type: "finish", usage: result.usage, finishReason: result.finishReason });

	return parts;
}
