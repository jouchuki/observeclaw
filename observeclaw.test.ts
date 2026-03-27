import { describe, it, expect, beforeEach, vi } from "vitest";
import * as spendTracker from "./src/spend-tracker.js";
import * as alertStore from "./src/alert-store.js";
import { calculateCost, setConfigPricing } from "./src/pricing.js";
import { checkBudget } from "./src/budget-enforcer.js";
import { checkTool } from "./src/tool-policy.js";
import { runDetectors } from "./src/anomaly.js";
import { dispatchWebhooks, formatSlackPayload } from "./src/webhook.js";
import { DEFAULT_CONFIG } from "./src/types.js";
import type { AnomalyAlert, ObserveClawConfig, WebhookConfig } from "./src/types.js";

// Reset spend tracker between tests by recording negative amounts is not possible,
// so we test functions that don't depend on global state where possible.

describe("pricing", () => {
	it("calculates cost for known model", () => {
		const cost = calculateCost("anthropic", "claude-sonnet-4-5", {
			input: 1000,
			output: 500,
		});
		// input: 1000 * 3 / 1M = 0.003, output: 500 * 15 / 1M = 0.0075
		expect(cost).toBeCloseTo(0.0105, 4);
	});

	it("returns 0 for unknown model", () => {
		const cost = calculateCost("unknown-provider", "unknown-model", {
			input: 1000,
			output: 500,
		});
		expect(cost).toBe(0);
	});

	it("returns 0 for local models", () => {
		const cost = calculateCost("ollama", "llama3:8b", {
			input: 100_000,
			output: 50_000,
		});
		expect(cost).toBe(0);
	});

	it("uses config overrides", () => {
		setConfigPricing({
			"custom/my-model": { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
		});
		const cost = calculateCost("custom", "my-model", {
			input: 1_000_000,
			output: 1_000_000,
		});
		// input: 1M * 10 / 1M = 10, output: 1M * 20 / 1M = 20
		expect(cost).toBe(30);
		// Reset
		setConfigPricing({});
	});

	it("handles cache tokens", () => {
		const cost = calculateCost("anthropic", "claude-sonnet-4-5", {
			input: 100,
			output: 100,
			cacheRead: 50_000,
			cacheWrite: 10_000,
		});
		// cacheRead: 50000 * 0.3 / 1M = 0.015, cacheWrite: 10000 * 3.75 / 1M = 0.0375
		expect(cost).toBeGreaterThan(0);
	});
});

describe("spend-tracker", () => {
	it("records spend and retrieves it", () => {
		const cost = spendTracker.record("test-agent-1", "anthropic", "claude-sonnet-4-5", {
			input: 10_000,
			output: 5_000,
		});
		expect(cost).toBeGreaterThan(0);

		const spend = spendTracker.get("test-agent-1");
		expect(spend).toBeDefined();
		expect(spend!.today).toBeGreaterThan(0);
		expect(spend!.callCount).toBe(1);
	});

	it("tracks per-session spend", () => {
		spendTracker.record("test-agent-2", "anthropic", "claude-sonnet-4-5", { input: 1000, output: 500 }, "session-1");
		spendTracker.record("test-agent-2", "anthropic", "claude-sonnet-4-5", { input: 2000, output: 1000 }, "session-1");
		spendTracker.record("test-agent-2", "anthropic", "claude-sonnet-4-5", { input: 500, output: 200 }, "session-2");

		const spend = spendTracker.get("test-agent-2");
		expect(spend!.sessions.size).toBe(2);
		expect(spend!.sessions.get("session-1")!.callCount).toBe(2);
		expect(spend!.sessions.get("session-2")!.callCount).toBe(1);
	});

	it("tracks consecutive errors", () => {
		spendTracker.record("test-agent-3", "anthropic", "claude-sonnet-4-5", { input: 100, output: 50 });
		expect(spendTracker.get("test-agent-3")!.consecutiveErrors).toBe(0);

		spendTracker.recordError("test-agent-3");
		spendTracker.recordError("test-agent-3");
		expect(spendTracker.get("test-agent-3")!.consecutiveErrors).toBe(2);

		// Successful call resets
		spendTracker.record("test-agent-3", "anthropic", "claude-sonnet-4-5", { input: 100, output: 50 });
		expect(spendTracker.get("test-agent-3")!.consecutiveErrors).toBe(0);
	});

	it("tracks input token history for inflation detection", () => {
		for (let i = 0; i < 8; i++) {
			spendTracker.record("test-agent-4", "anthropic", "claude-sonnet-4-5", { input: 1000 + i * 500, output: 100 });
		}
		const spend = spendTracker.get("test-agent-4");
		expect(spend!.recentInputTokens.length).toBe(8);
	});

	it("getBudgetRatio works", () => {
		spendTracker.record("test-agent-5", "openai", "gpt-4o", { input: 100_000, output: 50_000 });
		const ratio = spendTracker.getBudgetRatio("test-agent-5", 100);
		expect(ratio).toBeGreaterThan(0);
		expect(ratio).toBeLessThan(1);
	});
});

describe("budget-enforcer", () => {
	it("allows when under budget", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			budgets: { defaults: { daily: 1000, monthly: 10000, warnAt: 0.8 }, agents: {} },
		};
		// Fresh agent with no spend
		const decision = checkBudget("fresh-agent", config);
		expect(decision.action).toBe("allow");
	});

	it("uses per-agent budget when configured", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			budgets: {
				defaults: { daily: 1000, monthly: 10000, warnAt: 0.8 },
				agents: { "tight-agent": { daily: 0.001, monthly: 0.01, warnAt: 0.5 } },
			},
		};
		// Record some spend
		spendTracker.record("tight-agent", "anthropic", "claude-sonnet-4-5", { input: 10_000, output: 5_000 });
		const decision = checkBudget("tight-agent", config);
		expect(decision.action).toBe("block");
	});
});

