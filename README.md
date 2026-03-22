# ObserveClaw

Agent spend tracking, budget enforcement, tool policy, and anomaly detection for OpenClaw.

ObserveClaw is an OpenClaw plugin that monitors how much each agent spends on language model calls, enforces daily and monthly budgets, controls which tools each agent can use, detects anomalous spending patterns, and sends alerts to external services when something goes wrong. It runs entirely inside the OpenClaw gateway process with no external dependencies.

## Installation

### From npm

Run the following two commands on any machine where OpenClaw is installed. The first command downloads and installs the plugin into OpenClaw's plugin directory. The second command enables it in the gateway configuration.

```bash
openclaw plugins install observeclaw
openclaw plugins enable observeclaw
```

After enabling, restart the gateway for the plugin to load.

### From a local directory

If you have the source code checked out, point the install command at the extension directory.

```bash
openclaw plugins install ./extensions/observeclaw/
openclaw plugins enable observeclaw
```

Restart the gateway after enabling.

### Verify installation

After restarting the gateway, check that the plugin is loaded.

```bash
openclaw plugins list
```

You should see ObserveClaw listed with status "loaded". The gateway logs will also show a startup line confirming the plugin is active, displaying the default daily budget and the downgrade model.

## Configuration

Add an `observeclaw` block to your OpenClaw config file under `plugins`. The minimal configuration requires only `enabled: true`. All other settings have sensible defaults.

```yaml
plugins:
  observeclaw:
    enabled: true
```

With no further configuration, the plugin activates with a one hundred dollar daily budget per agent, model downgrade to Claude Haiku at eighty percent of budget, and all five anomaly detectors running with default thresholds.

### Full configuration reference

```yaml
plugins:
  observeclaw:
    enabled: true
    currency: "USD"                    # Display currency. Cost calculation is always USD internally.

    budgets:
      defaults:
        daily: 100                     # Default daily spend limit per agent in USD.
        monthly: 2000                  # Default monthly spend limit per agent in USD.
        warnAt: 0.8                    # Ratio (0 to 1) at which model downgrade begins. Default 0.8 (80%).
      agents:
        sales-agent:
          daily: 20
          monthly: 400
        eng-agent:
          daily: 500
          monthly: 10000
          warnAt: 0.9                  # Engineering agents get downgraded later (90%).
        intern-agent:
          daily: 5
          monthly: 100
          warnAt: 0.5                  # Intern agents get downgraded earlier (50%).

    toolPolicy:
      defaults:
        allow: []                      # Empty means all tools allowed.
        deny: []                       # Empty means no tools denied.
      agents:
        intern-agent:
          allow:                       # Only these tools are permitted. Everything else is blocked.
            - search
            - read_file
            - send_message
        support-agent:
          deny:                        # These tools are explicitly forbidden. Everything else is allowed.
            - exec
            - shell
            - bash
            - run_command

    anomaly:
      spendSpikeMultiplier: 3          # Alert if hourly spend exceeds Nx the 7-day hourly average.
      idleBurnMinutes: 10              # Alert if agent calls LLM for N minutes with no tool output.
      errorLoopThreshold: 10           # Auto-pause after N consecutive LLM errors.
      tokenInflationMultiplier: 2      # Alert if average input tokens doubled over recent calls.

    downgradeModel: "claude-haiku-4-5" # Model to force when agent approaches budget limit.
    downgradeProvider: "anthropic"     # Provider for the downgrade model.

    pricing:                           # Override default per-million-token pricing.
      "custom-provider/my-model":
        input: 5
        output: 20
        cacheRead: 0.5
        cacheWrite: 2.5
      "ollama/*":                      # Wildcard: all Ollama models at zero cost.
        input: 0
        output: 0
        cacheRead: 0
        cacheWrite: 0

    webhooks:
      - url: "https://hooks.slack.com/services/T00/B00/xxx"
        minSeverity: warning           # Receives warning and critical alerts.
      - url: "https://events.pagerduty.com/v2/enqueue"
        minSeverity: critical          # Receives only critical alerts.
        headers:
          Authorization: "Token token=your-pagerduty-key"
        timeoutMs: 3000                # Timeout for this webhook in milliseconds. Default 5000.
```

