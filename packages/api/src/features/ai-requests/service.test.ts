import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A scripted query builder: every chained method returns the same object, and awaiting it yields
// the next scripted result for that statement kind. Enough to drive the poll loop without Postgres.
const { dbMock, state } = vi.hoisted(() => {
	const state = {
		selects: [] as unknown[][],
		updates: [] as unknown[][],
		inserts: [] as unknown[][],
		sets: [] as Record<string, unknown>[],
		calls: [] as string[],
	};

	function chain(kind: "select" | "update" | "insert" | "delete") {
		const nextResult = () => {
			if (kind === "select") return state.selects.shift() ?? [];
			if (kind === "update") return state.updates.shift() ?? [{ id: "req-1" }];
			if (kind === "insert") return state.inserts.shift() ?? [{ id: "req-1" }];
			return [];
		};
		const builder: Record<string, unknown> = {};

		for (const method of ["from", "where", "orderBy", "limit", "for", "values", "set", "returning"]) {
			builder[method] = vi.fn((...args: unknown[]) => {
				state.calls.push(`${kind}.${method}`);
				if (method === "set") state.sets.push(args[0] as Record<string, unknown>);
				return builder;
			});
		}
		// biome-ignore lint/suspicious/noThenProperty: the query builder is awaited directly, like Drizzle's.
		builder.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
			Promise.resolve(nextResult()).then(onFulfilled, onRejected);

		return builder;
	}

	const dbMock = {
		select: vi.fn(() => chain("select")),
		update: vi.fn(() => chain("update")),
		insert: vi.fn(() => chain("insert")),
		delete: vi.fn(() => chain("delete")),
		transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(dbMock)),
	};

	return { dbMock, state };
});

vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/env/server", () => ({
	env: { APP_URL: "https://rr.test/", AI_AGENT_REQUEST_TIMEOUT_MS: 5_000 },
}));

const { aiRequestsService, validateCompletion } = await import("./service");

function requestRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "req-1",
		userId: "user-1",
		aiProviderId: "prov-1",
		status: "queued",
		kind: "generate",
		request: { messages: [] },
		result: null,
		error: null,
		claimedAt: null,
		leaseExpiresAt: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function pollRow(overrides: Record<string, unknown> = {}) {
	return { status: "queued", result: null, error: null, createdAt: new Date(), leaseExpiresAt: null, ...overrides };
}

const enqueueInput = { userId: "user-1", aiProviderId: "prov-1", kind: "generate" as const, request: { messages: [] } };

