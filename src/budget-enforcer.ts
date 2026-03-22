import * as spendTracker from "./spend-tracker.js";
import type { BudgetConfig, ObserveClawConfig } from "./types.js";

export function resolveBudget(agentId: string, config: ObserveClawConfig): BudgetConfig {
	return config.budgets.agents[agentId] ?? config.budgets.defaults;
}

export interface BudgetDecision {
	action: "allow" | "downgrade" | "block";
	reason?: string;
	modelOverride?: string;
	providerOverride?: string;
}

export function checkBudget(agentId: string, config: ObserveClawConfig): BudgetDecision {
	const budget = resolveBudget(agentId, config);
	const ratio = spendTracker.getBudgetRatio(agentId, budget.daily);

	// Under warning threshold — allow
	if (ratio < budget.warnAt) {
		return { action: "allow" };
	}

	// Between warning and limit — downgrade to cheaper model
	if (ratio >= budget.warnAt && ratio < 1.0) {
		return {
			action: "downgrade",
			reason: `Budget at ${(ratio * 100).toFixed(0)}% ($${(ratio * budget.daily).toFixed(2)}/$${budget.daily.toFixed(2)}). Downgrading model.`,
			modelOverride: config.downgradeModel,
			providerOverride: config.downgradeProvider,
		};
	}

	// Over budget — still downgrade (message_sending hook will cancel the outbound)
	return {
		action: "block",
		reason: `Daily budget exceeded: $${(ratio * budget.daily).toFixed(2)}/$${budget.daily.toFixed(2)}`,
		modelOverride: config.downgradeModel,
		providerOverride: config.downgradeProvider,
	};
}

export function shouldCancelMessage(agentId: string, config: ObserveClawConfig): boolean {
	const budget = resolveBudget(agentId, config);
	return spendTracker.isOverBudget(agentId, budget.daily);
}
