/**
 * MCP over HTTP, met in `fetch`: for clients with transports of their own, such as the AI SDK's
 * `createMCPClient({ transport: { type: "http" | "sse", url } })`. Each JSON-RPC request is an MCP
 * request like any other in the cassette; the HTTP around it (sessions, streams) is answered for,
 * or passed on, as the session allows.
 *
 * Streamable HTTP: a client whose `initialize` is replayed gets a session id of tomiko's. Its
 * requests are answered from the cassette; one that has to go live goes in a session tomiko opens
 * with the server for it, replaying the client's handshake first. A client whose `initialize` went
 * to the server keeps the server's session, and its requests go as they are.
 *
 * The older HTTP+SSE transport: tomiko answers the client's stream itself, with an endpoint of its
 * own to post to, and carries the session as it does one over stdio (see `mcp.ts`).
 *
 * Clients of the official SDK don't come this way: tomiko meets them at their transport, and the
 * requests it sends for them skip the cassette.
 */
import { randomUUID } from "node:crypto";
import { TomikoError } from "./errors.js";
import { type McpExchange, type McpRecorder, type McpServer, mcpTransport, type McpTransport, paramsOf, type RpcId, type RpcMessage, slug } from "./mcp.js";
import { runtime } from "./runtime.js";

type Fetch = typeof globalThis.fetch;

const SESSION = "mcp-session-id";
const VERSION = "mcp-protocol-version";
const INITIALIZED = "notifications/initialized";
/** Methods only MCP has: they tell an MCP request from other JSON-RPC over HTTP (an A2A agent's) before MCP's headers do. */
const MCP_METHOD = /^(initialize|ping|server\/discover|(tools|resources|prompts|completion|logging|notifications|roots|sampling|elicitation)\/.+)$/;
/** HTTP errors not to keep: a timeout or rate limit is worth retrying, a key problem is fixed. */
const TRANSIENT = new Set([401, 403, 408, 429]);
/** The query parameter of the endpoint tomiko gives a client of the older HTTP+SSE transport. */
const SSE_SESSION = "tomiko-sse";

/** A client's session with a server over Streamable HTTP. */
interface HttpSession {
  /** The server, named as it named itself in its answer to `initialize`. */
  server: McpServer;
  /**
   * Set when tomiko answered the client's `initialize` from a cassette and gave the session an id
   * of its own: the client's handshake, to replay to the server when a request has to go live.
   */
  setup?: { message: RpcMessage; headers: Headers; url: string }[];
  /** The session tomiko opened with the server for it, then. */
  real?: Promise<{ id?: string; version?: string }>;
}

interface HttpState {
  /** Sessions by the id their client sends: the server's, or one tomiko gave. */
  sessions: Map<string, HttpSession>;
  /** Requests of the server's that a replay passed on, waiting for the client's answer. */
  waiting: Map<string, () => void>;
  /** Clients of the older HTTP+SSE transport, by the session in the endpoint tomiko gave them. */
  sse: Map<string, McpTransport>;
}

/** Kept across cassettes, as clients are: one connected in a `beforeAll` lives through many tests. */
const state = (): HttpState => ((runtime as { mcpOverHttp?: HttpState }).mcpOverHttp ??= { sessions: new Map(), waiting: new Map(), sse: new Map() });

const endpoint = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

const isRequest = (m: RpcMessage) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const marked = (request: Request) => request.headers.has(SESSION) || request.headers.has(VERSION);

/** A JSON-RPC message in a request body, if that's what it is. */
function rpcOf(text: string | undefined): RpcMessage | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as RpcMessage).jsonrpc === "2.0") return parsed as RpcMessage;
  } catch {
    // Not JSON.
  }
  return undefined;
}

/** The session in the endpoint tomiko gave a client of the older HTTP+SSE transport, if the request goes there. */
function sseSessionOf(request: Request): McpTransport | undefined {
  const id = new URL(request.url).searchParams.get(SSE_SESSION);
  return id === null ? undefined : state().sse.get(id);
}

