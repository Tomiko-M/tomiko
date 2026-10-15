import { TomikoError } from "./errors.js";
import { frameLength, isAwsEventStream } from "./eventstream.js";
import { isEventStream } from "./http.js";
import { type InjectionFault, type InjectionOptions, promptInjection } from "./injection.js";

/** What a fault's `when` filter sees of each request. */
export interface FaultRequest {
  method: string;
  /** With secret query parameters redacted, as stored in cassettes. */
  url: string;
  /** Parsed JSON body, raw text, or undefined. */
  body?: unknown;
}

export interface FaultTarget {
  /**
   * Request numbers to hit, 1-based, counting every request the cassette handles in this run
   * (retries and faulted requests included). Takes precedence over `times`.
   */
  on?: number | number[];
  /** Hit the first `times` requests that `when` accepts. Default 1; `Infinity` hits all of them. */
  times?: number;
  /** Only requests for which this returns true are hit. */
  when?: (request: FaultRequest) => boolean;
}

export type FaultName =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "network_error"
  | "cut_stream"
  | "latency"
  | "hallucinated_tool"
  | "broken_arguments"
  | "refusal"
  | "max_tokens"
  | "empty_answer"
  | "prompt_injection";

/** A fault that hits some requests, chosen with `on`, `times` and `when`. */
export type RequestFault = FaultTarget &
  (
    | { name: "rate_limit" | "overloaded" | "server_error"; retryAfterMs: number }
    | { name: "network_error"; message: string }
    | { name: "cut_stream"; afterEvents: number }
    | { name: "latency"; ms: number }
    | { name: "hallucinated_tool"; tool?: string; input?: Record<string, unknown> }
    | { name: "broken_arguments"; tool?: string; arguments?: string; input?: Record<string, unknown> }
    | { name: "refusal"; message: string }
    | { name: "max_tokens"; keep: number }
    | { name: "empty_answer" }
  );

/** A prompt injection rides with a tool result into every request that carries it, not one request. */
export type Fault = RequestFault | InjectionFault;

/**
 * Faults to inject into a cassette run, for testing retries and error handling against
 * recordings. Faulted requests never reach the network and are never recorded.
 *
 * ```ts
 * cassette("booking", run, { faults: [fault.rateLimit({ on: 1 }), fault.cutStream({ on: 3 })] });
 * ```
 */
/** A number option: its default when left out (or `undefined`), otherwise checked. */
function number(value: number | undefined, fallback: number, name: string, check: (n: number) => boolean, rule: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !check(value)) throw new TomikoError(`\`${name}\` must be ${rule}, got ${String(value)}.`);
  return value;
}
const delayMs = (value: number | undefined, name: string, fallback: number) => number(value, fallback, name, (n) => n >= 0 && Number.isFinite(n), "a number of milliseconds, 0 or more");

