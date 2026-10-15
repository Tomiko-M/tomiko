import type { RecordedBody, ToolCall } from "./types.js";
import { streamEvents } from "./usage.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Tool arguments arrive as JSON text from OpenAI and as streamed fragments from both providers. */
function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface ResponseContent {
  text: string;
  toolCalls: ToolCall[];
}

const ANTHROPIC_TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
/** Chat Completions choice 0: what clients read when `n` asks for several. */
const firstChoice = (choice: Obj) => choice.index === undefined || choice.index === 0;
/** How a Responses API stream ends: with the response, finished, cut short or failed. */
const FINAL_RESPONSE = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** Gemini candidates: text parts (thought summaries aside) and function calls. */
function fromCandidates(candidates: unknown[], text: string[], toolCalls: ToolCall[]): void {
  // Each candidate is an alternative answer; the first is the one clients use.
  const content = candidates.filter(isObj)[0]?.content;
  for (const part of isObj(content) && Array.isArray(content.parts) ? content.parts.filter(isObj) : []) {
    if (typeof part.text === "string" && part.thought !== true) text.push(part.text);
    const call = isObj(part.functionCall) ? part.functionCall : undefined;
    if (call && typeof call.name === "string") toolCalls.push({ name: call.name, input: call.args ?? {}, id: str(call.id) });
  }
}

/** Bedrock Converse content blocks: text, tool uses, reasoning (left out). */
function fromConverse(content: unknown[], text: string[], toolCalls: ToolCall[]): void {
  for (const block of content.filter(isObj)) {
    if (typeof block.text === "string") text.push(block.text);
    const use = isObj(block.toolUse) ? block.toolUse : undefined;
    if (use && typeof use.name === "string") toolCalls.push({ name: use.name, input: use.input ?? {}, id: str(use.toolUseId) });
  }
}

/** What other models on Bedrock answer through InvokeModel: Llama, Mistral, Titan, Cohere. */
function fromNative(o: Obj, text: string[]): void {
  if (typeof o.generation === "string") text.push(o.generation);
  if (typeof o.outputText === "string") text.push(o.outputText);
  for (const key of ["outputs", "results", "generations"]) {
    const first = Array.isArray(o[key]) ? (o[key] as unknown[]).filter(isObj)[0] : undefined;
    const value = first ? (first.text ?? first.outputText) : undefined;
    if (typeof value === "string") text.push(value);
  }
}

/**
 * A complete (non-streamed) response body: Anthropic Messages, OpenAI Chat Completions or
 * Responses, Gemini, Bedrock Converse, or a model's own format on Bedrock.
 */
function fromBody(o: Obj): ResponseContent {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(o.candidates)) fromCandidates(o.candidates, text, toolCalls);

  const converse = isObj(o.output) && isObj(o.output.message) ? o.output.message : undefined;
  if (converse && Array.isArray(converse.content)) fromConverse(converse.content, text, toolCalls);
  if (!converse && o.type !== "message" && !Array.isArray(o.choices) && !Array.isArray(o.output)) fromNative(o, text);

  if (o.type === "message" && Array.isArray(o.content)) {
    for (const block of o.content.filter(isObj)) {
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      if (ANTHROPIC_TOOL_BLOCKS.has(String(block.type)) && typeof block.name === "string") {
        toolCalls.push({ name: block.name, input: block.input ?? {}, id: str(block.id) });
      }
    }
  }

  if (Array.isArray(o.choices)) {
    // With `n` > 1, each choice is an alternative answer; the first is the one clients use.
    for (const choice of o.choices.filter(isObj).filter(firstChoice).slice(0, 1)) {
      const message = isObj(choice.message) ? choice.message : undefined;
      if (!message) continue;
      if (typeof message.content === "string") text.push(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObj) : []) {
        const fn = isObj(call.function) ? call.function : undefined;
        if (fn && typeof fn.name === "string") {
          toolCalls.push({ name: fn.name, input: parseArguments(str(fn.arguments) ?? ""), id: str(call.id) });
        }
      }
    }
  }

  if (Array.isArray(o.output)) {
    for (const item of o.output.filter(isObj)) {
      if (item.type === "function_call" && typeof item.name === "string") {
        toolCalls.push({ name: item.name, input: parseArguments(str(item.arguments) ?? ""), id: str(item.call_id) });
      }
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content.filter(isObj)) {
          if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
        }
      }
    }
  }

  return { text: text.join(""), toolCalls };
}

interface PartialTool {
  name: string;
  id?: string;
  json: string;
  input?: unknown;
}