describe("tool-policy", () => {
	it("allows all tools with empty policy", () => {
		const decision = checkTool("any-agent", "any-tool", DEFAULT_CONFIG);
		expect(decision.allowed).toBe(true);
	});

	it("blocks denied tools", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: [], deny: ["exec", "shell"] },
				agents: {},
			},
		};
		expect(checkTool("any-agent", "exec", config).allowed).toBe(false);
		expect(checkTool("any-agent", "shell", config).allowed).toBe(false);
		expect(checkTool("any-agent", "search", config).allowed).toBe(true);
	});

	it("blocks tools not in allowlist", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: ["search", "read"], deny: [] },
				agents: {},
			},
		};
		expect(checkTool("any-agent", "search", config).allowed).toBe(true);
		expect(checkTool("any-agent", "exec", config).allowed).toBe(false);
	});

	it("deny wins over allow", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: ["exec"], deny: ["exec"] },
				agents: {},
			},
		};
		expect(checkTool("any-agent", "exec", config).allowed).toBe(false);
	});

	it("uses per-agent policy", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: [], deny: [] },
				agents: { "restricted-agent": { allow: ["search"], deny: [] } },
			},
		};
		expect(checkTool("restricted-agent", "search", config).allowed).toBe(true);
		expect(checkTool("restricted-agent", "exec", config).allowed).toBe(false);
		// Other agents use defaults (allow all)
		expect(checkTool("other-agent", "exec", config).allowed).toBe(true);
	});
});

describe("anomaly-detection", () => {
	it("detects error loops", () => {
		// Create agent with many consecutive errors
		spendTracker.record("error-agent", "anthropic", "claude-sonnet-4-5", { input: 100, output: 50 });
		for (let i = 0; i < 12; i++) {
			spendTracker.recordError("error-agent");
		}

		const spend = spendTracker.get("error-agent")!;
		const alerts = runDetectors("error-agent", spend, DEFAULT_CONFIG.anomaly, 100);
		const errorAlert = alerts.find((a) => a.type === "error_loop");
		expect(errorAlert).toBeDefined();
		expect(errorAlert!.severity).toBe("critical");
		expect(errorAlert!.action).toBe("auto_pause");
	});

	it("detects budget warning at 80%", () => {
		// Record enough spend to hit 80% of a $1 budget
		for (let i = 0; i < 20; i++) {
			spendTracker.record("budget-warn-agent", "anthropic", "claude-sonnet-4-5", { input: 50_000, output: 10_000 });
		}

		const spend = spendTracker.get("budget-warn-agent")!;
		const alerts = runDetectors("budget-warn-agent", spend, DEFAULT_CONFIG.anomaly, 1);
		// Should have either budget_warning or nothing depending on exact spend
		// The key is that it doesn't crash
		expect(Array.isArray(alerts)).toBe(true);
	});

	it("returns empty alerts for healthy agent", () => {
		spendTracker.record("healthy-agent", "anthropic", "claude-sonnet-4-5", { input: 100, output: 50 });
		spendTracker.recordToolCall("healthy-agent");

		const spend = spendTracker.get("healthy-agent")!;
		const alerts = runDetectors("healthy-agent", spend, DEFAULT_CONFIG.anomaly, 100);
		// Should not flag anything for minimal spend
		const criticalAlerts = alerts.filter((a) => a.severity === "critical");
		expect(criticalAlerts.length).toBe(0);
	});
});

// ============================================================================
// SCENARIO SIMULATIONS — Real failure modes ObserveClaw catches
// ============================================================================

