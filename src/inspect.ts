import type { RecordedBody, ToolCall } from "./types.js";
import { parseSseData } from "./usage.js";

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

/** A complete (non-streamed) response body: Anthropic Messages, OpenAI Chat Completions or Responses. */
function fromBody(o: Obj): ResponseContent {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  if (o.type === "message" && Array.isArray(o.content)) {
    for (const block of o.content.filter(isObj)) {
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      if (ANTHROPIC_TOOL_BLOCKS.has(String(block.type)) && typeof block.name === "string") {
        toolCalls.push({ name: block.name, input: block.input ?? {}, id: str(block.id) });
      }
    }
  }

  if (Array.isArray(o.choices)) {
    for (const choice of o.choices.filter(isObj)) {
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

  for (const event of events.filter(isObj)) {
    // The Responses API ends with the full response object, which is the most reliable source.
    if (event.type === "response.completed" && isObj(event.response)) return fromBody(event.response);

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

    if (Array.isArray(event.choices)) {
      for (const choice of event.choices.filter(isObj)) {
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

  return { text: text.join(""), toolCalls: [...finish(anthropicTools), ...finish(chatTools)] };
}

export function readContent(body: RecordedBody): ResponseContent {
  if (body.type === "json" && isObj(body.value)) return fromBody(body.value);
  if (body.type === "sse") return fromEvents(parseSseData(body.chunks));
  return { text: "", toolCalls: [] };
}

/** Why the model stopped: `end_turn`, `tool_use`, `max_tokens`, `stop`, `length`, `completed`… */
export function stopReason(body: RecordedBody): string | undefined {
  const fromObj = (o: unknown): string | undefined => {
    if (!isObj(o)) return undefined;
    if (typeof o.stop_reason === "string") return o.stop_reason;
    if (isObj(o.delta) && typeof o.delta.stop_reason === "string") return o.delta.stop_reason;
    if (Array.isArray(o.choices)) {
      const reason = o.choices.filter(isObj).map((c) => c.finish_reason).find((r) => typeof r === "string");
      if (typeof reason === "string") return reason;
    }
    if (o.object === "response" && typeof o.status === "string") return o.status;
    if (o.type === "response.completed" && isObj(o.response)) return str(o.response.status);
    return undefined;
  };
  if (body.type === "json") return fromObj(body.value);
  if (body.type === "sse") return parseSseData(body.chunks).map(fromObj).filter(Boolean).pop();
  return undefined;
}
