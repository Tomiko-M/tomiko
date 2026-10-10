import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cassette, fault, type Fault } from "../src/index.js";
import { useCassette } from "../src/vitest.js";
import { ANTHROPIC_URL, anthropicMessage, anthropicStream, fakeApi, json, offline, sse, tmpDir } from "./helpers.js";

const params = { model: "claude-opus-5-5", max_tokens: 1024, messages: [{ role: "user" as const, content: "hi" }] };

/** A cassette with one plain and one streamed recording, replayed under the given faults. */
async function recorded() {
  const dir = tmpDir();
  const api = fakeApi((body) => (body.stream ? sse(anthropicStream(["Hel", "lo"])) : json(anthropicMessage("Hello"))));
  await cassette(
    "base",
    async () => {
      const client = new Anthropic({ apiKey: "k", maxRetries: 0 });
      await client.messages.create(params);
      await client.messages.stream(params).finalMessage();
    },
    { dir, fetch: api },
  );
  const replay = <T>(faults: Fault[], fn: (client: Anthropic) => Promise<T>, maxRetries = 2) =>
    cassette("base", () => fn(new Anthropic({ apiKey: "k", maxRetries })), { dir, mode: "replay", fetch: offline, faults });
  return { dir, api, replay };
}

describe("HTTP error faults", () => {
  it("lets the SDK retry a rate limit instantly and then succeed", async () => {
    const { replay } = await recorded();
    const started = Date.now();
    const message = await replay([fault.rateLimit({ times: 2 })], (client) => client.messages.create(params));
    expect(message.content[0]).toMatchObject({ text: "Hello" });
    expect(Date.now() - started).toBeLessThan(400); // retry-after-ms: 1, not the default backoff
  });

  it("surfaces persistent failures as the SDK's typed errors", async () => {
    const { replay } = await recorded();
    const overloaded = replay([fault.overloaded({ times: Infinity })], (c) => c.messages.create(params), 1);
    await expect(overloaded).rejects.toBeInstanceOf(Anthropic.InternalServerError);
    await expect(overloaded).rejects.toMatchObject({ status: 529, error: { error: { type: "overloaded_error" } } });

    const limited = replay([fault.rateLimit({ times: Infinity })], (c) => c.messages.create(params), 0);
    await expect(limited).rejects.toBeInstanceOf(Anthropic.RateLimitError);

    const broken = replay([fault.serverError()], (c) => c.messages.create(params), 0);
    await expect(broken).rejects.toMatchObject({ status: 500 });
  });

  it("uses OpenAI's error format for OpenAI endpoints", async () => {
    const res = await cassette("openai", () => globalThis.fetch("https://api.openai.com/v1/chat/completions", { method: "POST" }), {
      dir: tmpDir(),
      faults: [fault.rateLimit()],
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limit_exceeded" } });
  });

  it("records what happened, for assertions", async () => {
    await useCassette(
      async (c) => {
        await new Anthropic({ apiKey: "k", maxRetries: 2 }).messages.create(params);
        expect(c.calls.map((call) => [call.status, call.fault])).toEqual([
          [429, "rate_limit"],
          [529, "overloaded"],
          [200, undefined],
        ]);
        expect(c).toHaveMadeRequests(3);
      },
      {
        dir: tmpDir(),
        fetch: fakeApi(() => json(anthropicMessage("ok"))),
        faults: [fault.rateLimit({ on: 1 }), fault.overloaded({ on: 2 })],
      },
    );
  });
});

describe("network faults", () => {
  it("rejects fetch like a reset connection", async () => {
    const error = await cassette("net", () => globalThis.fetch(ANTHROPIC_URL, { method: "POST" }), {
      dir: tmpDir(),
      faults: [fault.networkError()],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("fetch failed");
    expect(error.cause).toMatchObject({ code: "ECONNRESET" });
  });

  it("is retried by the SDK as a connection error", async () => {
    const { replay } = await recorded();
    await expect(replay([fault.networkError({ times: Infinity })], (c) => c.messages.create(params), 0)).rejects.toBeInstanceOf(
      Anthropic.APIConnectionError,
    );
    // One retry after the SDK's default backoff (~0.5s), which then succeeds.
    const message = await replay([fault.networkError()], (c) => c.messages.create(params), 1);
    expect(message.content[0]).toMatchObject({ text: "Hello" });
  });
});

describe("cut streams", () => {
  it("drops a replayed stream after the given number of events", async () => {
    const { replay } = await recorded();
    const events: string[] = [];
    const run = replay([fault.cutStream({ when: (r) => (r.body as any)?.stream === true, afterEvents: 4 })], async (client) => {
      for await (const event of client.messages.stream(params)) events.push(event.type);
    });
    await expect(run).rejects.toThrow();
    expect(events).toEqual(["message_start", "content_block_start", "content_block_delta"]);
  });

  it("cuts plain responses halfway", async () => {
    const { replay } = await recorded();
    // The SDK passes body read errors through as is, as with a real dropped connection.
    await expect(replay([fault.cutStream({ on: 1 })], (c) => c.messages.create(params), 0)).rejects.toThrow("terminated");
  });

  it("still saves the complete stream when the cut happens while recording", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["Hello", ", world"])));
    const stream = (client: Anthropic) => client.messages.stream(params).finalMessage();

    await expect(
      cassette("cut-record", () => stream(new Anthropic({ apiKey: "k", maxRetries: 0 })), {
        dir,
        fetch: api,
        faults: [fault.cutStream({ afterEvents: 2 })],
      }),
    ).rejects.toThrow();

    const saved = JSON.parse(readFileSync(join(dir, "cut-record.json"), "utf8"));
    expect(saved.interactions[0].response.body.chunks.join("")).toContain("message_stop");
    const message = await cassette("cut-record", () => stream(new Anthropic({ apiKey: "k", maxRetries: 0 })), {
      dir,
      mode: "replay",
      fetch: offline,
    });
    expect(message.content[0]).toMatchObject({ text: "Hello, world" });
  });
});

