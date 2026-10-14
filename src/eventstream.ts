/**
 * AWS event streams: the binary framing Amazon Bedrock streams answers in
 * (`application/vnd.amazon.eventstream`). Cassettes store the events decoded, as JSON, so they
 * read and diff like any other recording; replays encode them back into frames.
 *
 * A frame is: total length and headers length (uint32 each), a CRC32 of those 8 bytes, the
 * headers, the payload, and a CRC32 of everything before it.
 */
import type { StreamSink } from "./http.js";
import type { StreamEvent } from "./types.js";

export const EVENT_STREAM = "application/vnd.amazon.eventstream";

export const isAwsEventStream = (contentType: string) => contentType.includes(EVENT_STREAM);

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface Frame {
  headers: Record<string, string>;
  payload: Uint8Array;
}

const utf8 = new TextEncoder();
const text = new TextDecoder();

/** Header values other than strings are rare in Bedrock streams; they are kept as text. */
function readHeaders(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const nameLength = bytes[at]!;
    const name = text.decode(bytes.subarray(at + 1, at + 1 + nameLength));
    at += 1 + nameLength;
    const type = bytes[at++]!;
    let value: string;
    switch (type) {
      case 0:
      case 1:
        value = String(type === 0);
        break;
      case 2:
        value = String(view.getInt8(at));
        at += 1;
        break;
      case 3:
        value = String(view.getInt16(at));
        at += 2;
        break;
      case 4:
        value = String(view.getInt32(at));
        at += 4;
        break;
      case 5:
      case 8:
        value = String(view.getBigInt64(at));
        at += 8;
        break;
      case 6:
      case 7: {
        const length = view.getUint16(at);
        const raw = bytes.subarray(at + 2, at + 2 + length);
        value = type === 7 ? text.decode(raw) : Buffer.from(raw).toString("base64");
        at += 2 + length;
        break;
      }
      case 9:
        value = Buffer.from(bytes.subarray(at, at + 16)).toString("hex");
        at += 16;
        break;
      default:
        throw new Error(`Unknown event stream header type ${type}`);
    }
    headers[name] = value;
  }
  return headers;
}

/** Length of the frame starting at `offset`, once its prelude has arrived. */
export function frameLength(bytes: Uint8Array, offset = 0): number | undefined {
  if (bytes.length - offset < 4) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

/** Every complete frame in `bytes`, and where the incomplete rest starts. Throws on a corrupt frame. */
export function decodeFrames(bytes: Uint8Array): { frames: Frame[]; rest: number } {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    const total = frameLength(bytes, offset);
    if (total === undefined || bytes.length - offset < total) break;
    if (total < 16) throw new Error("Event stream frame is too short");
    const frame = bytes.subarray(offset, offset + total);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headersLength = view.getUint32(4);
    if (view.getUint32(8) !== crc32(frame.subarray(0, 8))) throw new Error("Event stream prelude checksum mismatch");
    if (view.getUint32(total - 4) !== crc32(frame.subarray(0, total - 4))) throw new Error("Event stream message checksum mismatch");
    frames.push({
      headers: readHeaders(frame.subarray(12, 12 + headersLength)),
      payload: frame.slice(12 + headersLength, total - 4),
    });
    offset += total;
  }
  return { frames, rest: offset };
}

export function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const encoded = Object.entries(headers).map(([name, value]) => ({ name: utf8.encode(name), value: utf8.encode(value) }));
  const headersLength = encoded.reduce((n, h) => n + 1 + h.name.length + 1 + 2 + h.value.length, 0);
  const total = 12 + headersLength + payload.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  let at = 12;
  for (const h of encoded) {
    frame[at++] = h.name.length;
    frame.set(h.name, at);
    at += h.name.length;
    frame[at++] = 7; // string
    view.setUint16(at, h.value.length);
    at += 2;
    frame.set(h.value, at);
    at += h.value.length;
  }
  frame.set(payload, at);
  view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
  return frame;
}

const STANDARD = new Set([":message-type", ":event-type", ":exception-type", ":content-type"]);

