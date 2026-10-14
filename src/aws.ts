/**
 * The AWS SDK doesn't use fetch: `BedrockRuntimeClient` talks HTTP/2 through Node's own modules,
 * where tomiko can't see it. This request handler, given to the client, sends its requests
 * through tomiko's fetch instead: to the active cassette, and to the network otherwise.
 *
 * ```ts
 * import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
 * import { awsRequestHandler } from "tomiko";
 *
 * const client = new BedrockRuntimeClient({ region: "us-east-1", requestHandler: awsRequestHandler });
 * ```
 */
import { Readable } from "node:stream";
import { dispatch } from "./runtime.js";

/** The parts of the AWS SDK's `HttpRequest` the handler reads. */
export interface AwsHttpRequest {
  method: string;
  protocol?: string;
  hostname: string;
  port?: number;
  path: string;
  query?: Record<string, string | (string | null)[] | null>;
  fragment?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** The AWS SDK's `HttpResponse`. */
export interface AwsHttpResponse {
  statusCode: number;
  reason?: string;
  headers: Record<string, string>;
  body: Readable;
}

interface LegacyAbortSignal {
  aborted: boolean;
  onabort: (() => void) | null;
}

export interface AwsHandlerOptions {
  abortSignal?: AbortSignal | LegacyAbortSignal;
  requestTimeout?: number;
}

/** Headers fetch sets itself, from the URL and the body. */
const TRANSPORT_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "expect"]);

/** The query encoding the AWS SDK signs with. */
const escape = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function urlOf(request: AwsHttpRequest): string {
  const query = Object.entries(request.query ?? {})
    .flatMap(([key, value]) =>
      value === null ? [escape(key)] : (Array.isArray(value) ? value : [value]).map((v) => (v === null ? escape(key) : `${escape(key)}=${escape(v)}`)),
    )
    .join("&");
  const port = request.port ? `:${request.port}` : "";
  return `${request.protocol ?? "https:"}//${request.hostname}${port}${request.path}${query ? `?${query}` : ""}${request.fragment ? `#${request.fragment}` : ""}`;
}

async function bodyOf(body: unknown): Promise<string | Uint8Array<ArrayBuffer> | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const parts: Uint8Array[] = [];
    for await (const part of body as AsyncIterable<string | Uint8Array>) parts.push(typeof part === "string" ? Buffer.from(part) : part);
    return new Uint8Array(Buffer.concat(parts));
  }
  return String(body);
}

function signalOf(options: AwsHandlerOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  const given = options.abortSignal;
  if (given instanceof AbortSignal) signals.push(given);
  else if (given) {
    // The SDK's own AbortSignal, from before it used the platform's.
    const controller = new AbortController();
    if (given.aborted) controller.abort();
    else given.onabort = () => controller.abort();
    signals.push(controller.signal);
  }
  if (options.requestTimeout) signals.push(AbortSignal.timeout(options.requestTimeout));
  // AbortSignal.any arrived in Node 20.3.
  return signals.length > 1 && typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : signals[0];
}

/**
 * A Node stream of the body that reads no further ahead than its reader. A stream that breaks
 * (a dropped connection, `fault.cutStream`) then delivers everything before the break first,
 * where read-ahead would have thrown buffered events away with the error.
 */
function readable(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();
  return new Readable({
    highWaterMark: 0,
    read() {
      reader.read().then(
        ({ done, value }) => this.push(done ? null : value),
        (error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    },
    destroy(error, callback) {
      reader.cancel(error ?? undefined).then(() => callback(error), () => callback(error));
    },
  });
}

/** Give it to an AWS SDK client as `requestHandler`, so tomiko records and replays its requests. */
export const awsRequestHandler = {
  metadata: { handlerProtocol: "http/1.1" },

  async handle(request: AwsHttpRequest, options: AwsHandlerOptions = {}): Promise<{ response: AwsHttpResponse }> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!TRANSPORT_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    const response = await dispatch(urlOf(request), {
      method: request.method,
      headers,
      body: await bodyOf(request.body),
      signal: signalOf(options),
    });
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => (out[name] = value));
    return {
      response: {
        statusCode: response.status,
        reason: response.statusText,
        headers: out,
        body: response.body ? readable(response.body) : Readable.from([]),
      },
    };
  },

  updateHttpClientConfig(): void {},
  httpHandlerConfigs(): Record<string, never> {
    return {};
  },
  destroy(): void {},
};
