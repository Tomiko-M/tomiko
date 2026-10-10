import { readContent } from "../inspect.js";
import { canonical } from "../match.js";
import { costOf, defaultPricing, priceFor } from "../pricing.js";
import type { CassetteFile, Interaction, PricingTable, RecordedBody, ToolCall, Usage } from "../types.js";
import { addUsage, detectProvider, emptyUsage, extractUsage, parseSseData } from "../usage.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export type PartView =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: unknown; id?: string }
  | { kind: "tool_result"; content: string; id?: string; isError?: boolean }
  | { kind: "image" }
  | { kind: "other"; label: string; value: unknown };

export interface MessageView {
  role: string;
  parts: PartView[];
}

export interface ToolView {
  name: string;
  description?: string;
}

export interface InteractionView {
  index: number;
  method: string;
  url: string;
  status: number;
  provider?: string;
  model?: string;
  recordedAt: string;
  durationMs: number;
  usage?: Usage;
  cost: number | null;
  system?: string;
  /** The system prompt is the same as in the previous request. */
  systemRepeated: boolean;
  tools: ToolView[];
  /** Leading messages identical to the previous request's, which are not repeated in `messages`. */
  earlierMessages: number;
  /** The previous response, sent back as history, is also left out of `messages`. */
  repeatsPreviousResponse: boolean;
  messages: MessageView[];
  response: {
    text: string;
    toolCalls: ToolCall[];
    stopReason?: string;
    streamed: boolean;
  };
  rawRequest: unknown;
  rawResponse: unknown;
}

export interface CassetteView {
  /** Path relative to the root the viewer was built from. */
  path: string;
  interactions: InteractionView[];
  usage: Usage;
  cost: number | null;
  unpricedModels: string[];
}

export interface ViewModel {
  generatedAt: string;
  root: string;
  cassettes: CassetteView[];
  usage: Usage;
  cost: number | null;
  requests: number;
}

/** Tool results and other content may be a string or a list of text blocks. */
function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObj(part) && typeof part.text === "string" ? part.text : isObj(part) ? `[${String(part.type)}]` : ""))
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function partsOf(content: unknown): PartView[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return content === undefined || content === null ? [] : [{ kind: "other", label: "content", value: content }];
  return content.filter(isObj).map((part): PartView => {
    switch (part.type) {
      case "text":
      case "input_text":
      case "output_text":
        return { kind: "text", text: str(part.text) ?? "" };
      case "tool_use":
      case "server_tool_use":
        return { kind: "tool_call", name: str(part.name) ?? "?", input: part.input, id: str(part.id) };
      case "tool_result":
        return { kind: "tool_result", content: flattenText(part.content), id: str(part.tool_use_id), isError: part.is_error === true };
      case "image":
      case "image_url":
      case "input_image":
        return { kind: "image" };
      default:
        return { kind: "other", label: String(part.type ?? "part"), value: part };
    }
  });
}

/** Anthropic Messages and OpenAI Chat Completions messages. */
function chatMessage(m: Obj): MessageView {
  const role = str(m.role) ?? "?";
  if (role === "tool") {
    return { role, parts: [{ kind: "tool_result", content: flattenText(m.content), id: str(m.tool_call_id) }] };
  }
  const parts = partsOf(m.content);
  for (const call of Array.isArray(m.tool_calls) ? m.tool_calls.filter(isObj) : []) {
    const fn = isObj(call.function) ? call.function : {};
    parts.push({ kind: "tool_call", name: str(fn.name) ?? "?", input: parseArgs(fn.arguments), id: str(call.id) });
  }
  return { role, parts };
}

/** OpenAI Responses API input items. */
function responsesItem(item: unknown): MessageView {
  if (typeof item === "string") return { role: "user", parts: [{ kind: "text", text: item }] };
  if (!isObj(item)) return { role: "?", parts: [{ kind: "other", label: "item", value: item }] };
  if (item.type === "function_call") {
    return { role: "assistant", parts: [{ kind: "tool_call", name: str(item.name) ?? "?", input: parseArgs(item.arguments), id: str(item.call_id) }] };
  }
  if (item.type === "function_call_output") {
    return { role: "tool", parts: [{ kind: "tool_result", content: flattenText(item.output), id: str(item.call_id) }] };
  }
  if (typeof item.role === "string") return { role: item.role, parts: partsOf(item.content) };
  return { role: "?", parts: [{ kind: "other", label: String(item.type ?? "item"), value: item }] };
}

interface RequestView {
  system?: string;
  rawMessages: unknown[];
  messages: MessageView[];
  tools: ToolView[];
}

