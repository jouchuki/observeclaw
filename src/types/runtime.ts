export interface AgentSpend {
	agentId: string;
	today: number;
	thisMonth: number;
	lastHourCost: number;
	hourlyHistory: number[]; // last 168 hourly buckets (7 days)
	callCount: number;
	lastCallAt: number;
	consecutiveErrors: number;
	lastProductiveToolCallAt: number;
	recentInputTokens: number[];
	warningEmitted: boolean;
	sessions: Map<string, SessionSpend>;
}

export interface SessionSpend {
	sessionKey: string;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	callCount: number;
	startedAt: number;
}
