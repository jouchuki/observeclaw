import type { PluginLogger, HookContext } from "../types/plugin.js";
import type { ObserveClawConfig } from "../types/config.js";
import type { AnomalyAlert } from "../types/events.js";
import { checkBudget } from "../budget-enforcer.js";
import { runRoutingPipeline } from "../routing/pipeline.js";
import { validateEvaluators } from "../routing/validation.js";
import { dispatchWebhooks } from "../webhook.js";
import { setPendingRedaction } from "./prompt-build.js";

export function validateRoutingOnStartup(config: ObserveClawConfig, logger: PluginLogger): void {
	if (!config.routing.enabled || config.routing.evaluators.length === 0) return;

	const validationError = validateEvaluators(config.routing.evaluators);
	if (validationError) {
		logger.error(`[observeclaw] routing config error: ${validationError}`);
	} else {
		logger.info(
			`[observeclaw] routing active | ${config.routing.evaluators.filter((e) => e.enabled).length} evaluator(s) | fallback: openclaw default`,
		);
	}
}

export async function handleBeforeModelResolve(
	event: { prompt?: string },
	ctx: HookContext,
	config: ObserveClawConfig,
	logger: PluginLogger,
	broadcastAlert: (alert: AnomalyAlert) => void,
): Promise<{ providerOverride?: string; modelOverride?: string } | undefined> {
	const agentId = ctx.agentId ?? "default";

	// 1. Budget check (highest priority — overrides routing)
	const budgetDecision = checkBudget(agentId, config);

	if (budgetDecision.action === "downgrade") {
		logger.warn(`[observeclaw] ${agentId} | ${budgetDecision.reason} -> ${budgetDecision.modelOverride}`);
		broadcastAlert({
			type: "budget_warning",
			agentId,
			severity: "warning",
			message: budgetDecision.reason ?? "Approaching budget limit",
		});
		return {
			modelOverride: budgetDecision.modelOverride,
			providerOverride: budgetDecision.providerOverride,
		};
	}

	if (budgetDecision.action === "block") {
		logger.error(`[observeclaw] ${agentId} | BLOCKED: ${budgetDecision.reason}`);
		broadcastAlert({
			type: "budget_exceeded",
			agentId,
			severity: "critical",
			action: "auto_pause",
			message: budgetDecision.reason ?? "Budget exceeded",
		});
		// Force unknown model — no LLM call, zero cost
		return { modelOverride: `__OBSERVECLAW_BLOCKED__Budget exceeded. ${budgetDecision.reason}` };
	}

	// 2. Routing pipeline (only if enabled and under budget)
	if (!config.routing.enabled || config.routing.evaluators.length === 0) return;

	const prompt = event.prompt ?? "";
	const { decision: routeDecision, event: routingEvent, shouldBlock, blockReply, redactedPrompt, redactions } =
		await runRoutingPipeline(prompt, agentId, config.routing.evaluators, logger);

	// If any evaluator produced redactions, store them for before_prompt_build
	if (redactedPrompt && redactions.length > 0) {
		setPendingRedaction(agentId, redactedPrompt, redactions);
		logger.info(`[observeclaw] ${agentId} | ${redactions.length} redaction(s) queued for prompt build`);
	}

	// Log routing decision
	if (config.routing.logRouting) {
		if (routeDecision) {
			const preview = prompt.slice(0, 80).replace(/\n/g, " ");
			logger.info(
				`[observeclaw] route: ${agentId} → ${routeDecision.provider}/${routeDecision.model} | ${routingEvent.winner?.name}:${routeDecision.reason} | ${routingEvent.durationMs}ms | "${preview}${prompt.length > 80 ? "..." : ""}"`,
			);
		} else {
			logger.info(`[observeclaw] route: ${agentId} → openclaw default (no evaluator claimed) | ${routingEvent.durationMs}ms`);
		}
	}

	// Emit routing events — per-evaluator webhooks first, then global
	for (const ev of routingEvent.evaluators) {
		if (!ev.matched) continue;

		const alert: AnomalyAlert = {
			type: "routing_event",
			agentId,
			severity: "info",
			message: `Routing: ${ev.name} matched → ${routeDecision?.provider ?? "default"}/${routeDecision?.model ?? "default"} (${routingEvent.durationMs}ms)`,
			routingEvent,
		};

		if (ev.webhooks?.length) {
			dispatchWebhooks(alert, ev.webhooks.map((url) => ({ url })), logger).catch(() => {});
		}

		if (ev.emitEvent) {
			broadcastAlert(alert);
		}
	}

	// Block: force unknown model so the LLM call never happens
	if (shouldBlock) {
		const blockerNames = routingEvent.evaluators
			.filter((e) => e.blockMessage)
			.map((e) => e.name)
			.join(", ");
		const reply = blockReply ?? "Message blocked by security policy.";
		logger.warn(`[observeclaw] BLOCKED: ${agentId} | evaluator: ${blockerNames} | ${reply}`);

		for (const ev of routingEvent.evaluators) {
			if (ev.blockMessage && ev.webhooks?.length) {
				dispatchWebhooks(
					{ type: "routing_event", agentId, severity: "critical", message: `Message blocked by ${ev.name}`, routingEvent },
					ev.webhooks.map((url) => ({ url })),
					logger,
				).catch(() => {});
			}
		}

		return { modelOverride: `__OBSERVECLAW_BLOCKED__${reply}` };
	}

	if (routeDecision) {
		return { providerOverride: routeDecision.provider, modelOverride: routeDecision.model };
	}
}
