import type { PluginLogger } from "../types/plugin.js";
import type { ObserveClawConfig } from "../types/config.js";
import { shouldCancelMessage } from "../budget-enforcer.js";
import * as spendTracker from "../spend-tracker.js";

export function handleMessageSending(
	_event: unknown,
	ctx: { agentId?: string },
	config: ObserveClawConfig,
	logger: PluginLogger,
): { cancel: boolean } | undefined {
	const agentId = ctx.agentId;
	if (agentId && shouldCancelMessage(agentId, config)) {
		logger.warn(`[observeclaw] ${agentId} | outbound message cancelled (over budget)`);
		return { cancel: true };
	}
}

export function handleMessageSent(_event: unknown, ctx: { agentId?: string }): void {
	if (ctx.agentId) spendTracker.recordToolCall(ctx.agentId);
}