describe("latency", () => {
  it("delays responses and lets client timeouts fire", async () => {
    const { replay } = await recorded();
    const started = Date.now();
    await replay([fault.latency({ ms: 60 })], (c) => c.messages.create(params));
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);

    const timedOut = Date.now();
    const run = cassette("base", () => new Anthropic({ apiKey: "k", maxRetries: 0, timeout: 30 }).messages.create(params), {
      dir: (await recorded()).dir,
      mode: "replay",
      fetch: offline,
      faults: [fault.latency({ ms: 5_000 })],
    });
    await expect(run).rejects.toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(Date.now() - timedOut).toBeLessThan(1_000);
  });
});

describe("targeting", () => {
  const hit = async (faults: Fault[], requests: unknown[]) => {
    const statuses: number[] = [];
    await cassette(
      "t",
      async () => {
        for (const body of requests) {
          statuses.push((await globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify(body) })).status);
        }
      },
      { dir: tmpDir(), fetch: fakeApi(() => json({})), faults },
    );
    return statuses;
  };

  it("hits the first request by default", async () => {
    expect(await hit([fault.serverError()], [1, 2, 3])).toEqual([500, 200, 200]);
  });

  it("hits specific request numbers with `on`", async () => {
    expect(await hit([fault.serverError({ on: [2, 4] })], [1, 2, 3, 4])).toEqual([200, 500, 200, 500]);
  });

  it("hits the first `times` matching requests with `when`", async () => {
    const big = (r: { body?: unknown }) => (r.body as { model: string }).model === "big";
    const statuses = await hit([fault.rateLimit({ when: big, times: 2 })], [
      { model: "small" },
      { model: "big" },
      { model: "big" },
      { model: "big" },
    ]);
    expect(statuses).toEqual([200, 429, 429, 200]);
  });

  it("never sends or records faulted requests", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json({ ok: true }));
    await cassette("quiet", () => globalThis.fetch(ANTHROPIC_URL, { method: "POST" }), {
      dir,
      fetch: api,
      faults: [fault.overloaded()],
    });
    expect(api.calls).toHaveLength(0);
  });
});