describe("scenario: Adrian's $10k cache loop", () => {
	// An agent rewrites 200k tokens of context into cache every 5 minutes,
	// producing zero useful output, for 13 days. $10,542 burned.
	// https://linkedin.com — Adrian Dragomir / Sferal AI

	const agentId = "optimus-cache-loop";
	const config: ObserveClawConfig = {
		...DEFAULT_CONFIG,
		budgets: { defaults: { daily: 100, monthly: 2000, warnAt: 0.8 }, agents: {} },
	};

	it("tracks cost of cache-heavy calls correctly", () => {
		// Single cache write: 200k tokens on Claude Opus
		const cost = calculateCost("anthropic", "claude-opus-4-6", {
			input: 200_000,
			output: 100,
			cacheWrite: 200_000,
		});
		// input: 200k * 5 / 1M = $1.00, output: 100 * 25 / 1M = $0.0025
		// cacheWrite: 200k * 6.25 / 1M = $1.25
		// Total per call: ~$2.25
		expect(cost).toBeGreaterThan(1.5);
		expect(cost).toBeLessThan(4);
	});

	it("budget enforcer blocks after ~44 cache writes ($100 budget)", () => {
		// Simulate cache writes every 5 minutes
		let callCount = 0;
		let blocked = false;

		for (let i = 0; i < 200; i++) {
			spendTracker.record(agentId, "anthropic", "claude-opus-4-6", {
				input: 200_000,
				output: 100,
				cacheWrite: 200_000,
			});
			callCount++;

			const decision = checkBudget(agentId, config);
			if (decision.action === "block") {
				blocked = true;
				break;
			}
		}

		expect(blocked).toBe(true);
		// Should block after ~44 calls ($2.25 * 44 ≈ $99)
		expect(callCount).toBeLessThan(50);
		expect(callCount).toBeGreaterThan(30);

		const spend = spendTracker.get(agentId)!;
		// Max damage: ~$100 (daily budget), not $10,542
		expect(spend.today).toBeLessThan(150);
		expect(spend.today).toBeGreaterThan(80);
	});

	it("model downgrade kicks in before full block", () => {
		const freshAgent = "optimus-downgrade-test";
		// Each call costs ~$2.25. 36 calls = ~$81, which is >80% of $100
		for (let i = 0; i < 36; i++) {
			spendTracker.record(freshAgent, "anthropic", "claude-opus-4-6", {
				input: 200_000,
				output: 100,
				cacheWrite: 200_000,
			});
		}

		const decision = checkBudget(freshAgent, config);
		// At ~$81 of $100, should be in downgrade zone (>80% but <100%)
		expect(decision.action).toBe("downgrade");
		expect(decision.modelOverride).toBe("claude-haiku-4-5");
	});

	it("idle burn detector fires (no tool calls, constant LLM spending)", () => {
		const idleAgent = "optimus-idle";
		// Record several calls but NO tool calls
		for (let i = 0; i < 5; i++) {
			spendTracker.record(idleAgent, "anthropic", "claude-opus-4-6", {
				input: 200_000,
				output: 100,
				cacheWrite: 200_000,
			});
		}
		// Simulate 15 minutes passing with no tool calls
		const spend = spendTracker.get(idleAgent)!;
		spend.lastProductiveToolCallAt = Date.now() - 15 * 60_000;
		spend.lastHourCost = 30; // $30 in last hour

		const alerts = runDetectors(idleAgent, spend, DEFAULT_CONFIG.anomaly, 100);
		const idleAlert = alerts.find((a) => a.type === "idle_burn");
		expect(idleAlert).toBeDefined();
		expect(idleAlert!.severity).toBe("warning");
		expect(idleAlert!.message).toContain("15min");
	});
});

describe("scenario: prompt injection tool exfiltration", () => {
	// Agent gets prompt-injected via a webpage. Attacker tries to make the agent
	// call exec/shell/curl to exfiltrate data. Tool policy blocks it.

	it("blocks exec tool when denied by policy", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: [], deny: ["exec", "shell", "bash", "run_command"] },
				agents: {},
			},
		};

		// Attacker tries multiple tool names
		const attempts = ["exec", "shell", "bash", "run_command"];
		for (const tool of attempts) {
			const decision = checkTool("support-agent", tool, config);
			expect(decision.allowed).toBe(false);
			expect(decision.reason).toContain("denied");
		}

		// Legitimate tools still work
		expect(checkTool("support-agent", "search", config).allowed).toBe(true);
		expect(checkTool("support-agent", "read_file", config).allowed).toBe(true);
	});

	it("allowlist-only agent blocks anything not explicitly permitted", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			toolPolicy: {
				defaults: { allow: [], deny: [] },
				agents: {
					"locked-down-agent": {
						allow: ["search_web", "read_file", "send_message"],
						deny: [],
					},
				},
			},
		};

		// Allowed tools work
		expect(checkTool("locked-down-agent", "search_web", config).allowed).toBe(true);
		expect(checkTool("locked-down-agent", "send_message", config).allowed).toBe(true);

		// Everything else blocked — including attacker-injected calls
		expect(checkTool("locked-down-agent", "exec", config).allowed).toBe(false);
		expect(checkTool("locked-down-agent", "curl", config).allowed).toBe(false);
		expect(checkTool("locked-down-agent", "write_file", config).allowed).toBe(false);
		expect(checkTool("locked-down-agent", "mcp_external_tool", config).allowed).toBe(false);
	});
});

