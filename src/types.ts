import type { Fault, FaultName } from "./faults.js";
import type { JudgeOptions } from "./judge.js";

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
  /** A judge's request, made by `judge()` or `toMeet()`, not by the code under test. */
  judge?: boolean;
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

/**
 * Keys are model ids. A key also prices snapshots of its model: ids that add a date or version,
 * `-latest`, `-preview` or `-exp` to it (`gpt-5-2025-08-07`, `gemini-3-pro-preview`). The longest
 * matching key wins.
 */
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
  /**
   * Also save transient errors (408, 429 and 5xx). By default they are passed to the caller but not
   * saved, since a recorded outage would replay forever. Simulate failures with `faults` instead.
   */
  recordErrors?: boolean;
  /**
   * Guards cassettes against API keys and other secrets before they are written. Default: `"fail"`,
   * which saves nothing and fails the test. `"redact"` replaces each secret with a placeholder, and
   * `"warn"` saves as is. Pass an object to allow values or add your own formats; `false` turns the
   * guard off.
   */
  secrets?: SecretAction | SecretsOptions | false;
  /** The model `toMeet()` and `judge()` ask. Default: `claude-haiku-5-5`. */
  judge?: JudgeOptions;
}

/**
 * What happens when a recording about to be saved contains a secret:
 * - `fail`    save nothing and fail the test (default)
 * - `redact`  replace each secret with a placeholder such as `[REDACTED:anthropic-api-key]`, then save
 * - `warn`    save as is and add a warning to the report
 */
export type SecretAction = "fail" | "redact" | "warn";

export interface SecretsOptions {
  action?: SecretAction;
  /** Values that look like secrets but are safe to commit, e.g. fake keys in your fixtures. */
  allow?: (string | RegExp)[];
  /**
   * Your own secret formats, on top of the built-in ones. A named group `secret` marks the part to
   * hide: `/acme_id=\w+;key=(?<secret>\w+)/`.
   */
  patterns?: (RegExp | { name: string; pattern: RegExp })[];
  /**
   * Also look for the values of your environment variables named like secrets (`*_API_KEY`,
   * `*_TOKEN`, `*_SECRET`, `*_PASSWORD`), whatever their format. Default: true.
   */
  env?: boolean;
}

/** A secret found in a cassette. Only a masked preview of it is ever included. */
export interface SecretFinding {
  /** What it is: `"Anthropic API key"`, `"Value of $MISTRAL_API_KEY"`, `"Value of \"password\""`. */
  kind: string;
  /** The rule that found it, which also names its placeholder: `"anthropic-api-key"`. */
  rule: string;
  /** The environment variable holding this same value, when it is one of yours. */
  env?: string;
  /** `"sk-ant-api03-…f9Qa"`: a public prefix and the last four characters at most. */
  preview: string;
  /** The 1-based position of the request it first appears in. */
  request: number;
  /** Where in that request: `"request body › messages[0].content"`. */
  location: string;
  /** How many places in the cassette hold this same secret. */
  occurrences: number;
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
