import type { ModelPricing } from "./types.js";

/**
 * Default pricing per million tokens for common models.
 * Source: provider pricing pages as of March 2026.
 * Override via plugin config `pricing` field.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
	// Anthropic — https://platform.claude.com/docs/en/about-claude/pricing
	"anthropic/claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"anthropic/claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

	// OpenAI — https://developers.openai.com/api/docs/pricing
	"openai/gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.875, cacheWrite: 1.75 },
	"openai/gpt-5": { input: 1.25, output: 10, cacheRead: 0.625, cacheWrite: 1.25 },
	"openai/gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.125, cacheWrite: 0.25 },
	"openai/gpt-4.1": { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
	"openai/gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.2, cacheWrite: 0.4 },
	"openai/gpt-4.1-nano": { input: 0.05, output: 0.2, cacheRead: 0.025, cacheWrite: 0.05 },
	"openai/gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
	"openai/gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
	"openai/o3": { input: 2, output: 8, cacheRead: 1, cacheWrite: 2 },
	"openai/o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
	"openai/codex-mini": { input: 1.5, output: 6, cacheRead: 0.75, cacheWrite: 1.5 },

	// Google — https://ai.google.dev/gemini-api/docs/pricing
	"google/gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 2 },
	"google/gemini-3.1-flash": { input: 0.5, output: 3, cacheRead: 0.125, cacheWrite: 0.5 },
	"google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.0625, cacheWrite: 0.25 },
	"google/gemini-2.5-pro": { input: 1, output: 10, cacheRead: 0.25, cacheWrite: 1 },
	"google/gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },

	// DeepSeek — https://api-docs.deepseek.com/quick_start/pricing
	"deepseek/deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
	"deepseek/deepseek-reasoner": { input: 0.5, output: 2.18, cacheRead: 0.05, cacheWrite: 0.5 },

	// Mistral
	"mistral/mistral-medium-3": { input: 0.4, output: 2, cacheRead: 0.04, cacheWrite: 0.4 },

	// Meta (via API providers)
	"meta/llama-4-maverick": { input: 0.27, output: 0.85, cacheRead: 0.027, cacheWrite: 0.27 },

	// Local models (free)
	"ollama/*": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	"lm-studio/*": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

let configOverrides: Record<string, ModelPricing> = {};

export function setConfigPricing(overrides: Record<string, ModelPricing>): void {
	configOverrides = overrides;
}

export function getModelPricing(provider: string, model: string): ModelPricing | undefined {
	const key = `${provider}/${model}`;

	// Config overrides take precedence
	if (configOverrides[key]) return configOverrides[key];

	// Exact match in defaults
	if (DEFAULT_PRICING[key]) return DEFAULT_PRICING[key];

	// Wildcard match (e.g., "ollama/*")
	const wildcardKey = `${provider}/*`;
	if (configOverrides[wildcardKey]) return configOverrides[wildcardKey];
	if (DEFAULT_PRICING[wildcardKey]) return DEFAULT_PRICING[wildcardKey];

	return undefined;
}

export function calculateCost(
	provider: string,
	model: string,
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number {
	const pricing = getModelPricing(provider, model);
	if (!pricing) return 0;

	const input = (usage.input ?? 0) * pricing.input;
	const output = (usage.output ?? 0) * pricing.output;
	const cacheRead = (usage.cacheRead ?? 0) * pricing.cacheRead;
	const cacheWrite = (usage.cacheWrite ?? 0) * pricing.cacheWrite;

	return (input + output + cacheRead + cacheWrite) / 1_000_000;
}
