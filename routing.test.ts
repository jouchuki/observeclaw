import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runRoutingPipeline, validateEvaluators } from "./src/routing.js";
import type { EvaluatorConfig } from "./src/routing.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateEvaluators", () => {
  it("rejects duplicate priorities", () => {
    const result = validateEvaluators([
      { name: "a", type: "regex", priority: 100, enabled: true, patterns: [], provider: "x", model: "y" },
      { name: "b", type: "regex", priority: 100, enabled: true, patterns: [], provider: "x", model: "y" },
    ]);
    expect(result).toContain("Duplicate priority 100");
  });

  it("allows same priority if one is disabled", () => {
    const result = validateEvaluators([
      { name: "a", type: "regex", priority: 100, enabled: true, patterns: [], provider: "x", model: "y" },
      { name: "b", type: "regex", priority: 100, enabled: false, patterns: [], provider: "x", model: "y" },
    ]);
    expect(result).toBeNull();
  });

  it("passes with unique priorities", () => {
    const result = validateEvaluators([
      { name: "a", type: "regex", priority: 100, enabled: true, patterns: [], provider: "x", model: "y" },
      { name: "b", type: "regex", priority: 50, enabled: true, patterns: [], provider: "x", model: "y" },
    ]);
    expect(result).toBeNull();
  });
});

describe("regex evaluator", () => {
  it("matches SSN pattern and routes to local model", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("my SSN is 123-45-6789", "agent-1", evaluators, logger);
    expect(result).toEqual({
      provider: "ollama",
      model: "llama3:8b",
      reason: "pii:regex_match",
    });
  });

  it("matches email pattern", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"],
        provider: "ollama",
        model: "llama3:8b",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("email me at ceo@bigcorp.com", "agent-1", evaluators, logger);
    expect(result?.reason).toBe("pii:regex_match");
  });

  it("returns null when no pattern matches", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("hello how are you", "agent-1", evaluators, logger);
    expect(result).toBeNull();
  });

  it("handles invalid regex gracefully", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "broken",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["[invalid("],
        provider: "ollama",
        model: "llama3:8b",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("anything", "agent-1", evaluators, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid pattern"));
  });

  it("matches credit card across different formats", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "card-detect",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b"],
        provider: "local",
        model: "phi-3",
      },
    ];

    expect((await runRoutingPipeline("card: 4111-1111-1111-1111", "a", evaluators, logger)).decision).not.toBeNull();
    expect((await runRoutingPipeline("card: 4111 1111 1111 1111", "a", evaluators, logger)).decision).not.toBeNull();
    expect((await runRoutingPipeline("card: 4111111111111111", "a", evaluators, logger)).decision).not.toBeNull();
    expect((await runRoutingPipeline("no card here", "a", evaluators, logger)).decision).toBeNull();
  });
});

describe("priority ordering", () => {
  it("highest priority wins when multiple evaluators match", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "low-priority",
        type: "regex",
        priority: 10,
        enabled: true,
        patterns: [".*"], // matches everything
        provider: "cheap",
        model: "tiny",
      },
      {
        name: "high-priority",
        type: "regex",
        priority: 90,
        enabled: true,
        patterns: [".*"], // also matches everything
        provider: "expensive",
        model: "huge",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("anything", "agent-1", evaluators, logger);
    expect(result?.provider).toBe("expensive");
    expect(result?.model).toBe("huge");
  });

  it("PII at 100 beats complexity at 50", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "complexity",
        type: "regex",
        priority: 50,
        enabled: true,
        patterns: ["analyze|debug|refactor"],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
    ];

    // Message has BOTH a keyword AND an SSN — PII should win
    const { decision: result, event } = await runRoutingPipeline(
      "analyze my SSN 123-45-6789 for security issues",
      "agent-1",
      evaluators,
      logger,
    );
    expect(result?.provider).toBe("ollama");
    expect(result?.reason).toBe("pii:regex_match");
  });

  it("lower priority evaluator wins when higher priority doesn't match", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
      {
        name: "complexity",
        type: "regex",
        priority: 50,
        enabled: true,
        patterns: ["analyze|debug|refactor"],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ];

    // No SSN, but has keyword — complexity should win
    const { decision: result, event } = await runRoutingPipeline(
      "analyze this code for bugs",
      "agent-1",
      evaluators,
      logger,
    );
    expect(result?.provider).toBe("anthropic");
    expect(result?.reason).toBe("complexity:regex_match");
  });
});