/**
 * A request that is MCP over HTTP: an MCP message (by its method, or MCP's headers), the stream or
 * end of a Streamable HTTP session, or a post to the endpoint tomiko gave an SSE client.
 */
export function isMcpHttp(request: Request, body: string | undefined): boolean {
  if (request.method === "POST") {
    const message = rpcOf(body);
    if (!message) return false;
    return marked(request) || (typeof message.method === "string" && MCP_METHOD.test(message.method)) || sseSessionOf(request) !== undefined;
  }
  if (request.method === "GET" || request.method === "DELETE") return marked(request);
  return false;
}

/**
 * A GET for a stream of events outside any Streamable HTTP session: maybe the stream of MCP's older
 * HTTP+SSE transport, which only the server, or a cassette's recording of it, can tell.
 */
export function maybeSseStream(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/event-stream") && !request.headers.has(SESSION);
}

/** Thrown out of an exchange when the server answers with an HTTP error, which is passed on and not recorded. */
class HttpFailure extends Error {
  constructor(
    readonly response: Response,
    reason = `HTTP ${response.status}`,
  ) {
    super(reason);
  }
}

/* ---------------------------------------- server-sent events ---------------------------------------- */

interface SseEvent {
  event: string;
  data: string;
}

const BOUNDARY = /\r?\n\r?\n/;

function parseEvent(block: string): SseEvent | undefined {
  let event = "";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return event || data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

/** The events of a stream, as they come. */
async function* eventsOf(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at = BOUNDARY.exec(buffer); at; at = BOUNDARY.exec(buffer)) {
      const event = parseEvent(buffer.slice(0, at.index));
      buffer = buffer.slice(at.index + at[0].length);
      if (event) yield event;
    }
  }
  const last = parseEvent(buffer + decoder.decode());
  if (last) yield last;
}

const isAnswer = (message: RpcMessage, id: RpcId | undefined) => message.method === undefined && message.id === id;

/**
 * The messages of a Streamable HTTP answer to request `id`: one JSON-RPC message, or a stream of
 * them, up to the answer, which ends the exchange whether or not the server ends the stream.
 */
async function messagesOf(response: Response, id: RpcId | undefined): Promise<RpcMessage[]> {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
    const one = rpcOf(await response.text());
    return one ? [one] : [];
  }
  const messages: RpcMessage[] = [];
  const reader = response.body.getReader();
  for await (const { data } of eventsOf(reader)) {
    const message = rpcOf(data);
    if (!message) continue;
    messages.push(message);
    if (isAnswer(message, id)) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return messages;
}

/**
 * The first event of a stream, read without losing it: the response comes back whole. Gives up
 * after `ms`, for a stream with nothing to say yet.
 */
export async function peekEvent(response: Response, ms = 1000): Promise<{ event?: string; response: Response }> {
  if (!response.body) return { response };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let ended = false;
  const deadline = Date.now() + ms;
  while (!BOUNDARY.test(text) && !ended) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer: NodeJS.Timeout | undefined;
    pending ??= reader.read();
    const next = await Promise.race([pending, new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), left)))]);
    clearTimeout(timer);
    if (next === "late") break;
    pending = undefined;
    if (next.done) ended = true;
    else {
      chunks.push(next.value);
      text += decoder.decode(next.value, { stream: true });
    }
  }
  const at = BOUNDARY.exec(text);
  const event = at ? parseEvent(text.slice(0, at.index)) : undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks.shift();
      if (chunk) return controller.enqueue(chunk);
      if (ended) return controller.close();
      const next = await (pending ?? reader.read());
      pending = undefined;
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { event: event?.event, response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }) };
}

/* ------------------------------------------- answers ------------------------------------------- */

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { ...headers, "content-type": "application/json" } });
const accepted = () => new Response(null, { status: 202 });
/** What a server that keeps no stream for its own messages answers, so the client goes on without one. */
const noStream = () => new Response(null, { status: 405, headers: { allow: "POST" } });

/**
 * An answer as the server would put it on the wire: JSON, or a stream when something comes before
 * it. A request of the server's in it waits for `answered`, as the server did for the client's answer.
 */
