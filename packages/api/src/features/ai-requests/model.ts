import type { AgentQueueCallOptions, AgentQueueModel } from "./serialize";
import { serializeCallOptions, toGenerateResult, toStreamParts } from "./serialize";
import { aiRequestsService } from "./service";

type CreateAgentQueueModelInput = {
	userId: string;
	providerId: string;
	modelId: string;
};

/**
 * A language model whose "network call" is a row in `ai_requests`: the call is queued, an MCP
 * client answers it with its own model, and the answer is mapped back into the spec's result.
 * Every feature that calls `getModel` works unchanged; only the transport differs.
 */
export function createAgentQueueModel(input: CreateAgentQueueModelInput): AgentQueueModel {
	const generate = async (options: AgentQueueCallOptions) => {
		const { id, result } = await aiRequestsService.enqueueAndWait({
			userId: input.userId,
			aiProviderId: input.providerId,
			kind: "generate",
			request: serializeCallOptions(options),
			...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
		});

		return toGenerateResult(result, { id, modelId: input.modelId });
	};

	return {
		specificationVersion: "v3",
		provider: "mcp-agent",
		modelId: input.modelId,
		// No URL support: the SDK downloads URL file parts itself and hands over bytes.
		supportedUrls: {},
		doGenerate: generate,
		doStream: async (options) => {
			// The agent answers whole; a rejection propagates as a thrown error, never as an
			// `error` part, so the SDK's retry and abort handling see it the same way.
			const parts = toStreamParts(await generate(options));

			return {
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
}