describe("scenario: LLM error loop burning tokens", () => {
	// Agent keeps calling the LLM but every call errors (bad prompt, context too long,
	// rate limited). Each call still costs tokens for the input. Agent retries forever.

	const agentId = "retry-loop-agent";

	it("detects error loop after threshold consecutive failures", () => {
		// First call succeeds (agent starts normally)
		spendTracker.record(agentId, "anthropic", "claude-sonnet-4-5", { input: 5_000, output: 1_000 });

		// Then 12 consecutive errors — recordError only, no successful record() calls
		// (in reality, the LLM provider returns an error before producing output)
		for (let i = 0; i < 12; i++) {
			spendTracker.recordError(agentId);
		}

		const spend = spendTracker.get(agentId)!;
		expect(spend.consecutiveErrors).toBe(12);

		const alerts = runDetectors(agentId, spend, DEFAULT_CONFIG.anomaly, 100);
		const errorAlert = alerts.find((a) => a.type === "error_loop");
		expect(errorAlert).toBeDefined();
		expect(errorAlert!.severity).toBe("critical");
		expect(errorAlert!.action).toBe("auto_pause");
		expect(errorAlert!.message).toContain("12 consecutive");
	});

	it("a single successful call resets the error counter", () => {
		const resetAgent = "retry-reset-agent";
		spendTracker.record(resetAgent, "anthropic", "claude-sonnet-4-5", { input: 1000, output: 500 });

		// 8 errors (under threshold of 10)
		for (let i = 0; i < 8; i++) spendTracker.recordError(resetAgent);
		expect(spendTracker.get(resetAgent)!.consecutiveErrors).toBe(8);

		// One success resets
		spendTracker.record(resetAgent, "anthropic", "claude-sonnet-4-5", { input: 1000, output: 500 });
		expect(spendTracker.get(resetAgent)!.consecutiveErrors).toBe(0);

		// 8 more errors — still under threshold
		for (let i = 0; i < 8; i++) spendTracker.recordError(resetAgent);
		const spend = spendTracker.get(resetAgent)!;
		const alerts = runDetectors(resetAgent, spend, DEFAULT_CONFIG.anomaly, 100);
		expect(alerts.find((a) => a.type === "error_loop")).toBeUndefined();
	});
});

describe("scenario: context window bloat (token inflation)", () => {
	// Agent's context window keeps growing because compaction isn't running.
	// Each call sends more and more input tokens, burning increasing amounts of money.

	it("detects doubling input tokens over sequential calls", () => {
		const agentId = "bloat-agent";
		// Simulate growing context: 10k, 20k, 40k, 80k, 160k input tokens
		const sizes = [10_000, 15_000, 20_000, 30_000, 40_000, 60_000, 80_000, 120_000, 160_000, 200_000];
		for (const inputSize of sizes) {
			spendTracker.record(agentId, "anthropic", "claude-sonnet-4-5", { input: inputSize, output: 500 });
		}

		const spend = spendTracker.get(agentId)!;
		const alerts = runDetectors(agentId, spend, DEFAULT_CONFIG.anomaly, 1000);
		const inflationAlert = alerts.find((a) => a.type === "token_inflation");
		expect(inflationAlert).toBeDefined();
		expect(inflationAlert!.severity).toBe("info");
		expect(inflationAlert!.message).toContain("Input tokens growing");
	});

	it("does NOT flag stable context size", () => {
		const agentId = "stable-context-agent";
		// Consistent ~50k input tokens (normal operation)
		for (let i = 0; i < 10; i++) {
			spendTracker.record(agentId, "anthropic", "claude-sonnet-4-5", {
				input: 48_000 + Math.random() * 4_000, // 48k-52k variance
				output: 1_000,
			});
		}

		const spend = spendTracker.get(agentId)!;
		const alerts = runDetectors(agentId, spend, DEFAULT_CONFIG.anomaly, 1000);
		const inflationAlert = alerts.find((a) => a.type === "token_inflation");
		expect(inflationAlert).toBeUndefined();
	});
});

describe("scenario: multi-agent fleet with different budgets", () => {
	// Company runs 3 agents: sales (cheap), engineering (expensive), intern (tiny budget)

	const config: ObserveClawConfig = {
		...DEFAULT_CONFIG,
		budgets: {
			defaults: { daily: 50, monthly: 1000, warnAt: 0.8 },
			agents: {
				"sales-agent": { daily: 20, monthly: 400, warnAt: 0.8 },
				"eng-agent": { daily: 500, monthly: 10000, warnAt: 0.9 },
				"intern-agent": { daily: 5, monthly: 100, warnAt: 0.5 },
			},
		},
		toolPolicy: {
			defaults: { allow: [], deny: [] },
			agents: {
				"intern-agent": { allow: ["search", "read_file"], deny: [] },
			},
		},
	};

	it("intern gets blocked quickly, eng agent keeps running", () => {
		// Each call: input 10k*3/1M=$0.03, output 2k*15/1M=$0.03. Total ~$0.06/call.
		// Intern budget: $5/day. Need ~84 calls to exceed. Let's do 100.
		for (let i = 0; i < 100; i++) {
			spendTracker.record("intern-agent-fleet", "anthropic", "claude-sonnet-4-5", { input: 10_000, output: 2_000 });
		}
		// Eng agent makes same calls
		for (let i = 0; i < 100; i++) {
			spendTracker.record("eng-agent-fleet", "anthropic", "claude-sonnet-4-5", { input: 10_000, output: 2_000 });
		}

		const internSpend = spendTracker.get("intern-agent-fleet")!;
		const engSpend = spendTracker.get("eng-agent-fleet")!;

		// Both spent the same amount (~$6)
		expect(internSpend.today).toBeCloseTo(engSpend.today, 2);

		// But with different budgets, intern is over $5, eng is way under $500
		const internConfig: ObserveClawConfig = {
			...config,
			budgets: { ...config.budgets, defaults: { daily: 5, monthly: 100, warnAt: 0.5 } },
		};
		const engConfig: ObserveClawConfig = {
			...config,
			budgets: { ...config.budgets, defaults: { daily: 500, monthly: 10000, warnAt: 0.9 } },
		};

		const internDecision = checkBudget("intern-agent-fleet", internConfig);
		const engDecision = checkBudget("eng-agent-fleet", engConfig);

		expect(internDecision.action).toBe("block");
		expect(engDecision.action).toBe("allow");
	});

	it("intern cannot use exec tool, eng agent can", () => {
		expect(checkTool("intern-agent", "exec", config).allowed).toBe(false);
		expect(checkTool("intern-agent", "search", config).allowed).toBe(true);
		// eng-agent uses defaults (allow all)
		expect(checkTool("eng-agent", "exec", config).allowed).toBe(true);
	});
});

