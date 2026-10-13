/**
 * Real SDKs against tomiko: each scenario records against a fake API, then replays offline and
 * must produce the same result, with matchers and faults working on both runs.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { ApiError, GoogleGenAI } from "@google/genai";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool as langchainTool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { generateText, stepCountIs, streamText, tool } from "ai";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Cassette, cassette, fault, fetch as tomikoFetch } from "../src/index.js";
import "../src/vitest.js"; // registers the matchers
import {
  anthropicMessage,
  anthropicStream,
  type FakeApi,
  fakeApi,
  geminiResponse,
  geminiStream,
  json,
  offline,
  openaiChat,
  openaiChatStream,
  openaiResponse,
  openaiResponseStream,
  sse,
  tmpDir,
} from "./helpers.js";

/** Runs `run` against the fake API (recording), then offline (replaying); returns both results. */
async function recordThenReplay<T>(api: FakeApi, run: (c: Cassette) => Promise<T>) {
  const dir = tmpDir();
  const live = await cassette("compat", run, { dir, fetch: api });
  const sent = api.calls.length;
  const replayed = await cassette("compat", run, { dir, mode: "replay", fetch: offline });
  expect(api.calls).toHaveLength(sent);
  return { live, replayed };
}

const weatherTool = {
  type: "function" as const,
  function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
};

describe("openai SDK", () => {
  it("chat completions with tool calls", async () => {
    const api = fakeApi(() => json(openaiChat({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] })));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const client = new OpenAI({ apiKey: "k", maxRetries: 0 });
      const res = await client.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "Weather in Lisbon?" }],
        tools: [weatherTool],
      });
      expect(c).toHaveCalledTool("get_weather", { city: "Lisbon" });
      expect(c.calls[0]!.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 });
      return res.choices[0]!.message.tool_calls;
    });
    expect(replayed).toEqual(live);
  });

  it("streamed chat completions, with tool arguments in fragments", async () => {
    const api = fakeApi(() => sse(openaiChatStream({ parts: ["Let me ", "check."], tool: { name: "get_weather", input: { city: "Porto" } } }), 23));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const client = new OpenAI({ apiKey: "k", maxRetries: 0 });
      const stream = await client.chat.completions.create({
        model: "gpt-test",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [weatherTool],
        stream: true,
        stream_options: { include_usage: true },
      });
      let text = "";
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
      expect(c).toHaveCalledTool("get_weather", { city: "Porto" });
      expect(c.calls[0]!.usage).toMatchObject({ inputTokens: 80, outputTokens: 12 });
      return text;
    });
    expect(live).toBe("Let me check.");
    expect(replayed).toBe(live);
  });

  it("the Responses API, plain and streamed", async () => {
    const api = fakeApi((body) => (body.stream ? sse(openaiResponseStream(["Bom ", "dia!"])) : json(openaiResponse({ text: "Olá!" }))));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const client = new OpenAI({ apiKey: "k", maxRetries: 0 });
      const plain = await client.responses.create({ model: "gpt-test", input: "Say hi in Portuguese" });
      let streamed = "";
      const stream = await client.responses.create({ model: "gpt-test", input: "Say good morning", stream: true });
      for await (const event of stream) if (event.type === "response.output_text.delta") streamed += event.delta;
      expect(c.calls.map((call) => call.text)).toEqual(["Olá!", "Bom dia!"]);
      return [plain.output_text, streamed];
    });
    expect(live).toEqual(["Olá!", "Bom dia!"]);
    expect(replayed).toEqual(live);
  });

  it("maps simulated failures to the SDK's errors and retries them instantly", async () => {
    const dir = tmpDir();
    const ask = (client: OpenAI) => client.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    await cassette("faults", () => ask(new OpenAI({ apiKey: "k", maxRetries: 0 })), { dir, fetch: fakeApi(() => json(openaiChat({ text: "hi" }))) });

    const replay = (maxRetries: number) =>
      cassette("faults", () => ask(new OpenAI({ apiKey: "k", maxRetries })), {
        dir,
        mode: "replay",
        fetch: offline,
        faults: [fault.rateLimit({ times: 2 })],
      });
    await expect(replay(0)).rejects.toBeInstanceOf(OpenAI.RateLimitError);
    const started = Date.now();
    expect((await replay(2)).choices[0]!.message.content).toBe("hi");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("works with a client created once, given tomiko's fetch", async () => {
    const client = new OpenAI({ apiKey: "k", maxRetries: 0, fetch: tomikoFetch });
    const api = fakeApi(() => json(openaiChat({ text: "shared client" })));
    const { replayed } = await recordThenReplay(api, async () => {
      const res = await client.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      return res.choices[0]!.message.content;
    });
    expect(replayed).toBe("shared client");
  });
});

