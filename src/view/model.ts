import { isMcp } from "../compare.js";
import { readableBody } from "../converse.js";
import type { FaultName } from "../faults.js";
import { type Injection, obeyed } from "../injection.js";
import { readContent, stopReason } from "../inspect.js";
import type { McpExchange, RpcMessage } from "../mcp.js";
import { canonical } from "../match.js";
import { costOf, defaultPricing, priceFor } from "../pricing.js";
import type { CassetteFile, Interaction, PricingTable, RecordedBody, RecordedCall, ToolCall, Usage } from "../types.js";
import { addUsage, detectProvider, emptyUsage, extractUsage, isStreamed, requestModel } from "../usage.js";

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

/** A request to an MCP server, as the viewer shows it. */
export interface McpView {
  /** The name the server gives itself, or the one cassettes know it by. */
  server: string;
  method: string;
  /** For `tools/call`: the tool and its arguments. */
  tool?: string;
  input?: unknown;
  /** What came back: text, images, resources. */
  output: PartView[];
  isError: boolean;
  /** A JSON-RPC or HTTP error instead of a result. */
  error?: string;
  /** For `tools/list`: the tools the server offers. */
  tools?: ToolView[];
  /** For `initialize`: who the server is and what it can do. */
  info?: string;
  /** Progress and log messages the server sent while it worked. */
  notes: string[];
}

