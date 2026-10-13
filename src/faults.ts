import { isEventStream } from "./http.js";

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

export type FaultName = "rate_limit" | "overloaded" | "server_error" | "network_error" | "cut_stream" | "latency";

export type Fault = FaultTarget &
  (
    | { name: "rate_limit" | "overloaded" | "server_error"; retryAfterMs: number }
    | { name: "network_error"; message: string }
    | { name: "cut_stream"; afterEvents: number }
    | { name: "latency"; ms: number }
  );

/**
 * Faults to inject into a cassette run, for testing retries and error handling against
 * recordings. Faulted requests never reach the network and are never recorded.
 *
 * ```ts
 * cassette("booking", run, { faults: [fault.rateLimit({ on: 1 }), fault.cutStream({ on: 3 })] });
 * ```
 */
export const fault = {
  /** HTTP 429 in the provider's error format. `retryAfterMs` (default 1) keeps SDK retries instant. */
  rateLimit: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    retryAfterMs: 1,
    ...options,
    name: "rate_limit",
  }),
  /** Anthropic's 529 overloaded error; 503 for other providers. */
  overloaded: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    retryAfterMs: 1,
    ...options,
    name: "overloaded",
  }),
  /** HTTP 500 in the provider's error format. */
  serverError: (options: FaultTarget & { retryAfterMs?: number } = {}): Fault => ({
    retryAfterMs: 1,
    ...options,
    name: "server_error",
  }),
  /** The request fails before any response, like a reset connection: `fetch` rejects. */
  networkError: (options: FaultTarget & { message?: string } = {}): Fault => ({
    message: "read ECONNRESET",
    ...options,
    name: "network_error",
  }),
  /**
   * The response starts normally, then the connection drops: streams after `afterEvents` events
   * (default 3), other bodies halfway. A cut during recording still saves the complete response.
   */
  cutStream: (options: FaultTarget & { afterEvents?: number } = {}): Fault => ({
    afterEvents: 3,
    ...options,
    name: "cut_stream",
  }),
  /** Delays the response by `ms`. Honors the request's abort signal, so client timeouts fire. */
  latency: (options: FaultTarget & { ms: number }): Fault => ({ ...options, name: "latency" }),
};

/** Decides which faults hit which requests, keeping per-fault hit counts for `times`. */
export class FaultPlan {
  private readonly hits = new Map<Fault, number>();
  private count = 0;

  constructor(private readonly faults: readonly Fault[]) {}

  /** Faults for the next request, in the order they were declared. */
  next(request: FaultRequest): Fault[] {
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

/** Status and body each provider sends for this kind of failure, so SDKs map it to their usual error. */
export function errorResponse(
  name: "rate_limit" | "overloaded" | "server_error",
  provider: string | undefined,
): { status: number; body: unknown } {
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
  const reader = response.body.getReader();
  const sse = isEventStream(response.headers.get("content-type") ?? "");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buffered: Uint8Array[] = [];
  let text = "";

  const drop = () => new TypeError("terminated", { cause: new Error(`other side closed (${SIMULATED})`) });

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!sse) {
        // A plain body is cut halfway, which needs its full length first.
        if (!done) return void buffered.push(value);
        const all = concat(buffered);
        if (all.byteLength === 0) return controller.close();
        controller.enqueue(all.subarray(0, Math.floor(all.byteLength / 2)));
        return controller.error(drop());
      }
      if (done) return controller.close(); // ended before the cut point
      const before = text.length;
      text += decoder.decode(value, { stream: true });
      const cutAt = nthEventEnd(text, afterEvents);
      if (cutAt === undefined) return controller.enqueue(encoder.encode(text.slice(before)));
      if (cutAt > before) controller.enqueue(encoder.encode(text.slice(before, cutAt)));
      void reader.cancel();
      controller.error(drop());
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