function answer(messages: RpcMessage[], headers: Record<string, string>, answered?: (request: RpcMessage) => { promise: Promise<void>; give: () => void }): Response {
  if (messages.length === 1) return json(messages[0], headers);
  const encoder = new TextEncoder();
  let waiting: (() => void) | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        for (const message of messages) {
          if (cancelled) return;
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
          if (answered && isRequest(message)) {
            const { promise, give } = answered(message);
            waiting = give;
            await promise;
            waiting = undefined;
          }
        }
        if (!cancelled) controller.close();
      })();
    },
    cancel() {
      cancelled = true;
      waiting?.();
    },
  });
  return new Response(body, { status: 200, headers: { ...headers, "content-type": "text/event-stream" } });
}

/** Headers of the server's answer that the client needs: its session and protocol. */
function pass(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [SESSION, VERSION]) {
    const value = headers?.get(name);
    if (value) out[name] = value;
  }
  return out;
}

const progressToken = (message: RpcMessage): RpcId | undefined => (message.params?._meta as { progressToken?: RpcId } | undefined)?.progressToken;

/** A message from the server as a cassette keeps it: progress without the client's per-run token. */
function stored(message: RpcMessage, request: RpcMessage): RpcMessage {
  if (message.method !== "notifications/progress" || !message.params) return message;
  const { progressToken: given, ...params } = message.params;
  return given === progressToken(request) ? { ...message, params } : message;
}

/** The recorded messages and answer, for the request the client sent this time. */
function replay(exchange: McpExchange, request: RpcMessage): RpcMessage[] {
  const token = progressToken(request);
  const before = (exchange.messages ?? []).flatMap((m): RpcMessage[] => {
    if (m.method !== "notifications/progress") return [m];
    return token === undefined ? [] : [{ ...m, params: { ...m.params, progressToken: token } }];
  });
  const final: RpcMessage = exchange.error ? { jsonrpc: "2.0", id: request.id, error: exchange.error } : { jsonrpc: "2.0", id: request.id, result: exchange.result ?? {} };
  return [...before, final];
}

/** The server as it named itself in an answer to `initialize`, or `fallback`. */
function named(exchange: McpExchange, fallback: McpServer): McpServer {
  const name = (exchange.result as { serverInfo?: { name?: unknown } } | undefined)?.serverInfo?.name;
  return typeof name === "string" && name ? { id: slug(name), name } : fallback;
}

/* ------------------------------------------ Streamable HTTP ------------------------------------------ */

/**
 * Answers an MCP request over HTTP for `cassette`: replayed, or sent and recorded. Without a
 * cassette (`mcp: false`), it goes to the server as it is, unless it belongs to a session tomiko
 * answered for. `send` reaches the server.
 */
export async function mcpOverHttp(cassette: McpRecorder | undefined, request: Request, body: string | undefined, send: Fetch): Promise<Response> {
  const sse = sseSessionOf(request);
  if (sse) return postToSse(sse, rpcOf(body));
  const sid = request.headers.get(SESSION) ?? undefined;
  const session = sid === undefined ? undefined : state().sessions.get(sid);
  try {
    if (request.method !== "POST") return await notPost(cassette, session, sid, request, send);
    return await post(cassette, session, sid, request, body!, send);
  } catch (error) {
    if (error instanceof HttpFailure) return error.response;
    throw error;
  }
}

/** The session's stream, or its end: the server's business, unless tomiko answered for the session. */
async function notPost(cassette: McpRecorder | undefined, session: HttpSession | undefined, sid: string | undefined, request: Request, send: Fetch): Promise<Response> {
  if (request.method === "DELETE" && sid !== undefined) {
    state().sessions.delete(sid);
    release(sid);
  }
  // A stream asked for before there is a session to carry: whose it would be, a replay can't say.
  if (cassette && sid === undefined && request.method === "GET") return noStream();
  if (!session?.setup) return send(request);
  if (request.method === "GET") return noStream();
  if (session.real) await end(session, request, send);
  return new Response(null, { status: 200 });
}

