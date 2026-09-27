import { z } from "zod";

const AI_PROVIDERS = [
	"openai",
	"anthropic",
	"gemini",
	"vercel-ai-gateway",
	"openrouter",
	"mistral",
	"cohere",
	"xai",
	"groq",
	"deepseek",
	"togetherai",
	"fireworks",
	"cerebras",
	"perplexity",
	"ollama",
	"openai-compatible",
	// Served by an MCP client (Claude Code, Codex, ...) that claims queued requests and answers
	// them with its own model; no API key or base URL.
	"mcp-agent",
] as const;

export type AIProvider = (typeof AI_PROVIDERS)[number];

export const aiProviderSchema = z.enum(AI_PROVIDERS);

// Every place the app calls a language model, grouped as users recognise them. Each feature can
// be routed to a saved provider; `default` is the explicit fallback for unrouted features.
export const AI_FEATURES = [
	"default",
	"chat",
	"import",
	"ats-review",
	"autofill",
	"evaluation",
	"tailoring",
	"cover-letter",
	"outreach",
	"stories",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export const aiFeatureSchema = z.enum(AI_FEATURES);

export const AI_PROVIDER_DEFAULT_BASE_URLS: Record<AIProvider, string> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	gemini: "https://generativelanguage.googleapis.com/v1beta",
	"vercel-ai-gateway": "https://ai-gateway.vercel.sh/v3/ai",
	openrouter: "https://openrouter.ai/api/v1",
	mistral: "https://api.mistral.ai/v1",
	cohere: "https://api.cohere.com/v2",
	xai: "https://api.x.ai/v1",
	groq: "https://api.groq.com/openai/v1",
	deepseek: "https://api.deepseek.com/v1",
	togetherai: "https://api.together.xyz/v1",
	fireworks: "https://api.fireworks.ai/inference/v1",
	cerebras: "https://api.cerebras.ai/v1",
	perplexity: "https://api.perplexity.ai",
	ollama: "https://ollama.com/api",
	"openai-compatible": "",
	"mcp-agent": "",
};

// Brand names, used when a message has to name the provider outside a translated UI string. Every
// such message opens with this value, so the generic fallback is capitalised to match.
export const AI_PROVIDER_DISPLAY_NAMES: Record<AIProvider, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	gemini: "Google Gemini",
	"vercel-ai-gateway": "Vercel AI Gateway",
	openrouter: "OpenRouter",
	mistral: "Mistral",
	cohere: "Cohere",
	xai: "xAI",
	groq: "Groq",
	deepseek: "DeepSeek",
	togetherai: "Together AI",
	fireworks: "Fireworks AI",
	cerebras: "Cerebras",
	perplexity: "Perplexity",
	ollama: "Ollama",
	"openai-compatible": "The provider",
	"mcp-agent": "Connected agent (MCP)",
};