## How It Works

### Spend tracking

Every time any agent on this gateway makes a call to a language model, OpenClaw fires the `llm_output` hook with the response's token counts. The plugin intercepts this event, looks up the model's pricing in its built-in pricing table (which covers Anthropic, OpenAI, Google, and local models like Ollama), and calculates the cost of that specific call by multiplying each token type (input, output, cache read, cache write) by its per-million-token rate.

The calculated cost is accumulated in an in-memory data structure that tracks each agent's total spend today, total spend this month, cost in the current rolling hour, a seven-day history of hourly costs, the number of LLM calls made, and the sizes of recent input token payloads. If the agent's call is associated with a specific session, the plugin also tracks per-session spend breakdowns including the session's total cost, total tokens by type, and call count.

After recording the cost, the plugin logs a line showing the agent's name, the cost of this individual call, the cumulative spend for today, and which provider and model were used. For example: `[observeclaw] sales-agent | call: $0.1050 | today: $12.34 | anthropic/claude-sonnet-4-5`.

The pricing table can be overridden via configuration. If you are using a custom model or a provider whose pricing differs from the defaults, you add an entry to the pricing config with the provider and model name as the key and the per-million-token costs as the value. Wildcard matching is supported, so you can set all Ollama models to zero cost with a single entry.

### Budget enforcement

Before every LLM call, OpenClaw fires the `before_model_resolve` hook. The plugin intercepts this and checks the agent's cumulative daily spend against its configured budget.

If the agent has spent less than eighty percent of its daily budget (or whatever the `warnAt` ratio is set to), the plugin does nothing and the call proceeds normally with whatever model was originally selected.

If the agent has spent between the warning threshold and one hundred percent of its daily budget, the plugin forces a model downgrade. It returns an override that switches the model to a cheaper alternative, by default Claude Haiku. The agent continues to function, but at lower cost per call. This gives the agent a soft landing rather than a hard stop. The plugin logs a warning and pushes a `budget_warning` alert.

If the agent has exceeded one hundred percent of its daily budget, the plugin continues to force the downgrade model and pushes a `budget_exceeded` alert with critical severity. The agent can still make calls on the cheaper model, but the plugin also hooks into `message_sending` to cancel outbound messages from over-budget agents. This means the agent's responses are silently dropped — it keeps running on the cheap model but its output never reaches the user or channel.

### Tool policy enforcement

Before every tool call, including both native OpenClaw tools and MCP tools from external servers, OpenClaw fires the `before_tool_call` hook. The plugin checks the tool name against the agent's configured tool policy.

The tool policy supports two modes. In deny-list mode, you specify which tools are explicitly forbidden. Any tool on the deny list is blocked, and everything else is allowed. In allow-list mode, you specify which tools are explicitly permitted. Any tool not on the allow list is blocked. If both an allow list and a deny list are configured, the deny list takes precedence: a tool that appears on both lists is blocked.

When a tool is blocked, the plugin returns a block response with a reason string. OpenClaw communicates this back to the language model as a tool error, and the model typically adjusts its behavior.

Tool policies are configured per agent. This means you can give a support agent access to search and read tools only, while giving an engineering agent full access to exec and shell tools. An agent with no tool policy configured inherits the global defaults, which by default allow all tools.

This is particularly important for security. If an agent is prompt-injected through a malicious webpage or user input, the attacker might try to make the agent call exec, shell, or curl to exfiltrate data. With a deny list or an allow list in place, these calls are blocked before they execute, regardless of what the language model was tricked into requesting.

### Anomaly detection

Every thirty seconds, the plugin evaluates five rule-based anomaly detectors against every tracked agent.

**Spend spike.** Compares the agent's cost in the current rolling hour against the average hourly cost from its seven-day history. If the current hour's cost exceeds three times the historical average, it fires a warning alert. This catches situations where someone changes an agent's model from Sonnet to Opus without updating the budget, or where unexpected traffic causes a cost surge.

**Idle burn.** Checks whether the agent has been making LLM calls but has not executed any tool calls for more than ten minutes. This catches agents stuck in a loop, burning tokens but producing zero useful output. This is the exact failure mode that cost one company over ten thousand dollars in thirteen days.