async function post(cassette: McpRecorder | undefined, session: HttpSession | undefined, sid: string | undefined, request: Request, body: string, send: Fetch): Promise<Response> {
  const message = rpcOf(body)!;
  const method = message.method;
  const setup = session?.setup;

  // A notification, or the client's answer to a request of the server's.
  if (method === undefined || message.id === undefined || message.id === null) {
    const answered = method === undefined ? take(waitKey(sid, request.url, message.id)) : undefined;
    if (answered) {
      answered();
      return accepted();
    }
    // The server hasn't heard of a session tomiko answered for, until a request has to reach it.
    if (setup && !session.real) {
      if (method === INITIALIZED) setup.push({ message, headers: new Headers(request.headers), url: request.url });
      return accepted();
    }
    return sendLive(session, request, body, send);
  }
  if (method === "ping" && setup && !session.real) return json({ jsonrpc: "2.0", id: message.id, result: {} });

  // The client's initialize starts a session of its own, whatever id it still sends.
  const current = method === "initialize" ? undefined : session;
  const ours = current?.setup !== undefined;
  if (!cassette) return sendLive(current, request, body, send);

  const server = current?.server ?? { id: slug(new URL(request.url).hostname) };
  let streamed: (response: Response) => void = () => undefined;
  const early = new Promise<Response>((resolve) => (streamed = resolve));
  let headers: Headers | undefined;
  const outcome = cassette.mcpExchange(server, method, paramsOf(message), async (answering) => {
    const response = await sendLive(current, request, body, send);
    if (!response.ok) {
      // An answer the server would give again (a 400 to a method it doesn't know) is kept; one
      // worth retrying, about a key, or for a session the server ended (404) is passed on.
      if (TRANSIENT.has(response.status) || response.status >= 500 || (response.status === 404 && request.headers.has(SESSION))) throw new HttpFailure(response);
      const contentType = response.headers.get("content-type") ?? undefined;
      return { http: { status: response.status, body: await response.text(), ...(contentType ? { contentType } : {}) } };
    }
    // The older HTTP+SSE transport answers on its stream, which tomiko didn't open.
    if (response.status === 202 || !response.body) throw new HttpFailure(response, "it answered on a stream tomiko didn't open (the older HTTP+SSE transport)");
    headers = response.headers;
    let messages: RpcMessage[];
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && method !== "initialize") {
      // The client reads the stream as it comes: the server may ask it something before it answers.
      const [mine, theirs] = response.body.tee();
      answering();
      streamed(new Response(theirs, { status: response.status, headers: { ...(ours ? {} : pass(response.headers)), "content-type": "text/event-stream" } }));
      messages = await messagesOf(new Response(mine, { headers: response.headers }), message.id);
    } else {
      messages = await messagesOf(response, message.id);
    }
    const final = messages.find((m) => isAnswer(m, message.id));
    if (!final) throw new HttpFailure(new Response("The MCP server's answer had no response to the request.", { status: 502 }), "its answer had no response to the request");
    const others = messages.filter((m) => m !== final).map((m) => stored(m, message));
    return { ...(final.error ? { error: final.error } : { result: final.result }), ...(others.length > 0 ? { messages: others } : {}) };
  });
  const settled = outcome.then(({ exchange, replayed }) => {
    if (exchange.http) {
      const { status, body: text, contentType } = exchange.http;
      return new Response(text || null, { status, headers: contentType ? { "content-type": contentType } : {} });
    }
    const messages = replay(exchange, message);
    if (!replayed) {
      // The server's session, named for the requests that follow in it.
      const real = method === "initialize" ? headers?.get(SESSION) : null;
      if (real && !exchange.error) state().sessions.set(real, { server: named(exchange, server) });
      return answer(messages, ours ? {} : pass(headers));
    }
    if (method === "initialize" && !exchange.error) {
      // The server never saw this handshake: the session is tomiko's, under an id of its own.
      const id = `tomiko-${randomUUID()}`;
      state().sessions.set(id, { server: named(exchange, server), setup: [{ message, headers: new Headers(request.headers), url: request.url }] });
      return answer(messages, { [SESSION]: id });
    }
    return answer(messages, {}, (asked) => waitFor(waitKey(sid, request.url, asked.id)));
  });
  return Promise.race([early, settled]);
}

