import type { EvaluatorConfig } from "../routing/types.js";

export interface WebhookConfig {
	url: string;
	minSeverity?: "info" | "warning" | "critical";
	headers?: Record<string, string>;
	timeoutMs?: number;
}

export interface RoutingConfig {
	enabled: boolean;
	evaluators: EvaluatorConfig[];
	logRouting: boolean;
}

export interface BudgetConfig {
	daily: number;
	monthly: number;
	warnAt: number; // 0-1 ratio, default 0.8
}

export interface ToolPolicyConfig {
	allow: string[];
	deny: string[];
}

export interface AnomalyConfig {
	spendSpikeMultiplier: number;
	idleBurnMinutes: number;
	errorLoopThreshold: number;
	tokenInflationMultiplier: number;
	checkIntervalSeconds: number;
}

export interface ModelPricing {
	input: number; // per million tokens
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ObserveClawConfig {
	enabled: boolean;
	currency: "USD" | "EUR";
	budgets: {
		defaults: BudgetConfig;
		agents: Record<string, BudgetConfig>;
	};
	routing: RoutingConfig;
	toolPolicy: {
		defaults: ToolPolicyConfig;
		agents: Record<string, ToolPolicyConfig>;
	};
	anomaly: AnomalyConfig;
	downgradeModel: string;
	downgradeProvider: string;
	pricing: Record<string, ModelPricing>;
	webhooks: WebhookConfig[];
}

export const DEFAULT_CONFIG: ObserveClawConfig = {
	enabled: true,
	currency: "USD",
	budgets: {
		defaults: { daily: 100, monthly: 2000, warnAt: 0.8 },
		agents: {},
	},
	routing: {
		enabled: false,
		evaluators: [],
		logRouting: true,
	},
	toolPolicy: {
		defaults: { allow: [], deny: [] },
		agents: {},
	},
	anomaly: {
		spendSpikeMultiplier: 3,
		idleBurnMinutes: 10,
		errorLoopThreshold: 10,
		tokenInflationMultiplier: 2,
		checkIntervalSeconds: 30,
	},
	downgradeModel: "claude-haiku-4-5",
	downgradeProvider: "anthropic",
	pricing: {},
	webhooks: [],
};
