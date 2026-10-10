import { describe, expect, it } from "vitest";
import { cassette, costOf, formatSummary, priceFor, defaultPricing, reports, summary } from "../src/index.js";
import { extractUsage } from "../src/usage.js";
import { ANTHROPIC_URL, anthropicMessage, anthropicStream, fakeApi, json, sse, tmpDir } from "./helpers.js";

const chunksOf = (events: { event?: string; data: unknown }[]) =>
  events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`);

describe("usage extraction", () => {
  it("reads Anthropic JSON responses", () => {
    expect(extractUsage({ type: "json", value: anthropicMessage("x") })).toEqual({
      model: "claude-opus-5-5",
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("combines message_start and message_delta in Anthropic streams", () => {
    const chunks = chunksOf(anthropicStream(["a", "b"]));
    expect(extractUsage({ type: "sse", chunks })).toEqual({
      model: "claude-opus-5-5",
      usage: { inputTokens: 120, outputTokens: 42, cacheReadTokens: 2000, cacheWriteTokens: 0 },
    });
  });

  it("reads OpenAI chat completions, excluding cached tokens from input", () => {
    const value = {
      model: "gpt-x",
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } },
    };
    expect(extractUsage({ type: "json", value }).usage).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  it("reads OpenAI Responses API streams", () => {
    const chunks = chunksOf([
      { data: { type: "response.created", response: { model: "gpt-x", usage: null } } },
      { data: { type: "response.output_text.delta", delta: "hi" } },
      {
        data: {
          type: "response.completed",
          response: { model: "gpt-x", usage: { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } } },
        },
      },
    ]);
    expect(extractUsage({ type: "sse", chunks })).toEqual({
      model: "gpt-x",
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
  });

  it("returns nothing for responses without usage", () => {
    expect(extractUsage({ type: "json", value: { hello: "world" } })).toEqual({});
    expect(extractUsage({ type: "sse", chunks: ["data: [DONE]\n\n"] })).toEqual({});
  });
});

describe("pricing", () => {
  it("prefers exact ids and falls back to the longest prefix", () => {
    expect(priceFor("claude-opus-5-5", defaultPricing)).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(priceFor("claude-opus-5-20260101", defaultPricing)).toEqual({ input: 5, output: 25 });
    expect(priceFor("anthropic.claude-sonnet-5-5", defaultPricing)?.input).toBe(2);
    expect(priceFor("claude-haiku-4-5@20251001", defaultPricing)?.input).toBe(1);
    expect(priceFor("gpt-x", defaultPricing)).toBeUndefined();
  });

  it("prices cache reads and writes with sensible defaults", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(costOf(usage, { input: 10, output: 50 })).toBeCloseTo(10 + 50 + 1 + 12.5);
    expect(costOf(usage, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 })).toBeCloseTo(10 + 50 + 0.25 + 20);
  });
});

describe("reports", () => {
  it("reports cost and how much replay saved", async () => {
    const dir = tmpDir();
    const send = () =>
      globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", n: 1 }) });
    const api = fakeApi(() => json(anthropicMessage("x")));
    await cassette("cost", send, { dir, fetch: api });
    await cassette("cost", send, { dir, fetch: api });

    // 1000 in × $4/M + 200 out × $20/M = $0.008 per call
    expect(reports()[0]).toMatchObject({ recorded: 1, cost: expect.closeTo(0.008), savedCost: null });
    expect(reports()[1]).toMatchObject({ replayed: 1, cost: expect.closeTo(0.008), savedCost: expect.closeTo(0.008) });

    const s = summary();
    expect(s).toMatchObject({ cassettes: 2, replayed: 1, recorded: 1, cost: expect.closeTo(0.016) });
    expect(formatSummary(s)).toContain("$0.0080 saved by replay");
  });

  it("lists models without a price and honors custom pricing", async () => {
    const dir = tmpDir();
    const send = () => globalThis.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
    const api = fakeApi(() => json({ model: "gpt-x", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));

    await cassette("unpriced", send, { dir, fetch: api });
    expect(reports()[0]).toMatchObject({ cost: null, unpricedModels: ["gpt-x"] });

    await cassette("priced", send, { dir, fetch: api, pricing: { "gpt-x": { input: 2, output: 8 } } });
    expect(reports()[1]).toMatchObject({ cost: expect.closeTo(2), unpricedModels: [] });
  });

  it("counts streamed usage once the stream finishes", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["hi"])));
    await cassette("stream-cost", async () => {
      const res = await globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" });
      await res.text();
    }, { dir, fetch: api });
    expect(reports()[0]!.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheReadTokens: 2000, cacheWriteTokens: 0 });
  });
});