describe("disabled evaluators", () => {
  it("skips disabled evaluators entirely", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "catch-all",
        type: "regex",
        priority: 100,
        enabled: false, // disabled
        patterns: [".*"],
        provider: "should-not-appear",
        model: "nope",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("anything", "agent-1", evaluators, logger);
    expect(result).toBeNull();
  });

  it("falls through disabled high-priority to enabled low-priority", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "disabled-pii",
        type: "regex",
        priority: 100,
        enabled: false,
        patterns: [".*"],
        provider: "ollama",
        model: "llama3:8b",
      },
      {
        name: "catch-all",
        type: "regex",
        priority: 10,
        enabled: true,
        patterns: [".*"],
        provider: "cheap",
        model: "tiny",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("anything", "agent-1", evaluators, logger);
    expect(result?.provider).toBe("cheap");
  });
});

describe("classifier evaluator", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("routes based on classifier response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "complex" } }],
      }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "smart-router",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost:11434/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: 'Classify: simple or complex. Message: {{message}}',
        routes: {
          simple: { provider: "openai", model: "gpt-4o-mini" },
          complex: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("explain quantum computing", "agent-1", evaluators, logger);
    expect(result?.provider).toBe("anthropic");
    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.reason).toBe("smart-router:complex");
  });

  it("returns null when classifier returns unknown label", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "gibberish_label" } }],
      }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "router",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost:11434/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: {
          simple: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("hello", "agent-1", evaluators, logger);
    expect(result).toBeNull();
  });

  it("handles classifier timeout gracefully", async () => {
    fetchSpy.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 10);
    }));

    const evaluators: EvaluatorConfig[] = [
      {
        name: "slow-classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost:11434/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: { simple: { provider: "openai", model: "gpt-4o-mini" } },
        timeoutMs: 1,
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("hello", "agent-1", evaluators, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("handles classifier HTTP error gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const evaluators: EvaluatorConfig[] = [
      {
        name: "broken-classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost:11434/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: { simple: { provider: "openai", model: "gpt-4o-mini" } },
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("hello", "agent-1", evaluators, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("returned 500"));
  });

  it("does partial label matching", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "I think this is a complex task" } }],
      }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "fuzzy-router",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost:11434/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: {
          simple: { provider: "openai", model: "gpt-4o-mini" },
          complex: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("do something hard", "agent-1", evaluators, logger);
    expect(result?.provider).toBe("anthropic");
    expect(result?.reason).toBe("fuzzy-router:complex");
  });
});

