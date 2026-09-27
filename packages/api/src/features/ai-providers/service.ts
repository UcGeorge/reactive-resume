import type { AIProvider, AiFeature } from "@reactive-resume/ai/types";
import type { AiProviderRouteStatus, ResolvedRoute } from "./routing";
import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { aiProviderSchema } from "@reactive-resume/ai/types";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import {
	assertCredentialEncryptionConfigured,
	decryptCredential,
	encryptCredential,
	redactEncryptedCredential,
} from "../ai/credentials";
import { testConnection } from "../ai/service";
import { resolveAiBaseUrl } from "../ai/url-policy";
import { listRouteStatuses, resolveFeatureProviderId } from "./routing";

type AiProviderRecord = typeof schema.aiProvider.$inferSelect;

export type AiProviderResponse = {
	id: string;
	label: string;
	provider: AIProvider;
	model: string;
	baseURL: string | null;
	enabled: boolean;
	testStatus: string;
	testError: string | null;
	apiKeyPreview: string;
	apiKeyFingerprint: string;
	lastTestedAt: Date | null;
	lastUsedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

type CreateAiProviderInput = {
	userId: string;
	label: string;
	provider: AIProvider;
	model: string;
	baseURL?: string | null;
	// Optional only for connected agents, which get a server-minted placeholder.
	apiKey?: string;
};

export type RunnableAiProvider = AiProviderResponse & { userId: string; apiKey: string; baseURL: string };

// A connected agent has nothing to authenticate with; the placeholder keeps the encrypted
// credential column non-null and is never shown or used.
function mintPlaceholderKey() {
	return randomBytes(24).toString("base64url");
}

type UpdateAiProviderInput = {
	id: string;
	userId: string;
	label?: string;
	provider?: AIProvider;
	model?: string;
	baseURL?: string | null;
	apiKey?: string;
	enabled?: boolean;
};

function toResponse(row: AiProviderRecord): AiProviderResponse {
	const provider = aiProviderSchema.parse(row.provider);
	const { apiKeyFingerprint, apiKeyPreview } = redactEncryptedCredential({
		encryptedApiKey: row.encryptedApiKey,
		apiKeySalt: row.apiKeySalt,
		apiKeyHash: row.apiKeyHash,
		apiKeyPreview: row.apiKeyPreview,
	});

	return {
		id: row.id,
		label: row.label,
		provider,
		model: row.model,
		baseURL: row.baseUrl,
		enabled: row.enabled,
		testStatus: row.testStatus,
		testError: row.testError,
		apiKeyPreview,
		apiKeyFingerprint,
		lastTestedAt: row.lastTestedAt,
		lastUsedAt: row.lastUsedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function normalizeBaseUrl(input: { provider: AIProvider; baseURL?: string | null | undefined }) {
	const trimmed = input.baseURL?.trim() ?? "";
	if (!trimmed || input.provider === "mcp-agent") return null;

	return resolveAiBaseUrl({ provider: input.provider, baseURL: trimmed });
}

function toRunnable(row: AiProviderRecord, userId: string): RunnableAiProvider {
	return {
		...toResponse(row),
		userId,
		apiKey: decryptCredential(row.encryptedApiKey),
		baseURL: row.baseUrl ?? "",
	};
}

async function loadProvidersAndRoutes(userId: string) {
	const [providers, routes] = await Promise.all([
		db.select().from(schema.aiProvider).where(eq(schema.aiProvider.userId, userId)),
		db.select().from(schema.aiProviderRoute).where(eq(schema.aiProviderRoute.userId, userId)),
	]);

	return { providers, routes };
}

async function getOwnedProvider(input: { id: string; userId: string }) {
	const [provider] = await db
		.select()
		.from(schema.aiProvider)
		.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
		.limit(1);

	if (!provider) throw new ORPCError("NOT_FOUND");

	return provider;
}

export const aiProvidersService = {
	list: async (input: { userId: string }) => {
		assertCredentialEncryptionConfigured();

		const providers = await db
			.select()
			.from(schema.aiProvider)
			.where(eq(schema.aiProvider.userId, input.userId))
			.orderBy(
				desc(sql<Date>`coalesce(${schema.aiProvider.lastUsedAt}, '1970-01-01T00:00:00.000Z'::timestamptz)`),
				asc(schema.aiProvider.createdAt),
			);

		return providers.map(toResponse);
	},

	getRunnableById: async (input: { id: string; userId: string }) => {
		assertCredentialEncryptionConfigured();

		const provider = await getOwnedProvider(input);
		if (!provider.enabled || provider.testStatus !== "success") {
			throw new ORPCError("BAD_REQUEST", { message: "AI provider must be tested and enabled before use." });
		}

		return toRunnable(provider, input.userId);
	},

	getDefaultRunnable: async (input: { userId: string }) => {
		assertCredentialEncryptionConfigured();

		const [provider] = await db
			.select()
			.from(schema.aiProvider)
			.where(
				and(
					eq(schema.aiProvider.userId, input.userId),
					eq(schema.aiProvider.enabled, true),
					eq(schema.aiProvider.testStatus, "success"),
				),
			)
			.orderBy(asc(schema.aiProvider.createdAt))
			.limit(1);

		return provider ? toRunnable(provider, input.userId) : null;
	},

	/** The provider a feature resolves to (feature route → default route → oldest runnable). */
	resolveForFeature: async (input: {
		userId: string;
		feature: AiFeature;
	}): Promise<Omit<ResolvedRoute, "providerId"> & { provider: RunnableAiProvider | null }> => {
		assertCredentialEncryptionConfigured();

		const { providers, routes } = await loadProvidersAndRoutes(input.userId);
		const { providerId, ...resolved } = resolveFeatureProviderId(input.feature, routes, providers);
		const row = providerId ? providers.find((provider) => provider.id === providerId) : undefined;

		return { ...resolved, provider: row ? toRunnable(row, input.userId) : null };
	},

	routes: {
		list: async (input: { userId: string }): Promise<AiProviderRouteStatus[]> => {
			assertCredentialEncryptionConfigured();

			const { providers, routes } = await loadProvidersAndRoutes(input.userId);
			return listRouteStatuses(routes, providers);
		},

		// Null clears the route (the feature falls back to Default); otherwise the provider must be
		// the caller's. Untested or disabled providers may be assigned: the resolver skips them at
		// call time and the list reports them as unavailable.
		set: async (input: { userId: string; feature: AiFeature; aiProviderId: string | null }) => {
			assertCredentialEncryptionConfigured();

			if (input.aiProviderId === null) {
				await db
					.delete(schema.aiProviderRoute)
					.where(
						and(eq(schema.aiProviderRoute.userId, input.userId), eq(schema.aiProviderRoute.feature, input.feature)),
					);
			} else {
				await getOwnedProvider({ id: input.aiProviderId, userId: input.userId });
				await db
					.insert(schema.aiProviderRoute)
					.values({ userId: input.userId, feature: input.feature, aiProviderId: input.aiProviderId })
					.onConflictDoUpdate({
						target: [schema.aiProviderRoute.userId, schema.aiProviderRoute.feature],
						set: { aiProviderId: input.aiProviderId, updatedAt: new Date() },
					});
			}

			return aiProvidersService.routes.list({ userId: input.userId });
		},
	},

	create: async (input: CreateAiProviderInput) => {
		assertCredentialEncryptionConfigured();

		const apiKey = input.provider === "mcp-agent" ? mintPlaceholderKey() : input.apiKey?.trim();
		if (!apiKey) throw new ORPCError("BAD_REQUEST", { message: "API key is required." });

		const encrypted = encryptCredential(apiKey);
		const [provider] = await db
			.insert(schema.aiProvider)
			.values({
				userId: input.userId,
				label: input.label.trim(),
				provider: input.provider,
				model: input.model.trim(),
				baseUrl: normalizeBaseUrl(input),
				...encrypted,
			})
			.returning();

		if (!provider) throw new Error("AI_PROVIDER_CREATE_FAILED");

		return toResponse(provider);
	},

	update: async (input: UpdateAiProviderInput) => {
		assertCredentialEncryptionConfigured();

		const existing = await getOwnedProvider(input);
		const provider = input.provider ?? aiProviderSchema.parse(existing.provider);
		const providerChanged = input.provider !== undefined && input.provider !== existing.provider;
		// Switching to a connected agent mints its placeholder; switching away requires a real key.
		const nextApiKey =
			input.apiKey?.trim() || (provider === "mcp-agent" && providerChanged ? mintPlaceholderKey() : undefined);
		const encrypted = nextApiKey ? encryptCredential(nextApiKey) : {};
		const credentialChanged = !!nextApiKey;
		const baseUrlTouched = input.baseURL !== undefined || provider === "mcp-agent";
		const nextBaseUrl = baseUrlTouched ? normalizeBaseUrl({ provider, baseURL: input.baseURL }) : existing.baseUrl;
		const modelChanged = input.model !== undefined && input.model.trim() !== existing.model;
		const baseUrlChanged = baseUrlTouched && nextBaseUrl !== existing.baseUrl;
		const runtimeChanged = credentialChanged || providerChanged || modelChanged || baseUrlChanged;

		if (input.enabled === true && existing.testStatus !== "success" && !runtimeChanged) {
			throw new ORPCError("BAD_REQUEST", { message: "AI provider must be tested successfully before enabling." });
		}

		const [updated] = await db
			.update(schema.aiProvider)
			.set({
				...(input.label !== undefined ? { label: input.label.trim() } : {}),
				...(input.provider !== undefined ? { provider: input.provider } : {}),
				...(input.model !== undefined ? { model: input.model.trim() } : {}),
				...(baseUrlTouched ? { baseUrl: nextBaseUrl } : {}),
				...(input.enabled !== undefined && !runtimeChanged ? { enabled: input.enabled } : {}),
				...(runtimeChanged ? { enabled: false, testStatus: "untested", lastTestedAt: null, testError: null } : {}),
				...encrypted,
			})
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
			.returning();

		if (!updated) throw new ORPCError("NOT_FOUND");
		return toResponse(updated);
	},

	delete: async (input: { id: string; userId: string }) => {
		assertCredentialEncryptionConfigured();

		await db
			.delete(schema.aiProvider)
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)));
	},

	test: async (input: { id: string; userId: string }) => {
		assertCredentialEncryptionConfigured();

		const provider = await getOwnedProvider(input);
		const parsedProvider = aiProviderSchema.parse(provider.provider);
		const apiKey = decryptCredential(provider.encryptedApiKey);

		try {
			const result = await testConnection({
				provider: parsedProvider,
				model: provider.model,
				apiKey,
				baseURL: provider.baseUrl ?? "",
				id: provider.id,
				userId: input.userId,
			});

			// A provider that answers "no" is a completed test, not a failed request: it comes back as
			// data so the client can show why, instead of a generic transport error.
			const [updated] = await db
				.update(schema.aiProvider)
				.set({
					enabled: result.ok,
					testStatus: result.ok ? "success" : "failure",
					testError: result.ok ? null : result.message,
					lastTestedAt: new Date(),
				})
				.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)))
				.returning();

			if (!updated) throw new ORPCError("NOT_FOUND");
			return toResponse(updated);
		} catch (error) {
			// Only unexpected failures reach here now: provider-side outcomes come back as data above.
			await db
				.update(schema.aiProvider)
				.set({
					enabled: false,
					testStatus: "failure",
					testError: error instanceof Error ? error.message : "Failed to test provider.",
					lastTestedAt: new Date(),
				})
				.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)));

			throw error;
		}
	},

	markUsed: async (input: { id: string; userId: string }) => {
		await db
			.update(schema.aiProvider)
			.set({ lastUsedAt: new Date() })
			.where(and(eq(schema.aiProvider.id, input.id), eq(schema.aiProvider.userId, input.userId)));
	},
};
