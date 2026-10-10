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

/** Reads a stream to the end, collecting decoded text chunks as they arrive. */
export async function collectChunks(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) into.push(text);
  }
  const rest = decoder.decode();
  if (rest) into.push(rest);
}
