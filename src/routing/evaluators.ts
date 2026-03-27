import type { PluginLogger } from "../types/plugin.js";
import type {
	RoutingDecision,
	RegexEvaluatorConfig,
	ClassifierEvaluatorConfig,
	WebhookEvaluatorConfig,
} from "./types.js";

export function runRegexEvaluator(
	prompt: string,
	config: RegexEvaluatorConfig,
	logger?: PluginLogger,
): RoutingDecision | null {
	for (const pattern of config.patterns) {
		try {
			const regex = new RegExp(pattern, "i");
			if (regex.test(prompt)) {
				return {
					provider: config.provider,
					model: config.model,
					reason: `${config.name}:regex_match`,
				};
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			logger?.warn(`[observeclaw] regex evaluator ${config.name}: invalid pattern "${pattern}" — ${message}`);
		}
	}
	return null;
}

export async function runClassifierEvaluator(
	prompt: string,
	config: ClassifierEvaluatorConfig,
	logger: PluginLogger,
): Promise<RoutingDecision | null> {
	const classificationPrompt = config.prompt.replace("{{message}}", prompt);
	const timeoutMs = config.timeoutMs ?? 3000;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const response = await fetch(config.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.classifierModel,
				messages: [{ role: "user", content: classificationPrompt }],
				max_tokens: 50,
				temperature: 0,
			}),
			signal: controller.signal,
		});

		clearTimeout(timer);

		if (!response.ok) {
			logger.warn(`[observeclaw] classifier ${config.name} returned ${response.status}`);
			return null;
		}

		const data = (await response.json()) as Record<string, unknown>;
		const choices = data?.choices as Array<{ message?: { content?: string } }> | undefined;
		const ollamaMessage = data?.message as { content?: string } | undefined;

		const label = (
			choices?.[0]?.message?.content ??
			ollamaMessage?.content ??
			""
		).trim().toLowerCase();

		// Exact match
		const route = config.routes[label];
		if (route) {
			return { provider: route.provider, model: route.model, reason: `${config.name}:${label}` };
		}

		// Partial match
		for (const [key, value] of Object.entries(config.routes)) {
			if (label.includes(key.toLowerCase())) {
				return { provider: value.provider, model: value.model, reason: `${config.name}:${key}` };
			}
		}

		return null;
	} catch (err: unknown) {
		const isAbort = err instanceof Error && err.name === "AbortError";
		if (isAbort) {
			logger.warn(`[observeclaw] classifier ${config.name} timed out (${timeoutMs}ms)`);
		} else {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`[observeclaw] classifier ${config.name} failed: ${message}`);
		}
		return null;
	}
}

export async function runWebhookEvaluator(
	prompt: string,
	agentId: string,
	config: WebhookEvaluatorConfig,
	logger: PluginLogger,
): Promise<RoutingDecision | null> {
	const timeoutMs = config.timeoutMs ?? 2000;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const response = await fetch(config.url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(config.headers ?? {}) },
			body: JSON.stringify({ prompt, agentId }),
			signal: controller.signal,
		});

		clearTimeout(timer);

		if (!response.ok) {
			logger.warn(`[observeclaw] webhook evaluator ${config.name} returned ${response.status}`);
			return null;
		}

		const data = (await response.json()) as Record<string, unknown>;
		if (typeof data?.provider === "string" && typeof data?.model === "string") {
			return {
				provider: data.provider,
				model: data.model,
				reason: `${config.name}:webhook`,
			};
		}

		return null;
	} catch (err: unknown) {
		const isAbort = err instanceof Error && err.name === "AbortError";
		if (isAbort) {
			logger.warn(`[observeclaw] webhook evaluator ${config.name} timed out (${timeoutMs}ms)`);
		} else {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`[observeclaw] webhook evaluator ${config.name} failed: ${message}`);
		}
		return null;
	}
}