describe("webhook evaluator", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("routes based on webhook response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "external-router",
        type: "webhook",
        priority: 70,
        enabled: true,
        url: "http://router.internal/decide",
        headers: { "X-Api-Key": "secret" },
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("complex task", "agent-1", evaluators, logger);
    expect(result?.provider).toBe("anthropic");
    expect(result?.model).toBe("claude-opus-4-6");

    // Verify request was sent correctly
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://router.internal/decide",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "complex task", agentId: "agent-1" }),
      }),
    );
  });

  it("passes custom headers to webhook", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ provider: "x", model: "y" }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "authed-webhook",
        type: "webhook",
        priority: 70,
        enabled: true,
        url: "http://router.internal/decide",
        headers: { "Authorization": "Bearer token123", "X-Tenant": "acme" },
      },
    ];

    await runRoutingPipeline("msg", "agent-1", evaluators, logger);

    const callHeaders = (fetchSpy.mock.calls[0]?.[1] as any)?.headers;
    expect(callHeaders).toMatchObject({
      "Authorization": "Bearer token123",
      "X-Tenant": "acme",
    });
  });

  it("returns null when webhook returns no provider/model", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "pass" }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "passive-webhook",
        type: "webhook",
        priority: 70,
        enabled: true,
        url: "http://router.internal/decide",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("msg", "agent-1", evaluators, logger);
    expect(result).toBeNull();
  });

  it("handles webhook timeout gracefully", async () => {
    fetchSpy.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 10);
    }));

    const evaluators: EvaluatorConfig[] = [
      {
        name: "slow-webhook",
        type: "webhook",
        priority: 70,
        enabled: true,
        url: "http://router.internal/decide",
        timeoutMs: 1,
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("msg", "agent-1", evaluators, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});

describe("mixed evaluator pipeline", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("PII regex beats classifier beats webhook — all match", async () => {
    // Classifier says "complex"
    fetchSpy.mockImplementation((url: any) => {
      if (String(url).includes("classifier")) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "complex" } }],
        }), { status: 200 }));
      }
      // Webhook says use opus
      return Promise.resolve(new Response(JSON.stringify({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }), { status: 200 }));
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
      {
        name: "classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost/classifier",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: {
          complex: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
      {
        name: "webhook",
        type: "webhook",
        priority: 30,
        enabled: true,
        url: "http://localhost/webhook",
      },
    ];

    // All three match — PII wins at priority 100
    const { decision: result, event } = await runRoutingPipeline(
      "analyze SSN 123-45-6789 please",
      "agent-1",
      evaluators,
      logger,
    );
    expect(result?.provider).toBe("ollama");
    expect(result?.reason).toBe("pii:regex_match");
  });

  it("classifier wins when PII doesn't match", async () => {
    fetchSpy.mockImplementation((url: any) => {
      if (String(url).includes("classifier")) {
        return Promise.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: "complex" } }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }), { status: 200 }));
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
      {
        name: "classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://localhost/classifier",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: {
          complex: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
    ];

    // No SSN — classifier wins
    const { decision: result, event } = await runRoutingPipeline(
      "explain distributed consensus algorithms",
      "agent-1",
      evaluators,
      logger,
    );
    expect(result?.provider).toBe("anthropic");
    expect(result?.reason).toBe("classifier:complex");
  });

  it("all evaluators run in parallel — not sequentially", async () => {
    const callOrder: string[] = [];

    fetchSpy.mockImplementation((url: any) => {
      const name = String(url).includes("slow") ? "slow" : "fast";
      callOrder.push(`${name}-start`);
      const delay = name === "slow" ? 100 : 10;
      return new Promise((resolve) => {
        setTimeout(() => {
          callOrder.push(`${name}-end`);
          resolve(new Response(JSON.stringify({
            choices: [{ message: { content: "simple" } }],
          }), { status: 200 }));
        }, delay);
      });
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "slow",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://slow/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "a", model: "b" } },
      },
      {
        name: "fast",
        type: "classifier",
        priority: 40,
        enabled: true,
        url: "http://fast/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "c", model: "d" } },
      },
    ];

    await runRoutingPipeline("test", "agent-1", evaluators, logger);

    // Both should START before either ENDs (parallel execution)
    expect(callOrder[0]).toBe("slow-start");
    expect(callOrder[1]).toBe("fast-start");
  });

  it("returns null when all evaluators fail or return null", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));

    const evaluators: EvaluatorConfig[] = [
      {
        name: "regex-nomatch",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["^IMPOSSIBLE_PATTERN_xyz123$"],
        provider: "x",
        model: "y",
      },
      {
        name: "broken-classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://down/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "a", model: "b" } },
      },
      {
        name: "broken-webhook",
        type: "webhook",
        priority: 30,
        enabled: true,
        url: "http://also-down/route",
      },
    ];

    const { decision: result, event } = await runRoutingPipeline("normal message", "agent-1", evaluators, logger);
    expect(result).toBeNull();
  });

  it("empty evaluator list returns null immediately", async () => {
    const { decision: result, event } = await runRoutingPipeline("anything", "agent-1", [], logger);
    expect(result).toBeNull();
  });
});

