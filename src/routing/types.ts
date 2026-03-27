export interface RoutingDecision {
	provider: string;
	model: string;
	reason: string;
}

export interface BaseEvaluatorConfig {
	name: string;
	priority: number;
	enabled: boolean;
	emitEvent?: boolean;
	webhooks?: string[];
	blockMessage?: boolean;
	blockReply?: string;
}

export interface RegexEvaluatorConfig extends BaseEvaluatorConfig {
	type: "regex";
	patterns: string[];
	provider: string;
	model: string;
}

export interface ClassifierEvaluatorConfig extends BaseEvaluatorConfig {
	type: "classifier";
	url: string;
	classifierModel: string;
	prompt: string;
	routes: Record<string, { provider: string; model: string }>;
	timeoutMs?: number;
}

export interface WebhookEvaluatorConfig extends BaseEvaluatorConfig {
	type: "webhook";
	url: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

export type EvaluatorConfig =
	| RegexEvaluatorConfig
	| ClassifierEvaluatorConfig
	| WebhookEvaluatorConfig;

export interface EvaluatorResult {
	name: string;
	type: "regex" | "classifier" | "webhook";
	priority: number;
	matched: boolean;
	durationMs: number;
	decision: RoutingDecision | null;
	error?: string;
	label?: string;
	emitEvent: boolean;
	webhooks?: string[];
	blockMessage: boolean;
	blockReply?: string;
}

export interface RoutingEvent {
	agentId: string;
	promptPreview: string;
	timestamp: number;
	durationMs: number;
	winner: EvaluatorResult | null;
	evaluators: EvaluatorResult[];
}

export interface RoutingPipelineResult {
	decision: RoutingDecision | null;
	event: RoutingEvent;
	shouldBlock: boolean;
	blockReply?: string;
}
