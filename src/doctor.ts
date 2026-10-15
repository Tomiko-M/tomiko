/**
 * Reads recordings for money left on the table: prompts that can't be cached, tools nobody calls,
 * tool results resent on every turn, requests sent twice, and token limits far above what answers
 * use. Each finding comes with what it costs one live run of the tests, which is also what the
 * same pattern costs your app per conversation like them.
 */
import { isMcp } from "./compare.js";
import { readableBody } from "./converse.js";
import { readContent, stopReason } from "./inspect.js";
import { canonical } from "./match.js";
import { costOf, defaultPricing, priceFor } from "./pricing.js";
import type { CassetteFile, Interaction, ModelPrice, PricingTable } from "./types.js";
import { extractUsage, requestModel } from "./usage.js";
import { diffWords, type Piece } from "./words.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Tokens in a text, roughly: about four characters each. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type FindingKind = "volatile-prompt" | "unused-tools" | "large-tool-result" | "duplicate-request" | "max-tokens";

export interface Where {
  path: string;
  /** 1-based request positions in the cassette. */
  requests: number[];
}

export interface Finding {
  kind: FindingKind;
  /** USD one run of the tests spends on this that it needn't. 0 when it is a risk rather than a cost. */
  waste: number;
  /**
   * The part of `waste` another finding also counts: tokens in a prompt that can't be cached
   * would cost little to resend once it can be. Totals leave it out.
   */
  overlap: number;
  /** For a risk: the most it could cost, in USD. */
  risk?: number;
  /** Tokens involved, for context. */
  tokens: number;
  where: Where[];
  /** Kind-specific details. */
  detail: {
    tools?: string[];
    tool?: string;
    sends?: number;
    limit?: number;
    used?: number;
    /** The changing part of a prompt, as a word diff. */
    change?: Piece[];
  };
}

export interface Diagnosis {
  cassettes: number;
  requests: number;
  /** USD one live run of these recordings costs. */
  cost: number;
  /** What fixing everything would save a run, each token counted once. */
  savings: number;
  findings: Finding[];
  /** Models without a price, whose waste is counted in tokens only. */
  unpriced: string[];
}

interface Request {
  path: string;
  index: number;
  interaction: Interaction;
  model?: string;
  price?: ModelPrice;
  /** Input tokens the request was billed for, cached or not. */
  input: number;
  /** Of those, read from the prompt cache. */
  cached: number;
  /** What its input cost, per token, cached and uncached together. */
  rate: number;
  output: number;
  cost: number;
  system: string;
  tools: Map<string, string>;
  results: { name: string; key: string; tokens: number }[];
  limit?: number;
}

/* ----------------------------------------- reading ----------------------------------------- */

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : isObj(p) ? "" : String(p))).join("\n");
  return content === undefined ? "" : JSON.stringify(content);
}

/** The system prompt in each API's place for it. */
function systemOf(body: Obj): string {
  const parts: string[] = [];
  if (body.system !== undefined) parts.push(textOf(body.system));
  if (typeof body.instructions === "string") parts.push(body.instructions);
  const instruction = body.systemInstruction ?? body.system_instruction;
  if (isObj(instruction)) parts.push(textOf(instruction.parts));
  for (const m of Array.isArray(body.messages) ? body.messages.filter(isObj) : []) {
    if (m.role === "system" || m.role === "developer") parts.push(textOf(m.content));
  }
  return parts.join("\n\n");
}

/** Tool definitions by name, as sent. */
function toolsOf(body: Obj): Map<string, string> {
  const tools = new Map<string, string>();
  for (const tool of Array.isArray(body.tools) ? body.tools.filter(isObj) : []) {
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(declarations)) {
      for (const d of declarations.filter(isObj)) tools.set(str(d.name) ?? "?", JSON.stringify(d));
      continue;
    }
    const fn = isObj(tool.function) ? tool.function : tool;
    const name = str(fn.name);
    if (name) tools.set(name, JSON.stringify(tool));
  }
  return tools;
}