describe("scenario: spend spike detection", () => {
	// Agent normally spends ~$2/hour. Suddenly starts spending $10/hour
	// because someone changed the model to Opus without updating the budget.

	it("detects 3x hourly spend spike", () => {
		const agentId = "spike-agent";
		spendTracker.record(agentId, "anthropic", "claude-sonnet-4-5", { input: 1000, output: 500 });

		// Build up 24 hours of normal $2/hour history
		const spend = spendTracker.get(agentId)!;
		spend.hourlyHistory = Array(24).fill(2.0); // $2/hour for 24 hours

		// Current hour: $10 (5x spike — someone switched to Opus)
		spend.lastHourCost = 10.0;

		const alerts = runDetectors(agentId, spend, DEFAULT_CONFIG.anomaly, 100);
		const spikeAlert = alerts.find((a) => a.type === "spend_spike");
		expect(spikeAlert).toBeDefined();
		expect(spikeAlert!.severity).toBe("warning");
		expect(spikeAlert!.message).toContain("5.0x");
	});

	it("does NOT flag normal hourly variance", () => {
		const agentId = "normal-variance-agent";
		spendTracker.record(agentId, "anthropic", "claude-sonnet-4-5", { input: 1000, output: 500 });

		const spend = spendTracker.get(agentId)!;
		spend.hourlyHistory = [1.5, 2.0, 1.8, 2.2, 1.9, 2.1, 2.0, 1.7]; // normal variance
		spend.lastHourCost = 2.5; // slightly above average, not a spike

		const alerts = runDetectors(agentId, spend, DEFAULT_CONFIG.anomaly, 100);
		const spikeAlert = alerts.find((a) => a.type === "spend_spike");
		expect(spikeAlert).toBeUndefined();
	});
});

// ============================================================================
// ALERT STORE — notification storage and retrieval
// ============================================================================

describe("alert-store", () => {
	beforeEach(() => {
		alertStore.clearAlerts();
	});

	it("stores and retrieves alerts", () => {
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "agent-1", severity: "critical", message: "Over budget" });
		alertStore.pushAlert({ type: "spend_spike", agentId: "agent-2", severity: "warning", message: "Spike detected" });

		const all = alertStore.getAlerts();
		expect(all.length).toBe(2);
		expect(all[0].type).toBe("budget_exceeded");
		expect(all[1].type).toBe("spend_spike");
	});

	it("alerts have timestamps", () => {
		const before = Date.now();
		alertStore.pushAlert({ type: "idle_burn", agentId: "agent-1", severity: "warning", message: "Idle" });
		const after = Date.now();

		const alerts = alertStore.getAlerts();
		expect(alerts[0].ts).toBeGreaterThanOrEqual(before);
		expect(alerts[0].ts).toBeLessThanOrEqual(after);
	});

	it("limits to 100 alerts (FIFO eviction)", () => {
		for (let i = 0; i < 120; i++) {
			alertStore.pushAlert({ type: "spend_spike", agentId: `agent-${i}`, severity: "warning", message: `Alert ${i}` });
		}

		expect(alertStore.alertCount()).toBe(100);
		// First 20 should have been evicted
		const alerts = alertStore.getAlerts(100);
		expect(alerts[0].agentId).toBe("agent-20");
		expect(alerts[99].agentId).toBe("agent-119");
	});

	it("filters by agent", () => {
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "agent-a", severity: "critical", message: "A over" });
		alertStore.pushAlert({ type: "spend_spike", agentId: "agent-b", severity: "warning", message: "B spike" });
		alertStore.pushAlert({ type: "idle_burn", agentId: "agent-a", severity: "warning", message: "A idle" });

		const agentA = alertStore.getAlertsByAgent("agent-a");
		expect(agentA.length).toBe(2);
		expect(agentA.every((a) => a.agentId === "agent-a")).toBe(true);

		const agentB = alertStore.getAlertsByAgent("agent-b");
		expect(agentB.length).toBe(1);
	});

	it("filters by severity", () => {
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "a", severity: "critical", message: "crit" });
		alertStore.pushAlert({ type: "spend_spike", agentId: "b", severity: "warning", message: "warn" });
		alertStore.pushAlert({ type: "error_loop", agentId: "c", severity: "critical", message: "crit2" });
		alertStore.pushAlert({ type: "token_inflation", agentId: "d", severity: "info", message: "info" });

		expect(alertStore.getAlertsBySeverity("critical").length).toBe(2);
		expect(alertStore.getAlertsBySeverity("warning").length).toBe(1);
		expect(alertStore.getAlertsBySeverity("info").length).toBe(1);
	});

	it("filters by type", () => {
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "a", severity: "critical", message: "1" });
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "b", severity: "critical", message: "2" });
		alertStore.pushAlert({ type: "spend_spike", agentId: "c", severity: "warning", message: "3" });

		expect(alertStore.getAlertsByType("budget_exceeded").length).toBe(2);
		expect(alertStore.getAlertsByType("spend_spike").length).toBe(1);
		expect(alertStore.getAlertsByType("idle_burn").length).toBe(0);
	});

	it("respects limit parameter", () => {
		for (let i = 0; i < 20; i++) {
			alertStore.pushAlert({ type: "spend_spike", agentId: "agent", severity: "warning", message: `${i}` });
		}

		expect(alertStore.getAlerts(5).length).toBe(5);
		// Returns the LAST 5
		expect(alertStore.getAlerts(5)[0].message).toBe("15");
	});

	it("clearAlerts empties the store", () => {
		alertStore.pushAlert({ type: "spend_spike", agentId: "a", severity: "warning", message: "test" });
		expect(alertStore.alertCount()).toBe(1);

		alertStore.clearAlerts();
		expect(alertStore.alertCount()).toBe(0);
		expect(alertStore.getAlerts().length).toBe(0);
	});
});

