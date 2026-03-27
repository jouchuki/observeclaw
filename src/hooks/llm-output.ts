import type { PluginLogger, HookContext } from "../types/plugin.js";
import type { ObserveClawConfig } from "../types/config.js";
import * as spendTracker from "../spend-tracker.js";

export function handleLlmOutput(
	event: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; provider?: string; model?: string },
	ctx: HookContext,
	logger: PluginLogger,
): void {
	if (!event.usage) return;

	const agentId = ctx.agentId ?? "default";
	const cost = spendTracker.record(
		agentId,
		event.provider ?? "unknown",
		event.model ?? "unknown",
		{
			input: event.usage.input,
			output: event.usage.output,
			cacheRead: event.usage.cacheRead,
			cacheWrite: event.usage.cacheWrite,
		},
		ctx.sessionKey,
	);

	const spend = spendTracker.get(agentId);
	if (cost > 0) {
		logger.info(
			`[observeclaw] ${agentId} | call: $${cost.toFixed(4)} | today: $${spend?.today.toFixed(2)} | ${event.provider}/${event.model}`,
		);
	} else {
		logger.warn(
			`[observeclaw] ${agentId} | call: $0 (no pricing for ${event.provider}/${event.model}) | tokens: in=${event.usage.input ?? 0} out=${event.usage.output ?? 0}`,
		);
	}
}