/** Tool results sent back to the model, with the name of the tool that produced each. */
function resultsOf(body: Obj): Request["results"] {
  const names = new Map<string, string>();
  const results: Request["results"] = [];
  const add = (name: string, content: unknown) => {
    const text = textOf(content);
    results.push({ name, key: `${name}\0${text}`, tokens: estimateTokens(text) });
  };
  const turns = [...(Array.isArray(body.messages) ? body.messages : []), ...(Array.isArray(body.input) ? body.input : [])].filter(isObj);
  for (const turn of turns) {
    // Calls first, so results can be named after them.
    for (const block of Array.isArray(turn.content) ? turn.content.filter(isObj) : []) {
      if (block.type === "tool_use" && typeof block.id === "string") names.set(block.id, str(block.name) ?? "?");
    }
    for (const call of Array.isArray(turn.tool_calls) ? turn.tool_calls.filter(isObj) : []) {
      const fn = isObj(call.function) ? call.function : {};
      if (typeof call.id === "string") names.set(call.id, str(fn.name) ?? "?");
    }
    if (turn.type === "function_call" && typeof turn.call_id === "string") names.set(turn.call_id, str(turn.name) ?? "?");

    for (const block of Array.isArray(turn.content) ? turn.content.filter(isObj) : []) {
      if (block.type === "tool_result") add(names.get(str(block.tool_use_id) ?? "") ?? "a tool", block.content);
    }
    if (turn.role === "tool") add(names.get(str(turn.tool_call_id) ?? "") ?? "a tool", turn.content);
    if (turn.type === "function_call_output") add(names.get(str(turn.call_id) ?? "") ?? "a tool", turn.output);
  }
  for (const turn of Array.isArray(body.contents) ? body.contents.filter(isObj) : []) {
    for (const part of Array.isArray(turn.parts) ? turn.parts.filter(isObj) : []) {
      if (isObj(part.functionResponse)) add(str(part.functionResponse.name) ?? "a tool", part.functionResponse.response);
    }
  }
  return results;
}

function limitOf(body: Obj): number | undefined {
  const config = isObj(body.generationConfig) ? body.generationConfig : {};
  const limit = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? config.maxOutputTokens;
  return typeof limit === "number" ? limit : undefined;
}

function read(path: string, file: CassetteFile, pricing: PricingTable): Request[] {
  return file.interactions.map((interaction, i) => {
    const readable = readableBody(interaction.request);
    const body = isObj(readable) ? readable : {};
    const { model: answered, usage } = extractUsage(interaction.response.body, interaction.response.headers);
    const model = answered ?? interaction.meta.model ?? requestModel(interaction.request);
    const price = model ? priceFor(model, pricing) : undefined;
    const input = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
    const inputCost = usage && price ? costOf({ ...usage, outputTokens: 0 }, price) : 0;
    return {
      path,
      index: i + 1,
      interaction,
      model,
      price,
      input,
      cached: usage?.cacheReadTokens ?? 0,
      rate: input > 0 && inputCost > 0 ? inputCost / input : (price?.input ?? 0) / 1e6,
      output: usage?.outputTokens ?? 0,
      cost: usage && price ? costOf(usage, price) : 0,
      system: systemOf(body),
      tools: toolsOf(body),
      results: resultsOf(body),
      limit: limitOf(body),
    };
  });
}

/* ----------------------------------------- checks ------------------------------------------ */

const inputPrice = (r: Request) => (r.price?.input ?? 0) / 1e6;
const cachedPrice = (r: Request) => (r.price ? (r.price.cacheRead ?? r.price.input * 0.1) : 0) / 1e6;

/** Dates, times, timestamps, ids and counters: what makes a prompt differ on every request. */
const VOLATILE = /^[\s\d:.,\-+/TZ]*$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Consecutive requests whose system prompts differ only in a timestamp or id, which breaks caching. */
function volatilePrompts(byCassette: Request[][], uncached: Set<Request>, repeated: Set<Request>): Finding[] {
  const findings: Finding[] = [];
  for (const requests of byCassette) {
    let waste = 0;
    let tokens = 0;
    const at: number[] = [];
    let change: Piece[] | undefined;
    for (let i = 1; i < requests.length; i++) {
      const [a, b] = [requests[i - 1]!, requests[i]!];
      if (!a.system || !b.system || a.system === b.system || a.model !== b.model) continue;
      const { pieces } = diffWords(a.system, b.system);
      const changed = pieces.filter((p) => p.op !== "=").map((p) => p.text.trim());
      if (changed.length === 0 || !changed.every((t) => VOLATILE.test(t))) continue;
      // Everything the earlier request sent could have been read from the cache; what was read
      // from it anyway (the time sits after a cache breakpoint) costs nothing more.
      const prefix = Math.min(a.input, b.input);
      const missed = Math.max(0, prefix - b.cached);
      if (missed < prefix * 0.1) continue;
      if (!repeated.has(b)) waste += missed * (inputPrice(b) - cachedPrice(b));
      tokens += missed;
      at.push(b.index);
      uncached.add(b);
      change ??= pieces;
    }
    if (at.length > 0) findings.push({ kind: "volatile-prompt", waste, overlap: 0, tokens, where: [{ path: requests[0]!.path, requests: at }], detail: { change } });
  }
  return findings;
}