export const fault = {
  /** HTTP 429 in the provider's error format. `retryAfterMs` (default 1) keeps SDK retries instant. */
  rateLimit: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    ...options,
    retryAfterMs: delayMs(options.retryAfterMs, "retryAfterMs", 1),
    name: "rate_limit",
  }),
  /** Anthropic's 529 overloaded error; 503 for other providers. */
  overloaded: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    ...options,
    retryAfterMs: delayMs(options.retryAfterMs, "retryAfterMs", 1),
    name: "overloaded",
  }),
  /** HTTP 500 in the provider's error format. */
  serverError: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    ...options,
    retryAfterMs: delayMs(options.retryAfterMs, "retryAfterMs", 1),
    name: "server_error",
  }),
  /** The request fails before any response, like a reset connection: `fetch` rejects. */
  networkError: (options: FaultTarget & { message?: string } = {}): Fault => ({
    ...options,
    message: options.message ?? "read ECONNRESET",
    name: "network_error",
  }),
  /**
   * The response starts normally, then the connection drops: streams after `afterEvents` events
   * (default 3), other bodies halfway. A cut during recording still saves the complete response.
   */
  cutStream: (options: FaultTarget & { afterEvents?: number } = {}): Fault => ({
    ...options,
    afterEvents: number(options.afterEvents, 3, "afterEvents", (n) => Number.isInteger(n) && n >= 0, "a whole number, 0 or more"),
    name: "cut_stream",
  }),
  /** Delays the response by `ms`. Honors the request's abort signal, so client timeouts fire. */
  latency: (options: FaultTarget & { ms: number }): Fault => ({ ...options, ms: delayMs(options.ms, "ms", 0), name: "latency" }),

  // The model misbehaving. The request is answered as usual (replayed, or sent and recorded), and
  // the caller gets the answer rewritten, in the provider's format, streamed or not.

  /**
   * The model calls a tool that doesn't exist: by default the first tool offered, with `_v2`
   * added to its name, as models do. Set `tool` and `input` to choose.
   */
  hallucinatedTool: (options: FaultTarget & { tool?: string; input?: Record<string, unknown> } = {}): Fault => ({
    ...options,
    name: "hallucinated_tool",
  }),
  /**
   * The model calls a tool with arguments that don't fit it: JSON cut off in the middle where
   * arguments are text (OpenAI), no arguments at all where they are an object (Anthropic,
   * Gemini). `tool` picks the call; `arguments` or `input` set exactly what is sent.
   */
  brokenArguments: (options: FaultTarget & { tool?: string; arguments?: string; input?: Record<string, unknown> } = {}): Fault => ({
    ...options,
    name: "broken_arguments",
  }),
  /** The model declines to answer, with the provider's refusal signal where it has one. */
  refusal: (options: FaultTarget & { message?: string } = {}): Fault => ({
    ...options,
    message: options.message ?? "I'm sorry, but I can't help with that.",
    name: "refusal",
  }),
  /**
   * The model stops at the token limit: the answer is cut, `keep` (default 0.5) of the way
   * through, and the stop reason says so. An answer that was a tool call stops inside it.
   */
  maxTokens: (options: FaultTarget & { keep?: number } = {}): Fault => ({
    ...options,
    keep: number(options.keep, 0.5, "keep", (n) => n >= 0 && n <= 1, "a share between 0 and 1"),
    name: "max_tokens",
  }),
  /** The model answers with nothing: no text, no tool calls. */
  emptyAnswer: (options: FaultTarget = {}): Fault => ({ ...options, name: "empty_answer" }),

  /**
   * A prompt injection in what a tool returned: by default, the agent's first tool result tells
   * the model to call its most harmful tool. The model sees it on that turn and every turn after;
   * your code never does. Check the model kept to its job with `toResistInjection()`.
   *
   * ```ts
   * fault.promptInjection({ into: "fetch_page", attack: "exfiltrate" })
   * ```
   */
  promptInjection: (options: InjectionOptions = {}): Fault => promptInjection(options),
};

/** Decides which faults hit which requests, keeping per-fault hit counts for `times`. */
export class FaultPlan {
  private readonly hits = new Map<RequestFault, number>();
  private count = 0;

  constructor(private readonly faults: readonly RequestFault[]) {}

  /** Faults for the next request, in the order they were declared. */
  next(request: FaultRequest): RequestFault[] {
    const n = ++this.count;
    return this.faults.filter((f) => {
      if (f.when && !f.when(request)) return false;
      if (f.on !== undefined) return (Array.isArray(f.on) ? f.on : [f.on]).includes(n);
      const hits = this.hits.get(f) ?? 0;
      if (hits >= (f.times ?? 1)) return false;
      this.hits.set(f, hits + 1);
      return true;
    });
  }
}

const SIMULATED = "Simulated by tomiko";

const anthropicError = (type: string, message: string) => ({ type: "error", error: { type, message: `${message} (${SIMULATED})` } });
const googleError = (code: number, status: string, message: string) => ({
  error: { code, message: `${message} (${SIMULATED})`, status },
});
const openaiError = (type: string, code: string | null, message: string) => ({
  error: { message: `${message} (${SIMULATED})`, type, param: null, code },
});

/**
 * Bedrock's errors: a message in the body, the type in `x-amzn-errortype`, from which the AWS SDK
 * builds its `ThrottlingException`, `ServiceUnavailableException`…
 */