/** Reassembles text and tool calls from streamed events, including tool arguments sent in pieces. */
function fromEvents(events: unknown[]): ResponseContent {
  const text: string[] = [];
  const anthropicTools = new Map<number, PartialTool>();
  const chatTools = new Map<number, PartialTool>();
  const converseTools = new Map<number, PartialTool>();
  const geminiTools: ToolCall[] = [];

  for (const event of events.filter(isObj)) {
    // Bedrock ConverseStream: each event keyed by its type.
    if (isObj(event.contentBlockStart)) {
      const start = event.contentBlockStart;
      const use = isObj(start.start) && isObj(start.start.toolUse) ? start.start.toolUse : undefined;
      if (use && typeof use.name === "string") converseTools.set(Number(start.contentBlockIndex), { name: use.name, id: str(use.toolUseId), json: "" });
    }
    if (isObj(event.contentBlockDelta) && isObj(event.contentBlockDelta.delta)) {
      const { delta, contentBlockIndex } = event.contentBlockDelta;
      if (typeof delta.text === "string") text.push(delta.text);
      if (isObj(delta.toolUse) && typeof delta.toolUse.input === "string") {
        const tool = converseTools.get(Number(contentBlockIndex));
        if (tool) tool.json += delta.toolUse.input;
      }
    }
    // Other models through InvokeModel stream their own pieces.
    if (event.type === undefined && !Array.isArray(event.choices) && !Array.isArray(event.candidates)) fromNative(event, text);

    // The Responses API ends with the full response object, which is the most reliable source.
    if (FINAL_RESPONSE.has(String(event.type)) && isObj(event.response)) return fromBody(event.response);

    if (event.type === "content_block_start" && isObj(event.content_block)) {
      const block = event.content_block;
      if (ANTHROPIC_TOOL_BLOCKS.has(String(block.type)) && typeof block.name === "string") {
        anthropicTools.set(Number(event.index), { name: block.name, id: str(block.id), json: "", input: block.input });
      }
    }
    if (event.type === "content_block_delta" && isObj(event.delta)) {
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") text.push(delta.text);
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const tool = anthropicTools.get(Number(event.index));
        if (tool) tool.json += delta.partial_json;
      }
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text.push(event.delta);

    // Gemini streams whole responses, each carrying the next piece of text.
    if (Array.isArray(event.candidates)) fromCandidates(event.candidates, text, geminiTools);

    if (Array.isArray(event.choices)) {
      for (const choice of event.choices.filter(isObj).filter(firstChoice)) {
        const delta = isObj(choice.delta) ? choice.delta : undefined;
        if (!delta) continue;
        if (typeof delta.content === "string") text.push(delta.content);
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isObj) : []) {
          const index = typeof call.index === "number" ? call.index : 0;
          const tool = chatTools.get(index) ?? { name: "", json: "" };
          const fn = isObj(call.function) ? call.function : {};
          if (typeof call.id === "string") tool.id = call.id;
          if (typeof fn.name === "string") tool.name += fn.name;
          if (typeof fn.arguments === "string") tool.json += fn.arguments;
          chatTools.set(index, tool);
        }
      }
    }
  }

  const finish = (tools: Map<number, PartialTool>): ToolCall[] =>
    [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, t]) => t.name)
      .map(([, t]) => ({ name: t.name, input: t.json ? parseArguments(t.json) : (t.input ?? {}), id: t.id }));

  return { text: text.join(""), toolCalls: [...finish(anthropicTools), ...finish(chatTools), ...finish(converseTools), ...geminiTools] };
}

export function readContent(body: RecordedBody): ResponseContent {
  if (body.type === "json" && isObj(body.value)) return fromBody(body.value);
  if (body.type === "sse" || body.type === "eventstream") return fromEvents(streamEvents(body));
  return { text: "", toolCalls: [] };
}

/** Why the model stopped: `end_turn`, `tool_use`, `max_tokens`, `stop`, `length`, `completed`, `STOP`… */
export function stopReason(body: RecordedBody): string | undefined {
  const fromObj = (o: unknown): string | undefined => {
    if (!isObj(o)) return undefined;
    if (typeof o.stop_reason === "string") return o.stop_reason;
    // Bedrock Converse, whole or as its stream's `messageStop` event.
    if (typeof o.stopReason === "string") return o.stopReason;
    if (isObj(o.messageStop) && typeof o.messageStop.stopReason === "string") return o.messageStop.stopReason;
    if (isObj(o.delta) && typeof o.delta.stop_reason === "string") return o.delta.stop_reason;
    if (Array.isArray(o.choices)) {
      const reason = o.choices.filter(isObj).map((c) => c.finish_reason).find((r) => typeof r === "string");
      if (typeof reason === "string") return reason;
    }
    if (Array.isArray(o.candidates)) {
      const reason = o.candidates.filter(isObj).map((c) => c.finishReason).find((r) => typeof r === "string");
      if (typeof reason === "string") return reason;
    }
    if (o.object === "response" && typeof o.status === "string") return o.status;
    if (FINAL_RESPONSE.has(String(o.type)) && isObj(o.response)) return str(o.response.status);
    return undefined;
  };
  if (body.type === "json") return fromObj(body.value);
  return streamEvents(body).map(fromObj).filter(Boolean).pop();
}
