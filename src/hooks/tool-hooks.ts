import type { PluginLogger, HookContext } from "../types/plugin.js";
import type { ObserveClawConfig } from "../types/config.js";
import type { AnomalyAlert } from "../types/events.js";
import { checkTool } from "../tool-policy.js";
import * as spendTracker from "../spend-tracker.js";

export function handleBeforeToolCall(
	event: { toolName: string },
	ctx: HookContext,
	config: ObserveClawConfig,
	logger: PluginLogger,
	broadcastAlert: (alert: AnomalyAlert) => void,
): { block: boolean; blockReason: string } | undefined {
	const agentId = ctx.agentId ?? "default";
	const decision = checkTool(agentId, event.toolName, config);

	if (!decision.allowed) {
		logger.warn(`[observeclaw] ${agentId} | tool blocked: ${event.toolName} | ${decision.reason}`);
		broadcastAlert({
			type: "budget_warning",
			agentId,
			severity: "warning",
			message: `Tool blocked: ${event.toolName} — ${decision.reason}`,
		});
		return { block: true, blockReason: decision.reason };
	}
}

export function handleAfterToolCall(_event: unknown, ctx: HookContext): void {
	const agentId = ctx.agentId ?? "default";
	spendTracker.recordToolCall(agentId);
}