export interface InteractionView {
  index: number;
  /** A judge's request, not one the code under test made. */
  judge: boolean;
  /** A fault that rewrote this answer for the test; the response shown is the real one. */
  fault?: FaultName;
  /** A request to an MCP server rather than to a model. */
  mcp?: McpView;
  /** Prompt injections that reach the model for the first time in this request. */
  injections?: Injection[];
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

/** How the model took the prompt injections in a cassette. */
export interface InjectionVerdict {
  attacks: Injection[];
  /** What it did that an attack asked for; empty when it resisted. */
  obeyed: { request: number; what: string }[];
}

export interface CassetteView {
  /** Path relative to the root the viewer was built from. */
  path: string;
  interactions: InteractionView[];
  /** Requests to models. */
  requests: number;
  /** Requests to MCP servers. */
  mcpCalls: number;
  usage: Usage;
  cost: number | null;
  unpricedModels: string[];
  injection?: InjectionVerdict;
}

export interface ViewModel {
  generatedAt: string;
  root: string;
  cassettes: CassetteView[];
  usage: Usage;
  cost: number | null;
  /** Requests to models. */
  requests: number;
  /** Requests to MCP servers. */
  mcpCalls: number;
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

/** Gemini `parts`: text, function calls and their results, inline files. */
function geminiParts(parts: unknown): PartView[] {
  return (Array.isArray(parts) ? parts.filter(isObj) : []).map((part): PartView => {
    if (typeof part.text === "string") return { kind: "text", text: part.text };
    if (isObj(part.functionCall)) return { kind: "tool_call", name: str(part.functionCall.name) ?? "?", input: part.functionCall.args, id: str(part.functionCall.id) };
    if (isObj(part.functionResponse)) {
      return { kind: "tool_result", content: flattenText(part.functionResponse.response), id: str(part.functionResponse.id) };
    }
    if (isObj(part.inlineData) || isObj(part.fileData)) return { kind: "image" };
    return { kind: "other", label: Object.keys(part)[0] ?? "part", value: part };
  });
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
  // Gemini: `contents` with `user` and `model` turns, the system prompt in `systemInstruction`.
  if (Array.isArray(body.contents)) {
    const instruction = body.systemInstruction ?? body.system_instruction;
    const system = isObj(instruction) ? geminiParts(instruction.parts).map((p) => (p.kind === "text" ? p.text : "")).join("\n") : str(instruction);
    const geminiTools = (Array.isArray(body.tools) ? body.tools.filter(isObj) : []).flatMap((t) => {
      const declarations = t.functionDeclarations ?? t.function_declarations;
      return (Array.isArray(declarations) ? declarations.filter(isObj) : []).map((d): ToolView => ({ name: str(d.name) ?? "?", description: str(d.description) }));
    });
    const messages = body.contents.filter(isObj).map((c): MessageView => ({
      role: c.role === "model" ? "assistant" : (str(c.role) ?? "user"),
      parts: geminiParts(c.parts),
    }));
    return { system, rawMessages: body.contents, messages, tools: geminiTools };
  }
  if (body.input !== undefined) {
    const items = Array.isArray(body.input) ? body.input : [body.input];
    return { system: str(body.instructions), rawMessages: items, messages: items.map(responsesItem), tools };
  }
  return { rawMessages: [], messages: [], tools };
}

function rawBody(body: RecordedBody): unknown {
  switch (body.type) {
    case "json":
    case "text":
      return body.value;
    case "sse":
      return body.chunks.join("");
    case "eventstream":
      return body.events;
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

/** Whether a history message is the previous response sent back, not one written into the request (a prefill). */
function isResponse(message: MessageView | undefined, response: { text: string; toolCalls: ToolCall[] }): boolean {
  if (!message || message.role !== "assistant") return false;
  const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("").trim();
  const calls = message.parts.flatMap((p) => (p.kind === "tool_call" ? [p.name] : []));
  return text === response.text.trim() && calls.join("\0") === response.toolCalls.map((t) => t.name).join("\0");
}

function interactionView(
  interaction: Interaction,
  index: number,
  previous: (RequestView & { response: { text: string; toolCalls: ToolCall[] } }) | undefined,
  pricing: PricingTable,
) {
  const { request, response, meta } = interaction;
  const req = requestView(readableBody(request));
  const { model: responseModel, usage } = extractUsage(response.body, response.headers);
  const model = responseModel ?? meta.model ?? requestModel(request);
  const price = model && usage ? priceFor(model, pricing) : undefined;
  const earlier = previous ? sharedPrefix(previous.rawMessages, req.rawMessages) : 0;
  // An agent loop sends the whole history back: the previous request's messages, then the
  // previous response as an assistant message. Only what follows is new.
  const repeatsPreviousResponse =
    previous !== undefined && earlier === previous.rawMessages.length && isResponse(req.messages[earlier], previous.response);
  const fresh = earlier + (repeatsPreviousResponse ? 1 : 0);
  const view: InteractionView = {
    index,
    judge: meta.judge === true,
    fault: meta.fault,
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
    response: { ...readContent(response.body), stopReason: stopReason(response.body), streamed: isStreamed(response.body) },
    rawRequest: request.body,
    rawResponse: rawBody(response.body),
  };
  return { view, req };
}

/** Parts of an MCP result: a tool's content, a resource's contents, a prompt's messages. */
function mcpParts(result: unknown): PartView[] {
  if (!isObj(result)) return result === undefined ? [] : [{ kind: "other", label: "result", value: result }];
  const fromContent = (part: unknown): PartView => {
    if (!isObj(part)) return { kind: "other", label: "content", value: part };
    if (typeof part.text === "string") return { kind: "text", text: part.text };
    if (part.type === "image" || part.type === "audio") return { kind: "image" };
    if (isObj(part.resource) && typeof part.resource.text === "string") return { kind: "text", text: part.resource.text };
    return { kind: "other", label: str(part.type) ?? "content", value: part };
  };
  if (Array.isArray(result.content)) {
    const parts = result.content.map(fromContent);
    if (parts.length === 0 && result.structuredContent !== undefined) return [{ kind: "other", label: "structured content", value: result.structuredContent }];
    return parts;
  }
  if (Array.isArray(result.contents)) return result.contents.map(fromContent);
  if (Array.isArray(result.messages)) {
    return result.messages.filter(isObj).map((m) => (isObj(m.content) ? fromContent(m.content) : { kind: "other", label: "message", value: m }));
  }
  return [{ kind: "other", label: "result", value: result }];
}

function mcpNote(m: RpcMessage): string {
  const params = isObj(m.params) ? m.params : {};
  if (m.method === "notifications/progress") {
    const of = typeof params.total === "number" ? `/${params.total}` : "";
    return `progress ${String(params.progress)}${of}${typeof params.message === "string" ? ` · ${params.message}` : ""}`;
  }
  if (m.method === "notifications/message") return `log (${String(params.level ?? "info")}): ${typeof params.data === "string" ? params.data : JSON.stringify(params.data)}`;
  return m.id !== undefined ? `asked the client: ${String(m.method)}` : String(m.method);
}

function mcpView(interaction: Interaction): McpView {
  const { request, response, meta } = interaction;
  const [, id = "mcp", method = "?"] = /^mcp:\/\/([^/]+)\/(.+)$/.exec(request.url) ?? [];
  const params = isObj(request.body) ? request.body : undefined;
  const exchange = (response.body.type === "json" && isObj(response.body.value) ? response.body.value : {}) as McpExchange;
  const result = isObj(exchange.result) ? exchange.result : undefined;
  const view: McpView = {
    server: meta.server ?? id,
    method,
    output: [],
    isError: exchange.error !== undefined || exchange.http !== undefined || result?.isError === true,
    notes: (exchange.messages ?? []).map(mcpNote),
  };
  if (exchange.error) view.error = `error ${exchange.error.code}: ${exchange.error.message}`;
  else if (exchange.http) view.error = `HTTP ${exchange.http.status}${exchange.http.body ? `: ${exchange.http.body.slice(0, 200)}` : ""}`;
  if (method === "tools/call" && params && typeof params.name === "string") {
    view.tool = params.name;
    view.input = params.arguments ?? {};
  } else if (params) view.input = params;
  if (method === "tools/list" && result && Array.isArray(result.tools)) {
    view.tools = result.tools.filter(isObj).map((t) => ({ name: str(t.name) ?? "?", description: str(t.description) }));
  } else if ((method === "initialize" || method === "server/discover") && result) {
    const info = isObj(result.serverInfo) ? result.serverInfo : isObj(result._meta) && isObj(result._meta["io.modelcontextprotocol/serverInfo"]) ? result._meta["io.modelcontextprotocol/serverInfo"] : {};
    const capabilities = isObj(result.capabilities) ? Object.keys(result.capabilities) : [];
    const version = str(result.protocolVersion) ?? (Array.isArray(result.supportedVersions) ? result.supportedVersions.join(", ") : undefined);
    view.info = [[str(info.name), str(info.version)].filter(Boolean).join(" "), version && `protocol ${version}`, capabilities.length > 0 && capabilities.join(", ")].filter(Boolean).join(" · ");
    if (typeof result.instructions === "string") view.output = [{ kind: "text", text: result.instructions }];
  } else if (!view.error) view.output = mcpParts(exchange.result);
  return view;
}

/** What the model did with the prompt injections in a cassette, read as assertions read it. */
function verdictOf(file: CassetteFile): InjectionVerdict | undefined {
  const calls = file.interactions
    .filter((i) => !isMcp(i) && !i.meta.judge)
    .map((i): RecordedCall => ({
      position: file.interactions.indexOf(i) + 1,
      method: i.request.method,
      url: i.request.url,
      requestBody: i.request.body,
      status: i.response.status,
      replayed: true,
      ...(i.meta.injections ? { injections: i.meta.injections } : {}),
      cost: null,
      ...readContent(i.response.body),
    }));
  const attacks = new Map<string, Injection>();
  for (const call of calls) for (const attack of call.injections ?? []) attacks.set(attack.canary, attack);
  if (attacks.size === 0) return undefined;
  return { attacks: [...attacks.values()], obeyed: obeyed(calls).map((o) => ({ request: o.call, what: o.what })) };
}

export function cassetteView(path: string, file: CassetteFile, pricing: PricingTable = defaultPricing): CassetteView {
  const interactions: InteractionView[] = [];
  let previous: (RequestView & { response: { text: string; toolCalls: ToolCall[] } }) | undefined;
  const seen = new Set<string>();
  file.interactions.forEach((interaction, i) => {
    if (isMcp(interaction)) {
      const { request, response, meta } = interaction;
      interactions.push({
        index: i + 1,
        judge: false,
        mcp: mcpView(interaction),
        method: request.method,
        url: request.url,
        status: response.status,
        provider: "mcp",
        recordedAt: meta.recordedAt,
        durationMs: meta.durationMs,
        cost: null,
        systemRepeated: false,
        tools: [],
        earlierMessages: 0,
        repeatsPreviousResponse: false,
        messages: [],
        response: { text: "", toolCalls: [], streamed: false },
        rawRequest: request.body,
        rawResponse: rawBody(response.body),
      });
      return;
    }
    const { view, req } = interactionView(interaction, i + 1, previous, pricing);
    const fresh = (interaction.meta.injections ?? []).filter((attack) => !seen.has(attack.canary));
    for (const attack of fresh) seen.add(attack.canary);
    if (fresh.length > 0) view.injections = fresh;
    interactions.push(view);
    previous = { ...req, response: view.response };
  });
  const priced = interactions.filter((i) => i.cost !== null);
  const unpriced = interactions.filter((i) => i.usage && i.cost === null).map((i) => i.model ?? "(unknown model)");
  const injection = verdictOf(file);
  const mcpCalls = interactions.filter((i) => i.mcp).length;
  return {
    path,
    interactions,
    requests: interactions.length - mcpCalls,
    mcpCalls,
    usage: interactions.reduce((u, i) => (i.usage ? addUsage(u, i.usage) : u), emptyUsage()),
    cost: priced.length > 0 ? priced.reduce((sum, i) => sum + (i.cost ?? 0), 0) : null,
    unpricedModels: [...new Set(unpriced)].sort(),
    ...(injection ? { injection } : {}),
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
    requests: cassettes.reduce((n, c) => n + c.requests, 0),
    mcpCalls: cassettes.reduce((n, c) => n + c.mcpCalls, 0),
  };
}