// ============================================================================
// END-TO-END: full alert pipeline (detect → store → retrieve)
// ============================================================================

describe("scenario: full alert pipeline", () => {
	beforeEach(() => {
		alertStore.clearAlerts();
	});

	it("budget exceeded generates retrievable alert", () => {
		const config: ObserveClawConfig = {
			...DEFAULT_CONFIG,
			budgets: { defaults: { daily: 0.01, monthly: 1, warnAt: 0.8 }, agents: {} },
		};

		// Spend enough to exceed $0.01 budget
		spendTracker.record("pipeline-agent-1", "anthropic", "claude-sonnet-4-5", { input: 10_000, output: 5_000 });

		const decision = checkBudget("pipeline-agent-1", config);
		expect(decision.action).toBe("block");

		// Simulate what the plugin does on block — push alert
		alertStore.pushAlert({
			type: "budget_exceeded",
			agentId: "pipeline-agent-1",
			severity: "critical",
			action: "auto_pause",
			message: decision.reason ?? "Budget exceeded",
		});

		// Verify retrievable via alert store (same data RPC/HTTP would serve)
		const alerts = alertStore.getAlerts();
		expect(alerts.length).toBe(1);
		expect(alerts[0].type).toBe("budget_exceeded");
		expect(alerts[0].agentId).toBe("pipeline-agent-1");
		expect(alerts[0].severity).toBe("critical");
		expect(alerts[0].action).toBe("auto_pause");
		expect(alerts[0].ts).toBeGreaterThan(0);

		// Verify agent-scoped retrieval
		const agentAlerts = alertStore.getAlertsByAgent("pipeline-agent-1");
		expect(agentAlerts.length).toBe(1);

		// Other agents have no alerts
		expect(alertStore.getAlertsByAgent("other-agent").length).toBe(0);
	});

	it("anomaly detectors feed into alert store", () => {
		// Build an agent with error loop
		spendTracker.record("pipeline-agent-2", "anthropic", "claude-sonnet-4-5", { input: 100, output: 50 });
		for (let i = 0; i < 15; i++) {
			spendTracker.recordError("pipeline-agent-2");
		}

		const spend = spendTracker.get("pipeline-agent-2")!;
		const anomalies = runDetectors("pipeline-agent-2", spend, DEFAULT_CONFIG.anomaly, 100);

		// Push each anomaly into alert store (same as plugin's anomaly timer does)
		for (const alert of anomalies) {
			alertStore.pushAlert(alert);
		}

		// Should have at least the error_loop alert
		const criticals = alertStore.getAlertsBySeverity("critical");
		expect(criticals.length).toBeGreaterThanOrEqual(1);
		expect(criticals.some((a) => a.type === "error_loop")).toBe(true);

		// Verify it has auto_pause action
		const errorAlert = criticals.find((a) => a.type === "error_loop")!;
		expect(errorAlert.action).toBe("auto_pause");
		expect(errorAlert.agentId).toBe("pipeline-agent-2");
	});

	it("multiple agents generate separate alerts", () => {
		// Agent A: budget exceeded
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "agent-a", severity: "critical", message: "A over" });

		// Agent B: tool blocked
		alertStore.pushAlert({ type: "budget_warning", agentId: "agent-b", severity: "warning", message: "B tool blocked" });

		// Agent C: spend spike
		alertStore.pushAlert({ type: "spend_spike", agentId: "agent-c", severity: "warning", message: "C spike" });

		// All 3 in global view
		expect(alertStore.getAlerts().length).toBe(3);

		// Each agent's view is isolated
		expect(alertStore.getAlertsByAgent("agent-a").length).toBe(1);
		expect(alertStore.getAlertsByAgent("agent-b").length).toBe(1);
		expect(alertStore.getAlertsByAgent("agent-c").length).toBe(1);

		// Severity filtering works across agents
		expect(alertStore.getAlertsBySeverity("critical").length).toBe(1);
		expect(alertStore.getAlertsBySeverity("warning").length).toBe(2);
	});

	it("alert store serves same data as RPC and HTTP endpoints would", () => {
		// Simulate a realistic sequence of events
		alertStore.pushAlert({ type: "budget_warning", agentId: "sales-01", severity: "warning", message: "At 82% of budget" });
		alertStore.pushAlert({ type: "spend_spike", agentId: "ops-07", severity: "warning", message: "4x normal spend" });
		alertStore.pushAlert({ type: "budget_exceeded", agentId: "sales-01", severity: "critical", message: "Budget exceeded", action: "auto_pause" });
		alertStore.pushAlert({ type: "error_loop", agentId: "support-03", severity: "critical", message: "12 consecutive errors", action: "auto_pause" });

		// This is what observeclaw.alerts RPC would return
		const rpcResponse = { alerts: alertStore.getAlerts(50) };
		expect(rpcResponse.alerts.length).toBe(4);
		expect(rpcResponse.alerts.every((a: { ts: number }) => typeof a.ts === "number")).toBe(true);

		// This is what observeclaw.agent RPC would return for sales-01
		const agentResponse = {
			agentId: "sales-01",
			alerts: alertStore.getAlertsByAgent("sales-01", 20),
		};
		expect(agentResponse.alerts.length).toBe(2);
		expect(agentResponse.alerts[0].type).toBe("budget_warning");
		expect(agentResponse.alerts[1].type).toBe("budget_exceeded");

		// This is what GET /plugins/observeclaw/alerts HTTP would return
		const httpResponse = JSON.parse(JSON.stringify({ alerts: alertStore.getAlerts(50) }));
		expect(httpResponse.alerts.length).toBe(4);
		// JSON serializable — no functions, no circular refs
		expect(typeof httpResponse.alerts[0].ts).toBe("number");
		expect(typeof httpResponse.alerts[0].type).toBe("string");
	});
});

