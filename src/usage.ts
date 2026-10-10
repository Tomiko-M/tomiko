import type { RecordedBody, Usage } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * Normalizes a provider `usage` object. Anthropic reports uncached `input_tokens` plus separate
 * cache counters; OpenAI's `prompt_tokens` / `input_tokens` include cached tokens, so those are
 * subtracted to make `inputTokens` mean "uncached input" everywhere.
 */
function normalize(u: Obj): Usage | undefined {
  const anthropicCacheRead = num(u.cache_read_input_tokens);
  const anthropicCacheWrite = num(u.cache_creation_input_tokens);
  const openaiDetails = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : isObj(u.input_tokens_details) ? u.input_tokens_details : undefined;
  const openaiCached = openaiDetails ? num(openaiDetails.cached_tokens) : undefined;
  const isOpenAI = num(u.prompt_tokens) !== undefined || openaiDetails !== undefined;

  const rawInput = num(u.input_tokens) ?? num(u.prompt_tokens);
  const output = num(u.output_tokens) ?? num(u.completion_tokens);
  if (rawInput === undefined && output === undefined) return undefined;

  const cacheRead = anthropicCacheRead ?? openaiCached ?? 0;
  const input = isOpenAI ? Math.max(0, (rawInput ?? 0) - (openaiCached ?? 0)) : rawInput ?? 0;
  return {
    inputTokens: input,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: anthropicCacheWrite ?? 0,
  };
}

interface Extracted {
  model?: string;
  usage?: Usage;
}

function fromPayload(payload: unknown): Extracted {
  if (!isObj(payload)) return {};
  // Top level covers plain responses and Anthropic's message_delta; `message` is Anthropic's
  // message_start; `response` is OpenAI Responses API stream events.
  const nested = [payload, payload.message, payload.response].filter(isObj);
  let model: string | undefined;
  let usage: Usage | undefined;
  for (const o of nested) {
    if (model === undefined && typeof o.model === "string") model = o.model;
    if (usage === undefined && isObj(o.usage)) usage = normalize(o.usage);
  }
  return { model, usage };
}

/** Streaming providers report usage cumulatively across events, so the max of each counter is the total. */
function maxUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
  };
}

export function parseSseData(chunks: string[]): unknown[] {
  const events: unknown[] = [];
  for (const line of chunks.join("").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Not JSON; nothing to extract.
    }
  }
  return events;
}

export function extractUsage(body: RecordedBody): Extracted {
  if (body.type === "json") return fromPayload(body.value);
  if (body.type !== "sse") return {};
  let model: string | undefined;
  let usage: Usage | undefined;
  for (const event of parseSseData(body.chunks)) {
    const found = fromPayload(event);
    model ??= found.model;
    usage = maxUsage(usage, found.usage);
  }
  return { model, usage };
}

export function detectProvider(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host.endsWith("anthropic.com")) return "anthropic";
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("generativelanguage.googleapis.com")) return "google";
  return host;
}