/** Where a client's answer to a request of the server's is waited for: its session, or its server. */
const waitKey = (sid: string | undefined, url: string, id: RpcId | undefined) => `${sid ?? endpoint(url)} ${JSON.stringify(id)}`;

function waitFor(key: string): { promise: Promise<void>; give: () => void } {
  let give!: () => void;
  const promise = new Promise<void>((resolve) => (give = resolve));
  state().waiting.set(key, give);
  return { promise, give: () => (state().waiting.delete(key), give()) };
}

function take(key: string): (() => void) | undefined {
  const { waiting } = state();
  const waiter = waiting.get(key);
  waiting.delete(key);
  return waiter;
}

/** Lets a replay go on past what a session's client won't answer now: it ended. */
function release(sid: string): void {
  for (const [key, waiter] of state().waiting) {
    if (key.startsWith(`${sid} `)) {
      state().waiting.delete(key);
      waiter();
    }
  }
}

/**
 * Sends the request to the server: as it is, or, in a session tomiko answered for, in the session
 * tomiko opened for it. If the server ended that one (404), tomiko opens another, once.
 */
async function sendLive(session: HttpSession | undefined, request: Request, body: string | undefined, send: Fetch): Promise<Response> {
  if (!session?.setup) return send(new Request(request, { body }));
  const response = await send(await inSession(session, request, body, send));
  if (response.status !== 404) return response;
  await response.body?.cancel();
  session.real = undefined;
  return send(await inSession(session, request, body, send));
}

