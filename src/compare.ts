/**
 * Compares two recordings of the same tests by what the model did rather than by their bytes:
 * which tools it called and with what, why it stopped, what it answered, and what that cost.
 * Ids, signatures, timestamps and other values that change with every recording are ignored.
 */
import { readableBody } from "./converse.js";
import { readContent, stopReason } from "./inspect.js";
import { canonical, diff, type DiffEntry } from "./match.js";
import { costOf, defaultPricing, priceFor } from "./pricing.js";
import type { CassetteFile, Interaction, PricingTable, Usage } from "./types.js";
import { addUsage, emptyUsage, extractUsage, requestModel } from "./usage.js";
import { diffWords, type Piece } from "./words.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * How much a change matters, most first:
 * - `behavior`  the model did something else: other tools or arguments, another stop reason or
 *               status, different data in a JSON answer, more or fewer requests
 * - `wording`   the same behavior, in other words
 * - `request`   only what was sent changed (a prompt or a parameter); the answer is the same
 * - `none`      nothing that matters; ids and timestamps aside, the recordings are the same
 */
export type Impact = "behavior" | "wording" | "request" | "none";
const IMPACTS: readonly Impact[] = ["behavior", "wording", "request", "none"];
const worst = (impacts: Impact[]): Impact => IMPACTS.find((i) => impacts.includes(i)) ?? "none";

export interface Change<T> {
  before: T;
  after: T;
}

export interface TextChange {
  before: string;
  after: string;
  /** Share of words the two texts have in common, in [0, 1]. */
  similarity: number;
  pieces: Piece[];
}

export interface ToolInputChange {
  name: string;
  /** Which call to this tool, counting from 0, when the model called it more than once. */
  occurrence: number;
  changes: DiffEntry[];
}

export interface ToolsChange {
  /** Tool names in call order. */
  before: string[];
  after: string[];
  /** Calls to the same tool, in the same position among its calls, with other arguments. */
  inputs: ToolInputChange[];
}

export interface RequestChanges {
  model?: Change<string | undefined>;
  /** System prompt or instructions. */
  system?: TextChange;
  /** What the user turns say. */
  prompt?: TextChange;
  /** Top-level parameters: `temperature`, `max_tokens`, `tool_choice`… */
  params: DiffEntry[];
  tools: { added: string[]; removed: string[]; changed: string[] };
  /** Earlier turns, tool results or attachments differ. */
  history: boolean;
}

export interface ResponseChanges {
  status?: Change<number>;
  stopReason?: Change<string | undefined>;
  tools?: ToolsChange;
  /** The answer is JSON on both sides: what changed in it. */
  data?: DiffEntry[];
  /** The answer went from JSON to prose or back. */
  format?: Change<"json" | "text">;
  text?: TextChange;
}

/** One recorded response, as compared. */
export interface Side {
  status: number;
  model?: string;
  stopReason?: string;
  /** The model's text, or the error message of a failed request. */
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage?: Usage;
  cost: number | null;
  durationMs: number;
}

export interface RequestDiff {
  /** 1-based position in the new recording, or in the old one for a request that is gone. */
  index: number;
  /** 1-based position in the old recording. */
  beforeIndex?: number;
  status: "added" | "removed" | "changed" | "unchanged";
  impact: Impact;
  method: string;
  url: string;
  before?: Side;
  after?: Side;
  request?: RequestChanges;
  response?: ResponseChanges;
}

export interface Totals {
  requests: number;
  usage: Usage;
  /** USD, or null when no model had a known price. */
  cost: number | null;
  durationMs: number;
  unpricedModels: string[];
}

export interface CassetteDiff {
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  impact: Impact;
  requests: RequestDiff[];
  before?: Totals;
  after?: Totals;
}

export interface DiffOptions {
  /** Merged over the built-in pricing table. */
  pricing?: PricingTable;
}

/* -------------------------------------------------------------------------------------------- */

