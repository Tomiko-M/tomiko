/**
 * The model misbehaving: each fault, against each provider's real SDK, streamed and not. The SDK
 * must take the rewritten answer as a real one, and the cassette must keep the real answer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { GoogleGenAI } from "@google/genai";
import { generateText, stepCountIs, tool } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Cassette, cassette, type Fault, fault } from "../src/index.js";
import "../src/vitest.js";
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

/** Records against `api`, then replays with `faults`; returns what the replay produced. */
async function withFaults<T>(api: FakeApi, faults: Fault[], run: (c: Cassette) => Promise<T>): Promise<T> {
  const dir = tmpDir();
  await cassette("m", run, { dir, fetch: api });
  return cassette("m", run, { dir, mode: "replay", fetch: offline, faults });
}

const weather = { name: "get_weather", description: "Weather", input_schema: { type: "object" as const, properties: { city: { type: "string" } }, required: ["city"] } };
const toolUse = () =>
  json({ ...anthropicMessage(""), content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Lisbon" } }], stop_reason: "tool_use" });

describe("Anthropic", () => {
  const ask = (c: Anthropic) => c.messages.create({ model: "claude-opus-5-5", max_tokens: 100, tools: [weather], messages: [{ role: "user", content: "Weather?" }] });
  const client = () => new Anthropic({ apiKey: "k", maxRetries: 0 });

  it("calls a tool that doesn't exist", async () => {
    const res = await withFaults(fakeApi(toolUse), [fault.hallucinatedTool()], () => ask(client()));
    expect(res.content).toEqual([{ type: "tool_use", id: "toolu_tomiko_1", name: "get_weather_v2", input: { city: "Lisbon" } }]);
    expect(res.stop_reason).toBe("tool_use");
  });

  it("calls a tool without its arguments, refuses, stops at the limit, says nothing", async () => {
    const api = fakeApi(toolUse);
    expect((await withFaults(api, [fault.brokenArguments()], () => ask(client()))).content).toMatchObject([{ name: "get_weather", input: {} }]);
    const refused = await withFaults(api, [fault.refusal()], () => ask(client()));
    expect(refused.stop_reason).toBe("refusal");
    expect(refused.content).toEqual([{ type: "text", text: "I'm sorry, but I can't help with that." }]);
    const cut = await withFaults(fakeApi(() => json(anthropicMessage("The weather in Lisbon is sunny and warm today."))), [fault.maxTokens()], () => ask(client()));
    expect(cut.stop_reason).toBe("max_tokens");
    expect(cut.content).toEqual([{ type: "text", text: "The weather in Lisbon" }]);
    expect((await withFaults(api, [fault.emptyAnswer()], () => ask(client()))).content).toEqual([]);
  });

  it("works on streams too", async () => {
    const api = fakeApi(() => sse(anthropicStream(["Sunny", " in Lisbon"])));
    const stream = (c: Anthropic) => c.messages.stream({ model: "claude-opus-5-5", max_tokens: 100, tools: [weather], messages: [{ role: "user", content: "Weather?" }] }).finalMessage();
    const hallucinated = await withFaults(api, [fault.hallucinatedTool({ tool: "book_flight", input: { to: "LIS" } })], () => stream(client()));
    expect(hallucinated.content).toEqual([{ type: "tool_use", id: "toolu_tomiko_1", name: "book_flight", input: { to: "LIS" } }]);
    const refused = await withFaults(api, [fault.refusal({ message: "No." })], () => stream(client()));
    expect(refused).toMatchObject({ stop_reason: "refusal", content: [{ type: "text", text: "No." }] });
  });

  it("keeps the real answer in the cassette and shows assertions the one the caller got", async () => {
    const dir = tmpDir();
    let seen: Cassette | undefined;
    await cassette(
      "rec",
      async (c) => {
        seen = c;
        return ask(client());
      },
      { dir, fetch: fakeApi(toolUse), faults: [fault.hallucinatedTool()] },
    );
    expect(seen!.calls[0]).toMatchObject({ fault: "hallucinated_tool", toolCalls: [{ name: "get_weather_v2" }] });
    expect(readFileSync(join(dir, "rec.json"), "utf8")).toContain('"name": "get_weather"');
    expect(readFileSync(join(dir, "rec.json"), "utf8")).not.toContain("get_weather_v2");
  });
});

describe("OpenAI", () => {
  const tools = [{ type: "function" as const, function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  const client = () => new OpenAI({ apiKey: "k", maxRetries: 0 });
  const toolCall = () => json(openaiChat({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] }));

  it("chat completions: arguments that don't parse, a refusal, the length limit", async () => {
    const ask = () => client().chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "Weather?" }], tools });
    const broken = await withFaults(fakeApi(toolCall), [fault.brokenArguments()], ask);
    const args = broken.choices[0]!.message.tool_calls![0]!;
    expect(args.type === "function" && args.function.arguments).toBe('{"city":"');
    expect(() => JSON.parse(args.type === "function" ? args.function.arguments : "")).toThrow();
    const refused = await withFaults(fakeApi(toolCall), [fault.refusal()], ask);
    expect(refused.choices[0]!.message).toMatchObject({ content: null, refusal: "I'm sorry, but I can't help with that." });
    const cut = await withFaults(fakeApi(() => json(openaiChat({ text: "Sunny and warm all day in Lisbon." }))), [fault.maxTokens({ keep: 0.3 })], ask);
    expect(cut.choices[0]).toMatchObject({ finish_reason: "length", message: { content: "Sunny and" } });
  });

  it("streamed chat completions", async () => {
    const api = fakeApi(() => sse(openaiChatStream({ parts: ["Sunny", " today"] })));
    const stream = () => client().chat.completions.stream({ model: "gpt-test", messages: [{ role: "user", content: "Weather?" }], tools }).finalChatCompletion();
    const hallucinated = await withFaults(api, [fault.hallucinatedTool()], stream);
    const call = hallucinated.choices[0]!.message.tool_calls![0]!;
    expect(call.type === "function" && call.function.name).toBe("get_weather_v2");
    const empty = await withFaults(api, [fault.emptyAnswer()], stream);
    expect(empty.choices[0]!.message.content).toBe("");
  });

  it("the Responses API, plain and streamed", async () => {
    const ask = () => client().responses.create({ model: "gpt-test", input: "Weather?" });
    const cut = await withFaults(fakeApi(() => json(openaiResponse({ text: "Sunny and warm all day." }))), [fault.maxTokens()], ask);
    expect(cut).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(cut.output_text).toBe("Sunny and");
    const stream = () => client().responses.stream({ model: "gpt-test", input: "Weather?" }).finalResponse();
    const api = fakeApi(() => sse(openaiResponseStream(["Sunny ", "today"])));
    const refused = await withFaults(api, [fault.refusal()], stream);
    expect(refused.output[0]).toMatchObject({ type: "message", content: [{ type: "refusal", refusal: "I'm sorry, but I can't help with that." }] });
    const broken = await withFaults(api, [fault.brokenArguments({ tool: "lookup", arguments: "{oops" })], stream);
    expect(broken.output).toContainEqual(expect.objectContaining({ type: "function_call", name: "lookup", arguments: "{oops" }));
  });
});

