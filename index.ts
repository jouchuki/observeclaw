import type { ObserveClawConfig } from "./src/types/config.js";
import { DEFAULT_CONFIG } from "./src/types/config.js";
import type { AnomalyAlert } from "./src/types/events.js";
import type { PluginApi } from "./src/types/plugin.js";
import { setConfigPricing } from "./src/pricing.js";
import * as spendTracker from "./src/spend-tracker.js";
import * as alertStore from "./src/alert-store.js";
import { runDetectors } from "./src/anomaly.js";
import { dispatchWebhooks } from "./src/webhook.js";
import { handleLlmOutput } from "./src/hooks/llm-output.js";
import { validateRoutingOnStartup, handleBeforeModelResolve } from "./src/hooks/model-resolve.js";
import { handleBeforeToolCall, handleAfterToolCall } from "./src/hooks/tool-hooks.js";
import { handleMessageSending, handleMessageSent } from "./src/hooks/message-hooks.js";
import { handleSessionStart, handleSessionEnd, handleGatewayStart, handleGatewayStop } from "./src/hooks/lifecycle.js";

function parseConfig(raw: Record<string, unknown> | undefined): ObserveClawConfig {
	if (!raw) return DEFAULT_CONFIG;
	return {
		enabled: (raw.enabled as boolean) ?? DEFAULT_CONFIG.enabled,
		currency: (raw.currency as ObserveClawConfig["currency"]) ?? DEFAULT_CONFIG.currency,
		budgets: {
			defaults: {
				...DEFAULT_CONFIG.budgets.defaults,
				...((raw.budgets as Record<string, unknown>)?.defaults as Record<string, unknown>),
			},
			agents: ((raw.budgets as Record<string, unknown>)?.agents as Record<string, Record<string, unknown>>) ?? {},
		} as ObserveClawConfig["budgets"],
		routing: {
			...DEFAULT_CONFIG.routing,
			...(raw.routing as Record<string, unknown>),
			evaluators: ((raw.routing as Record<string, unknown>)?.evaluators as ObserveClawConfig["routing"]["evaluators"]) ?? [],
		} as ObserveClawConfig["routing"],
		toolPolicy: {
			defaults: {
				...DEFAULT_CONFIG.toolPolicy.defaults,
				...((raw.toolPolicy as Record<string, unknown>)?.defaults as Record<string, unknown>),
			},
			agents: ((raw.toolPolicy as Record<string, unknown>)?.agents as Record<string, Record<string, unknown>>) ?? {},
		} as ObserveClawConfig["toolPolicy"],
		anomaly: {
			...DEFAULT_CONFIG.anomaly,
			...(raw.anomaly as Record<string, unknown>),
		} as ObserveClawConfig["anomaly"],
		downgradeModel: (raw.downgradeModel as string) ?? DEFAULT_CONFIG.downgradeModel,
		downgradeProvider: (raw.downgradeProvider as string) ?? DEFAULT_CONFIG.downgradeProvider,
		pricing: (raw.pricing as ObserveClawConfig["pricing"]) ?? {},
		webhooks: (raw.webhooks as ObserveClawConfig["webhooks"]) ?? [],
	} as ObserveClawConfig;
}