/** Tools offered in requests that no recording ever called. */
function unusedTools(all: Request[], uncached: Set<Request>, repeated: Set<Request>): Finding[] {
  const called = new Set<string>();
  for (const r of all) {
    for (const call of readContent(r.interaction.response.body).toolCalls) called.add(call.name);
    for (const result of r.results) called.add(result.name);
  }
  const unused = new Map<string, string>();
  let waste = 0;
  let overlap = 0;
  let tokens = 0;
  const where = new Map<string, number[]>();
  for (const r of all) {
    let here = 0;
    for (const [name, definition] of r.tools) {
      if (called.has(name)) continue;
      unused.set(name, definition);
      here += estimateTokens(definition);
    }
    if (here === 0) continue;
    tokens += here;
    waste += here * r.rate;
    // A repeated request's cost is counted whole as a duplicate already.
    if (repeated.has(r)) overlap += here * r.rate;
    else if (uncached.has(r)) overlap += here * Math.max(0, r.rate - cachedPrice(r));
    where.set(r.path, [...(where.get(r.path) ?? []), r.index]);
  }
  if (unused.size === 0) return [];
  return [
    {
      kind: "unused-tools",
      waste,
      overlap,
      tokens,
      where: [...where].map(([path, requests]) => ({ path, requests })),
      detail: { tools: [...unused.keys()].sort() },
    },
  ];
}

/** Tool results big enough to matter that every later request of a loop sends again. */
function largeResults(byCassette: Request[][], threshold: number, uncached: Set<Request>, repeated: Set<Request>): Finding[] {
  const findings: Finding[] = [];
  for (const requests of byCassette) {
    const seen = new Map<string, { name: string; tokens: number; at: number[]; waste: number; overlap: number }>();
    for (const r of requests) {
      for (const result of r.results) {
        if (result.tokens < threshold) continue;
        const entry = seen.get(result.key) ?? { name: result.name, tokens: result.tokens, at: [], waste: 0, overlap: 0 };
        entry.at.push(r.index);
        entry.waste += result.tokens * r.rate;
        if (repeated.has(r)) entry.overlap += result.tokens * r.rate;
        else if (uncached.has(r)) entry.overlap += result.tokens * Math.max(0, r.rate - cachedPrice(r));
        seen.set(result.key, entry);
      }
    }
    for (const entry of seen.values()) {
      findings.push({
        kind: "large-tool-result",
        waste: entry.waste,
        overlap: entry.overlap,
        tokens: entry.tokens,
        where: [{ path: requests[0]!.path, requests: entry.at }],
        detail: { tool: entry.name, sends: entry.at.length },
      });
    }
  }
  return findings;
}

/** Why the model stopped short: a reason to ask again. */
const CUT_OFF = new Set(["max_tokens", "length", "incomplete", "MAX_TOKENS", "model_context_window_exceeded"]);

/**
 * An answer worth asking again after: an error, nothing at all, cut off, or one a fault rewrote
 * when it was recorded. A request repeated after one is a retry, not a waste.
 */
function unusable(r: Request): boolean {
  const { response, meta } = r.interaction;
  if (response.status >= 400 || meta.fault) return true;
  const content = readContent(response.body);
  if (!content.text.trim() && content.toolCalls.length === 0) return true;
  return CUT_OFF.has(stopReason(response.body) ?? "");
}