beforeEach(() => {
	vi.clearAllMocks();
	state.selects = [];
	state.updates = [];
	state.inserts = [];
	state.sets = [];
	state.calls = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe("validateCompletion", () => {
	const withTools = { messages: [], tools: [{ name: "read_resume", inputSchema: {} }] };

	it("requires text or a tool call", () => {
		expect(validateCompletion({ messages: [] }, {})).toEqual(["Provide text, at least one tool call, or both."]);
		expect(validateCompletion({ messages: [] }, { text: "  " })).toHaveLength(1);
		expect(validateCompletion({ messages: [] }, { text: "hi" })).toEqual([]);
	});

	it("only accepts tool calls the request offered, with object inputs", () => {
		expect(validateCompletion({ messages: [] }, { toolCalls: [{ toolName: "x", input: {} }] })).toEqual([
			"This request offers no tools, so it must be answered with text only.",
		]);
		expect(validateCompletion(withTools, { toolCalls: [{ toolName: "nope", input: {} }] })).toEqual([
			'Unknown tool "nope". Available tools: read_resume.',
		]);
		expect(
			validateCompletion(withTools, {
				toolCalls: [{ toolName: "read_resume", input: [] as unknown as Record<string, unknown> }],
			}),
		).toEqual(['The input for tool "read_resume" must be a JSON object.']);
		expect(validateCompletion(withTools, { toolCalls: [{ toolName: "read_resume", input: { id: "r1" } }] })).toEqual(
			[],
		);
	});

	it("insists on one JSON object when the request asked for JSON", () => {
		const json = { messages: [], responseFormat: { type: "json" as const } };

		expect(validateCompletion(json, { text: "```json\n{}\n```" })).toHaveLength(1);
		expect(validateCompletion(json, { text: "[1]" })).toHaveLength(1);
		expect(validateCompletion(json, { text: '{"ok":true}' })).toEqual([]);
	});
});

describe("enqueueAndWait", () => {
	it("cleans up, inserts, and resolves once the agent completes the row", async () => {
		vi.useFakeTimers();
		state.selects = [[pollRow()], [pollRow({ status: "completed", result: { text: "hi" } })]];

		const pending = aiRequestsService.enqueueAndWait(enqueueInput);
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(pending).resolves.toEqual({ id: "req-1", result: { text: "hi" } });
		expect(state.calls.slice(0, 3)).toEqual(["delete.where", "insert.values", "insert.returning"]);
	});

	it("fails the row and explains how to connect when nobody claims it in time", async () => {
		state.selects = [[pollRow({ createdAt: new Date(Date.now() - 10_000) })]];

		await expect(aiRequestsService.enqueueAndWait(enqueueInput)).rejects.toThrow(
			"No connected agent answered within 5 seconds. Connect an MCP client to https://rr.test/mcp",
		);
		expect(state.sets.at(-1)).toMatchObject({ status: "failed" });
	});

	it("fails a claimed row whose lease ran out", async () => {
		state.selects = [[pollRow({ status: "claimed", leaseExpiresAt: new Date(Date.now() - 1) })]];

		await expect(aiRequestsService.enqueueAndWait(enqueueInput)).rejects.toThrow("did not answer within 10 minutes");
	});

	it("surfaces the agent's reason when it gave up", async () => {
		state.selects = [[pollRow({ status: "failed", error: "cannot read PDFs" })]];

		await expect(aiRequestsService.enqueueAndWait(enqueueInput)).rejects.toThrow("cannot read PDFs");
	});

	it("cancels the row and rethrows the abort reason", async () => {
		const controller = new AbortController();
		const reason = new DOMException("RUN_TIMEOUT", "AbortError");
		controller.abort(reason);

		await expect(aiRequestsService.enqueueAndWait({ ...enqueueInput, abortSignal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(state.sets.at(-1)).toMatchObject({ status: "canceled" });
	});
});

describe("claim", () => {
	it("returns null right away when nothing is queued and no wait was asked for", async () => {
		state.selects = [[]];

		await expect(aiRequestsService.claim({ userId: "user-1" })).resolves.toBeNull();
		expect(state.calls).toContain("select.for");
		expect(state.sets[0]).toMatchObject({ status: "failed" }); // stale leases are expired first
	});

	it("returns the claimed request with indexed files and agent instructions", async () => {
		const claimed = requestRow({
			status: "claimed",
			leaseExpiresAt: new Date("2026-09-27T12:00:00Z"),
			request: {
				system: "Be brief.",
				messages: [{ role: "user", content: [{ type: "file", fileIndex: 0, mediaType: "application/pdf" }] }],
				files: [{ mediaType: "application/pdf", data: "QUJD" }],
				tools: [{ name: "read_resume", inputSchema: {} }],
				responseFormat: { type: "json" },
			},
		});
		state.selects = [[{ id: "req-1" }]];
		state.updates = [[], [claimed]];

		const result = await aiRequestsService.claim({ userId: "user-1", providerId: "prov-1", wait: 0 });

		expect(result).toMatchObject({
			id: "req-1",
			kind: "generate",
			providerId: "prov-1",
			system: "Be brief.",
			files: [{ index: 0, mediaType: "application/pdf", data: "QUJD" }],
		});
		expect(result?.instructions).toContain("toolCalls");
		expect(result?.instructions).toContain("JSON object");
		expect(result?.instructions).toContain("fileIndex");
		expect(result?.instructions).toContain("fail_ai_request");
		expect(result?.instructions).toContain("2026-09-27T12:00:00.000Z");
	});
});

describe("complete and fail", () => {
	it("rejects an answer that does not fit the request so the agent can retry", async () => {
		state.selects = [
			[requestRow({ status: "claimed", request: { messages: [], tools: [{ name: "a", inputSchema: {} }] } })],
		];

		await expect(
			aiRequestsService.complete({ userId: "user-1", id: "req-1", toolCalls: [{ toolName: "b", input: {} }] }),
		).rejects.toThrow('Unknown tool "b"');
		expect(state.sets).toEqual([]);
	});

	it("stores the result on a claimed row", async () => {
		state.selects = [[requestRow({ status: "claimed" })]];

		await expect(aiRequestsService.complete({ userId: "user-1", id: "req-1", text: " OK " })).resolves.toEqual({
			id: "req-1",
			status: "completed",
		});
		expect(state.sets.at(-1)).toMatchObject({ status: "completed", result: { text: "OK" } });
	});

	it("refuses to complete a row that is not claimed", async () => {
		state.selects = [[requestRow({ status: "queued" })]];

		await expect(aiRequestsService.complete({ userId: "user-1", id: "req-1", text: "OK" })).rejects.toThrow(
			"Request is queued, not claimed.",
		);
	});

	it("records the agent's reason when it gives up", async () => {
		state.selects = [[requestRow({ status: "claimed" })]];

		await expect(
			aiRequestsService.fail({ userId: "user-1", id: "req-1", reason: " no PDF support " }),
		).resolves.toEqual({ id: "req-1", status: "failed" });
		expect(state.sets.at(-1)).toMatchObject({ status: "failed", error: "no PDF support" });
	});
});
