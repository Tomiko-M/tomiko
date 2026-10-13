/**
 * The model misbehaving on cue: calling a tool that doesn't exist, sending arguments that don't
 * parse, refusing, stopping at the token limit, saying nothing. The answer is rebuilt in the
 * provider's own format, streamed or not, so SDKs and agents meet it the way they would live.
 */
import { TomikoError } from "./errors.js";
import type { Fault } from "./faults.js";
import { readContent } from "./inspect.js";
import type { RecordedBody, RecordedRequest, RecordedResponse, Usage } from "./types.js";
import { extractUsage, parseSseData } from "./usage.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export type Misbehavior = Extract<Fault, { name: "hallucinated_tool" | "broken_arguments" | "refusal" | "max_tokens" | "empty_answer" }>;
export const MISBEHAVIORS = new Set<string>(["hallucinated_tool", "broken_arguments", "refusal", "max_tokens", "empty_answer"]);

type Format = "anthropic" | "chat" | "responses" | "gemini";

interface Call {
  name: string;
  input: unknown;
  /** Arguments as text, for the formats that send them as text; may be invalid JSON. */
  raw?: string;
}

interface Answer {
  text: string;
  calls: Call[];
  stop: "end" | "tool" | "max_tokens" | "refusal";
  refusal?: string;
}

interface Base {
  id: string;
  model: string;
  created: number;
  usage: Usage;
}

/* ------------------------------------------ reading ------------------------------------------ */

function formatOf(body: RecordedBody): Format | undefined {
  const of = (o: unknown): Format | undefined => {
    if (!isObj(o)) return undefined;
    if (o.type === "message" || o.type === "message_start" || String(o.type).startsWith("content_block")) return "anthropic";
    if (o.object === "chat.completion" || o.object === "chat.completion.chunk") return "chat";
    if (o.object === "response" || String(o.type).startsWith("response.")) return "responses";
    if (Array.isArray(o.candidates)) return "gemini";
    if (Array.isArray(o.choices)) return "chat";
    return undefined;
  };
  if (body.type === "json") return of(body.value);
  if (body.type === "sse") return parseSseData(body.chunks).map(of).find(Boolean);
  return undefined;
}

/** Tool names the request offers the model. */
function offeredTools(body: unknown): string[] {
  if (!isObj(body) || !Array.isArray(body.tools)) return [];
  return body.tools.filter(isObj).flatMap((t) => {
    const declarations = t.functionDeclarations ?? t.function_declarations;
    if (Array.isArray(declarations)) return declarations.filter(isObj).map((d) => str(d.name) ?? "");
    const fn = isObj(t.function) ? t.function : t;
    return [str(fn.name) ?? ""];
  }).filter(Boolean);
}