/** Values each recording mints anew: message, tool call and response ids. */
const GENERATED_ID = /^(?:msg|toolu|tooluse|srvtoolu|mcptoolu|call|fc|resp|rs|ws|ci|ctc|chatcmpl|run|step|req|file|conv|batch|asst|thread|cntr|container)[_-][A-Za-z0-9_-]{6,}$/;
/** Fields that hold such ids. A tool's own arguments (`"script": "run-unit-tests"`) are left alone. */
const ID_KEY = /^(?:id|call_id|tool_use_id|tool_call_id|toolUseId|previous_response_id|item_id|file_id|container|container_id|conversation|conversation_id|batch_id|thread_id|assistant_id|run_id)$/;
/** Thinking signatures and encrypted reasoning, sent back verbatim in later turns. */
const OPAQUE = new Set(["signature", "encrypted_content"]);

function stable(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key !== undefined && ID_KEY.test(key) && GENERATED_ID.test(value) ? "<id>" : value;
  if (Array.isArray(value)) return value.map((item) => stable(item, key));
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = OPAQUE.has(k) && typeof v === "string" ? "<opaque>" : stable(v, k);
    return out;
  }
  return value;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObj(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : canonical(content);
}

interface RequestParts {
  model?: string;
  system: string[];
  prompt: string[];
  history: unknown[];
  tools: Map<string, string>;
  params: Obj;
}

/** Keys that hold the conversation; everything else at the top level is a parameter. */
const CONVERSATION = new Set(["model", "system", "messages", "tools", "input", "instructions", "contents", "systemInstruction", "system_instruction"]);
const TEXT_PARTS = new Set(["text", "input_text"]);

function userTurn(content: unknown, parts: RequestParts): void {
  if (typeof content === "string") return void parts.prompt.push(content);
  for (const block of Array.isArray(content) ? content : [content]) {
    if (isObj(block) && TEXT_PARTS.has(String(block.type)) && typeof block.text === "string") parts.prompt.push(block.text);
    else if (block !== undefined) parts.history.push(block);
  }
}

function withoutCallIds(node: unknown): unknown {
  if (Array.isArray(node)) node.forEach(withoutCallIds);
  else if (isObj(node)) {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "functionCall" || key === "functionResponse") && isObj(value)) delete value.id;
      withoutCallIds(value);
    }
  }
  return node;
}

/** Gemini turns: text in `parts`, function results among them, the model's own turns as `model`. */
function geminiTurns(body: Obj, parts: RequestParts): void {
  const instruction = body.systemInstruction ?? body.system_instruction;
  if (isObj(instruction)) parts.system.push(textOf(instruction.parts));
  else if (typeof instruction === "string") parts.system.push(instruction);
  for (const turn of Array.isArray(body.contents) ? body.contents.filter(isObj) : []) {
    if (turn.role === "model") {
      parts.history.push(turn);
      continue;
    }
    for (const part of Array.isArray(turn.parts) ? turn.parts : []) {
      if (isObj(part) && typeof part.text === "string") parts.prompt.push(part.text);
      else parts.history.push(part);
    }
  }
  // Ids clients make up for Gemini's function calls change with every recording.
  parts.history = parts.history.map((item) => withoutCallIds(structuredClone(item)));
  for (const tool of Array.isArray(body.tools) ? body.tools.filter(isObj) : []) {
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    for (const d of Array.isArray(declarations) ? declarations.filter(isObj) : []) parts.tools.set(str(d.name) ?? canonical(d), canonical(d));
  }
}

