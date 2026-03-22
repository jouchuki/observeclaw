import type { ObserveClawConfig } from "./src/types.js";
import { DEFAULT_CONFIG } from "./src/types.js";
import { setConfigPricing } from "./src/pricing.js";
import * as spendTracker from "./src/spend-tracker.js";
import * as alertStore from "./src/alert-store.js";
import { checkBudget, shouldCancelMessage } from "./src/budget-enforcer.js";
import { checkTool } from "./src/tool-policy.js";
import { runDetectors } from "./src/anomaly.js";
import { dispatchWebhooks } from "./src/webhook.js";

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

const plugin: any = {
	id: "observeclaw",
	name: "ObserveClaw",
	description: "Agent spend tracking, budget enforcement, tool policy, and anomaly detection",
	_registerCount: 0,

	register(api: any) {
		const config = parseConfig(api.pluginConfig as Record<string, unknown> | undefined);

		if (!config.enabled) {
			api.logger.info("[observeclaw] disabled via config");
			return;
		}

		// Guard against duplicate registration — OpenClaw calls register() in
		// both setup and gateway contexts. Skip the first (setup), run the second (gateway).
		plugin._registerCount = (plugin._registerCount ?? 0) + 1;
		if (plugin._registerCount < 2) return;

		// Apply pricing overrides
		if (Object.keys(config.pricing).length > 0) {
			setConfigPricing(config.pricing);
		}

		api.logger.info(
			`[observeclaw] active | daily budget: $${config.budgets.defaults.daily} | downgrade model: ${config.downgradeModel}`,
		);

		// --- Timers ---

		// Rotate hourly spend buckets
		const hourlyTimer = setInterval(() => spendTracker.rotateHourly(), 3_600_000);

		// Check for daily/monthly reset
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

		// --- Event Broadcasting ---

		// Broadcast an ObserveClaw event — stores + dispatches to webhooks
		function broadcastAlert(alert: import("./src/types.js").AnomalyAlert): void {
			alertStore.pushAlert(alert);
			if (config.webhooks.length > 0) {
				dispatchWebhooks(alert, config.webhooks, api.logger).catch(() => {
					// Fire-and-forget — webhook failures don't block plugin operation
				});
			}
		}

		// Gateway RPC: query spend data
		api.registerGatewayMethod("observeclaw.spend", ({ respond }) => {
			respond(true, {
				agents: spendTracker.getSummary(),
				alerts: alertStore.getAlerts(50),
			});
		});

		// Gateway RPC: query alerts
		api.registerGatewayMethod("observeclaw.alerts", ({ respond }) => {
			respond(true, { alerts: alertStore.getAlerts(50) });
		});

		// Gateway RPC: query single agent
		api.registerGatewayMethod("observeclaw.agent", ({ params, respond }) => {
			const agentId = params.agentId as string;
			if (!agentId) {
				respond(false, undefined, { code: "INVALID_REQUEST", message: "agentId required" });
				return;
			}
			const spend = spendTracker.get(agentId);
			const budget = config.budgets.agents[agentId] ?? config.budgets.defaults;
			respond(true, {
				agentId,
				spend: spend
					? { today: spend.today, thisMonth: spend.thisMonth, callCount: spend.callCount, lastCallAt: spend.lastCallAt }
					: null,
				budget,
				budgetRatio: spend ? spendTracker.getBudgetRatio(agentId, budget.daily) : 0,
				alerts: alertStore.getAlertsByAgent(agentId, 20),
			});
		});

		// HTTP endpoint: GET /plugins/observeclaw/alerts for external integrations
		api.registerHttpRoute({
			path: "/plugins/observeclaw/alerts",
			auth: "gateway",
			match: "exact",
			handler: async (_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ alerts: alertStore.getAlerts(50) }));
			},
		});

		// Periodic anomaly check + spend summary
		const anomalyTimer = setInterval(() => {
			for (const [agentId, spend] of spendTracker.entries()) {
				const budget = config.budgets.agents[agentId] ?? config.budgets.defaults;
				const alerts = runDetectors(agentId, spend, config.anomaly, budget.daily);
				for (const alert of alerts) {
					broadcastAlert(alert);
					if (alert.severity === "critical") {
						api.logger.error(`[observeclaw] ALERT: ${alert.message}`);
					} else {
						api.logger.warn(`[observeclaw] alert: ${alert.message}`);
					}
				}
			}
		}, config.anomaly.checkIntervalSeconds * 1000);

		// --- Hooks ---

		// Track spend on every LLM call
		api.on("llm_output", (event: any, ctx: any) => {
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
				api.logger.info(
					`[observeclaw] ${agentId} | call: $${cost.toFixed(4)} | today: $${spend?.today.toFixed(2)} | ${event.provider}/${event.model}`,
				);
			} else {
				api.logger.warn(
					`[observeclaw] ${agentId} | call: $0 (no pricing for ${event.provider}/${event.model}) | tokens: in=${event.usage.input ?? 0} out=${event.usage.output ?? 0}`,
				);
			}
		});

		// Budget enforcement — runs before every LLM call
		api.on(
			"before_model_resolve",
			(_event, ctx) => {
				const agentId = ctx.agentId ?? "default";
				const decision = checkBudget(agentId, config);

				if (decision.action === "downgrade") {
					api.logger.warn(`[observeclaw] ${agentId} | ${decision.reason} -> ${decision.modelOverride}`);
					broadcastAlert({
						type: "budget_warning",
						agentId,
						severity: "warning",
						message: decision.reason ?? "Approaching budget limit",
					});
					return {
						modelOverride: decision.modelOverride,
						providerOverride: decision.providerOverride,
					};
				}

				if (decision.action === "block") {
					api.logger.error(`[observeclaw] ${agentId} | BLOCKED: ${decision.reason}`);
					broadcastAlert({
						type: "budget_exceeded",
						agentId,
						severity: "critical",
						action: "auto_pause",
						message: decision.reason ?? "Budget exceeded",
					});
					return {
						modelOverride: decision.modelOverride,
					};
				}
			},
			{ priority: -10 }, // Run after other hooks so we get final say
		);

		// Tool policy enforcement
		api.on("before_tool_call", (event, ctx) => {
			const agentId = ctx.agentId ?? "default";
			const decision = checkTool(agentId, event.toolName, config);

			if (!decision.allowed) {
				api.logger.warn(`[observeclaw] ${agentId} | tool blocked: ${event.toolName} | ${decision.reason}`);
				broadcastAlert({
					type: "budget_warning", // reuse type — tool block is a policy event
					agentId,
					severity: "warning",
					message: `Tool blocked: ${event.toolName} — ${decision.reason}`,
				});
				return {
					block: true,
					blockReason: decision.reason,
				};
			}
		});

		// Track productive tool calls (for idle burn detection)
		api.on("after_tool_call", (_event, ctx) => {
			const agentId = ctx.agentId ?? "default";
			spendTracker.recordToolCall(agentId);
		});

		// Cancel outbound messages if agent is over budget
		api.on("message_sending", (_event, ctx) => {
			const agentId = (ctx as Record<string, unknown>).agentId as string | undefined;
			if (agentId && shouldCancelMessage(agentId, config)) {
				api.logger.warn(`[observeclaw] ${agentId} | outbound message cancelled (over budget)`);
				return { cancel: true };
			}
		});

		// Session lifecycle
		api.on("session_start", (_event, ctx) => {
			api.logger.info(`[observeclaw] session started: ${ctx.sessionKey} (agent: ${ctx.agentId})`);
		});

		api.on("session_end", (_event, ctx) => {
			const agentId = ctx.agentId ?? "default";
			const spend = spendTracker.get(agentId);
			const session = spend?.sessions.get(ctx.sessionKey ?? "");
			if (session) {
				api.logger.info(
					`[observeclaw] session ended: ${ctx.sessionKey} | cost: $${session.cost.toFixed(4)} | calls: ${session.callCount}`,
				);
			}
		});

		// Gateway lifecycle
		api.on("gateway_start", () => {
			api.logger.info("[observeclaw] gateway started — tracking active");
		});

		api.on("gateway_stop", () => {
			clearInterval(hourlyTimer);
			clearInterval(resetTimer);
			clearInterval(anomalyTimer);

			// Final spend summary
			const summary = spendTracker.getSummary();
			if (summary.length > 0) {
				api.logger.info("[observeclaw] final spend summary:");
				for (const s of summary) {
					api.logger.info(`  ${s.agentId}: today=$${s.today.toFixed(2)} month=$${s.thisMonth.toFixed(2)} calls=${s.callCount}`);
				}
			}
		});
	},
};

export default plugin;
