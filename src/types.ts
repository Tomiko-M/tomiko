import type { Fault, FaultName } from "./faults.js";

/**
 * - `auto`    replay when a recording matches, otherwise hit the network and record (default locally)
 * - `replay`  never touch the network; unmatched requests throw (default when `CI` is set)
 * - `record`  always hit the network and overwrite the cassette
 */
export type Mode = "auto" | "replay" | "record";

export type RecordedBody =
  | { type: "empty" }
  | { type: "json"; value: unknown }
  | { type: "text"; value: string }
  | { type: "sse"; chunks: string[] }
  | { type: "base64"; value: string };

export interface RecordedRequest {
  method: string;
  /** URL with secret-looking query parameters redacted. */
  url: string;
  /** Parsed JSON body, raw text, or undefined when the request had no body. */
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: RecordedBody;
}

/** Token usage normalized across providers. `inputTokens` excludes cached tokens. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface InteractionMeta {
  provider?: string;
  model?: string;
  usage?: Usage;
  recordedAt: string;
  durationMs: number;
}

export interface Interaction {
  request: RecordedRequest;
  response: RecordedResponse;
  meta: InteractionMeta;
}

export interface CassetteFile {
  version: 1;
  interactions: Interaction[];
}

/** Prices in USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Defaults to 10% of `input`. */
  cacheRead?: number;
  /** Defaults to 125% of `input`. */
  cacheWrite?: number;
}

/** Keys are model ids; a key also matches any model id it is a prefix of (longest key wins). */
export type PricingTable = Record<string, ModelPrice>;

export interface TomikoOptions {
  /** Directory cassettes are stored in. Default: `__cassettes__` in the current working directory. */
  dir?: string;
  /** Default: `TOMIKO_MODE` env var, else `replay` when `CI` is set, else `auto`. */
  mode?: Mode;
  /**
   * Similarity threshold (0..1) for replaying a recording whose request body is close but not
   * identical, e.g. after a prompt tweak. The difference is reported as a warning.
   * Default: `false` (exact matching only).
   */
  fuzzy?: number | false;
  /** Request body paths ignored when matching, e.g. `"metadata.user_id"` or `"messages.*.cache_control"`. */
  ignore?: string[];
  /** Only requests for which this returns true go through the cassette; others pass straight through. */
  intercept?: (request: Request) => boolean;
  /** Transform each interaction before it is written to disk, e.g. to scrub personal data. */
  redact?: (interaction: Interaction) => Interaction;
  /** Merged over the built-in pricing table. */
  pricing?: PricingTable;
  /** The fetch used to reach the network while recording. Default: `globalThis.fetch` at open time. */
  fetch?: typeof globalThis.fetch;
  /** Simulated failures for testing retries and error handling. Build them with `fault.*`. */
  faults?: Fault[];
}

export interface CassetteReport {
  name: string;
  file: string;
  mode: Mode;
  replayed: number;
  recorded: number;
  usage: Usage;
  /** Estimated USD cost of all interactions served, or null when no model had a known price. */
  cost: number | null;
  /** Estimated USD cost of the interactions that were replayed instead of sent. */
  savedCost: number | null;
  /** Models seen without an entry in the pricing table. */
  unpricedModels: string[];
  warnings: string[];
  saved: boolean;
}

/** A tool the model asked to call. */
export interface ToolCall {
  name: string;
  /** Parsed arguments; raw text if they were not valid JSON. */
  input: unknown;
  id?: string;
}

/** One request a cassette served during this run, recorded or replayed, as seen by assertions. */
export interface RecordedCall {
  method: string;
  url: string;
  requestBody: unknown;
  /** 0 when the request failed without a response (a simulated network error). */
  status: number;
  replayed: boolean;
  /** The simulated fault that hit this request, if any. */
  fault?: FaultName;
  provider?: string;
  model?: string;
  usage?: Usage;
  /** Estimated USD cost, or null when there is no usage or no price for the model. */
  cost: number | null;
  /** The model's text output. */
  text: string;
  toolCalls: ToolCall[];
}
