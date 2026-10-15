/**
 * MCP over Streamable HTTP, met in `fetch`: for clients with transports of their own, such as the
 * AI SDK's `createMCPClient({ transport: { type: "http", url } })`. Each JSON-RPC request is an MCP
 * request like any other in the cassette; the HTTP around it (sessions, the stream a client may
 * open for the server's own messages) is answered for, or passed on, as the session allows.
 *
 * Clients of the official SDK don't come this way: tomiko meets them at their transport, and the
 * requests it sends for them skip the cassette.
 */
import { type McpExchange, type McpRecorder, paramsOf, type RpcId, type RpcMessage, slug } from "./mcp.js";
import { runtime } from "./runtime.js";

const SESSION = "mcp-session-id";
const VERSION = "mcp-protocol-version";
const HANDSHAKE = new Set(["initialize", "server/discover", "notifications/initialized"]);
/** HTTP errors not to keep: a timeout or rate limit is worth retrying, a key problem is fixed. */
const TRANSIENT = new Set([401, 403, 408, 429]);

/** What tomiko knows of a client's session with a server, across cassettes. */
interface HttpSession {
  /** The client's handshake, as it sent it, to replay to the server. */
  setup: { message: RpcMessage; headers: Headers; url: string }[];
  /** The client's handshake was answered from a cassette: the server never saw it. */
  replayed: boolean;
  /** The session tomiko opened with the server for it, once a request had to go live. */
  real?: Promise<{ session?: string; version?: string }>;
}

const sessions = (): Map<string, HttpSession> => ((runtime as { mcpHttp?: Map<string, HttpSession> }).mcpHttp ??= new Map());

const endpoint = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

function sessionFor(url: string): HttpSession {
  const key = endpoint(url);
  let session = sessions().get(key);
  if (!session) sessions().set(key, (session = { setup: [], replayed: false }));
  return session;
}

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

/** A request that is MCP over HTTP: a JSON-RPC message, or the session's stream or end. */
export function isMcpHttp(request: Request, body: string | undefined): boolean {
  if (request.method === "POST") return rpcOf(body) !== undefined;
  if (request.method === "GET" || request.method === "DELETE") return request.headers.has(SESSION) || request.headers.has(VERSION);
  return false;
}

/** Thrown out of an exchange when the server answers with an HTTP error, which is passed on and not recorded. */
class HttpFailure extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
  }
}

/** The messages of a Streamable HTTP answer: one JSON-RPC message, or a stream of them. */
async function messagesOf(response: Response): Promise<RpcMessage[]> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const one = rpcOf(text);
    return one ? [one] : [];
  }
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n"),
    )
    .flatMap((data) => {
      const message = rpcOf(data);
      return message ? [message] : [];
    });
}

const json = (body: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });

/** An answer as the server would put it on the wire: JSON, or a stream when something comes before it. */
function answer(messages: RpcMessage[], headers: HeadersInit = {}): Response {
  if (messages.length === 1) return json(messages[0], headers);
  const body = messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { ...Object.fromEntries(new Headers(headers)), "content-type": "text/event-stream" } });
}

const accepted = () => new Response(null, { status: 202 });
/** What a server that keeps no stream for its own messages answers, so the client goes on without one. */
const noStream = () => new Response(null, { status: 405, headers: { allow: "POST" } });

/**
 * Answers an MCP request over HTTP for `cassette`: replayed, or sent and recorded. `send` reaches
 * the server.
 */