function baseOf(body: RecordedBody, request: RecordedRequest): Base {
  const { model, usage } = extractUsage(body);
  const first = body.type === "json" ? body.value : body.type === "sse" ? parseSseData(body.chunks)[0] : undefined;
  const o = isObj(first) ? (isObj(first.message) ? first.message : isObj(first.response) ? first.response : first) : {};
  const requested = isObj(request.body) ? str(request.body.model) : undefined;
  return {
    id: str(o.id) ?? str(o.responseId) ?? "tomiko_fault",
    model: model ?? requested ?? "unknown",
    created: typeof o.created === "number" ? o.created : typeof o.created_at === "number" ? o.created_at : 1_760_000_000,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Cut at a word boundary near `keep` of the way through, as a model stopped by max_tokens is. */
function cut(text: string, keep: number): string {
  const at = Math.floor(text.length * Math.min(Math.max(keep, 0), 1));
  const space = text.lastIndexOf(" ", at);
  return text.slice(0, space > at / 2 ? space : at);
}

/** Arguments that are no longer JSON: the text a model stopped in the middle of. */
function broken(input: unknown): string {
  const json = JSON.stringify(input ?? {});
  return json.length > 2 ? json.slice(0, Math.max(1, Math.ceil(json.length / 2))) : "{";
}

function answerFor(fault: Misbehavior, response: RecordedResponse, request: RecordedRequest, format: Format): Answer {
  const original = readContent(response.body);
  const textArgs = format === "chat" || format === "responses";
  const offered = offeredTools(request.body);
  switch (fault.name) {
    case "hallucinated_tool": {
      let name = fault.tool ?? (offered[0] ? `${offered[0]}_v2` : "search");
      while (offered.includes(name)) name += "_v2";
      return { text: "", calls: [{ name, input: fault.input ?? original.toolCalls[0]?.input ?? {} }], stop: "tool" };
    }
    case "broken_arguments": {
      const calls: Call[] = original.toolCalls.map((c) => ({ name: c.name, input: c.input }));
      let at = calls.findIndex((c) => fault.tool === undefined || c.name === fault.tool);
      if (at === -1) {
        const name = fault.tool ?? offered[0];
        if (!name) throw new TomikoError("fault.brokenArguments() needs a tool call to break: the request offers no tools. Name one with `tool`.");
        calls.unshift({ name, input: {} });
        at = 0;
      }
      const call = calls[at]!;
      calls[at] = textArgs ? { ...call, raw: fault.arguments ?? broken(call.input) } : { ...call, input: fault.input ?? {} };
      return { text: original.text, calls, stop: "tool" };
    }
    case "refusal":
      return { text: fault.message, calls: [], stop: "refusal", refusal: fault.message };
    case "max_tokens": {
      if (original.text || original.toolCalls.length === 0) return { text: cut(original.text, fault.keep), calls: [], stop: "max_tokens" };
      // Stopped in the middle of a tool call's arguments.
      const call = original.toolCalls[0]!;
      return { text: "", calls: [textArgs ? { name: call.name, input: call.input, raw: broken(call.input) } : { name: call.name, input: {} }], stop: "max_tokens" };
    }
    case "empty_answer":
      return { text: "", calls: [], stop: "end" };
  }
}

/* ------------------------------------------ writing ------------------------------------------ */

const sse = (events: { event?: string; data: unknown }[]): RecordedBody => ({
  type: "sse",
  chunks: events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`),
});

const callId = (format: Format, i: number) => (format === "anthropic" ? `toolu_tomiko_${i + 1}` : `call_tomiko_${i + 1}`);
const args = (c: Call) => c.raw ?? JSON.stringify(c.input ?? {});

function anthropic(base: Base, a: Answer, streamed: boolean): RecordedBody {
  const stop = { end: "end_turn", tool: "tool_use", max_tokens: "max_tokens", refusal: "refusal" }[a.stop];
  const usage = {
    input_tokens: base.usage.inputTokens,
    output_tokens: base.usage.outputTokens,
    cache_read_input_tokens: base.usage.cacheReadTokens,
    cache_creation_input_tokens: base.usage.cacheWriteTokens,
  };
  type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
  const blocks: Block[] = [
    ...(a.text ? [{ type: "text" as const, text: a.text }] : []),
    ...a.calls.map((c, i) => ({ type: "tool_use" as const, id: callId("anthropic", i), name: c.name, input: c.input ?? {} })),
  ];
  const message = { id: base.id, type: "message", role: "assistant", model: base.model };
  if (!streamed) return { type: "json", value: { ...message, content: blocks, stop_reason: stop, stop_sequence: null, usage } };
  return sse([
    { event: "message_start", data: { type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } } },
    ...blocks.flatMap((block, index) => [
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } } },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    ]),
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function chat(base: Base, a: Answer, streamed: boolean): RecordedBody {
  const finish = { end: "stop", tool: "tool_calls", max_tokens: "length", refusal: "stop" }[a.stop];
  const usage = {
    prompt_tokens: base.usage.inputTokens + base.usage.cacheReadTokens,
    completion_tokens: base.usage.outputTokens,
    total_tokens: base.usage.inputTokens + base.usage.cacheReadTokens + base.usage.outputTokens,
    prompt_tokens_details: { cached_tokens: base.usage.cacheReadTokens },
  };
  const calls = a.calls.map((c, i) => ({ id: callId("chat", i), type: "function", function: { name: c.name, arguments: args(c) } }));
  const head = { id: base.id, created: base.created, model: base.model };
  if (!streamed) {
    const message = {
      role: "assistant",
      content: a.refusal ? null : a.text || (calls.length > 0 ? null : ""),
      refusal: a.refusal ?? null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
    return { type: "json", value: { ...head, object: "chat.completion", choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage } };
  }
  const chunk = (delta: Obj, finish_reason: string | null = null) => ({
    data: { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta, logprobs: null, finish_reason }] },
  });
  return sse([
    chunk({ role: "assistant", content: "" }),
    ...(a.refusal ? [chunk({ refusal: a.refusal })] : a.text ? [chunk({ content: a.text })] : []),
    ...calls.flatMap((c, index) => [
      chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] }),
      chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] }),
    ]),
    chunk({}, finish),
    { data: { ...head, object: "chat.completion.chunk", choices: [], usage } },
    { data: "[DONE]" },
  ]);
}

function responses(base: Base, a: Answer, streamed: boolean): RecordedBody {
  const cutShort = a.stop === "max_tokens";
  const status = cutShort ? "incomplete" : "completed";
  const usage = {
    input_tokens: base.usage.inputTokens + base.usage.cacheReadTokens,
    input_tokens_details: { cached_tokens: base.usage.cacheReadTokens },
    output_tokens: base.usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: base.usage.inputTokens + base.usage.cacheReadTokens + base.usage.outputTokens,
  };
  const part = a.refusal ? { type: "refusal", refusal: a.refusal } : { type: "output_text", text: a.text, annotations: [], logprobs: [] };
  const message = { type: "message", id: "msg_tomiko_1", status, role: "assistant", content: [part] };
  const calls = a.calls.map((c, i) => ({ type: "function_call", id: `fc_tomiko_${i + 1}`, call_id: callId("responses", i), name: c.name, arguments: args(c), status: "completed" }));
  const output = [...(a.text || a.refusal || calls.length === 0 ? [message] : []), ...calls];
  const response = {
    id: base.id,
    object: "response",
    created_at: base.created,
    status,
    error: null,
    incomplete_details: cutShort ? { reason: "max_output_tokens" } : null,
    model: base.model,
    output,
    usage,
  };
  if (!streamed) return { type: "json", value: response };
  let seq = 0;
  const event = (type: string, fields: Obj) => ({ event: type, data: { type, sequence_number: seq++, ...fields } });
  const pending = { ...response, status: "in_progress", output: [], usage: null };
  return sse([
    event("response.created", { response: pending }),
    event("response.in_progress", { response: pending }),
    ...output.flatMap((item, output_index): { event?: string; data: unknown }[] => {
      if (item.type === "function_call") {
        const call = item as (typeof calls)[number];
        return [
          event("response.output_item.added", { output_index, item: { ...call, arguments: "", status: "in_progress" } }),
          event("response.function_call_arguments.delta", { item_id: call.id, output_index, delta: call.arguments }),
          event("response.function_call_arguments.done", { item_id: call.id, output_index, arguments: call.arguments }),
          event("response.output_item.done", { output_index, item: call }),
        ];
      }
      const kind = a.refusal ? "refusal" : "output_text";
      const value = a.refusal ?? a.text;
      const empty = a.refusal ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [], logprobs: [] };
      return [
        event("response.output_item.added", { output_index, item: { ...message, status: "in_progress", content: [] } }),
        event("response.content_part.added", { item_id: message.id, output_index, content_index: 0, part: empty }),
        event(`response.${kind}.delta`, { item_id: message.id, output_index, content_index: 0, delta: value, ...(a.refusal ? {} : { logprobs: [] }) }),
        event(`response.${kind}.done`, { item_id: message.id, output_index, content_index: 0, [a.refusal ? "refusal" : "text"]: value, ...(a.refusal ? {} : { logprobs: [] }) }),
        event("response.content_part.done", { item_id: message.id, output_index, content_index: 0, part }),
        event("response.output_item.done", { output_index, item: message }),
      ];
    }),
    event(`response.${status}`, { response }),
  ]);
}

function gemini(base: Base, a: Answer, streamed: boolean): RecordedBody {
  const finishReason = { end: "STOP", tool: "STOP", max_tokens: "MAX_TOKENS", refusal: "SAFETY" }[a.stop];
  const parts = [...(a.text && !a.refusal ? [{ text: a.text }] : []), ...a.calls.map((c) => ({ functionCall: { name: c.name, args: c.input ?? {} } }))];
  // A blocked answer has no content at all.
  const candidate = a.refusal ? { finishReason, index: 0 } : { content: { role: "model", parts }, finishReason, index: 0 };
  const value = {
    candidates: [candidate],
    usageMetadata: {
      promptTokenCount: base.usage.inputTokens + base.usage.cacheReadTokens,
      candidatesTokenCount: base.usage.outputTokens,
      cachedContentTokenCount: base.usage.cacheReadTokens,
      totalTokenCount: base.usage.inputTokens + base.usage.cacheReadTokens + base.usage.outputTokens,
    },
    modelVersion: base.model,
    responseId: base.id,
  };
  return streamed ? sse([{ data: value }]) : { type: "json", value };
}

/** The answer the caller gets instead of `response`, which stays in the cassette as it was. */
export function misbehave(fault: Misbehavior, response: RecordedResponse, request: RecordedRequest): RecordedResponse {
  if (response.status >= 400) return response;
  const format = formatOf(response.body);
  if (!format) {
    throw new TomikoError(`Fault "${fault.name}" can't rewrite this response: tomiko knows the answers of Anthropic, OpenAI and Gemini.`);
  }
  const streamed = response.body.type === "sse";
  const answer = answerFor(fault, response, request, format);
  const base = baseOf(response.body, request);
  const body = { anthropic, chat, responses, gemini }[format](base, answer, streamed);
  return { status: 200, headers: { "content-type": streamed ? "text/event-stream" : "application/json" }, body };
}
