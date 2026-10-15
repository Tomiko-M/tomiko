/**
 * Each test here failed before its fix: bugs found reviewing the core runtime for 0.3.0.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { cassette, costOf, fault, openCassette, priceFor, defaultPricing } from "../src/index.js";
import { extractUsage } from "../src/usage.js";
import { readContent } from "../src/inspect.js";
import "../src/vitest.js";
import { ANTHROPIC_URL, anthropicStream, fakeApi, json, offline, OPENAI_URL, openaiChat, sse, tmpDir } from "./helpers.js";

/** A real HTTP server streaming SSE events slowly, so real fetch and SDKs meet it as they would the API. */
let server: Server | undefined;
async function slowServer(events: { event?: string; data: unknown }[], every = 15): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      if (i === events.length) {
        res.end();
        return clearInterval(timer);
      }
      const e = events[i++]!;
      res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
    }, every);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => {
  server?.close();
  server = undefined;
});

const chatChunks = (words: string[]) => [
  ...words.map((w) => ({ data: { id: "c", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: w }, finish_reason: null }] } })),
  { data: "[DONE]" },
];

describe("recording a stream the caller leaves", () => {
  it("records the whole stream when an SDK breaks out of it early", async () => {
    const baseURL = `${await slowServer(chatChunks(["one ", "two ", "three ", "four"]))}/v1`;
    const dir = tmpDir();
    const run = (mode: "auto" | "replay") =>
      cassette("break", async () => {
        const client = new OpenAI({ apiKey: "k", baseURL, maxRetries: 0 });
        const stream = await client.chat.completions.create({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] });
        for await (const chunk of stream) if (chunk.choices[0]?.delta.content) break;
        return "ok";
      }, { dir, mode, fetch: mode === "replay" ? offline : undefined });
    await run("auto");
    server!.close();
    await expect(run("replay")).resolves.toBe("ok");
    const c = await openCassette("break", { dir, mode: "replay", fetch: offline });
    const text = await (await c.fetch(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }) })).text();
    expect(text).toContain("four");
  });

  it("saves the complete answer when a cut stream makes the SDK abort while recording", async () => {
    const baseURL = await slowServer(anthropicStream(["Hel", "lo", " there", " friend"]));
    const dir = tmpDir();
    const error = await cassette(
      "cut",
      () => new Anthropic({ apiKey: "k", baseURL, maxRetries: 0 }).messages.stream({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).finalMessage(),
      { dir, faults: [fault.cutStream()] },
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(existsSync(join(dir, "cut.json"))).toBe(true);
    const replayed = await cassette(
      "cut",
      () => new Anthropic({ apiKey: "k", baseURL, maxRetries: 0 }).messages.stream({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }).finalMessage(),
      { dir, mode: "replay", fetch: offline },
    );
    expect(replayed.content).toEqual([expect.objectContaining({ text: "Hello there friend" })]);
  });

  it("gives a caller still reading every chunk when the cassette closes", async () => {
    const encoder = new TextEncoder();
    const slow = () => {
      let i = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (i === 5) return c.close();
            await new Promise((r) => setTimeout(r, 15));
            c.enqueue(encoder.encode(`data: {"n":${i++}}\n\n`));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const dir = tmpDir();
    const c = await openCassette("race", { dir, fetch: fakeApi(slow), mode: "record" });
    const reading = (await c.fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", body: "{}" })).text();
    await new Promise((r) => setTimeout(r, 20));
    const [text] = await Promise.all([reading, c.close()]);
    expect(text).toBe([0, 1, 2, 3, 4].map((n) => `data: {"n":${n}}\n\n`).join(""));
  });
});

describe("abort signals on replay", () => {
  it("rejects an aborted request and fails the body when aborted mid-stream, as fetch does", async () => {
    const dir = tmpDir();
    const body = JSON.stringify({ model: "claude-opus-5-5", stream: true });
    await cassette("abort", () => globalThis.fetch(ANTHROPIC_URL, { method: "POST", body }).then((r) => r.text()), { dir, fetch: fakeApi(() => sse(anthropicStream(["Hel", "lo", " there"]))) });
    const c = await openCassette("abort", { dir, mode: "replay", fetch: offline });
    await expect(c.fetch(ANTHROPIC_URL, { method: "POST", body, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });

    const controller = new AbortController();
    const reader = (await c.fetch(ANTHROPIC_URL, { method: "POST", body, signal: controller.signal })).body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("what a cassette keeps and in which order", () => {
  it("lists concurrent requests in the order they were sent, recording or replaying", async () => {
    const dir = tmpDir();
    const api = fakeApi(async (body) => {
      if (body.messages[0].content === "slow") await new Promise((r) => setTimeout(r, 40));
      return json(openaiChat({ tools: [{ name: body.messages[0].content === "slow" ? "search" : "answer", input: {} }] }));
    });
    const run = async (c: { calls: { toolCalls: { name: string }[] }[] }) => {
      const ask = (content: string) => globalThis.fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content }] }) }).then((r) => r.json());
      await Promise.all([ask("slow"), ask("fast")]);
      return c.calls.map((x) => x.toolCalls[0]!.name);
    };
    expect(await cassette("order", run, { dir, fetch: api })).toEqual(["search", "answer"]);
    expect(await cassette("order", run, { dir, mode: "replay", fetch: offline })).toEqual(["search", "answer"]);
  });

  it("doesn't save an authentication error, which would replay after the key is fixed", async () => {
    const dir = tmpDir();
    const ask = () => globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" }).then((r) => r.status);
    expect(await cassette("auth", ask, { dir, fetch: fakeApi(() => json({ type: "error", error: { type: "authentication_error" } }, 401)) })).toBe(401);
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
    expect(await cassette("auth", ask, { dir, fetch: fakeApi(() => json({ type: "message", content: [] })) })).toBe(200);
  });

  it("refuses two names that would share one file", async () => {
    const dir = tmpDir();
    const ask = () => globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" }).then((r) => r.status);
    const api = fakeApi(() => json({ type: "message", content: [] }));
    await cassette("answers What is 2+2?", ask, { dir, fetch: api });
    await expect(cassette("answers What is 2*2?", ask, { dir, fetch: api })).rejects.toThrow(
      'Cassettes "answers What is 2+2?" and "answers What is 2*2?" would share the file',
    );
    // The same name again is fine.
    await cassette("answers What is 2+2?", ask, { dir, fetch: api });
  });

  it("closes once when close() is called twice at the same time", async () => {
    const dir = tmpDir();
    const c = await openCassette("twice", { dir, fetch: fakeApi(() => json({ type: "message", content: [] })) });
    await c.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" });
    const [a, b] = await Promise.allSettled([c.close(), c.close()]);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
  });
});

describe("faults, models and money", () => {
  it("keeps fault defaults when an option is passed as undefined, and checks numbers", () => {
    expect(fault.cutStream({ afterEvents: undefined })).toMatchObject({ afterEvents: 3 });
    expect(fault.rateLimit({ retryAfterMs: undefined })).toMatchObject({ retryAfterMs: 1 });
    expect(fault.maxTokens({ keep: undefined })).toMatchObject({ keep: 0.5 });
    expect(() => fault.cutStream({ afterEvents: 2.5 })).toThrow("`afterEvents` must be a whole number, 0 or more, got 2.5.");
    expect(() => fault.maxTokens({ keep: 2 })).toThrow("`keep` must be a share between 0 and 1, got 2.");
  });

  it("counts the model a request asked for, though it answers under a snapshot name", async () => {
    await cassette("alias", async (c) => {
      await globalThis.fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-4o", messages: [] }) });
      expect(c).toHaveUsedModel("gpt-4o");
      expect(c).toHaveUsedModel("gpt-4o-2024-08-06");
    }, { dir: tmpDir(), fetch: fakeApi(() => json(openaiChat({ text: "hi", model: "gpt-4o-2024-08-06" }))) });
  });

  it("prices one-hour cache writes at twice the input price", () => {
    const { usage } = extractUsage({
      type: "json",
      value: { type: "message", model: "claude-sonnet-4-6", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } } },
    });
    expect(costOf(usage!, priceFor("claude-sonnet-4-6", defaultPricing)!)).toBeCloseTo(6, 10);
  });

  it("reads only the first choice of a stream that asked for several", () => {
    const chunk = (index: number, args: string) => ({ data: { choices: [{ index, delta: { tool_calls: [{ index: 0, id: `c${index}`, type: "function", function: { name: "search", arguments: args } }] } }] } });
    const events = [chunk(0, '{"q":"x"}'), chunk(1, '{"q":"y"}')];
    const body = { type: "sse" as const, chunks: events.map((e) => `data: ${JSON.stringify(e.data)}\n\n`) };
    expect(readContent(body).toolCalls).toEqual([{ name: "search", input: { q: "x" }, id: "c0" }]);
  });
});