**Error loop.** Checks whether the agent has accumulated ten or more consecutive LLM errors without any successful call in between. If so, it fires a critical alert and marks the agent for auto-pause. This catches agents stuck retrying against a rate-limited API, agents with malformed prompts that always fail, or agents whose API keys have expired. A single successful call resets the counter, so transient errors do not trigger false positives.

**Token inflation.** Compares the average input token count in the first half of the agent's recent calls against the second half. If the input size has doubled, it fires an informational alert. This catches context windows that are growing without compaction, which predicts future cost spikes as larger inputs cost more money.

**Budget warning.** Fires a one-time warning when the agent reaches eighty percent of its daily budget. It does not repeat until the daily counters reset at midnight. This gives the operator advance notice before the budget enforcer starts downgrading models or blocking calls.

### Alerts and notifications

Every alert generated by the anomaly detectors, the budget enforcer, and the tool policy enforcer is stored in an in-memory alert store. The store keeps the last one hundred alerts in a first-in-first-out queue. Each stored alert includes the alert type, agent ID, severity, message, optional action, optional metrics, and a timestamp.

Alerts are accessible through three interfaces.

**Gateway RPC methods.** Any client connected to the gateway via WebSocket can call `observeclaw.spend` to get all agents' spend summaries plus the fifty most recent alerts, `observeclaw.alerts` to get only the alerts, or `observeclaw.agent` with an agent ID to get that specific agent's spend, budget, utilization ratio, and recent alerts.

**HTTP endpoint.** A GET request to `/plugins/observeclaw/alerts` returns the fifty most recent alerts as JSON. This endpoint requires gateway authentication. It exists for external integrations that cannot connect via WebSocket, such as monitoring tools, cron jobs, or custom dashboards.

**Outbound webhooks.** When an alert is generated, the plugin sends it as a JSON POST request to each configured webhook URL. Each webhook has a minimum severity filter, so you can send only critical alerts to PagerDuty while sending all warnings and above to Slack. Each webhook can include custom headers for authentication. Webhook dispatch is fire-and-forget: failures are logged but do not block or delay other plugin operations.

The webhook payload is a JSON object with a `source` field set to "observeclaw" and an `alert` object containing the type, agent ID, severity, message, action (if any), metrics (if any), and a timestamp.

### Session lifecycle logging

When a session starts, the plugin logs the session key and agent ID. When a session ends, the plugin looks up the session's accumulated spend data and logs the total cost and call count for that session. This provides a per-session cost summary in the gateway logs without requiring any additional infrastructure.

### Gateway shutdown

When the gateway shuts down, the plugin clears all background timers and prints a final spend summary to the logs. The summary lists every tracked agent with its total spend today, total spend this month, and total call count. This provides a snapshot of the gateway's cost state at the moment it stopped.

## Alert Types Reference

| Type | Severity | Trigger | Action |
|------|----------|---------|--------|
| `budget_warning` | warning | Agent spend reaches the configured warning threshold (default 80% of daily budget) | Model downgraded to cheaper alternative |
| `budget_exceeded` | critical | Agent spend exceeds 100% of daily budget | Model downgraded, outbound messages cancelled |
| `spend_spike` | warning | Hourly spend exceeds 3x the seven-day hourly average | Alert only |
| `idle_burn` | warning | Agent calling LLM for more than 10 minutes with no tool output | Alert only |
| `error_loop` | critical | 10 or more consecutive LLM errors | Auto-pause recommended |
| `token_inflation` | info | Average input tokens doubled over recent calls | Alert only |
| Tool block | warning | Tool call blocked by allow/deny policy | Tool execution prevented |

## Querying Spend Data

### Via gateway WebSocket RPC

Connect to the gateway's WebSocket API and send a request frame.

```json
{"type": "req", "id": "1", "method": "observeclaw.spend"}
```

Response:

```json
{
  "type": "res", "id": "1", "ok": true,
  "payload": {
    "agents": [
      {"agentId": "sales-agent", "today": 14.23, "thisMonth": 312.47, "callCount": 847}
    ],
    "alerts": [
      {"type": "budget_warning", "agentId": "sales-agent", "severity": "warning", "message": "At 82% of budget", "ts": 1711036800000}
    ]
  }
}
```

