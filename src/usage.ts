import { payloads } from "./eventstream.js";
import type { RecordedBody, Usage } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  const hour = (a.cacheWriteHourTokens ?? 0) + (b.cacheWriteHourTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(hour ? { cacheWriteHourTokens: hour } : {}),
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
 * Bedrock's Converse `usage`. Like Anthropic's, `inputTokens` leaves out the tokens read from or
 * written to the prompt cache.
 */
function normalizeBedrock(u: Obj): Usage | undefined {
  const input = num(u.inputTokens) ?? num(u.inputTokenCount);
  const output = num(u.outputTokens) ?? num(u.outputTokenCount);
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: num(u.cacheReadInputTokens) ?? num(u.cacheReadInputTokenCount) ?? 0,
    cacheWriteTokens: num(u.cacheWriteInputTokens) ?? num(u.cacheWriteInputTokenCount) ?? 0,
  };
}

/** What Bedrock measured for an InvokeModel stream, at its end, whatever the model. */
const INVOCATION_METRICS = "amazon-bedrock-invocationMetrics";

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
  // Anthropic splits cache writes by how long they last; an hour costs more than five minutes.
  const hour = isObj(u.cache_creation) ? num(u.cache_creation.ephemeral_1h_input_tokens) : undefined;
  return {
    inputTokens: input,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: anthropicCacheWrite ?? 0,
    ...(hour ? { cacheWriteHourTokens: hour } : {}),
  };
}

interface Extracted {
  model?: string;
  usage?: Usage;
}

function fromPayload(payload: unknown): Extracted {
  if (!isObj(payload)) return {};
  // Top level covers plain responses and Anthropic's message_delta; `message` is Anthropic's
  // message_start; `response` is OpenAI Responses API stream events; `metadata` is the last event
  // of a Bedrock ConverseStream.
  const nested = [payload, payload.message, payload.response, payload.metadata].filter(isObj);
  let model: string | undefined;
  let usage: Usage | undefined;
  for (const o of nested) {
    if (model === undefined && typeof o.model === "string") model = o.model;
    // Gemini names the model that answered `modelVersion` and its usage `usageMetadata`.
    if (model === undefined && typeof o.modelVersion === "string") model = o.modelVersion;
    if (usage === undefined && isObj(o.usage)) usage = normalize(o.usage) ?? normalizeBedrock(o.usage);
    if (usage === undefined && isObj(o.usageMetadata)) usage = normalizeGemini(o.usageMetadata);
  }
  // Models on Bedrock with a format of their own: Meta's Llama counts in the body, and every
  // InvokeModel stream ends with Bedrock's own count.
  if (usage === undefined && (num(payload.prompt_token_count) !== undefined || num(payload.generation_token_count) !== undefined)) {
    usage = { inputTokens: num(payload.prompt_token_count) ?? 0, outputTokens: num(payload.generation_token_count) ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  if (isObj(payload[INVOCATION_METRICS])) usage = maxUsage(usage, normalizeBedrock(payload[INVOCATION_METRICS]));
  return { model, usage };
}

/** Bedrock's InvokeModel reports the tokens of any model in response headers. */
function fromHeaders(headers: Record<string, string> | undefined): Usage | undefined {
  const count = (name: string) => {
    const value = headers?.[`x-amzn-bedrock-${name}`];
    return value === undefined ? undefined : Number(value);
  };
  const input = count("input-token-count");
  const output = count("output-token-count");
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: count("cache-read-input-token-count") ?? 0,
    cacheWriteTokens: count("cache-write-input-token-count") ?? 0,
  };
}

/** Streaming providers report usage cumulatively across events, so the max of each counter is the total. */
function maxUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const hour = Math.max(a.cacheWriteHourTokens ?? 0, b.cacheWriteHourTokens ?? 0);
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    ...(hour ? { cacheWriteHourTokens: hour } : {}),
  };
}

/**
 * The events of a streamed response, parsed: SSE `data`, or the payloads of an AWS event stream
 * (see `payloads`). Empty for a response that isn't streamed.
 */
export function streamEvents(body: RecordedBody): unknown[] {
  if (body.type === "sse") return parseSseData(body.chunks);
  if (body.type === "eventstream") return payloads(body.events);
  return [];
}

/** A streamed response's body. */
export const isStreamed = (body: RecordedBody) => body.type === "sse" || body.type === "eventstream";

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

