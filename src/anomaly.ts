import type { AgentSpend, AnomalyAlert, AnomalyConfig } from "./types.js";

function average(arr: number[]): number {
	if (arr.length === 0) return 0;
	let sum = 0;
	for (const v of arr) sum += v;
	return sum / arr.length;
}

interface Detector {
	name: string;
	check(agentId: string, spend: AgentSpend, config: AnomalyConfig, dailyBudget: number): AnomalyAlert | null;
}

const detectors: Detector[] = [
	{
		name: "spend_spike",
		check(agentId, spend, config) {
			const avg = average(spend.hourlyHistory);
			if (avg > 0 && spend.lastHourCost > avg * config.spendSpikeMultiplier) {
				return {
					type: "spend_spike",
					agentId,
					severity: "warning",
					message: `Hourly spend $${spend.lastHourCost.toFixed(2)} is ${(spend.lastHourCost / avg).toFixed(1)}x average ($${avg.toFixed(2)})`,
					metric: { current: spend.lastHourCost, average: avg, ratio: spend.lastHourCost / avg },
				};
			}
			return null;
		},
	},
	{
		name: "idle_burn",
		// Track last emitted state per agent to avoid spamming
		_lastEmitted: new Map<string, { minute: number; spend: number }>(),
		check(agentId, spend, config) {
			const idleMs = Date.now() - spend.lastProductiveToolCallAt;
			const thresholdMs = config.idleBurnMinutes * 60_000;
			if (spend.callCount > 0 && idleMs > thresholdMs && spend.lastHourCost > 0) {
				const idleMin = Math.round(idleMs / 60_000);
				const spendRounded = Math.round(spend.lastHourCost * 100); // cents
				const last = this._lastEmitted.get(agentId);
				// Only emit if minute changed OR spend changed
				if (last && last.minute === idleMin && last.spend === spendRounded) {
					return null;
				}
				this._lastEmitted.set(agentId, { minute: idleMin, spend: spendRounded });
				return {
					type: "idle_burn",
					agentId,
					severity: "warning",
					message: `Agent calling LLM for ${idleMin}min with no tool output. Spent $${spend.lastHourCost.toFixed(2)} during idle.`,
					metric: { idleMinutes: idleMin, spendDuringIdle: spend.lastHourCost },
				};
			}
			// Reset tracking when agent becomes productive again
			this._lastEmitted.delete(agentId);
			return null;
		},
	},
	{
		name: "error_loop",
		check(agentId, spend, config) {
			if (spend.consecutiveErrors >= config.errorLoopThreshold) {
				return {
					type: "error_loop",
					agentId,
					severity: "critical",
					action: "auto_pause",
					message: `${spend.consecutiveErrors} consecutive LLM errors. Auto-pausing agent.`,
					metric: { consecutiveErrors: spend.consecutiveErrors },
				};
			}
			return null;
		},
	},
	{
		name: "token_inflation",
		check(agentId, spend, config) {
			if (spend.recentInputTokens.length >= 5) {
				const firstHalf = spend.recentInputTokens.slice(0, Math.floor(spend.recentInputTokens.length / 2));
				const secondHalf = spend.recentInputTokens.slice(Math.floor(spend.recentInputTokens.length / 2));
				const first = average(firstHalf);
				const last = average(secondHalf);
				if (first > 0 && last > first * config.tokenInflationMultiplier) {
					return {
						type: "token_inflation",
						agentId,
						severity: "info",
						message: `Input tokens growing: ${Math.round(first)} -> ${Math.round(last)} avg (${(last / first).toFixed(1)}x)`,
						metric: { firstAvg: first, lastAvg: last, ratio: last / first },
					};
				}
			}
			return null;
		},
	},
	{
		name: "budget_warning",
		check(agentId, spend, _config, dailyBudget) {
			if (dailyBudget <= 0) return null;
			const ratio = spend.today / dailyBudget;
			if (ratio >= 0.8 && ratio < 1.0 && !spend.warningEmitted) {
				spend.warningEmitted = true;
				return {
					type: "budget_warning",
					agentId,
					severity: "warning",
					message: `Agent at ${(ratio * 100).toFixed(0)}% of daily budget ($${spend.today.toFixed(2)}/$${dailyBudget.toFixed(2)})`,
					metric: { spent: spend.today, budget: dailyBudget, ratio },
				};
			}
			return null;
		},
	},
];

export function runDetectors(agentId: string, spend: AgentSpend, config: AnomalyConfig, dailyBudget: number): AnomalyAlert[] {
	const alerts: AnomalyAlert[] = [];
	for (const detector of detectors) {
		const alert = detector.check(agentId, spend, config, dailyBudget);
		if (alert) alerts.push(alert);
	}
	return alerts;
}
