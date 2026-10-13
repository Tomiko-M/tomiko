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
 * Gemini's `usageMetadata`: thinking tokens are billed as output, cached tokens are part of the
 * prompt count, and tokens of tool results the API fetched itself are input.
 */
function normalizeGemini(u: Obj): Usage | undefined {
  const prompt = num(u.promptTokenCount);
  const candidates = num(u.candidatesTokenCount);
  if (prompt === undefined && candidates === undefined) return undefined;
  const cached = num(u.cachedContentTokenCount) ?? 0;
  return {
    inputTokens: Math.max(0, (prompt ?? 0) - cached) + (num(u.toolUsePromptTokenCount) ?? 0),
    outputTokens: (candidates ?? 0) + (num(u.thoughtsTokenCount) ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
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
    // Gemini names the model that answered `modelVersion` and its usage `usageMetadata`.
    if (model === undefined && typeof o.modelVersion === "string") model = o.modelVersion;
    if (usage === undefined && isObj(o.usage)) usage = normalize(o.usage);
    if (usage === undefined && isObj(o.usageMetadata)) usage = normalizeGemini(o.usageMetadata);
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

/**
 * The model a request asks for: the `model` field of the body, or for Gemini, which puts it in
 * the path, `…/models/<model>:generateContent`.
 */
export function requestModel(request: { url: string; body?: unknown }): string | undefined {
  const body = request.body;
  if (isObj(body) && typeof body.model === "string") return body.model;
  const match = /\/models\/([^/:?#]+):/.exec(request.url);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * The API a request is for. The Anthropic SDK always sends `anthropic-version`; without headers,
 * the host decides, and behind a proxy or gateway (a custom base URL) the API's path still does.
 */
export function detectProvider(url: string, headers?: Headers): string | undefined {
  if (headers?.has("anthropic-version")) return "anthropic";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host.endsWith("anthropic.com")) return "anthropic";
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("generativelanguage.googleapis.com")) return "google";
  if (/\/v1\/messages(\/|$)/.test(parsed.pathname)) return "anthropic";
  if (/\/(chat\/completions|responses)$/.test(parsed.pathname)) return "openai";
  return host;
}
