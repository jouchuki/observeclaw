import type { PluginLogger } from "../types/plugin.js";
import type {
	EvaluatorConfig,
	EvaluatorResult,
	RoutingDecision,
	RoutingEvent,
	RoutingPipelineResult,
} from "./types.js";
import { runRegexEvaluator, runClassifierEvaluator, runWebhookEvaluator } from "./evaluators.js";

/**
 * Run all enabled evaluators in parallel with early exit.
 *
 * - Evaluators sorted by priority descending
 * - If the highest-priority evaluator matches instantly (regex), lower-priority
 *   async evaluators are skipped before their network call starts
 * - Returns null decision if no evaluator claims the message (OpenClaw default)
 * - shouldBlock is true if ANY matched evaluator has blockMessage=true
 */
export async function runRoutingPipeline(
	prompt: string,
	agentId: string,
	evaluators: EvaluatorConfig[],
	logger: PluginLogger,
): Promise<RoutingPipelineResult> {
	const pipelineStart = Date.now();
	const enabled = evaluators.filter((e) => e.enabled);

	if (enabled.length === 0) {
		return {
			decision: null,
			shouldBlock: false,
			event: {
				agentId,
				promptPreview: prompt.slice(0, 120),
				timestamp: pipelineStart,
				durationMs: 0,
				winner: null,
				evaluators: [],
			},
		};
	}

	const sorted = [...enabled].sort((a, b) => b.priority - a.priority);
	const highestPriority = sorted[0]!.priority;
	const earlyExitController = new AbortController();

	const evaluatorPromises = sorted.map(async (evaluator): Promise<EvaluatorResult> => {
		const start = Date.now();
		let decision: RoutingDecision | null = null;
		let error: string | undefined;
		let label: string | undefined;
		let cancelled = false;

		try {
			switch (evaluator.type) {
				case "regex":
					decision = runRegexEvaluator(prompt, evaluator, logger);
					break;
				case "classifier":
					if (earlyExitController.signal.aborted && evaluator.priority < highestPriority) {
						cancelled = true;
						break;
					}
					decision = await runClassifierEvaluator(prompt, evaluator, logger);
					if (decision?.reason) {
						const parts = decision.reason.split(":");
						if (parts.length > 1) label = parts[1];
					}
					break;
				case "webhook":
					if (earlyExitController.signal.aborted && evaluator.priority < highestPriority) {
						cancelled = true;
						break;
					}
					decision = await runWebhookEvaluator(prompt, agentId, evaluator, logger);
					break;
			}

			if (decision !== null && evaluator.priority === highestPriority) {
				earlyExitController.abort();
			}
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : String(err);
		}

		return {
			name: evaluator.name,
			type: evaluator.type,
			priority: evaluator.priority,
			matched: decision !== null,
			durationMs: Date.now() - start,
			decision,
			error: cancelled ? "skipped:early_exit" : error,
			label,
			emitEvent: evaluator.emitEvent ?? false,
			webhooks: evaluator.webhooks,
			blockMessage: (evaluator.blockMessage ?? false) && decision !== null,
			blockReply: evaluator.blockReply,
		};
	});

	const evaluatorResults = await Promise.all(evaluatorPromises);

	const winner = evaluatorResults
		.filter((r) => r.matched)
		.sort((a, b) => b.priority - a.priority)[0] ?? null;

	const event: RoutingEvent = {
		agentId,
		promptPreview: prompt.slice(0, 120),
		timestamp: pipelineStart,
		durationMs: Date.now() - pipelineStart,
		winner,
		evaluators: evaluatorResults,
	};

	const blocker = evaluatorResults.find((r) => r.blockMessage);

	return {
		decision: winner?.decision ?? null,
		shouldBlock: blocker !== undefined,
		blockReply: blocker?.blockReply,
		event,
	};
}