export async function mcpOverHttp(cassette: McpRecorder, request: Request, body: string | undefined, send: typeof globalThis.fetch): Promise<Response> {
  const session = sessionFor(request.url);
  if (request.method !== "POST") {
    // The server's stream, or the session's end: the server's business only if it knows the session.
    if (session.replayed && !request.headers.has(SESSION)) {
      if (request.method === "DELETE" && session.real) await end(session, request, send);
      return noStream();
    }
    return send(request);
  }
  const message = rpcOf(body)!;
  const method = message.method;
  if (method && HANDSHAKE.has(method)) {
    // A handshake after a finished one starts a new session: another client, or the same one again.
    if (method !== "notifications/initialized" && session.setup.some((s) => s.message.method === "notifications/initialized")) {
      Object.assign(session, { setup: [], replayed: false, real: undefined });
    }
    session.setup.push({ message, headers: new Headers(request.headers), url: request.url });
  }

  // A notification, or the client's answer to the server: for the server, if it has heard the session begin.
  if (!method || message.id === undefined || message.id === null) {
    if (session.replayed && !session.real) return accepted();
    return send(await live(session, request, body, send));
  }
  if (method === "ping" && session.replayed && !session.real) return json({ jsonrpc: "2.0", id: message.id, result: {} });

  const server = { id: slug(new URL(request.url).hostname) };
  let headers: Headers | undefined;
  try {
    const { exchange, replayed } = await cassette.mcpExchange(server, method, paramsOf(message), async () => {
      const response = await send(await live(session, request, body, send));
      if (!response.ok) {
        // An answer the server would give again (a 400 to a method it doesn't know) is kept; one
        // worth retrying, or about a key, is passed on.
        if (TRANSIENT.has(response.status) || response.status >= 500) throw new HttpFailure(response);
        const contentType = response.headers.get("content-type") ?? undefined;
        return { http: { status: response.status, body: await response.text(), ...(contentType ? { contentType } : {}) } };
      }
      headers = response.headers;
      const messages = await messagesOf(response);
      const final = messages.find((m) => m.id === message.id && m.method === undefined);
      if (!final) throw new HttpFailure(new Response("The MCP server's answer had no response to the request.", { status: 502 }));
      const others = messages.filter((m) => m !== final).map((m) => stored(m, message));
      return { ...(final.error ? { error: final.error } : { result: final.result }), ...(others.length > 0 ? { messages: others } : {}) };
    });
    if (replayed && HANDSHAKE.has(method)) session.replayed = true;
    if (exchange.http) {
      const { status, body: text, contentType } = exchange.http;
      return new Response(text || null, { status, headers: contentType ? { "content-type": contentType } : {} });
    }
    return replayed ? answer(replay(exchange, message)) : answer(replay(exchange, message), pass(headers));
  } catch (error) {
    if (error instanceof HttpFailure) return error.response;
    throw error;
  }
}

/** Headers of the server's answer that the client needs: its session and protocol. */
function pass(headers: Headers | undefined): HeadersInit {
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

/**
 * The request as the server must get it: in a session whose handshake was replayed, the server
 * hears that handshake first, and the request goes in the session it opened.
 */
async function live(session: HttpSession, request: Request, body: string | undefined, send: typeof globalThis.fetch): Promise<Request> {
  if (!session.replayed) return new Request(request, { body });
  session.real ??= handshake(session, send);
  const { session: id, version } = await session.real;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  if (id) headers.set(SESSION, id);
  if (version) headers.set(VERSION, version);
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

async function handshake(session: HttpSession, send: typeof globalThis.fetch): Promise<{ session?: string; version?: string }> {
  let id: string | undefined;
  let version: string | undefined;
  for (const [n, { message, headers, url }] of session.setup.entries()) {
    const sent = new Headers(headers);
    sent.delete("content-length");
    if (id) sent.set(SESSION, id);
    if (version) sent.set(VERSION, version);
    const isRequest = message.id !== undefined && message.id !== null;
    const response = await send(new Request(url, { method: "POST", headers: sent, body: JSON.stringify(isRequest ? { ...message, id: `tomiko-${n + 1}` } : message) }));
    id = response.headers.get(SESSION) ?? id;
    if (isRequest && response.ok) {
      const result = (await messagesOf(response)).find((m) => m.method === undefined)?.result as { protocolVersion?: unknown } | undefined;
      if (message.method === "initialize" && typeof result?.protocolVersion === "string") version = result.protocolVersion;
    } else {
      await response.body?.cancel();
    }
  }
  return { session: id, version };
}

/** Ends the session tomiko opened for a replayed one, when the client ends its own. */
async function end(session: HttpSession, request: Request, send: typeof globalThis.fetch): Promise<void> {
  const { session: id } = await session.real!;
  if (!id) return;
  const headers = new Headers(request.headers);
  headers.set(SESSION, id);
  await send(new Request(request.url, { method: "DELETE", headers })).then((r) => r.body?.cancel(), () => undefined);
}