/** Splits a request into what you wrote (system prompt, user turns, tools, parameters) and history. */
function requestParts(request: { url: string; body?: unknown }): RequestParts {
  const body = readableBody(request);
  const parts: RequestParts = { system: [], prompt: [], history: [], tools: new Map(), params: {} };
  parts.model = requestModel(request);
  if (!isObj(body)) {
    if (body !== undefined) parts.prompt.push(typeof body === "string" ? body : canonical(body));
    return parts;
  }
  if (Array.isArray(body.contents)) {
    geminiTurns(body, parts);
    for (const [key, value] of Object.entries(body)) if (!CONVERSATION.has(key)) parts.params[key] = value;
    return parts;
  }
  if (body.system !== undefined) parts.system.push(textOf(body.system));
  if (typeof body.instructions === "string") parts.system.push(body.instructions);

  // Anthropic Messages and Chat Completions use `messages`; the Responses API uses `input`.
  const turns = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  if (typeof body.input === "string") parts.prompt.push(body.input);
  for (const turn of turns) {
    if (typeof turn === "string") parts.prompt.push(turn);
    else if (!isObj(turn)) continue;
    else if (turn.role === "system" || turn.role === "developer") parts.system.push(textOf(turn.content));
    else if (turn.role === "user" && (turn.type === undefined || turn.type === "message")) userTurn(turn.content, parts);
    else parts.history.push(turn);
  }

  for (const tool of Array.isArray(body.tools) ? body.tools.filter(isObj) : []) {
    const fn = isObj(tool.function) ? tool.function : tool;
    parts.tools.set(str(fn.name) ?? str(tool.type) ?? canonical(tool), canonical(tool));
  }
  for (const [key, value] of Object.entries(body)) if (!CONVERSATION.has(key)) parts.params[key] = value;
  return parts;
}

function textChange(before: string, after: string): TextChange | undefined {
  if (before === after) return undefined;
  const { pieces, similarity } = diffWords(before, after);
  // Only whitespace moved, or came or went at the end.
  if (pieces.every((p) => p.op === "=" || !p.text.trim())) return undefined;
  return { before, after, similarity, pieces };
}

function compareRequests(a: RequestParts, b: RequestParts): RequestChanges | undefined {
  const changes: RequestChanges = {
    params: diff(stable(a.params), stable(b.params)),
    tools: {
      added: [...b.tools.keys()].filter((name) => !a.tools.has(name)),
      removed: [...a.tools.keys()].filter((name) => !b.tools.has(name)),
      changed: [...b.tools.keys()].filter((name) => a.tools.has(name) && a.tools.get(name) !== b.tools.get(name)),
    },
    history: canonical(stable(a.history)) !== canonical(stable(b.history)),
  };
  if (a.model !== b.model) changes.model = { before: a.model, after: b.model };
  const system = textChange(a.system.join("\n\n"), b.system.join("\n\n"));
  if (system) changes.system = system;
  const prompt = textChange(a.prompt.join("\n\n"), b.prompt.join("\n\n"));
  if (prompt) changes.prompt = prompt;
  const { tools } = changes;
  const changed =
    changes.model || system || prompt || changes.params.length > 0 || changes.history ||
    tools.added.length + tools.removed.length + tools.changed.length > 0;
  return changed ? changes : undefined;
}