// Created once at module load with no fetch option: the AI SDK looks up globalThis.fetch on every
// request, so the cassette's patch reaches it anyway.
const vercelAnthropic = createAnthropic({ apiKey: "k" });
const vercelOpenAI = createOpenAI({ apiKey: "k" });
const vercelGoogle = createGoogleGenerativeAI({ apiKey: "k" });

describe("Vercel AI SDK", () => {
  it("generateText runs a multi-step tool loop (Anthropic provider)", async () => {
    const api = fakeApi((body) => {
      const hasResult = JSON.stringify(body.messages).includes("tool_result");
      if (!hasResult) {
        return json({
          ...anthropicMessage(""),
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Lisbon" } }],
          stop_reason: "tool_use",
        });
      }
      return json(anthropicMessage("It is sunny in Lisbon."));
    });
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const result = await generateText({
        model: vercelAnthropic("claude-opus-5-5"),
        prompt: "Weather in Lisbon?",
        tools: {
          get_weather: tool({
            description: "Current weather for a city",
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => `Sunny in ${city}`,
          }),
        },
        stopWhen: stepCountIs(3),
      });
      expect(c).toHaveCalledTool("get_weather", { city: "Lisbon" });
      expect(c).toHaveMadeRequests(2);
      expect(c).toCostLessThan(0.1);
      return result.text;
    });
    expect(live).toBe("It is sunny in Lisbon.");
    expect(replayed).toBe(live);
  });

  it("streamText (Anthropic provider)", async () => {
    const api = fakeApi(() => sse(anthropicStream(["Hello", " from", " Claude"]), 11));
    const { live, replayed } = await recordThenReplay(api, async () => {
      const result = streamText({ model: vercelAnthropic("claude-opus-5-5"), prompt: "Hi" });
      return await result.text;
    });
    expect(live).toBe("Hello from Claude");
    expect(replayed).toBe(live);
  });

  it("streamText (OpenAI Responses provider)", async () => {
    const api = fakeApi(() => sse(openaiResponseStream(["Streaming ", "works"]), 29));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const result = streamText({ model: vercelOpenAI("gpt-test"), prompt: "Hi" });
      const text = await result.text;
      expect(c.calls[0]!.text).toBe("Streaming works");
      return text;
    });
    expect(live).toBe("Streaming works");
    expect(replayed).toBe(live);
  });

  it("generateText runs a tool loop (Google provider)", async () => {
    const api = fakeApi((body) => {
      const answered = JSON.stringify(body.contents).includes("functionResponse");
      return json(answered ? geminiResponse({ text: "Sunny in Lisbon." }) : geminiResponse({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] }));
    });
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const result = await generateText({
        model: vercelGoogle("gemini-2.5-flash"),
        prompt: "Weather in Lisbon?",
        tools: { get_weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `Sunny in ${city}` }) },
        stopWhen: stepCountIs(3),
      });
      expect(c).toHaveCalledToolsInOrder(["get_weather"]);
      expect(c).toHaveMadeRequests(2);
      return result.text;
    });
    expect(live).toBe("Sunny in Lisbon.");
    expect(replayed).toBe(live);
  });

  it("generateText (OpenAI chat provider)", async () => {
    const api = fakeApi(() => json(openaiChat({ text: "chat model" })));
    const { replayed } = await recordThenReplay(api, async () => {
      const result = await generateText({ model: vercelOpenAI.chat("gpt-test"), prompt: "Hi" });
      return result.text;
    });
    expect(replayed).toBe("chat model");
  });
});