/** The same request sent again in one test, after an answer that was fine. */
function duplicates(byCassette: Request[][], repeated: Set<Request>): Finding[] {
  const findings: Finding[] = [];
  for (const requests of byCassette) {
    const groups = new Map<string, Request[]>();
    for (const r of requests) {
      if (r.interaction.meta.judge) continue;
      const key = `${r.interaction.request.method} ${r.interaction.request.url} ${canonical(r.interaction.request.body)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const group of groups.values()) {
      const repeats = group.slice(1).filter((_, i) => !unusable(group[i]!));
      if (repeats.length === 0) continue;
      for (const r of repeats) repeated.add(r);
      findings.push({
        kind: "duplicate-request",
        waste: repeats.reduce((sum, r) => sum + r.cost, 0),
        overlap: 0,
        tokens: repeats.reduce((sum, r) => sum + r.input + r.output, 0),
        where: [{ path: group[0]!.path, requests: group.map((r) => r.index) }],
        detail: { sends: group.length },
      });
    }
  }
  return findings;
}

/** A token limit far above what answers use: no cost today, but a runaway answer's ceiling. */
function generousLimits(all: Request[]): Finding[] {
  const byLimit = new Map<number, Request[]>();
  for (const r of all) if (r.limit !== undefined && r.output > 0) byLimit.set(r.limit, [...(byLimit.get(r.limit) ?? []), r]);
  const findings: Finding[] = [];
  for (const [limit, requests] of byLimit) {
    const used = Math.max(...requests.map((r) => r.output));
    if (limit < 4096 || limit < used * 8) continue;
    const priciest = requests.reduce((a, b) => ((b.price?.output ?? 0) > (a.price?.output ?? 0) ? b : a));
    const where = new Map<string, number[]>();
    for (const r of requests) where.set(r.path, [...(where.get(r.path) ?? []), r.index]);
    findings.push({
      kind: "max-tokens",
      waste: 0,
      overlap: 0,
      risk: ((priciest.price?.output ?? 0) * limit) / 1e6,
      tokens: limit,
      where: [...where].map(([path, at]) => ({ path, requests: at })),
      detail: { limit, used },
    });
  }
  return findings;
}

/** One finding for a pattern seen in several cassettes, its first one as the example. */
function merge(findings: Finding[]): Finding[] {
  if (findings.length <= 1) return findings;
  const sorted = [...findings].sort((a, b) => b.waste - a.waste);
  return [
    {
      ...sorted[0]!,
      waste: sorted.reduce((sum, f) => sum + f.waste, 0),
      overlap: sorted.reduce((sum, f) => sum + f.overlap, 0),
      tokens: sorted.reduce((sum, f) => sum + f.tokens, 0),
      where: sorted.flatMap((f) => f.where),
    },
  ];
}

export interface DoctorOptions {
  /** Merged over the built-in pricing table. */
  pricing?: PricingTable;
  /** Tool results this big (in estimated tokens) or bigger are reported. Default 8000. */
  largeResult?: number;
}

/** Everything the recordings say could cost less, the costliest first. */
export function diagnose(cassettes: { path: string; data: CassetteFile }[], options: DoctorOptions = {}): Diagnosis {
  const pricing = { ...defaultPricing, ...options.pricing };
  // Requests to MCP servers cost nothing; positions stay those in the cassette.
  const byCassette = cassettes.map((c) => read(c.path, c.data, pricing).filter((r) => !isMcp(r.interaction))).filter((r) => r.length > 0);
  const all = byCassette.flat();
  const uncached = new Set<Request>();
  // Requests that repeat an earlier one: their whole cost is the duplicate's, never counted twice.
  const repeated = new Set<Request>();
  const duplicated = merge(duplicates(byCassette, repeated));
  const findings = [
    ...merge(volatilePrompts(byCassette, uncached, repeated)),
    ...unusedTools(all, uncached, repeated),
    ...largeResults(byCassette, options.largeResult ?? 8000, uncached, repeated),
    ...duplicated,
    ...generousLimits(all),
  ].sort((a, b) => b.waste - a.waste || (b.risk ?? 0) - (a.risk ?? 0) || b.tokens - a.tokens);
  const cost = all.reduce((sum, r) => sum + r.cost, 0);
  return {
    cassettes: cassettes.length,
    requests: all.length,
    cost,
    savings: Math.min(cost, findings.reduce((sum, f) => sum + f.waste - f.overlap, 0)),
    findings,
    unpriced: [...new Set(all.filter((r) => r.model && !r.price && r.input + r.output > 0).map((r) => r.model!))].sort(),
  };
}