describe("routing event emission", () => {
  it("event includes all evaluator results with timing", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
        emitEvent: true,
      },
      {
        name: "catch-all",
        type: "regex",
        priority: 10,
        enabled: true,
        patterns: [".*"],
        provider: "cheap",
        model: "tiny",
        emitEvent: false,
      },
    ];

    const { event } = await runRoutingPipeline("SSN: 123-45-6789", "agent-1", evaluators, logger);

    expect(event.agentId).toBe("agent-1");
    expect(event.evaluators).toHaveLength(2);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.timestamp).toBeGreaterThan(0);

    // PII matched
    const pii = event.evaluators.find((e) => e.name === "pii");
    expect(pii?.matched).toBe(true);
    expect(pii?.emitEvent).toBe(true);
    expect(pii?.durationMs).toBeGreaterThanOrEqual(0);

    // Catch-all also matched but emitEvent is false
    const catchAll = event.evaluators.find((e) => e.name === "catch-all");
    expect(catchAll?.matched).toBe(true);
    expect(catchAll?.emitEvent).toBe(false);

    // Winner is PII (priority 100)
    expect(event.winner?.name).toBe("pii");
    expect(event.winner?.priority).toBe(100);
  });

  it("event shows which evaluators did NOT match", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
      },
      {
        name: "profanity",
        type: "regex",
        priority: 80,
        enabled: true,
        patterns: ["badword1|badword2"],
        provider: "local",
        model: "tiny",
      },
    ];

    const { event } = await runRoutingPipeline("hello world", "agent-1", evaluators, logger);

    expect(event.winner).toBeNull();
    expect(event.evaluators[0]?.matched).toBe(false);
    expect(event.evaluators[1]?.matched).toBe(false);
  });

  it("event has promptPreview truncated to 120 chars", async () => {
    const longPrompt = "x".repeat(500);
    const { event } = await runRoutingPipeline(longPrompt, "agent-1", [], logger);
    expect(event.promptPreview).toHaveLength(120);
  });

  it("emitEvent defaults to false when not set", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "basic",
        type: "regex",
        priority: 10,
        enabled: true,
        patterns: [".*"],
        provider: "x",
        model: "y",
        // no emitEvent field
      },
    ];

    const { event } = await runRoutingPipeline("test", "agent-1", evaluators, logger);
    expect(event.evaluators[0]?.emitEvent).toBe(false);
  });

  it("classifier event includes label", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "complex" } }],
      }), { status: 200 }),
    );

    const evaluators: EvaluatorConfig[] = [
      {
        name: "classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        emitEvent: true,
        url: "http://localhost/v1/chat/completions",
        classifierModel: "llama3:8b",
        prompt: "Classify: {{message}}",
        routes: {
          complex: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
    ];

    const { event } = await runRoutingPipeline("hard question", "agent-1", evaluators, logger);

    const classifierResult = event.evaluators[0];
    expect(classifierResult?.label).toBe("complex");
    expect(classifierResult?.matched).toBe(true);
    expect(classifierResult?.emitEvent).toBe(true);

    fetchSpy.mockRestore();
  });
});

describe("message blocking", () => {
  it("shouldBlock is true when matching evaluator has blockMessage: true", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "dlp-blocker",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
        blockMessage: true,
        blockReply: "Message blocked: contains PII.",
      },
    ];

    const { shouldBlock, blockReply } = await runRoutingPipeline(
      "my SSN is 123-45-6789",
      "agent-1",
      evaluators,
      logger,
    );
    expect(shouldBlock).toBe(true);
    expect(blockReply).toBe("Message blocked: contains PII.");
  });

  it("shouldBlock is false when blockMessage evaluator doesn't match", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "dlp-blocker",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
        blockMessage: true,
      },
    ];

    const { shouldBlock } = await runRoutingPipeline("hello world", "agent-1", evaluators, logger);
    expect(shouldBlock).toBe(false);
  });

  it("any blocker triggers shouldBlock even if not the winner", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "router",
        type: "regex",
        priority: 50,
        enabled: true,
        patterns: [".*"],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        // no blockMessage — just routes
      },
      {
        name: "dlp",
        type: "regex",
        priority: 30,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
        blockMessage: true,
        blockReply: "PII detected — message not sent to LLM.",
      },
    ];

    // Router wins (priority 50) but DLP also matches and wants to block
    const { decision, shouldBlock, blockReply } = await runRoutingPipeline(
      "analyze SSN 123-45-6789",
      "agent-1",
      evaluators,
      logger,
    );
    expect(decision?.provider).toBe("anthropic"); // winner is router
    expect(shouldBlock).toBe(true); // but DLP still blocks
    expect(blockReply).toBe("PII detected — message not sent to LLM.");
  });
});

describe("per-evaluator webhooks", () => {
  it("evaluator result includes per-evaluator webhook URLs", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "pii",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "ollama",
        model: "llama3:8b",
        webhooks: ["https://dlp-alerts.internal/hook", "https://siem.internal/ingest"],
      },
      {
        name: "cost-router",
        type: "regex",
        priority: 50,
        enabled: true,
        patterns: [".*"],
        provider: "cheap",
        model: "tiny",
        webhooks: ["https://cost-tracking.internal/hook"],
      },
    ];

    const { event } = await runRoutingPipeline("SSN: 123-45-6789", "agent-1", evaluators, logger);

    const pii = event.evaluators.find((e) => e.name === "pii");
    expect(pii?.webhooks).toEqual(["https://dlp-alerts.internal/hook", "https://siem.internal/ingest"]);

    const cost = event.evaluators.find((e) => e.name === "cost-router");
    expect(cost?.webhooks).toEqual(["https://cost-tracking.internal/hook"]);
  });

  it("evaluator without webhooks has undefined webhooks field", async () => {
    const evaluators: EvaluatorConfig[] = [
      {
        name: "basic",
        type: "regex",
        priority: 10,
        enabled: true,
        patterns: [".*"],
        provider: "x",
        model: "y",
      },
    ];

    const { event } = await runRoutingPipeline("test", "agent-1", evaluators, logger);
    expect(event.evaluators[0]?.webhooks).toBeUndefined();
  });
});