const bedrockError = (status: number, type: string, message: string) => ({
  status,
  body: { message: `${message} (${SIMULATED})` },
  headers: { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/` },
});

/** Status and body each provider sends for this kind of failure, so SDKs map it to their usual error. */
export function errorResponse(
  name: "rate_limit" | "overloaded" | "server_error",
  provider: string | undefined,
): { status: number; body: unknown; headers?: Record<string, string> } {
  if (provider === "bedrock") {
    if (name === "rate_limit") return bedrockError(429, "ThrottlingException", "Too many requests, please wait before trying again.");
    if (name === "overloaded") return bedrockError(503, "ServiceUnavailableException", "Bedrock is unable to process your request.");
    return bedrockError(500, "InternalServerException", "The server encountered an internal error while processing the request.");
  }
  if (provider === "anthropic") {
    if (name === "rate_limit") return { status: 429, body: anthropicError("rate_limit_error", "Rate limited") };
    if (name === "overloaded") return { status: 529, body: anthropicError("overloaded_error", "Overloaded") };
    return { status: 500, body: anthropicError("api_error", "Internal server error") };
  }
  if (provider === "google") {
    if (name === "rate_limit") return { status: 429, body: googleError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted") };
    if (name === "overloaded") return { status: 503, body: googleError(503, "UNAVAILABLE", "The model is overloaded") };
    return { status: 500, body: googleError(500, "INTERNAL", "An internal error has occurred") };
  }
  if (name === "rate_limit") {
    return { status: 429, body: openaiError("requests", "rate_limit_exceeded", "Rate limit reached") };
  }
  if (name === "overloaded") return { status: 503, body: openaiError("server_error", null, "The server is overloaded") };
  return { status: 500, body: openaiError("server_error", null, "The server had an error") };
}

/** Rejects the way undici does when a connection fails before a response. */
export function networkError(message: string): TypeError {
  const cause = Object.assign(new Error(`${message} (${SIMULATED})`), { code: "ECONNRESET" });
  return new TypeError("fetch failed", { cause });
}

export function delay(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Passes the body through until the cut point, then fails the stream like a dropped connection. */
export function cutResponse(response: Response, afterEvents: number): Response {
  if (!response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (isAwsEventStream(contentType)) return cutFrames(response, afterEvents);
  const reader = response.body.getReader();
  const sse = isEventStream(contentType);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buffered: Uint8Array[] = [];
  let text = "";

  const drop = () => new TypeError("terminated", { cause: new Error(`other side closed (${SIMULATED})`) });

  // The connection drops on the read after the cut point: erroring right away would throw away
  // the last piece before anyone read it.
  let dropped = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (dropped) {
        void reader.cancel();
        return controller.error(drop());
      }
      const { done, value } = await reader.read();
      if (!sse) {
        // A plain body is cut halfway, which needs its full length first.
        if (!done) return void buffered.push(value);
        const all = concat(buffered);
        if (all.byteLength === 0) return controller.close();
        dropped = true;
        return controller.enqueue(all.subarray(0, Math.floor(all.byteLength / 2)));
      }
      if (done) return controller.close(); // ended before the cut point
      const before = text.length;
      text += decoder.decode(value, { stream: true });
      const cutAt = nthEventEnd(text, afterEvents);
      if (cutAt === undefined) return controller.enqueue(encoder.encode(text.slice(before)));
      dropped = true;
      if (cutAt > before) controller.enqueue(encoder.encode(text.slice(before, cutAt)));
      else {
        void reader.cancel();
        controller.error(drop());
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const cut = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(cut, "url", { value: response.url });
  return cut;
}

/** An AWS event stream, cut after `afterEvents` whole frames. */
function cutFrames(response: Response, afterEvents: number): Response {
  const reader = response.body!.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  let frames = 0;
  const drop = () => new TypeError("terminated", { cause: new Error(`other side closed (${SIMULATED})`) });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (frames >= afterEvents) {
        void reader.cancel();
        return controller.error(drop());
      }
      const { done, value } = await reader.read();
      if (done) return controller.close(); // ended before the cut point
      pending = concat([pending, value]);
      // Pass on whole frames only, up to the cut.
      let end = 0;
      for (let length = frameLength(pending, end); length !== undefined && end + length <= pending.length && frames < afterEvents; length = frameLength(pending, end)) {
        end += length;
        frames++;
      }
      if (end > 0) controller.enqueue(pending.slice(0, end));
      pending = pending.slice(end);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const cut = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(cut, "url", { value: response.url });
  return cut;
}

/** Index just past the end of the nth SSE event (events end with a blank line), if it has arrived. */
function nthEventEnd(text: string, n: number): number | undefined {
  if (n <= 0) return 0;
  const boundary = /\r?\n\r?\n/g;
  let seen = 0;
  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    if (++seen === n) return match.index + match[0].length;
  }
  return undefined;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