/** The request as the server must get it: in the session tomiko opened, its handshake replayed first. */
async function inSession(session: HttpSession, request: Request, body: string | undefined, send: Fetch): Promise<Request> {
  const opening = (session.real ??= handshake(session, send).catch((error: unknown) => {
    // The next request tries again.
    session.real = undefined;
    throw error;
  }));
  const { id, version } = await opening;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete(SESSION);
  if (id) headers.set(SESSION, id);
  if (version) headers.set(VERSION, version);
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

/** The client's handshake, as it sent it, replayed to the server: the session it opens. */
async function handshake(session: HttpSession, send: Fetch): Promise<{ id?: string; version?: string }> {
  let id: string | undefined;
  let version: string | undefined;
  for (const [n, { message, headers, url }] of session.setup!.entries()) {
    const sent = new Headers(headers);
    sent.delete("content-length");
    sent.delete(SESSION);
    if (id) sent.set(SESSION, id);
    if (version) sent.set(VERSION, version);
    const request = isRequest(message);
    const response = await send(new Request(url, { method: "POST", headers: sent, body: JSON.stringify(request ? { ...message, id: `tomiko-${n + 1}` } : message) }));
    if (!response.ok) throw new HttpFailure(response, `the server answered the handshake tomiko replayed to it with HTTP ${response.status}`);
    id = response.headers.get(SESSION) ?? id;
    if (!request) {
      await response.body?.cancel();
      continue;
    }
    const reply = (await messagesOf(response, `tomiko-${n + 1}`)).find((m) => isAnswer(m, `tomiko-${n + 1}`));
    if (!reply || reply.error) {
      const why = reply?.error?.message ?? "no answer";
      throw new HttpFailure(new Response(`The MCP server refused the handshake tomiko replayed to it: ${why}`, { status: 502 }), `the server refused the handshake tomiko replayed to it: ${why}`);
    }
    const result = reply.result as { protocolVersion?: unknown } | undefined;
    if (message.method === "initialize" && typeof result?.protocolVersion === "string") version = result.protocolVersion;
  }
  return { id, version };
}

/** Ends the session tomiko opened for one it answered for, when the client ends its own. */
async function end(session: HttpSession, request: Request, send: Fetch): Promise<void> {
  const real = await session.real!.catch(() => undefined);
  if (!real?.id) return;
  const headers = new Headers(request.headers);
  headers.set(SESSION, real.id);
  await send(new Request(request.url, { method: "DELETE", headers })).then((r) => r.body?.cancel(), () => undefined);
}

/* ------------------------------------ the older HTTP+SSE transport ------------------------------------ */

/**
 * The server's side of the older HTTP+SSE transport, as an MCP transport: a stream of events that
 * names where to post, then carries the server's messages. Started only when a message has to reach
 * the server; `opened` is its stream, if tomiko had to open it to know what it was.
 */
class SseServerConnection {
  onmessage?: (message: RpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private postTo: string | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private closed = false;

  constructor(
    readonly url: string,
    private readonly headers: Headers,
    private readonly fetch: Fetch,
    private opened?: Response,
  ) {}

  async start(): Promise<void> {
    const response = this.opened ?? (await this.fetch(new Request(this.url, { headers: this.headers })));
    this.opened = undefined;
    if (!response.ok || !response.body) throw new TomikoError(`The MCP server's event stream at ${endpoint(this.url)} answered HTTP ${response.status}.`);
    this.reader = response.body.getReader();
    const events = eventsOf(this.reader);
    for (;;) {
      const next = await events.next();
      if (next.done) throw new TomikoError(`The MCP server's event stream at ${endpoint(this.url)} ended before it named where to post.`);
      if (next.value.event === "endpoint") {
        this.postTo = new URL(next.value.data, this.url).href;
        break;
      }
    }
    void (async () => {
      for await (const { event, data } of events) {
        const message = event === "message" || event === "" ? rpcOf(data) : undefined;
        if (message) this.onmessage?.(message);
      }
    })().then(
      () => this.onclose?.(),
      (error: unknown) => {
        if (!this.closed) this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.onclose?.();
      },
    );
  }

  async send(message: RpcMessage): Promise<void> {
    if (!this.postTo) throw new TomikoError("The MCP server's event stream isn't open.");
    const headers = new Headers(this.headers);
    headers.delete("accept");
    headers.set("content-type", "application/json");
    const response = await this.fetch(new Request(this.postTo, { method: "POST", headers, body: JSON.stringify(message) }));
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new TomikoError(`The MCP server answered HTTP ${response.status}${text ? `: ${text}` : ""}.`);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.opened?.body?.cancel().catch(() => undefined);
    await this.reader?.cancel().catch(() => undefined);
  }
}

/**
 * Opens a client's stream of the older HTTP+SSE transport: tomiko's, with an endpoint of its own
 * to post to, over a session that answers from the cassette and reaches the server when it must.
 */
export function openSse(request: Request, send: Fetch, opened?: Response): Response {
  const id = randomUUID();
  const postTo = new URL(request.url);
  postTo.searchParams.set(SSE_SESSION, id);
  const headers = new Headers(request.headers);
  const connection = new SseServerConnection(request.url, headers, send, opened);
  const transport = mcpTransport(connection as unknown as McpTransport, { transport: "sse" }) as McpTransport & { onmessage?: (message: RpcMessage) => void };
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    state().sse.delete(id);
    void transport.close();
    void connection.close();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${postTo.pathname}${postTo.search}\n\n`));
    },
    // The client closed its stream: it is done with the session.
    cancel: finish,
  });
  transport.onmessage = (message) => {
    if (!ended) stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  };
  transport.onclose = () => {
    if (ended) return;
    finish();
    stream.close();
  };
  transport.onerror = () => undefined;
  void transport.start();
  state().sse.set(id, transport);
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** A client's message to the endpoint tomiko gave it: into its session, and accepted, as the server would. */
async function postToSse(transport: McpTransport, message: RpcMessage | undefined): Promise<Response> {
  if (!message) return new Response("Not a JSON-RPC message.", { status: 400 });
  try {
    await (transport.send as (message: RpcMessage) => Promise<void>)(message);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 502 });
  }
  return new Response("Accepted", { status: 202 });
}
