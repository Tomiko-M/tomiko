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

/** Parses a request body as JSON when possible, falling back to the raw text. */
export function parseRequestBody(text: string | undefined): unknown {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Response headers worth keeping. Request headers are never stored, so API keys can't leak into
 * cassettes; on the response side, an allowlist keeps out cookies and organization ids.
 */
const KEPT_HEADERS = new Set(["content-type", "retry-after", "request-id", "x-request-id"]);

export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (KEPT_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  });
  return out;
}

export const isEventStream = (contentType: string) => contentType.includes("text/event-stream");

const isTextual = (contentType: string) =>
  contentType === "" ||
  /^text\/|json|xml|javascript|x-www-form-urlencoded|ndjson/.test(contentType);

export function encodeBody(bytes: Uint8Array, contentType: string): RecordedBody {
  if (bytes.byteLength === 0) return { type: "empty" };
  if (!isTextual(contentType)) return { type: "base64", value: Buffer.from(bytes).toString("base64") };
  const text = new TextDecoder().decode(bytes);
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
      const chunks = body.chunks;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
    }
  }
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

/**
 * Passes `source` through to the caller while copying each chunk into `chunks` as it is read, so
 * everything the caller has seen is already recorded. A caller that stops early (or never reads)
 * doesn't truncate the recording: `settle()` drains the rest.
 */
export function recordStream(source: ReadableStream<Uint8Array>, chunks: string[]): RecordedStream {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let endedAt: number | undefined;
  let failure: { error: unknown } | undefined;

  // reader.read() calls resolve in the order they were made, so chunks stay in order even if the
  // caller and settle() read concurrently.
  const pump = async (): Promise<Uint8Array | undefined> => {
    const { done, value } = await reader.read();
    if (done) {
      const rest = decoder.decode();
      if (rest) chunks.push(rest);
      endedAt ??= Date.now();
      return undefined;
    }
    const text = decoder.decode(value, { stream: true });
    if (text) chunks.push(text);
    return value;
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const value = await pump();
          if (value) controller.enqueue(value);
          else controller.close();
        } catch (error) {
          failure = { error };
          controller.error(error);
        }
      },
      // Keep the source open: settle() still reads it to the end for the recording.
      cancel() {},
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    async settle() {
      if (failure) throw failure.error;
      while (endedAt === undefined) await pump();
      return endedAt;
    },
  };
}
