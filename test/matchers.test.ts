import Anthropic from "@anthropic-ai/sdk";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { TomikoError } from "../src/index.js";
import { readContent } from "../src/inspect.js";
import { currentCassette, setupCassettes, useCassette } from "../src/vitest.js";
import { ANTHROPIC_URL, fakeApi, json, offline, sse, tmpDir } from "./helpers.js";

/** The failure message of an assertion, without the runner's colors. */
function failure(assertion: () => void): string {
  try {
    assertion();
  } catch (error) {
    return stripVTControlCharacters((error as Error).message);
  }
  throw new Error("expected the assertion to fail");
}

const toChunks = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`);

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

function anthropicReply(content: unknown[], stop: "tool_use" | "end_turn", model = "claude-opus-5-5") {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** Anthropic stream events for one tool_use block whose JSON input arrives in fragments. */
function toolStream(name: string, input: unknown) {
  const raw = JSON.stringify(input);
  const pieces = [raw.slice(0, 5), raw.slice(5, 12), raw.slice(12)];
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name, input: {} } } },
    ...pieces.map((partial_json) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

describe("reading tool calls and text", () => {
  it("handles Anthropic messages, including streamed tool input", () => {
    const body = anthropicReply([{ type: "text", text: "Let me look." }, toolUse("tu_1", "search", { q: "tables" })], "tool_use");
    expect(readContent({ type: "json", value: body })).toEqual({
      text: "Let me look.",
      toolCalls: [{ name: "search", input: { q: "tables" }, id: "tu_1" }],
    });
    const streamed = readContent({ type: "sse", chunks: toChunks(toolStream("get_weather", { city: "Lisbon", unit: "c" }).map((e) => e.data)) });
    expect(streamed).toEqual({ text: "Checking.", toolCalls: [{ name: "get_weather", input: { city: "Lisbon", unit: "c" }, id: "tu_1" }] });
  });

  it("handles OpenAI Chat Completions, including fragmented streamed arguments", () => {
    const body = {
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "lookup", arguments: '{"id":7}' } }] } }],
    };
    expect(readContent({ type: "json", value: body }).toolCalls).toEqual([{ name: "lookup", input: { id: 7 }, id: "c1" }]);

    const chunks = toChunks([
      { choices: [{ delta: { content: "Hi " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"i' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "notify", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'd":7}' } }] } }] },
      { choices: [{ delta: { content: "there" } }] },
    ]).concat("data: [DONE]\n\n");
    expect(readContent({ type: "sse", chunks })).toEqual({
      text: "Hi there",
      toolCalls: [
        { name: "lookup", input: { id: 7 }, id: "c1" },
        { name: "notify", input: {}, id: "c2" },
      ],
    });
  });

  it("handles the OpenAI Responses API", () => {
    const response = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "Booking now." }] },
        { type: "function_call", call_id: "fc1", name: "book", arguments: '{"guests":2}' },
      ],
    };
    const expected = { text: "Booking now.", toolCalls: [{ name: "book", input: { guests: 2 }, id: "fc1" }] };
    expect(readContent({ type: "json", value: response })).toEqual(expected);
    const chunks = toChunks([
      { type: "response.output_text.delta", delta: "Booking now." },
      { type: "response.completed", response },
    ]);
    expect(readContent({ type: "sse", chunks })).toEqual(expected);
  });

  it("keeps arguments that are not valid JSON as text", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "not json" } }] } }] };
    expect(readContent({ type: "json", value: body }).toolCalls[0]!.input).toBe("not json");
  });
});

/** A minimal agent loop over the Messages API: search, then book, then answer. */
async function bookingAgent(fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
  const messages: unknown[] = [{ role: "user", content: "Table for two at 7pm" }];
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1024, messages }),
    });
    const reply = (await res.json()) as ReturnType<typeof anthropicReply>;
    messages.push({ role: "assistant", content: reply.content });
    if (reply.stop_reason === "end_turn") return (reply.content[0] as { text: string }).text;
    const tool = reply.content.find((b: any) => b.type === "tool_use") as { id: string };
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "ok" }] });
  }
  throw new Error("agent did not finish");
}

const bookingApi = () =>
  fakeApi((body) => {
    const turn = body.messages.length;
    if (turn === 1) return json(anthropicReply([toolUse("t1", "search_tables", { time: "19:00", guests: 2 })], "tool_use"));
    if (turn === 3) return json(anthropicReply([toolUse("t2", "book_table", { table: 12, guests: 2, note: "window" })], "tool_use"));
    return json(anthropicReply([{ type: "text", text: "Booked table 12 for 19:00." }], "end_turn"));
  });

describe("matchers", () => {
  it("assert what the agent did", async () => {
    await useCassette(
      async (c) => {
        await bookingAgent();
        expect(c).toHaveCalledTool("book_table");
        expect(c).toHaveCalledTool("book_table", { guests: 2 });
        expect(c).toHaveCalledTool("book_table", { table: expect.any(Number), note: expect.stringMatching(/win/) });
        expect(c).not.toHaveCalledTool("book_table", { guests: 3 });
        expect(c).not.toHaveCalledTool("cancel_booking");
        expect(c).toHaveCalledToolTimes("search_tables", 1);
        expect(c).toHaveCalledToolsInOrder(["search_tables", "book_table"]);
        expect(c).not.toHaveCalledToolsInOrder(["book_table", "search_tables"]);
        expect(c).toHaveMadeRequests(3);
        expect(c).toHaveMadeRequests({ max: 5 });
        expect(c).not.toHaveMadeRequests({ min: 4 });
        expect(c).toHaveUsedModel("claude-opus-5-5");
        expect(c).toHaveUsedModel(/^claude-opus/);
        expect(c).not.toHaveUsedModel("claude-haiku-5-5");
        // 3 calls × (500 in × $4/M + 100 out × $20/M) = $0.012
        expect(c).toCostLessThan(0.02);
        expect(c).not.toCostLessThan(0.01);
        expect(c).toHaveUsedFewerTokensThan(2000);
        expect(c).not.toHaveUsedFewerTokensThan(1800);
      },
      { dir: tmpDir(), fetch: bookingApi() },
    );
  });

  it("work the same on replay", async () => {
    const dir = tmpDir();
    await useCassette(() => bookingAgent(), { dir, fetch: bookingApi() });
    await useCassette(
      async (c) => {
        expect(await bookingAgent()).toBe("Booked table 12 for 19:00.");
        expect(c).toHaveCalledToolsInOrder(["search_tables", "book_table"]);
        expect(c.calls.every((call) => call.replayed)).toBe(true);
      },
      { dir, mode: "replay", fetch: offline },
    );
  });

  it("explain failures with the calls that were made", async () => {
    await useCassette(
      async (c) => {
        await bookingAgent();
        expect(failure(() => expect(c).toHaveCalledTool("cancel_booking"))).toMatch(
          /to call tool "cancel_booking"\.\nTool calls:\n {2}search_tables\(\{"time":"19:00","guests":2\}\)\n {2}book_table/,
        );
        expect(failure(() => expect(c).not.toHaveCalledTool("book_table"))).toMatch(
          /not to call tool "book_table"\.\nTool calls:\n {2}book_table/,
        );
        expect(failure(() => expect(c).toHaveCalledToolTimes("book_table", 2))).toMatch(/it was called 1 time/);
        expect(failure(() => expect(c).toHaveCalledToolsInOrder(["book_table", "search_tables"]))).toMatch(
          /matched up to "book_table"/,
        );
        expect(failure(() => expect(c).toHaveMadeRequests({ min: 1, max: 2 }))).toMatch(
          /make at least 1 and at most 2 request\(s\), it made 3/,
        );
        expect(failure(() => expect(c).toCostLessThan(0.001))).toMatch(/estimated cost is "\$0\.0120"/);
      },
      { dir: tmpDir(), fetch: bookingApi() },
    );
  });

  it("refuse to guess the cost of a model without a price", async () => {
    const api = fakeApi(() => json(anthropicReply([{ type: "text", text: "hi" }], "end_turn", "some-unpriced-model")));
    await useCassette(
      async (c) => {
        await bookingAgent();
        expect(() => expect(c).toCostLessThan(100)).toThrow(/no price for some-unpriced-model/);
        expect(c).toHaveUsedFewerTokensThan(1000);
      },
      { dir: tmpDir(), fetch: api },
    );
  });

  it("reject values that are not cassettes", () => {
    expect(() => expect({}).toHaveCalledTool("x")).toThrow(TomikoError);
  });

  it("see a streamed tool call as soon as the SDK has read it, while recording", async () => {
    const api = fakeApi(() => sse(toolStream("get_weather", { city: "Lisbon", unit: "c" }), 7));
    await useCassette(
      async (c) => {
        // Created inside the cassette, so it picks up the patched global fetch.
        const client = new Anthropic({ apiKey: "sk-ant-test", maxRetries: 0 });
        await client.messages
          .stream({ model: "claude-opus-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Weather?" }] })
          .finalMessage();
        expect(c.calls[0]!.replayed).toBe(false);
        expect(c).toHaveCalledTool("get_weather", { city: "Lisbon" });
        expect(c.calls[0]!.text).toBe("Checking.");
      },
      { dir: tmpDir(), fetch: api },
    );
  });
});

describe("currentCassette", () => {
  setupCassettes({ dir: tmpDir(), fetch: bookingApi() });

  it("gives tests covered by setupCassettes their cassette", async () => {
    await bookingAgent();
    expect(currentCassette()).toHaveCalledTool("search_tables", { guests: 2 });
    expect(currentCassette().toolCalls.map((t) => t.name)).toEqual(["search_tables", "book_table"]);
  });
});

it("currentCassette() fails clearly when no cassette is active", () => {
  expect(() => currentCassette()).toThrow(/No cassette is active/);
});
