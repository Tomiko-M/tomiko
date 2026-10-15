import { fromEvent } from "./eventstream.js";
import type { RecordedBody, RecordedResponse } from "./types.js";

const SECRET_PARAM = /^(key|api[-_]?key|access[-_]?token|token|auth|sig|signature)$/i;

/** Replaces secret-looking query parameter values, e.g. Gemini's `?key=`. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAM.test(name)) parsed.searchParams.set(name, "REDACTED");
  }
  return parsed.toString();
}

/**
 * Parses a request body as JSON when possible, falling back to the raw text. Multipart bodies
 * (file uploads) get a fixed boundary: clients pick a random one per request, which would
 * otherwise keep every upload from ever matching its recording.
 */
export function parseRequestBody(text: string | undefined, contentType?: string | null): unknown {
  if (text === undefined || text === "") return undefined;
  const boundary = /^multipart\/[^;]+;.*boundary="?([^";]+)"?/i.exec(contentType ?? "")?.[1];
  if (boundary) return text.split(boundary).join("tomiko-boundary");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Response headers worth keeping. Request headers are never stored, so API keys can't leak into
 * cassettes; on the response side, an allowlist keeps out cookies and organization ids. AWS
 * names an error's type only in `x-amzn-errortype`, which its SDK needs to throw the right class,
 * and Bedrock reports the tokens of an InvokeModel call in `x-amzn-bedrock-*` headers.
 */
const KEPT_HEADERS = new Set(["content-type", "retry-after", "request-id", "x-request-id", "x-amzn-requestid", "x-amzn-errortype"]);
const KEPT_PREFIX = "x-amzn-bedrock-";

export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (KEPT_HEADERS.has(lower) || lower.startsWith(KEPT_PREFIX)) out[lower] = value;
  });
  return out;
}

export const isEventStream = (contentType: string) => contentType.includes("text/event-stream");

const isTextual = (contentType: string) =>
  contentType === "" ||
  /^text\/|json|xml|javascript|x-www-form-urlencoded|ndjson/.test(contentType);

const base64 = (bytes: Uint8Array): RecordedBody => ({ type: "base64", value: Buffer.from(bytes).toString("base64") });

export function encodeBody(bytes: Uint8Array, contentType: string): RecordedBody {
  if (bytes.byteLength === 0) return { type: "empty" };
  if (!isTextual(contentType)) return base64(bytes);
  let text: string;
  try {
    // Without a content type, only valid UTF-8 is stored as text; anything else would be mangled.
    text = new TextDecoder("utf-8", { fatal: contentType === "" }).decode(bytes);
  } catch {
    return base64(bytes);
  }
  if (contentType.includes("json")) {
    try {
      return { type: "json", value: JSON.parse(text) };
    } catch {
      // Malformed JSON is kept verbatim.
    }
  }
  return { type: "text", value: text };
}

/** Statuses that must not carry a body; the Response constructor throws otherwise. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function bodyInit(body: RecordedBody): BodyInit | null {
  switch (body.type) {
    case "empty":
      return null;
    case "json":
      return JSON.stringify(body.value);
    case "text":
      return body.value;
    case "base64":
      return Buffer.from(body.value, "base64");
    case "sse": {
      const encoder = new TextEncoder();
      return chunked(body.chunks.map((chunk) => encoder.encode(chunk)));
    }
    case "eventstream":
      // One frame per chunk, as Bedrock sends them.
      return chunked(body.events.map(fromEvent));
  }
}

function chunked(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Builds a live Response from a recording. Streams replay chunk by chunk, exactly as recorded. */
export function buildResponse(recorded: RecordedResponse, url: string): Response {
  const body = NULL_BODY_STATUS.has(recorded.status) ? null : bodyInit(recorded.body);
  const response = new Response(body, {
    status: recorded.status,
    statusText: recorded.statusText ?? "",
    headers: recorded.headers,
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

export interface RecordedStream {
  /** The stream to hand to the caller: the same bytes, in the same chunks, as the source. */
  stream: ReadableStream<Uint8Array>;
  /** Reads whatever the caller left unread; resolves with the time the source ended. */
  settle(): Promise<number>;
}

/** Where a recorded stream's bytes go: each chunk as it is read, then the end. */
export interface StreamSink {
  chunk(bytes: Uint8Array): void;
  end(): void;
}

/** Keeps a text stream (SSE) as the text chunks it arrived in. */
export function textSink(chunks: string[]): StreamSink {
  const decoder = new TextDecoder();
  return {
    chunk(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      if (text) chunks.push(text);
    },
    end() {
      const rest = decoder.decode();
      if (rest) chunks.push(rest);
    },
  };
}

/**
 * Passes `source` through to the caller while copying each chunk into `sink` as it is read, so
 * everything the caller has seen is already recorded. A caller that stops early, never reads, or
 * aborts its request (`signal`) doesn't truncate the recording: `settle()` drains the rest, and
 * whatever it reads still reaches a caller who is reading.
 */
export function recordStream(source: ReadableStream<Uint8Array>, sink: StreamSink, signal?: AbortSignal | null): RecordedStream {
  const reader = source.getReader();
  let endedAt: number | undefined;
  let failure: { error: unknown } | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  /** The caller is no longer reading: it cancelled the stream or aborted the request. */
  let gone = false;
  const toCaller = (deliver: () => void) => {
    if (gone) return;
    try {
      deliver();
    } catch {
      gone = true;
    }
  };

  // reader.read() calls resolve in the order they were made, so chunks stay in order even if the
  // caller and settle() read concurrently; each one goes to both, whoever read it.
  const pump = async (): Promise<void> => {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      failure ??= { error };
      toCaller(() => controller.error(error));
      gone = true;
      throw error;
    }
    if (result.done) {
      if (endedAt === undefined) {
        sink.end();
        endedAt = Date.now();
        toCaller(() => controller.close());
      }
      return;
    }
    const value = result.value;
    sink.chunk(value);
    toCaller(() => controller.enqueue(value));
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      async pull() {
        if (endedAt === undefined && !failure) await pump().catch(() => {});
      },
      // Keep the source open: settle() still reads it to the end for the recording.
      cancel() {
        gone = true;
      },
    },
    { highWaterMark: 0 },
  );

  if (signal) {
    const abort = () => {
      toCaller(() => controller.error(signal.reason));
      gone = true;
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  return {
    stream,
    async settle() {
      if (failure) throw failure.error;
      while (endedAt === undefined) await pump();
      return endedAt;
    },
  };
}

/**
 * The response as fetch delivers it under an AbortSignal: once the signal aborts, reading the
 * body fails with its reason.
 */
export function abortable(response: Response, signal: AbortSignal | null): Response {
  if (!signal || !response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const abort = () => {
          if (finished) return;
          finished = true;
          controller.error(signal.reason);
          void reader.cancel(signal.reason).catch(() => {});
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          controller.close();
        } else controller.enqueue(value);
      },
      cancel(reason) {
        finished = true;
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperty(wrapped, "url", { value: response.url });
  return wrapped;
}