const plugin = {
	id: "observeclaw",
	name: "ObserveClaw",
	description: "Agent spend tracking, budget enforcement, routing, tool policy, and anomaly detection",
	_registerCount: 0,

	register(api: PluginApi) {
		const config = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);
		if (!config.enabled) {
			api.logger.info("[observeclaw] disabled via config");
			return;
		}

		(plugin as { _registerCount: number })._registerCount += 1;

		if (Object.keys(config.pricing).length > 0) {
			setConfigPricing(config.pricing);
		}

		api.logger.info(
			`[observeclaw] active | daily budget: $${config.budgets.defaults.daily} | downgrade model: ${config.downgradeModel}`,
		);

		// --- Timers ---

		const hourlyTimer = setInterval(() => spendTracker.rotateHourly(), 3_600_000);

		let lastDay = new Date().getDate();
		let lastMonth = new Date().getMonth();
		const resetTimer = setInterval(() => {
			const now = new Date();
			if (now.getDate() !== lastDay) {
				spendTracker.resetDaily();
				lastDay = now.getDate();
				api.logger.info("[observeclaw] daily spend counters reset");
			}
			if (now.getMonth() !== lastMonth) {
				spendTracker.resetMonthly();
				lastMonth = now.getMonth();
				api.logger.info("[observeclaw] monthly spend counters reset");
			}
		}, 60_000);

		const anomalyTimer = setInterval(() => {
			for (const [agentId, spend] of spendTracker.entries()) {
				const budget = config.budgets.agents[agentId] ?? config.budgets.defaults;
				for (const alert of runDetectors(agentId, spend, config.anomaly, budget.daily)) {
					broadcastAlert(alert);
					if (alert.severity === "critical") {
						api.logger.error(`[observeclaw] ALERT: ${alert.message}`);
					} else {
						api.logger.warn(`[observeclaw] alert: ${alert.message}`);
					}
				}
			}
		}, config.anomaly.checkIntervalSeconds * 1000);

		function clearTimers(): void {
			clearInterval(hourlyTimer);
			clearInterval(resetTimer);
			clearInterval(anomalyTimer);
		}

		// --- Event Broadcasting ---

		function broadcastAlert(alert: AnomalyAlert): void {
			alertStore.pushAlert(alert);
			if (config.webhooks.length > 0) {
				dispatchWebhooks(alert, config.webhooks, api.logger).catch(() => {});
			}
		}

		// --- Gateway RPC ---

		api.registerGatewayMethod("observeclaw.spend", ({ respond }: { respond: Function }) => {
			respond(true, { agents: spendTracker.getSummary(), alerts: alertStore.getAlerts(50) });
		});

		api.registerGatewayMethod("observeclaw.alerts", ({ respond }: { respond: Function }) => {
			respond(true, { alerts: alertStore.getAlerts(50) });
		});

		api.registerGatewayMethod("observeclaw.agent", ({ params, respond }: { params: Record<string, unknown>; respond: Function }) => {
			const agentId = params.agentId as string;
			if (!agentId) { respond(false, undefined, { code: "INVALID_REQUEST", message: "agentId required" }); return; }
			const spend = spendTracker.get(agentId);
			const budget = config.budgets.agents[agentId] ?? config.budgets.defaults;
			respond(true, {
				agentId,
				spend: spend ? { today: spend.today, thisMonth: spend.thisMonth, callCount: spend.callCount, lastCallAt: spend.lastCallAt } : null,
				budget,
				budgetRatio: spend ? spendTracker.getBudgetRatio(agentId, budget.daily) : 0,
				alerts: alertStore.getAlertsByAgent(agentId, 20),
			});
		});

		api.registerHttpRoute({
			path: "/plugins/observeclaw/alerts",
			auth: "gateway",
			match: "exact",
			handler: async (_req: unknown, res: { writeHead: Function; end: Function }) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ alerts: alertStore.getAlerts(50) }));
			},
		});

		// --- Hooks ---

		validateRoutingOnStartup(config, api.logger);

		api.on("llm_output", (event: unknown, ctx: unknown) => handleLlmOutput(event as Parameters<typeof handleLlmOutput>[0], ctx as Parameters<typeof handleLlmOutput>[1], api.logger));

		api.on("before_model_resolve", async (event: unknown, ctx: unknown) =>
			handleBeforeModelResolve(event as { prompt?: string }, ctx as Parameters<typeof handleBeforeModelResolve>[1], config, api.logger, broadcastAlert),
			{ priority: -10 },
		);

		api.on("before_tool_call", (event: unknown, ctx: unknown) =>
			handleBeforeToolCall(event as { toolName: string }, ctx as Parameters<typeof handleBeforeToolCall>[1], config, api.logger, broadcastAlert),
		);

		api.on("after_tool_call", (_event: unknown, ctx: unknown) => handleAfterToolCall(_event, ctx as Parameters<typeof handleAfterToolCall>[1]));

		api.on("message_sending", (_event: unknown, ctx: unknown) =>
			handleMessageSending(_event, ctx as { agentId?: string }, config, api.logger),
		);

		api.on("message_sent", (_event: unknown, ctx: unknown) => handleMessageSent(_event, ctx as { agentId?: string }));

		api.on("session_start", (_event: unknown, ctx: unknown) => handleSessionStart(_event, ctx as Parameters<typeof handleSessionStart>[1], api.logger));
		api.on("session_end", (_event: unknown, ctx: unknown) => handleSessionEnd(_event, ctx as Parameters<typeof handleSessionEnd>[1], api.logger));
		api.on("gateway_start", () => handleGatewayStart(api.logger));
		api.on("gateway_stop", () => handleGatewayStop(api.logger, clearTimers));
	},
};

export default plugin;