/** The answer as data when it is JSON, also inside a Markdown code fence. */
function asData(text: string): unknown {
  // Found with indexOf: a regex over an unclosed fence followed by whitespace is quadratic.
  let body = text.trim();
  if (body.startsWith("```")) {
    const open = body.indexOf("\n");
    const close = body.lastIndexOf("```");
    if (open === -1 || close <= open || !/^```(?:json)?[ \t]*\r?$/.test(body.slice(0, open))) return undefined;
    body = body.slice(open + 1, close).trim();
  }
  // A bare JSON value, `true` or `42`, is data too.
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(body)) return JSON.parse(body);
  if (!/^[[{]/.test(body)) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function compareTools(a: Side["toolCalls"], b: Side["toolCalls"]): ToolsChange | undefined {
  const before = a.map((t) => t.name);
  const after = b.map((t) => t.name);
  const inputs: ToolInputChange[] = [];
  const seen = new Map<string, number>();
  for (const call of b) {
    const occurrence = seen.get(call.name) ?? 0;
    seen.set(call.name, occurrence + 1);
    const earlier = a.filter((t) => t.name === call.name)[occurrence];
    if (!earlier) continue;
    const changes = diff(stable(earlier.input), stable(call.input));
    if (changes.length > 0) inputs.push({ name: call.name, occurrence, changes });
  }
  if (canonical(before) === canonical(after) && inputs.length === 0) return undefined;
  return { before, after, inputs };
}

function compareResponses(a: Side, b: Side): ResponseChanges | undefined {
  const changes: ResponseChanges = {};
  if (a.status !== b.status) changes.status = { before: a.status, after: b.status };
  if (a.stopReason !== b.stopReason) changes.stopReason = { before: a.stopReason, after: b.stopReason };
  const tools = compareTools(a.toolCalls, b.toolCalls);
  if (tools) changes.tools = tools;
  const dataA = asData(a.text);
  const dataB = asData(b.text);
  if (dataA !== undefined && dataB !== undefined) {
    const entries = diff(dataA, dataB);
    if (entries.length > 0) changes.data = entries;
  } else {
    if ((dataA === undefined) !== (dataB === undefined)) {
      changes.format = { before: dataA === undefined ? "text" : "json", after: dataB === undefined ? "text" : "json" };
    }
    const text = textChange(a.text, b.text);
    if (text) changes.text = text;
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

function impactOf(request: RequestChanges | undefined, response: ResponseChanges | undefined): Impact {
  if (response) {
    const { status, stopReason, tools, data, format } = response;
    return status || stopReason || tools || data || format ? "behavior" : "wording";
  }
  return request ? "request" : "none";
}

function errorMessage(interaction: Interaction): string {
  const body = interaction.response.body;
  if (body.type === "json") {
    const value = body.value;
    if (isObj(value) && isObj(value.error) && typeof value.error.message === "string") return value.error.message;
    if (isObj(value) && typeof value.message === "string") return value.message;
    return canonical(value);
  }
  return body.type === "text" ? body.value : "";
}

export function sideOf(interaction: Interaction, pricing: PricingTable): Side {
  const { request, response, meta } = interaction;
  const content = readContent(response.body);
  const { model: responseModel, usage } = extractUsage(response.body, response.headers);
  const model = responseModel ?? meta.model ?? requestModel(request);
  const price = model && usage ? priceFor(model, pricing) : undefined;
  return {
    status: response.status,
    model,
    stopReason: stopReason(response.body),
    text: response.status >= 400 && !content.text ? errorMessage(interaction) : content.text,
    toolCalls: content.toolCalls.map(({ name, input }) => ({ name, input })),
    usage,
    cost: usage && price ? costOf(usage, price) : null,
    durationMs: meta.durationMs,
  };
}

/**
 * Requests are paired per endpoint in recording order: the third call to an API with the third.
 * Gemini's model is part of the path, so a switch of model is a change, not another endpoint.
 */
function endpoint(interaction: Interaction): string {
  try {
    const url = new URL(interaction.request.url);
    // Ids minted per run (`/v1/responses/resp_68a1…`) don't make another endpoint.
    const path = url.pathname
      .replace(/\/models\/[^/:]+:/, "/models/*:")
      .split("/")
      .map((segment) => (GENERATED_ID.test(segment) ? "<id>" : segment))
      .join("/");
    return `${interaction.request.method} ${url.host}${path}`;
  } catch {
    return `${interaction.request.method} ${interaction.request.url}`;
  }
}

function pair(before: Interaction[], after: Interaction[]): { a?: number; b?: number }[] {
  const queues = new Map<string, number[]>();
  before.forEach((interaction, i) => {
    const key = endpoint(interaction);
    queues.set(key, [...(queues.get(key) ?? []), i]);
  });
  const pairs = after.map((interaction, b) => ({ a: queues.get(endpoint(interaction))?.shift(), b }));
  const gone = [...queues.values()].flat().sort((x, y) => x - y);
  return [...pairs, ...gone.map((a) => ({ a }))];
}

function totals(sides: Side[]): Totals {
  const priced = sides.filter((s) => s.cost !== null);
  return {
    requests: sides.length,
    usage: sides.reduce((u, s) => (s.usage ? addUsage(u, s.usage) : u), emptyUsage()),
    cost: priced.length > 0 ? priced.reduce((sum, s) => sum + (s.cost ?? 0), 0) : null,
    durationMs: sides.reduce((sum, s) => sum + s.durationMs, 0),
    unpricedModels: [...new Set(sides.filter((s) => s.usage && s.cost === null).map((s) => s.model ?? "(unknown model)"))].sort(),
  };
}

/**
 * What changed between two recordings of a cassette. Pass `undefined` for a cassette that is new
 * (`before`) or gone (`after`).
 */
export function diffCassettes(
  path: string,
  before: CassetteFile | undefined,
  after: CassetteFile | undefined,
  options: DiffOptions = {},
): CassetteDiff {
  const pricing = { ...defaultPricing, ...options.pricing };
  const a = before?.interactions ?? [];
  const b = after?.interactions ?? [];
  const sidesA = a.map((i) => sideOf(i, pricing));
  const sidesB = b.map((i) => sideOf(i, pricing));

  const requests = pair(a, b).map(({ a: ia, b: ib }): RequestDiff => {
    const old = ia === undefined ? undefined : a[ia];
    const now = ib === undefined ? undefined : b[ib];
    const { method, url } = (now ?? old)!.request;
    const base = { index: (ib ?? ia)! + 1, ...(ia === undefined ? {} : { beforeIndex: ia + 1 }), method, url };
    if (!old) return { ...base, status: "added", impact: "behavior", after: sidesB[ib!] };
    if (!now) return { ...base, status: "removed", impact: "behavior", before: sidesA[ia!] };
    const sideA = sidesA[ia!]!;
    const sideB = sidesB[ib!]!;
    const request = compareRequests(requestParts(old.request), requestParts(now.request));
    const response = compareResponses(sideA, sideB);
    const impact = impactOf(request, response);
    return {
      ...base,
      status: impact === "none" ? "unchanged" : "changed",
      impact,
      before: sideA,
      after: sideB,
      ...(request ? { request } : {}),
      ...(response ? { response } : {}),
    };
  });

  const status = !before ? "added" : !after ? "removed" : requests.some((r) => r.status !== "unchanged") ? "changed" : "unchanged";
  return {
    path,
    status,
    impact: worst(requests.map((r) => r.impact)),
    requests,
    ...(before ? { before: totals(sidesA) } : {}),
    ...(after ? { after: totals(sidesB) } : {}),
  };
}

export interface DiffSummary {
  cassettes: number;
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
  /** Changed cassettes by their most important change. */
  impact: Record<Exclude<Impact, "none">, number>;
  /** Over the cassettes that exist on each side. */
  before: Totals;
  after: Totals;
}

function sumTotals(list: Totals[]): Totals {
  const priced = list.filter((t) => t.cost !== null);
  return {
    requests: list.reduce((n, t) => n + t.requests, 0),
    usage: list.reduce((u, t) => addUsage(u, t.usage), emptyUsage()),
    cost: priced.length > 0 ? priced.reduce((sum, t) => sum + (t.cost ?? 0), 0) : null,
    durationMs: list.reduce((n, t) => n + t.durationMs, 0),
    unpricedModels: [...new Set(list.flatMap((t) => t.unpricedModels))].sort(),
  };
}

export function summarizeDiff(cassettes: readonly CassetteDiff[]): DiffSummary {
  const count = (status: CassetteDiff["status"]) => cassettes.filter((c) => c.status === status).length;
  const changed = cassettes.filter((c) => c.status === "changed");
  return {
    cassettes: cassettes.length,
    changed: changed.length,
    added: count("added"),
    removed: count("removed"),
    unchanged: count("unchanged"),
    impact: {
      behavior: changed.filter((c) => c.impact === "behavior").length,
      wording: changed.filter((c) => c.impact === "wording").length,
      request: changed.filter((c) => c.impact === "request").length,
    },
    before: sumTotals(cassettes.flatMap((c) => (c.before ? [c.before] : []))),
    after: sumTotals(cassettes.flatMap((c) => (c.after ? [c.after] : []))),
  };
}