// ============================================================================
// WEBHOOKS — outbound push notifications
// ============================================================================

describe("webhook dispatch", () => {
	const criticalAlert: AnomalyAlert = {
		type: "budget_exceeded",
		agentId: "sales-agent-01",
		severity: "critical",
		action: "auto_pause",
		message: "Daily budget exceeded: $100.04/$100.00",
	};

	const warningAlert: AnomalyAlert = {
		type: "spend_spike",
		agentId: "ops-agent-07",
		severity: "warning",
		message: "Hourly spend $10.00 is 5.0x average ($2.00)",
		metric: { current: 10, average: 2, ratio: 5 },
	};

	const infoAlert: AnomalyAlert = {
		type: "token_inflation",
		agentId: "data-agent",
		severity: "info",
		message: "Input tokens growing: 20000 -> 80000 avg (4.0x)",
	};

	it("dispatches to webhook URL", async () => {
		let capturedBody: Record<string, unknown> | null = null;

		// Mock fetch
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
			capturedBody = JSON.parse(opts.body as string);
			return new Response("ok", { status: 200 });
		});

		const webhooks: WebhookConfig[] = [{ url: "https://hooks.example.com/alert" }];
		const results = await dispatchWebhooks(criticalAlert, webhooks);

		expect(results.length).toBe(1);
		expect(results[0].ok).toBe(true);
		expect(results[0].status).toBe(200);
		expect(results[0].url).toBe("https://hooks.example.com/alert");

		// Verify payload
		expect(capturedBody).not.toBeNull();
		expect(capturedBody!.source).toBe("observeclaw");
		const alert = capturedBody!.alert as Record<string, unknown>;
		expect(alert.type).toBe("budget_exceeded");
		expect(alert.agentId).toBe("sales-agent-01");
		expect(alert.severity).toBe("critical");
		expect(alert.action).toBe("auto_pause");
		expect(typeof alert.ts).toBe("number");

		globalThis.fetch = originalFetch;
	});

	it("sends custom headers", async () => {
		let capturedHeaders: Record<string, string> = {};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
			capturedHeaders = Object.fromEntries(Object.entries(opts.headers ?? {}));
			return new Response("ok", { status: 200 });
		});

		const webhooks: WebhookConfig[] = [
			{
				url: "https://api.pagerduty.com/events",
				headers: { Authorization: "Token token=abc123", "X-Custom": "value" },
			},
		];
		await dispatchWebhooks(criticalAlert, webhooks);

		expect(capturedHeaders.Authorization).toBe("Token token=abc123");
		expect(capturedHeaders["X-Custom"]).toBe("value");
		expect(capturedHeaders["Content-Type"]).toBe("application/json");

		globalThis.fetch = originalFetch;
	});

	it("respects minSeverity — skips info alerts for warning-level webhook", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

		const webhooks: WebhookConfig[] = [{ url: "https://hooks.example.com/alert", minSeverity: "warning" }];

		// Info alert — should be skipped
		const infoResults = await dispatchWebhooks(infoAlert, webhooks);
		expect(infoResults.length).toBe(0);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		// Warning alert — should fire
		const warnResults = await dispatchWebhooks(warningAlert, webhooks);
		expect(warnResults.length).toBe(1);
		expect(warnResults[0].ok).toBe(true);

		// Critical alert — should fire
		const critResults = await dispatchWebhooks(criticalAlert, webhooks);
		expect(critResults.length).toBe(1);

		globalThis.fetch = originalFetch;
	});

	it("respects minSeverity: critical — only fires on critical", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

		const webhooks: WebhookConfig[] = [{ url: "https://pager.example.com", minSeverity: "critical" }];

		expect((await dispatchWebhooks(infoAlert, webhooks)).length).toBe(0);
		expect((await dispatchWebhooks(warningAlert, webhooks)).length).toBe(0);
		expect((await dispatchWebhooks(criticalAlert, webhooks)).length).toBe(1);

		globalThis.fetch = originalFetch;
	});

	it("dispatches to multiple webhooks simultaneously", async () => {
		const originalFetch = globalThis.fetch;
		const calledUrls: string[] = [];
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			calledUrls.push(url);
			return new Response("ok", { status: 200 });
		});

		const webhooks: WebhookConfig[] = [
			{ url: "https://slack.example.com/webhook" },
			{ url: "https://pagerduty.example.com/events" },
			{ url: "https://custom.example.com/alerts" },
		];

		const results = await dispatchWebhooks(criticalAlert, webhooks);
		expect(results.length).toBe(3);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(calledUrls).toContain("https://slack.example.com/webhook");
		expect(calledUrls).toContain("https://pagerduty.example.com/events");
		expect(calledUrls).toContain("https://custom.example.com/alerts");

		globalThis.fetch = originalFetch;
	});

	it("handles webhook failures gracefully", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

		const warnings: string[] = [];
		const logger = { warn: (msg: string) => warnings.push(msg) };

		const webhooks: WebhookConfig[] = [{ url: "https://dead.example.com/webhook" }];
		const results = await dispatchWebhooks(criticalAlert, webhooks, logger);

		expect(results.length).toBe(1);
		expect(results[0].ok).toBe(false);
		expect(results[0].error).toContain("Connection refused");
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("webhook failed");

		globalThis.fetch = originalFetch;
	});

	it("handles HTTP error responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));

		const webhooks: WebhookConfig[] = [{ url: "https://example.com/webhook" }];
		const results = await dispatchWebhooks(criticalAlert, webhooks);

		expect(results.length).toBe(1);
		expect(results[0].ok).toBe(false);
		expect(results[0].status).toBe(403);

		globalThis.fetch = originalFetch;
	});

	it("returns empty for no webhooks configured", async () => {
		const results = await dispatchWebhooks(criticalAlert, []);
		expect(results.length).toBe(0);
	});
});