/** The model that answered and the tokens it used. Pass the response headers for Bedrock's InvokeModel. */
export function extractUsage(body: RecordedBody, headers?: Record<string, string>): Extracted {
  let found: Extracted = {};
  if (body.type === "json") found = fromPayload(body.value);
  else if (isStreamed(body)) {
    for (const event of streamEvents(body)) {
      const next = fromPayload(event);
      found = { model: found.model ?? next.model, usage: maxUsage(found.usage, next.usage) };
    }
  }
  return found.usage ? found : { ...found, usage: fromHeaders(headers) };
}

/** Bedrock's model endpoints: `/model/<id>/converse`, `/model/<id>/invoke-with-response-stream`… */
export const BEDROCK_PATH = /\/model\/([^/?#]+)\/(converse|converse-stream|invoke|invoke-with-response-stream)(?=$|[?#])/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The model a request asks for: the `model` field of the body, or in the path for Gemini
 * (`…/models/<model>:generateContent`) and Bedrock (`…/model/<model>/converse`).
 */
export function requestModel(request: { url: string; body?: unknown }): string | undefined {
  const body = request.body;
  if (isObj(body) && typeof body.model === "string") return body.model;
  const bedrock = BEDROCK_PATH.exec(pathOf(request.url));
  if (bedrock) return decode(bedrock[1]!);
  const match = /\/models\/([^/:?#]+):/.exec(request.url);
  return match ? decode(match[1]!) : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Region prefixes of Bedrock's cross-region inference profiles: `us.anthropic.claude-…`. */
const PROFILE_REGION = /^(?:us|us-gov|eu|apac|jp|au|ca|global)\./;

/** A Bedrock model id: `anthropic.claude-…`, `us.amazon.nova-lite-v1:0`, or an ARN. */
export function isBedrockModel(model: string): boolean {
  if (/^arn:aws[a-z-]*:bedrock:/.test(model)) return true;
  // `vendor.model`: a vendor of letters and digits, then a name starting with a letter.
  return /^[a-z][a-z0-9]*\.[a-z]/i.test(model.replace(PROFILE_REGION, ""));
}

/** The family of a Bedrock model, which decides its InvokeModel format: `anthropic`, `amazon`, `meta`… */
export function bedrockFamily(model: string): string {
  const id = model.replace(/^arn:aws[a-z-]*:bedrock:[^/]*\/(?!.*\/)/, "").replace(PROFILE_REGION, "");
  return id.split(".")[0] ?? id;
}

/**
 * The URL as matching sees it: a Bedrock endpoint without its region, so a recording made in one
 * region replays in another.
 */
export function matchUrl(url: string): string {
  return url.replace(/^(https?:\/\/bedrock-runtime(?:-fips)?)\.[a-z0-9-]+(\.amazonaws\.com(?:\.cn)?)(?=[/:?#]|$)/, "$1$2");
}

/** `bedrock-runtime.us-east-1.amazonaws.com`, its FIPS twin, a VPC endpoint to it, or China's. */
const BEDROCK_HOST = /(?:^|\.)bedrock-runtime(?:-fips)?\.(?:[a-z0-9-]+\.)*amazonaws\.com(?:\.cn)?$/;

/**
 * The API a request is for. Bedrock is told by its host or its model paths. The Anthropic SDK
 * always sends `anthropic-version`; without headers, the host decides, and behind a proxy or
 * gateway (a custom base URL) the API's path still does.
 */
export function detectProvider(url: string, headers?: Headers): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return headers?.has("anthropic-version") ? "anthropic" : undefined;
  }
  if (parsed.protocol === "mcp:") return "mcp";
  const host = parsed.hostname;
  // Before the header: Anthropic's Bedrock SDK sends `anthropic-version` too.
  if (BEDROCK_HOST.test(host) || BEDROCK_PATH.test(parsed.pathname)) return "bedrock";
  if (headers?.has("anthropic-version")) return "anthropic";
  if (host.endsWith("anthropic.com")) return "anthropic";
  if (host.endsWith("openai.com")) return "openai";
  if (host.endsWith("generativelanguage.googleapis.com")) return "google";
  if (/\/v1\/messages(\/|$)/.test(parsed.pathname)) return "anthropic";
  if (/\/(chat\/completions|responses)$/.test(parsed.pathname)) return "openai";
  return host;
}
