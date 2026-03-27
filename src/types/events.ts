import type { RoutingEvent } from "../routing/types.js";

export type AlertType =
	| "spend_spike"
	| "idle_burn"
	| "error_loop"
	| "token_inflation"
	| "budget_warning"
	| "budget_exceeded"
	| "routing_event";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AnomalyAlert {
	type: AlertType;
	agentId: string;
	severity: AlertSeverity;
	message: string;
	action?: "alert" | "auto_pause";
	metric?: Record<string, number>;
	routingEvent?: RoutingEvent;
}