describe("TRUE parallel execution proof", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("three slow classifiers complete in ~max(durations) not sum(durations)", async () => {
    // Each classifier takes 50ms. If sequential: 150ms. If parallel: ~50ms.
    const delays = [50, 50, 50];
    let callIndex = 0;

    fetchSpy.mockImplementation(() => {
      const delay = delays[callIndex++] ?? 50;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify({
            choices: [{ message: { content: "simple" } }],
          }), { status: 200 }));
        }, delay);
      });
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "classifier-a",
        type: "classifier",
        priority: 90,
        enabled: true,
        url: "http://a/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "a", model: "a" } },
      },
      {
        name: "classifier-b",
        type: "classifier",
        priority: 80,
        enabled: true,
        url: "http://b/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "b", model: "b" } },
      },
      {
        name: "classifier-c",
        type: "classifier",
        priority: 70,
        enabled: true,
        url: "http://c/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { simple: { provider: "c", model: "c" } },
      },
    ];

    const start = Date.now();
    const { event } = await runRoutingPipeline("test", "agent-1", evaluators, logger);
    const elapsed = Date.now() - start;

    // If truly parallel: ~50ms. If sequential: ~150ms.
    // Allow generous margin but must be well under sequential time.
    expect(elapsed).toBeLessThan(120); // parallel: ~50-80ms, sequential would be 150+
    expect(event.evaluators).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // All three should have individual durations ~50ms
    for (const ev of event.evaluators) {
      expect(ev.durationMs).toBeGreaterThanOrEqual(40);
      expect(ev.durationMs).toBeLessThan(100);
    }
  });

  it("fast regex doesn't wait for slow classifier", async () => {
    fetchSpy.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify({
            choices: [{ message: { content: "complex" } }],
          }), { status: 200 }));
        }, 100); // 100ms classifier
      });
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "instant-regex",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "local",
        model: "phi",
      },
      {
        name: "slow-classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://slow/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { complex: { provider: "anthropic", model: "claude" } },
      },
    ];

    const { event } = await runRoutingPipeline("SSN: 123-45-6789", "agent-1", evaluators, logger);

    const regex = event.evaluators.find((e) => e.name === "instant-regex");
    const classifier = event.evaluators.find((e) => e.name === "slow-classifier");

    // Regex is instant
    expect(regex?.durationMs).toBeLessThan(5);
    expect(regex?.matched).toBe(true);

    // Classifier was skipped via early exit (regex at priority 100 matched instantly)
    expect(classifier?.matched).toBe(false);
    expect(classifier?.error).toBe("skipped:early_exit");

    // Winner is regex (priority 100)
    expect(event.winner?.name).toBe("instant-regex");
  });

  it("early exit: highest-priority regex match skips slow lower-priority classifiers", async () => {
    let classifierCalled = false;

    fetchSpy.mockImplementation(() => {
      classifierCalled = true;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify({
            choices: [{ message: { content: "complex" } }],
          }), { status: 200 }));
        }, 500); // Very slow — 500ms
      });
    });

    const evaluators: EvaluatorConfig[] = [
      {
        name: "fast-pii-regex",
        type: "regex",
        priority: 100,
        enabled: true,
        patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
        provider: "local",
        model: "phi",
      },
      {
        name: "slow-classifier",
        type: "classifier",
        priority: 50,
        enabled: true,
        url: "http://slow/v1/chat/completions",
        classifierModel: "x",
        prompt: "{{message}}",
        routes: { complex: { provider: "anthropic", model: "claude" } },
      },
    ];

    const start = Date.now();
    const { decision, event } = await runRoutingPipeline(
      "SSN: 123-45-6789",
      "agent-1",
      evaluators,
      logger,
    );
    const elapsed = Date.now() - start;

    // Winner is the instant regex
    expect(decision?.provider).toBe("local");
    expect(event.winner?.name).toBe("fast-pii-regex");

    // Total pipeline time should be way under 500ms (the classifier's delay)
    // because early exit skipped it
    expect(elapsed).toBeLessThan(100);

    // Classifier should show as skipped in results
    const classifier = event.evaluators.find((e) => e.name === "slow-classifier");
    expect(classifier?.error).toBe("skipped:early_exit");
    expect(classifier?.matched).toBe(false);
  });
});
