import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, queryMock, queryState } = vi.hoisted(() => {
	const state = {
		rows: [] as unknown[],
		// Rows for statements awaited straight after `.where()` (no `.limit()`), keyed by table.
		rowsByTable: new Map<unknown, unknown[]>(),
		whereArg: undefined as unknown,
		orderByArgs: [] as unknown[],
		deletedWhere: [] as unknown[],
	};
	type Statement = {
		where: (arg: unknown) => Statement;
		orderBy: (...args: unknown[]) => Statement;
		limit: (count: number) => Promise<unknown[]>;
		then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise<unknown>;
	};
	const limit = vi.fn(async () => state.rows);
	// Each `.from(table)` gets its own statement so concurrent selects (Promise.all) keep their
	// table; awaiting a statement without `.limit()` resolves that table's scripted rows.
	const statementFor = (table: unknown): Statement => {
		const statement: Statement = {
			where: vi.fn((arg: unknown) => {
				state.whereArg = arg;
				return statement;
			}),
			orderBy: vi.fn((...args: unknown[]) => {
				state.orderByArgs = args;
				return statement;
			}),
			limit,
			// biome-ignore lint/suspicious/noThenProperty: the query builder is awaited directly, like Drizzle's.
			then: (onFulfilled, onRejected) =>
				Promise.resolve(state.rowsByTable.get(table) ?? state.rows).then(onFulfilled, onRejected),
		};
		return statement;
	};
	const query = {
		from: vi.fn((table: unknown) => statementFor(table)),
		limit,
	};
	const deletion = {
		where: vi.fn((arg: unknown) => {
			state.deletedWhere.push(arg);
			return Promise.resolve();
		}),
	};

	return {
		dbMock: { select: vi.fn(() => query), delete: vi.fn(() => deletion) },
		queryMock: query,
		queryState: state,
	};
});

vi.mock("@reactive-resume/db/client", () => ({ db: dbMock }));
vi.mock("@reactive-resume/db/schema", () => ({
	aiProvider: {
		id: "ai_provider.id",
		userId: "ai_provider.user_id",
		label: "ai_provider.label",
		provider: "ai_provider.provider",
		model: "ai_provider.model",
		baseUrl: "ai_provider.base_url",
		encryptedApiKey: "ai_provider.encrypted_api_key",
		apiKeySalt: "ai_provider.api_key_salt",
		apiKeyHash: "ai_provider.api_key_hash",
		apiKeyPreview: "ai_provider.api_key_preview",
		testStatus: "ai_provider.test_status",
		testError: "ai_provider.test_error",
		lastTestedAt: "ai_provider.last_tested_at",
		lastUsedAt: "ai_provider.last_used_at",
		enabled: "ai_provider.enabled",
		createdAt: "ai_provider.created_at",
		updatedAt: "ai_provider.updated_at",
	},
	aiProviderRoute: {
		id: "ai_provider_route.id",
		userId: "ai_provider_route.user_id",
		feature: "ai_provider_route.feature",
		aiProviderId: "ai_provider_route.ai_provider_id",
		createdAt: "ai_provider_route.created_at",
		updatedAt: "ai_provider_route.updated_at",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ type: "and", conditions }),
	asc: (value: unknown) => ({ type: "asc", value }),
	desc: (value: unknown) => ({ type: "desc", value }),
	eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: "sql", strings: [...strings], values }),
}));
vi.mock("../ai/credentials", () => ({
	assertCredentialEncryptionConfigured: vi.fn(),
	decryptCredential: vi.fn(() => "decrypted-key"),
	encryptCredential: vi.fn(),
	redactEncryptedCredential: vi.fn(() => ({
		apiKeyFingerprint: "fingerprint",
		apiKeyPreview: "sk-...test",
	})),
}));
vi.mock("../ai/service", () => ({ testConnection: vi.fn() }));
vi.mock("../ai/url-policy", () => ({ resolveAiBaseUrl: vi.fn() }));

const { aiProvidersService } = await import("./service");
const schema = await import("@reactive-resume/db/schema");

function providerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-1",
		userId: "user-1",
		label: "OpenAI",
		provider: "openai",
		model: "gpt-5-mini",
		baseUrl: null,
		encryptedApiKey: "encrypted-key",
		apiKeySalt: "salt",
		apiKeyHash: "hash",
		apiKeyPreview: "preview",
		testStatus: "success",
		testError: null,
		lastTestedAt: new Date("2026-07-01T00:00:00Z"),
		lastUsedAt: new Date("2026-07-07T00:00:00Z"),
		enabled: true,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		updatedAt: new Date("2026-07-01T00:00:00Z"),
		...overrides,
	};
}

describe("aiProvidersService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryState.rows = [];
		queryState.rowsByTable = new Map();
		queryState.whereArg = undefined;
		queryState.orderByArgs = [];
		queryState.deletedWhere = [];
	});

	it("gets the first enabled and tested provider by creation order", async () => {
		queryState.rows = [providerRow({ id: "first-created" })];

		await expect(aiProvidersService.getDefaultRunnable({ userId: "user-1" })).resolves.toMatchObject({
			id: "first-created",
			apiKey: "decrypted-key",
		});

		expect(queryState.whereArg).toEqual({
			type: "and",
			conditions: [
				{ type: "eq", left: "ai_provider.user_id", right: "user-1" },
				{ type: "eq", left: "ai_provider.enabled", right: true },
				{ type: "eq", left: "ai_provider.test_status", right: "success" },
			],
		});
		expect(queryState.orderByArgs).toEqual([{ type: "asc", value: "ai_provider.created_at" }]);
		expect(queryMock.limit).toHaveBeenCalledWith(1);
	});
});

describe("aiProvidersService.resolveForFeature", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryState.rows = [];
		queryState.rowsByTable = new Map();
		queryState.deletedWhere = [];
	});

	it("uses the feature's route when its provider is runnable", async () => {
		queryState.rowsByTable.set(schema.aiProvider, [
			providerRow({ id: "oldest", createdAt: new Date("2026-06-01T00:00:00Z") }),
			providerRow({ id: "agent", provider: "mcp-agent" }),
		]);
		queryState.rowsByTable.set(schema.aiProviderRoute, [{ feature: "chat", aiProviderId: "agent" }]);

		await expect(aiProvidersService.resolveForFeature({ userId: "user-1", feature: "chat" })).resolves.toMatchObject({
			source: "feature",
			provider: { id: "agent", userId: "user-1", apiKey: "decrypted-key" },
		});
	});

	it("falls back to the oldest tested provider and flags the skipped route", async () => {
		queryState.rowsByTable.set(schema.aiProvider, [
			providerRow({ id: "oldest", createdAt: new Date("2026-06-01T00:00:00Z") }),
			providerRow({ id: "broken", enabled: false, testStatus: "failure" }),
		]);
		queryState.rowsByTable.set(schema.aiProviderRoute, [{ feature: "evaluation", aiProviderId: "broken" }]);

		await expect(
			aiProvidersService.resolveForFeature({ userId: "user-1", feature: "evaluation" }),
		).resolves.toMatchObject({ source: "fallback", warning: "unavailable", provider: { id: "oldest" } });
	});

	it("resolves to nothing when no provider can run", async () => {
		queryState.rowsByTable.set(schema.aiProvider, [
			providerRow({ id: "untested", testStatus: "untested", enabled: false }),
		]);
		queryState.rowsByTable.set(schema.aiProviderRoute, []);

		await expect(aiProvidersService.resolveForFeature({ userId: "user-1", feature: "stories" })).resolves.toEqual({
			source: "fallback",
			provider: null,
		});
	});

	it("clears a route when set to null and returns the refreshed list", async () => {
		queryState.rowsByTable.set(schema.aiProvider, [providerRow({ id: "only" })]);
		queryState.rowsByTable.set(schema.aiProviderRoute, []);

		const rows = await aiProvidersService.routes.set({ userId: "user-1", feature: "import", aiProviderId: null });

		expect(dbMock.delete).toHaveBeenCalledTimes(1);
		expect(queryState.deletedWhere[0]).toEqual({
			type: "and",
			conditions: [
				{ type: "eq", left: "ai_provider_route.user_id", right: "user-1" },
				{ type: "eq", left: "ai_provider_route.feature", right: "import" },
			],
		});
		expect(rows.find((row) => row.feature === "import")).toMatchObject({
			status: "unset",
			effectiveProviderId: "only",
			source: "fallback",
		});
	});
});