function requestView(body: unknown): RequestView {
  if (!isObj(body)) return { rawMessages: [], messages: [], tools: [] };
  const tools = (Array.isArray(body.tools) ? body.tools.filter(isObj) : []).map((t): ToolView => {
    const fn = isObj(t.function) ? t.function : t;
    return { name: str(fn.name) ?? str(t.type) ?? "?", description: str(fn.description) };
  });

  if (Array.isArray(body.messages)) {
    const system = body.system === undefined ? undefined : flattenText(body.system);
    return { system, rawMessages: body.messages, messages: body.messages.filter(isObj).map(chatMessage), tools };
  }
  if (body.input !== undefined) {
    const items = Array.isArray(body.input) ? body.input : [body.input];
    return { system: str(body.instructions), rawMessages: items, messages: items.map(responsesItem), tools };
  }
  return { rawMessages: [], messages: [], tools };
}

function stopReason(body: RecordedBody): string | undefined {
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

function rawBody(body: RecordedBody): unknown {
  switch (body.type) {
    case "json":
    case "text":
      return body.value;
    case "sse":
      return body.chunks.join("");
    case "base64":
      return `(binary, ${Math.round((body.value.length * 3) / 4)} bytes)`;
    case "empty":
      return null;
  }
}

/** Length of the common prefix of two message lists. */
function sharedPrefix(previous: unknown[], current: unknown[]): number {
  let n = 0;
  while (n < previous.length && n < current.length && canonical(previous[n]) === canonical(current[n])) n++;
  return n;
}

function interactionView(interaction: Interaction, index: number, previous: RequestView | undefined, pricing: PricingTable) {
  const { request, response, meta } = interaction;
  const req = requestView(request.body);
  const { model: responseModel, usage } = extractUsage(response.body);
  const requestModel = isObj(request.body) ? str(request.body.model) : undefined;
  const model = responseModel ?? meta.model ?? requestModel;
  const price = model && usage ? priceFor(model, pricing) : undefined;
  const earlier = previous ? sharedPrefix(previous.rawMessages, req.rawMessages) : 0;
  // An agent loop sends the whole history back: the previous request's messages, then the
  // previous response as an assistant message. Only what follows is new.
  const repeatsPreviousResponse =
    previous !== undefined && earlier === previous.rawMessages.length && req.messages[earlier]?.role === "assistant";
  const fresh = earlier + (repeatsPreviousResponse ? 1 : 0);
  const view: InteractionView = {
    index,
    method: request.method,
    url: request.url,
    status: response.status,
    provider: meta.provider ?? detectProvider(request.url),
    model,
    recordedAt: meta.recordedAt,
    durationMs: meta.durationMs,
    usage,
    cost: usage && price ? costOf(usage, price) : null,
    system: req.system,
    systemRepeated: previous !== undefined && req.system !== undefined && previous.system === req.system,
    tools: req.tools,
    earlierMessages: earlier,
    repeatsPreviousResponse,
    messages: req.messages.slice(fresh),
    response: { ...readContent(response.body), stopReason: stopReason(response.body), streamed: response.body.type === "sse" },
    rawRequest: request.body,
    rawResponse: rawBody(response.body),
  };
  return { view, req };
}

export function cassetteView(path: string, file: CassetteFile, pricing: PricingTable = defaultPricing): CassetteView {
  const interactions: InteractionView[] = [];
  let previous: RequestView | undefined;
  file.interactions.forEach((interaction, i) => {
    const { view, req } = interactionView(interaction, i + 1, previous, pricing);
    interactions.push(view);
    previous = req;
  });
  const priced = interactions.filter((i) => i.cost !== null);
  const unpriced = interactions.filter((i) => i.usage && i.cost === null).map((i) => i.model ?? "(unknown model)");
  return {
    path,
    interactions,
    usage: interactions.reduce((u, i) => (i.usage ? addUsage(u, i.usage) : u), emptyUsage()),
    cost: priced.length > 0 ? priced.reduce((sum, i) => sum + (i.cost ?? 0), 0) : null,
    unpricedModels: [...new Set(unpriced)].sort(),
  };
}

export function viewModel(root: string, files: { path: string; data: CassetteFile }[], pricing?: PricingTable): ViewModel {
  const table = { ...defaultPricing, ...pricing };
  const cassettes = files.map((f) => cassetteView(f.path, f.data, table)).sort((a, b) => a.path.localeCompare(b.path));
  const priced = cassettes.filter((c) => c.cost !== null);
  return {
    generatedAt: new Date().toISOString(),
    root,
    cassettes,
    usage: cassettes.reduce((u, c) => addUsage(u, c.usage), emptyUsage()),
    cost: priced.length > 0 ? priced.reduce((sum, c) => sum + (c.cost ?? 0), 0) : null,
    requests: cassettes.reduce((n, c) => n + c.interactions.length, 0),
  };
}
