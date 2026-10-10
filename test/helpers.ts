import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmpDir = () => mkdtempSync(join(tmpdir(), "tomiko-"));

export interface FakeApi {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: { url: string; body: unknown }[];
}

/** A stand-in for the network that counts calls. */
export function fakeApi(handler: (body: any, request: Request, call: number) => Response | Promise<Response>): FakeApi {
  const calls: FakeApi["calls"] = [];
  const api = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ url: request.url, body });
    return handler(body, request, calls.length);
  };
  return Object.assign(api, { calls });
}

export const offline = (async () => {
  throw new Error("network access in a replay test");
}) as typeof fetch;

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "set-cookie": "s=1" } });

/** An SSE response delivered in deliberately awkward chunks that split events mid-line. */
export function sse(events: { event?: string; data: unknown }[], chunkSize = 37): Response {
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export function anthropicMessage(text: string, model = "claude-opus-5-5") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

export function anthropicStream(parts: string[], model = "claude-opus-5-5") {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_02",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...parts.map((text) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}