function json(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text.decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

/** Bedrock pads payloads with a random `p` field to hide their length; it means nothing. */
function unpadded(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("p" in value)) return value;
  const { p: _padding, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** A frame as a cassette stores it. */
export function toEvent(frame: Frame): StreamEvent {
  const { headers, payload } = frame;
  const event: StreamEvent = {};
  if (headers[":message-type"] === "exception") event.exception = headers[":exception-type"] ?? "exception";
  else if (headers[":event-type"] !== undefined) event.event = headers[":event-type"];
  const extra = Object.entries(headers).filter(([name, value]) => !STANDARD.has(name) || (name === ":content-type" && value !== "application/json"));
  if (headers[":message-type"] !== undefined && !["event", "exception"].includes(headers[":message-type"])) extra.push([":message-type", headers[":message-type"]]);
  if (extra.length > 0) event.headers = Object.fromEntries(extra);

  const parsed = payload.length === 0 ? undefined : json(payload);
  if (parsed && !parsed.ok) {
    event.base64 = Buffer.from(payload).toString("base64");
    return event;
  }
  const data = unpadded(parsed?.value);
  // InvokeModel streams wrap each piece of the model's own stream, JSON, in base64 `bytes`.
  const bytes = event.event === "chunk" && data !== null && typeof data === "object" ? (data as { bytes?: unknown }).bytes : undefined;
  if (typeof bytes === "string") {
    const inner = json(Buffer.from(bytes, "base64"));
    if (inner.ok && Object.keys(data as object).length === 1) {
      event.bytes = unpadded(inner.value);
      return event;
    }
  }
  if (data !== undefined) event.data = data;
  return event;
}

export function fromEvent(event: StreamEvent): Uint8Array {
  const headers: Record<string, string> = {};
  if (event.exception !== undefined) {
    headers[":message-type"] = "exception";
    headers[":exception-type"] = event.exception;
  } else {
    headers[":message-type"] = "event";
    if (event.event !== undefined) headers[":event-type"] = event.event;
  }
  headers[":content-type"] = "application/json";
  Object.assign(headers, event.headers);
  let payload: Uint8Array;
  if (event.base64 !== undefined) payload = Buffer.from(event.base64, "base64");
  else if (event.bytes !== undefined) payload = utf8.encode(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event.bytes)).toString("base64") }));
  else payload = event.data === undefined ? new Uint8Array(0) : utf8.encode(JSON.stringify(event.data));
  return encodeFrame(headers, payload);
}

/** Decodes a whole recorded stream, or returns undefined when it isn't one. */
export function toEvents(bytes: Uint8Array): StreamEvent[] | undefined {
  try {
    const { frames, rest } = decodeFrames(bytes);
    if (rest !== bytes.length) return undefined;
    return frames.map(toEvent);
  } catch {
    return undefined;
  }
}

/**
 * The events a stream carries, the way readers of a cassette want them: for InvokeModel, the
 * model's own events (Anthropic's `message_start`, `content_block_delta`…); for ConverseStream,
 * each event keyed by its type, as the AWS SDK presents them: `{ contentBlockDelta: {…} }`.
 */
export function payloads(events: StreamEvent[]): unknown[] {
  return events.flatMap((e) => {
    if (e.bytes !== undefined) return [e.bytes];
    const type = e.exception ?? e.event;
    if (type === undefined || e.data === undefined) return [];
    return [{ [type]: e.data }];
  });
}

/**
 * Decodes frames into `events` as they arrive. If the bytes turn out not to be a valid event
 * stream, `fallback` gets all of them at the end.
 */
export function eventSink(events: StreamEvent[], fallback: (bytes: Uint8Array) => void): StreamSink {
  const all: Uint8Array[] = [];
  let pending: Uint8Array = new Uint8Array(0);
  let broken = false;
  return {
    chunk(bytes) {
      all.push(bytes);
      if (broken) return;
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      try {
        const { frames, rest } = decodeFrames(pending);
        events.push(...frames.map(toEvent));
        pending = pending.subarray(rest);
      } catch {
        broken = true;
      }
    },
    end() {
      if (broken || pending.length > 0) fallback(Buffer.concat(all));
    },
  };
}
