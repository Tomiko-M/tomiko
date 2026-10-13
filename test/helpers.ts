import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "tomiko-"));

export interface FakeApi {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: { url: string; body: unknown }[];
}

/** A stand-in for the network that counts calls. */
export function fakeApi(handler: (body: any, request: Request, call: number) => Response | Promise<Response>): FakeApi {
  const calls: FakeApi["calls"] = [];
  const api = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ url: request.url, body });
    return handler(body, request, calls.length);
  };
  return Object.assign(api, { calls });
}

export const offline = (async () => {
  throw new Error("network access in a replay test");
}) as typeof fetch;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "set-cookie": "s=1" } });

/** An SSE response delivered in deliberately awkward chunks that split events mid-line. */
export function sse(events: { event?: string; data: unknown }[], chunkSize = 37): Response {
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export function anthropicMessage(text: string, model = "claude-opus-5-5") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

export function anthropicStream(parts: string[], model = "claude-opus-5-5") {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_02",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...parts.map((text) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

export const OPENAI_URL = "https://api.openai.com/v1";

interface FakeTool {
  name: string;
  input: unknown;
}

export function openaiChat(options: { text?: string; tools?: FakeTool[]; model?: string }) {
  const tools = options.tools ?? [];
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1760000000,
    model: options.model ?? "gpt-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.text ?? null,
          refusal: null,
          ...(tools.length > 0 && {
            tool_calls: tools.map((t, i) => ({
              id: `call_${i}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.input) },
            })),
          }),
        },
        logprobs: null,
        finish_reason: tools.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
  };
}

/** Chat Completions stream events; tool arguments arrive in fragments, usage in a final chunk. */
export function openaiChatStream(options: { parts?: string[]; tool?: FakeTool; model?: string }) {
  const base = { id: "chatcmpl-2", object: "chat.completion.chunk", created: 1760000000, model: options.model ?? "gpt-test" };
  const chunk = (delta: object, finish: string | null = null) => ({
    data: { ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] },
  });
  const events: { data: unknown }[] = [chunk({ role: "assistant", content: "" })];
  for (const part of options.parts ?? []) events.push(chunk({ content: part }));
  if (options.tool) {
    const args = JSON.stringify(options.tool.input);
    events.push(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: options.tool.name, arguments: "" } }] }));
    for (const piece of [args.slice(0, 4), args.slice(4)]) {
      events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    }
  }
  events.push(chunk({}, options.tool ? "tool_calls" : "stop"));
  events.push({ data: { ...base, choices: [], usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 } } });
  events.push({ data: "[DONE]" });
  return events;
}

export function openaiResponse(options: { text?: string; tool?: FakeTool; model?: string; status?: string }) {
  const output: unknown[] = [];
  if (options.tool) {
    output.push({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: options.tool.name,
      arguments: JSON.stringify(options.tool.input),
      status: "completed",
    });
  }
  if (options.text !== undefined) {
    output.push({
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: options.text, annotations: [], logprobs: [] }],
    });
  }
  return {
    id: "resp_1",
    object: "response",
    created_at: 1760000000,
    status: options.status ?? "completed",
    model: options.model ?? "gpt-test",
    output,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 120,
    },
  };
}

/** Responses API stream events for a text answer, ending with the full response. */
export function openaiResponseStream(parts: string[], model = "gpt-test") {
  const text = parts.join("");
  const done = openaiResponse({ text, model });
  const message = (done.output as object[])[0];
  let seq = 0;
  const event = (type: string, fields: object) => ({ data: { type, sequence_number: seq++, ...fields } });
  return [
    event("response.created", { response: { ...done, status: "in_progress", output: [], usage: null } }),
    event("response.in_progress", { response: { ...done, status: "in_progress", output: [], usage: null } }),
    event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] },
    }),
    event("response.content_part.added", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    ...parts.map((delta) =>
      event("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta, logprobs: [] }),
    ),
    event("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text, logprobs: [] }),
    event("response.content_part.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }),
    event("response.output_item.done", { output_index: 0, item: message }),
    event("response.completed", { response: done }),
  ];
}

/**
 * Secrets that look real. They are built at run time so that no key-shaped literal appears in the
 * source, where secret scanners (GitHub push protection among them) would rightly object.
 */
const ALPHABET = "Q7mZ2xK9pL4vB8nR1tY6wC3jH5dF0gSaEuIoPqWrTyUiOlKjHgFdSaZxCvBnM";
export const random = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 7 + offset) % ALPHABET.length]).join("");
export const keys = {
  anthropic: ["sk", "ant", "api03", random(93) + "AA"].join("-"),
  openai: ["sk", "proj", random(80, 3)].join("-"),
  google: "AIza" + "Sy" + random(33, 5),
  github: "gh" + "p_" + random(36, 11),
  stripe: "sk_" + "live_" + random(24, 13),
  slack: "xo" + "xb-" + "1234567890-" + random(24, 17),
  aws: "AK" + "IA" + "Z7Q2X3N4M5P6R7S8",
  huggingface: "hf" + "_" + random(34, 19),
  groq: "gs" + "k_" + random(52, 23),
};

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiTurn {
  text?: string;
  tools?: FakeTool[];
  model?: string;
  finishReason?: string;
}

/** A Gemini generateContent response; usage counts thinking and cached tokens like the real API. */
export function geminiResponse(turn: GeminiTurn) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            ...(turn.text !== undefined ? [{ text: turn.text }] : []),
            ...(turn.tools ?? []).map((t) => ({ functionCall: { name: t.name, args: t.input } })),
          ],
        },
        finishReason: turn.finishReason ?? "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 40, totalTokenCount: 150 },
    modelVersion: turn.model ?? "gemini-2.5-flash",
    responseId: "resp-gemini-1",
  };
}

/** streamGenerateContent?alt=sse events: each one a response with the next piece of text. */
export function geminiStream(parts: string[], model = "gemini-2.5-flash") {
  return parts.map((text, i) => ({
    data: {
      candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0, ...(i === parts.length - 1 ? { finishReason: "STOP" } : {}) }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 * (i + 1), totalTokenCount: 12 + 2 * (i + 1) },
      modelVersion: model,
    },
  }));
}