For a single agent's detail view:

```json
{"type": "req", "id": "2", "method": "observeclaw.agent", "params": {"agentId": "sales-agent"}}
```

### Via HTTP

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  https://your-gateway/plugins/observeclaw/alerts
```

## Built-in Model Pricing

The plugin includes pricing for the following models. All prices are per million tokens.

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| claude-opus-4-6 | $5.00 | $25.00 | $0.50 | $6.25 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-sonnet-4-5 | $3.00 | $15.00 | $0.30 | $3.75 |
| claude-haiku-4-5 | $1.00 | $5.00 | $0.10 | $1.25 |
| gpt-5.2 | $1.75 | $14.00 | $0.875 | $1.75 |
| gpt-5 | $1.25 | $10.00 | $0.625 | $1.25 |
| gpt-5-mini | $0.25 | $2.00 | $0.125 | $0.25 |
| gpt-4.1 | $2.00 | $8.00 | $1.00 | $2.00 |
| gpt-4.1-mini | $0.40 | $1.60 | $0.20 | $0.40 |
| gpt-4.1-nano | $0.05 | $0.20 | $0.025 | $0.05 |
| gpt-4o | $2.50 | $10.00 | $1.25 | $2.50 |
| gpt-4o-mini | $0.15 | $0.60 | $0.075 | $0.15 |
| o3 | $2.00 | $8.00 | $1.00 | $2.00 |
| o4-mini | $1.10 | $4.40 | $0.55 | $1.10 |
| codex-mini | $1.50 | $6.00 | $0.75 | $1.50 |
| gemini-3.1-pro | $2.00 | $12.00 | $0.50 | $2.00 |
| gemini-3.1-flash | $0.50 | $3.00 | $0.125 | $0.50 |
| gemini-3.1-flash-lite | $0.25 | $1.50 | $0.0625 | $0.25 |
| gemini-2.5-pro | $1.00 | $10.00 | $0.25 | $1.00 |
| gemini-2.5-flash | $0.30 | $2.50 | $0.075 | $0.30 |
| deepseek-chat (v3) | $0.28 | $0.42 | $0.028 | $0.28 |
| deepseek-reasoner (r1) | $0.50 | $2.18 | $0.05 | $0.50 |
| mistral-medium-3 | $0.40 | $2.00 | $0.04 | $0.40 |
| llama-4-maverick | $0.27 | $0.85 | $0.027 | $0.27 |
| ollama/* | $0.00 | $0.00 | $0.00 | $0.00 |
| lm-studio/* | $0.00 | $0.00 | $0.00 | $0.00 |

Override or extend this table using the `pricing` configuration field.

## Limitations

The plugin does not persist spend data across gateway restarts. When the gateway stops, all in-memory counters are lost. This will be addressed in a future phase that adds a control plane for persistent telemetry storage.

The plugin cannot fully stop an agent from making LLM calls. When the budget is exceeded, it downgrades the model to a cheaper alternative and cancels outbound messages, but the agent process continues running and making calls on the cheaper model. A future phase adds a node-local proxy that cleanly blocks requests before they reach the provider.

The plugin does not hide API keys from agents. Agents still hold their own provider credentials in OpenClaw's auth profiles. A future phase adds a credential proxy that injects keys on behalf of agents so they never see the raw key values.

The plugin does not coordinate across multiple gateway instances. Each gateway tracks its own agents independently. A future phase adds a control plane that aggregates telemetry from all gateways into a single fleet view.

## Running Tests

```bash
bun test extensions/observeclaw/observeclaw.test.ts
```

The test suite includes fifty-seven tests covering unit tests for pricing, spend tracking, budget enforcement, tool policy, and anomaly detection, as well as scenario simulations that reproduce real-world failures (cache loop cost blowout, prompt injection tool exfiltration, LLM error loops, context window bloat, multi-agent fleet budgets, and spend spikes) and end-to-end tests for the alert store, alert pipeline, webhook dispatch, and Slack formatting.