describe("Google Gen AI SDK", () => {
  const weather = { name: "get_weather", parameters: { type: "OBJECT" as never, properties: { city: { type: "STRING" as never } } } };

  it("generateContent with a function call, priced as Gemini", async () => {
    const api = fakeApi(() => json(geminiResponse({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] })));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const ai = new GoogleGenAI({ apiKey: "k" });
      const res = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Weather in Lisbon?",
        config: { tools: [{ functionDeclarations: [weather] }] },
      });
      expect(c).toHaveCalledTool("get_weather", { city: "Lisbon" });
      expect(c).toHaveUsedModel("gemini-2.5-flash");
      const call = c.calls[0]!;
      // Thinking tokens are output; cached tokens come out of the prompt count.
      expect(call.usage).toEqual({ inputTokens: 60, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0 });
      expect(call.cost).toBeCloseTo((60 * 0.3 + 50 * 2.5 + 40 * 0.03) / 1e6, 12);
      return res.functionCalls;
    });
    expect(api.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(replayed).toEqual(live);
  });

  it("generateContentStream", async () => {
    const api = fakeApi(() => sse(geminiStream(["Olá", " do", " Gemini"]), 17));
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const ai = new GoogleGenAI({ apiKey: "k" });
      const chunks: string[] = [];
      for await (const chunk of await ai.models.generateContentStream({ model: "gemini-2.5-flash", contents: "Oi" })) chunks.push(chunk.text ?? "");
      expect(c.calls[0]!.text).toBe("Olá do Gemini");
      expect(c.calls[0]!.usage?.outputTokens).toBe(6);
      return chunks.join("");
    });
    expect(live).toBe("Olá do Gemini");
    expect(replayed).toBe(live);
  });

  it("simulated rate limits arrive as the SDK's API errors", async () => {
    const dir = tmpDir();
    const ask = () => new GoogleGenAI({ apiKey: "k" }).models.generateContent({ model: "gemini-2.5-flash", contents: "hi" });
    await cassette("faults", ask, { dir, fetch: fakeApi(() => json(geminiResponse({ text: "hi" }))) });
    const error = await cassette("faults", ask, { dir, mode: "replay", fetch: offline, faults: [fault.rateLimit()] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
  });
});

describe("LangChain.js", () => {
  it("ChatAnthropic with bound tools", async () => {
    const api = fakeApi(() =>
      json({
        ...anthropicMessage(""),
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Faro" } }],
        stop_reason: "tool_use",
      }),
    );
    const getWeather = langchainTool(async ({ city }: { city: string }) => `Sunny in ${city}`, {
      name: "get_weather",
      description: "Current weather for a city",
      schema: z.object({ city: z.string() }),
    });
    const { live, replayed } = await recordThenReplay(api, async (c) => {
      const model = new ChatAnthropic({ apiKey: "k", model: "claude-opus-5-5", maxRetries: 0, clientOptions: { fetch: tomikoFetch } });
      const message = await model.bindTools([getWeather]).invoke("Weather in Faro?");
      expect(c).toHaveCalledTool("get_weather", { city: "Faro" });
      return message.tool_calls?.map((t) => ({ name: t.name, args: t.args }));
    });
    expect(live).toEqual([{ name: "get_weather", args: { city: "Faro" } }]);
    expect(replayed).toEqual(live);
  });

  it("a model created once without options keeps working across cassettes", async () => {
    // LangChain builds its SDK client lazily on the first call and caches it, capturing whatever
    // global fetch it saw then. tomiko's global fetch routes to the cassette active at call time.
    const model = new ChatOpenAI({ apiKey: "k", model: "gpt-test", maxRetries: 0 });
    const dir = tmpDir();
    const api = fakeApi((body) => json(openaiChat({ text: `re: ${body.messages[0].content}` })));
    const ask = (name: string, prompt: string, mode?: "replay") =>
      cassette(name, async () => (await model.invoke(prompt)).content, { dir, mode, fetch: mode ? offline : api });
    expect(await ask("first", "one")).toBe("re: one");
    expect(await ask("second", "two")).toBe("re: two");
    expect(await ask("first", "one", "replay")).toBe("re: one");
    expect(api.calls).toHaveLength(2);
  });

  it("ChatOpenAI", async () => {
    const api = fakeApi(() => json(openaiChat({ text: "from LangChain" })));
    const { replayed } = await recordThenReplay(api, async () => {
      const model = new ChatOpenAI({ apiKey: "k", model: "gpt-test", maxRetries: 0, configuration: { fetch: tomikoFetch } });
      return (await model.invoke("Hi")).content;
    });
    expect(replayed).toBe("from LangChain");
  });
});