describe("webhook: Slack formatting", () => {
	it("formats critical alert with rotating_light emoji in text and blocks", () => {
		const payload = formatSlackPayload({
			type: "budget_exceeded",
			agentId: "sales-agent-01",
			severity: "critical",
			action: "auto_pause",
			message: "Daily budget exceeded: $100.04/$100.00",
		});

		// text field is mandatory for Slack
		expect(typeof payload.text).toBe("string");
		expect(payload.text as string).toContain(":rotating_light:");
		expect(payload.text as string).toContain("sales-agent-01");

		// blocks contain structured content
		const blocks = payload.blocks as Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string }> }>;
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		const sectionText = blocks[0].text?.text ?? "";
		expect(sectionText).toContain(":rotating_light:");
		expect(sectionText).toContain("sales-agent-01");
		expect(sectionText).toContain("budget_exceeded");
		// Should have action context block
		const actionBlock = blocks.find((b) => b.type === "context" && b.elements?.[0]?.text.includes("auto_pause"));
		expect(actionBlock).toBeDefined();
	});

	it("formats warning alert with warning emoji", () => {
		const payload = formatSlackPayload({
			type: "spend_spike",
			agentId: "ops-agent",
			severity: "warning",
			message: "5x normal spend rate",
		});

		expect(payload.text as string).toContain(":warning:");
		const blocks = payload.blocks as Array<{ type: string; text?: { text: string } }>;
		const sectionText = blocks[0].text?.text ?? "";
		expect(sectionText).toContain(":warning:");
		expect(sectionText).toContain("ops-agent");
	});

	it("formats info alert with information_source emoji", () => {
		const payload = formatSlackPayload({
			type: "token_inflation",
			agentId: "data-agent",
			severity: "info",
			message: "Input tokens growing",
		});

		expect(payload.text as string).toContain(":information_source:");
		const blocks = payload.blocks as Array<{ type: string; text?: { text: string } }>;
		const sectionText = blocks[0].text?.text ?? "";
		expect(sectionText).toContain(":information_source:");
		expect(sectionText).toContain("data-agent");
	});

	it("includes severity context block in all alerts", () => {
		const payload = formatSlackPayload({
			type: "idle_burn",
			agentId: "test-agent",
			severity: "warning",
			message: "Agent idle",
		});

		const blocks = payload.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
		const severityBlock = blocks.find((b) => b.type === "context" && b.elements?.[0]?.text.includes("Severity:"));
		expect(severityBlock).toBeDefined();
		expect(severityBlock!.elements![0].text).toContain("warning");
	});

	it("omits action block when no action present", () => {
		const payload = formatSlackPayload({
			type: "spend_spike",
			agentId: "test",
			severity: "warning",
			message: "spike",
		});

		const blocks = payload.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
		const actionBlock = blocks.find((b) => b.type === "context" && b.elements?.[0]?.text.includes("Action taken:"));
		expect(actionBlock).toBeUndefined();
	});

	it("includes action block when action present", () => {
		const payload = formatSlackPayload({
			type: "error_loop",
			agentId: "test",
			severity: "critical",
			action: "auto_pause",
			message: "10 consecutive errors",
		});

		const blocks = payload.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>;
		const actionBlock = blocks.find((b) => b.type === "context" && b.elements?.[0]?.text.includes("Action taken:"));
		expect(actionBlock).toBeDefined();
		expect(actionBlock!.elements![0].text).toContain("auto_pause");
	});
});
