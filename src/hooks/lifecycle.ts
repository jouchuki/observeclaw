import type { PluginLogger, HookContext } from "../types/plugin.js";
import * as spendTracker from "../spend-tracker.js";

export function handleSessionStart(_event: unknown, ctx: HookContext, logger: PluginLogger): void {
	logger.info(`[observeclaw] session started: ${ctx.sessionKey} (agent: ${ctx.agentId})`);
}

export function handleSessionEnd(_event: unknown, ctx: HookContext, logger: PluginLogger): void {
	const agentId = ctx.agentId ?? "default";
	const spend = spendTracker.get(agentId);
	const session = spend?.sessions.get(ctx.sessionKey ?? "");
	if (session) {
		logger.info(
			`[observeclaw] session ended: ${ctx.sessionKey} | cost: $${session.cost.toFixed(4)} | calls: ${session.callCount}`,
		);
	}
}

export function handleGatewayStart(logger: PluginLogger): void {
	logger.info("[observeclaw] gateway started — tracking active");
}

export function handleGatewayStop(
	logger: PluginLogger,
	clearTimers: () => void,
): void {
	clearTimers();

	const summary = spendTracker.getSummary();
	if (summary.length > 0) {
		logger.info("[observeclaw] final spend summary:");
		for (const s of summary) {
			logger.info(`  ${s.agentId}: today=$${s.today.toFixed(2)} month=$${s.thisMonth.toFixed(2)} calls=${s.callCount}`);
		}
	}
}
