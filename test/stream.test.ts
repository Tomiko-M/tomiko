import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cassette, fetch as tomikoFetch, openCassette, reports } from "../src/index.js";
import { ANTHROPIC_URL, anthropicMessage, anthropicStream, fakeApi, json, offline, sse, tmpDir } from "./helpers.js";

// Created once, before any cassette is open: the SDK captures `fetch` at construction,
// which is exactly why tomiko exports a stable dispatcher.
const client = new Anthropic({ apiKey: "sk-ant-test", fetch: tomikoFetch, maxRetries: 0 });

const params = {
  model: "claude-opus-5-5",
  max_tokens: 64000,
  messages: [{ role: "user" as const, content: "Say hello" }],
};

describe("streaming", () => {
  it("replays SSE chunk for chunk, exactly as recorded", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["Hel", "lo", " there"])));
    const send = () =>
      globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ ...params, stream: true }) });

    const live = await cassette("sse", async () => (await send()).text(), { dir, fetch: api });
    const replayed = await cassette(
      "sse",
      async () => {
        const res = await send();
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        return res.text();
      },
      { dir, mode: "replay", fetch: offline },
    );
    expect(replayed).toBe(live);

    const saved = JSON.parse(readFileSync(join(dir, "sse.json"), "utf8"));
    expect(saved.interactions[0].response.body.type).toBe("sse");
    expect(saved.interactions[0].response.body.chunks.length).toBeGreaterThan(1);
  });

  it("saves a stream the test never read", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["unread"])));
    await cassette("unread", async () => {
      await globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" });
    }, { dir, fetch: api });
    const saved = JSON.parse(readFileSync(join(dir, "unread.json"), "utf8"));
    expect(saved.interactions[0].response.body.chunks.join("")).toContain("unread");
  });

  it("does not save a stream that broke mid-recording", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => {
      const broken = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: message_start\n"));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(broken, { headers: { "content-type": "text/event-stream" } });
    });
    await cassette("broken", async () => {
      const res = await globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "{}" });
      await res.text().catch(() => {});
    }, { dir, fetch: api });
    expect(reports()[0]).toMatchObject({ recorded: 0, saved: false });
    expect(reports()[0]!.warnings[0]).toContain("connection reset");
  });
});

describe("with @anthropic-ai/sdk", () => {
  it("records and replays a streamed message", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["Hello", ", world"])));
    const run = () =>
      cassette("sdk-stream", async () => {
        const message = await client.messages.stream(params).finalMessage();
        return { text: message.content.map((b) => (b.type === "text" ? b.text : "")).join(""), usage: message.usage };
      }, { dir, fetch: api });

    const recorded = await run();
    expect(recorded.text).toBe("Hello, world");

    process.env.TOMIKO_MODE = "replay";
    const replayed = await cassette("sdk-stream", async () => {
      const message = await client.messages.stream(params).finalMessage();
      return { text: message.content.map((b) => (b.type === "text" ? b.text : "")).join(""), usage: message.usage };
    }, { dir, fetch: offline });

    expect(replayed).toEqual(recorded);
    expect(api.calls).toHaveLength(1);
  });

  it("records and replays a plain message through an explicitly opened cassette", async () => {
    const dir = tmpDir();
    const recorder = await openCassette("sdk-plain", { dir, fetch: fakeApi(() => json(anthropicMessage("Hi!"))) });
    const sdk = new Anthropic({ apiKey: "sk-ant-test", fetch: recorder.fetch, maxRetries: 0 });
    const first = await sdk.messages.create({ ...params, max_tokens: 1024 });
    await recorder.close();

    const player = await openCassette("sdk-plain", { dir, mode: "replay", fetch: offline });
    const replaySdk = new Anthropic({ apiKey: "sk-ant-test", fetch: player.fetch, maxRetries: 0 });
    const second = await replaySdk.messages.create({ ...params, max_tokens: 1024 });
    const report = await player.close();

    expect(second).toEqual(first);
    expect(report).toMatchObject({ replayed: 1, recorded: 0 });
  });

  it("surfaces replayed API errors as typed SDK errors", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429));
    const call = () => cassette("sdk-429", () => client.messages.create({ ...params, max_tokens: 1024 }), { dir, fetch: api });
    await expect(call()).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    process.env.TOMIKO_MODE = "replay";
    await expect(call()).rejects.toBeInstanceOf(Anthropic.RateLimitError);
  });

  it("goes to the real fetch when no cassette is active", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return json(anthropicMessage("live"));
    }) as typeof fetch;
    try {
      const message = await client.messages.create({ ...params, max_tokens: 1024 });
      expect(message.content[0]).toMatchObject({ text: "live" });
      expect(called).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