describe("Gemini", () => {
  const ai = () => new GoogleGenAI({ apiKey: "k" });

  it("a blocked answer, a hallucinated function, the token limit, streamed too", async () => {
    const ask = () => ai().models.generateContent({ model: "gemini-2.5-flash", contents: "Weather?" });
    const api = fakeApi(() => json(geminiResponse({ text: "Sunny and warm all day in Lisbon." })));
    const blocked = await withFaults(api, [fault.refusal()], ask);
    expect(blocked.candidates![0]!.finishReason).toBe("SAFETY");
    expect(blocked.text).toBeUndefined();
    const hallucinated = await withFaults(api, [fault.hallucinatedTool()], ask);
    expect(hallucinated.functionCalls).toEqual([{ name: "search", args: {} }]);
    const stream = async () => {
      let text = "";
      let reason: string | undefined;
      for await (const chunk of await ai().models.generateContentStream({ model: "gemini-2.5-flash", contents: "Weather?" })) {
        text += chunk.text ?? "";
        reason = chunk.candidates?.[0]?.finishReason ?? reason;
      }
      return { text, reason };
    };
    expect(await withFaults(fakeApi(() => sse(geminiStream(["Sunny and", " warm all day"]))), [fault.maxTokens()], stream)).toEqual({ text: "Sunny and", reason: "MAX_TOKENS" });
  });
});

describe("an agent meeting a misbehaving model", () => {
  it("records how the agent recovers once, then replays it", async () => {
    // The AI SDK sends a NoSuchToolError back to the model: a request the plain recording never
    // had. Run once in auto mode and it is recorded; every run after replays it.
    const api = fakeApi((body) => {
      const sent = JSON.stringify(body.messages);
      if (sent.includes("NoSuchToolError")) return json(openaiChat({ text: "Sorry, I couldn't check the weather." }));
      if (sent.includes('"role":"tool"')) return json(openaiChat({ text: "Sunny." }));
      return json(openaiChat({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] }));
    });
    const openai = createOpenAI({ apiKey: "k" });
    const run = async (c: Cassette) => {
      const result = await generateText({
        model: openai.chat("gpt-test"),
        prompt: "Weather in Lisbon?",
        tools: { get_weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async () => "Sunny" }) },
        stopWhen: stepCountIs(3),
      });
      return { text: result.text, called: c.calls[0]!.toolCalls.map((t) => t.name), calls: c.calls.length };
    };
    const dir = tmpDir();
    const faults = [fault.hallucinatedTool({ on: 1 })];
    expect(await cassette("agent", run, { dir, fetch: api })).toEqual({ text: "Sunny.", called: ["get_weather"], calls: 2 });
    const live = await cassette("agent", run, { dir, fetch: api, faults });
    expect(live).toEqual({ text: "Sorry, I couldn't check the weather.", called: ["get_weather_v2"], calls: 2 });
    // What went back to the model is the AI SDK's own error for an unknown tool.
    expect(JSON.stringify(api.calls.at(-1)!.body)).toContain("NoSuchToolError");
    expect(await cassette("agent", run, { dir, mode: "replay", fetch: offline, faults })).toEqual(live);
  });

  it("explains when a response is not an answer it knows", async () => {
    const api = fakeApi(() => json({ hello: "world" }));
    const error = await withFaults(api, [fault.refusal()], () => fetch("https://example.com/api", { method: "POST", body: "{}" }).then((r) => r.json())).catch(
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe('Fault "refusal" can\'t rewrite this response: tomiko knows the answers of Anthropic, OpenAI, Gemini and Bedrock.');
  });
});
