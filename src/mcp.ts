/**
 * MCP servers in cassettes: what an agent asks its MCP servers (to list their tools, call one,
 * read a resource) and what they answer, recorded and replayed like its model's answers. A replay
 * starts no server: no process is spawned and nothing goes over the network.
 *
 * tomiko sits between the MCP client and its transport, so it sees JSON-RPC messages, whatever
 * carries them: a server's stdin and stdout, Streamable HTTP, SSE, a WebSocket, memory. The real
 * transport starts only when a message has to reach the server; if the session's handshake was
 * replayed, tomiko replays it to the server first, so a new request can go live in a replayed
 * session.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TomikoError } from "./errors.js";
import { bypassed, runtime } from "./runtime.js";

export type RpcId = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC 2.0 message: a request (`id` and `method`), a notification (`method`), a response (`id`). */
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: RpcError;
}

/**
 * What tomiko needs of an MCP transport: the official SDK's `Transport` and the AI SDK's
 * `MCPTransport` both have it.
 */
export interface McpTransport {
  start(): Promise<void>;
  send(message: never, options?: never): Promise<void>;
  close(...args: never[]): Promise<void>;
  onmessage?: (message: never, extra?: never) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

export interface McpTransportOptions {
  /**
   * The server's name in cassettes. Default: from the command that starts it
   * (`npx @modelcontextprotocol/server-filesystem` is `server-filesystem`), its host for one over
   * HTTP, or the name it gives itself.
   */
  name?: string;
}

/** An MCP request's outcome, as a cassette keeps it. */
export interface McpExchange {
  result?: unknown;
  error?: RpcError;
  /** What the server sent while it worked: progress, log messages, requests of its own. */
  messages?: RpcMessage[];
  /** Over HTTP, an answer that was an HTTP error rather than a JSON-RPC one, such as a 400 to a request the server doesn't know. */
  http?: { status: number; body: string; contentType?: string };
}

/** The server a session talks to. */
export interface McpServer {
  /** How cassettes name it: in each request's URL, `mcp://<id>/<method>`. */
  id: string;
  /** The name it gives itself, once it has. */
  name?: string;
}

/** What a cassette does for MCP sessions. */
export interface McpRecorder {
  readonly name: string;
  /** False when the cassette leaves MCP alone (`mcp: false`). */
  readonly recordsMcp: boolean;
  /** Replays the request's outcome, or gets it with `send` and records it. */
  mcpExchange(server: McpServer, method: string, params: unknown, send: () => Promise<McpExchange>): Promise<{ exchange: McpExchange; replayed: boolean }>;
}

/** Requests that set a session up, replayed to the server before a request goes live in a replayed session. */
const HANDSHAKE = new Set(["initialize", "server/discover"]);
const INITIALIZED = "notifications/initialized";
/** JSON-RPC's code for an error inside the server, used when tomiko can't answer for it. */
const INTERNAL_ERROR = -32603;

const isRequest = (m: RpcMessage) => typeof m.method === "string" && m.id !== undefined && m.id !== null;
const isNotification = (m: RpcMessage) => typeof m.method === "string" && (m.id === undefined || m.id === null);
const isResponse = (m: RpcMessage) => m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

/** Request params as a cassette keeps them: without `_meta`, which carries per-run tokens. */
export function paramsOf(message: RpcMessage): Record<string, unknown> | undefined {
  if (!message.params || typeof message.params !== "object") return undefined;
  const { _meta: _, ...rest } = message.params;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

const progressToken = (message: RpcMessage): RpcId | undefined => {
  const meta = message.params?._meta as { progressToken?: RpcId } | undefined;
  return meta?.progressToken;
};

/* -------------------------------------- naming servers -------------------------------------- */

/** A name fit for a URL host: `secure-filesystem-server`. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "mcp"
  );
}

/** Commands that run something else, named by what they run. */
const LAUNCHERS = /^(npx|pnpx|bunx|uvx|uv|pipx|node|nodejs|deno|bun|python\d*(\.\d+)?|py|tsx|ts-node|docker|podman|npm|pnpm|yarn|go|cargo|dotnet|java|ruby|php|sh|bash|cmd)$/i;
const SUBCOMMANDS = new Set(["run", "exec", "dlx", "x", "tool", "start", "serve"]);
const base = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.(m?[jt]s|c[jt]s|py|exe|cmd|sh|jar)$/i, "");

/** `server-filesystem` for `npx -y @modelcontextprotocol/server-filesystem /data`. */
export function nameFromCommand(command: string, args: readonly string[] = []): string {
  const program = base(command);
  if (!LAUNCHERS.test(program)) return slug(program);
  const positional = args.filter((a) => !a.startsWith("-") && !SUBCOMMANDS.has(a) && !a.includes("="));
  // A package, an image or a script (`@scope/pkg`, `ghcr.io/x/y`, `server.py`, `mcp-server-git`),
  // not a value given to a flag (`-e GITHUB_TOKEN`).
  const target = positional.find((a) => /[/@.-]/.test(a)) ?? positional[0];
  if (!target) return slug(program);
  const withoutVersion = target.replace(/(?<=.)@[^/]*$/, "").replace(/:[\w.-]+$/, "");
  return slug(base(withoutVersion));
}

/** The name of the server a transport reaches, from what the official SDK's and the AI SDK's transports keep. */
export function nameOf(transport: object): string | undefined {
  const t = transport as Record<string, unknown>;
  const params = (t._serverParams ?? t.serverParams) as { command?: unknown; args?: unknown } | undefined;
  if (params && typeof params.command === "string") return nameFromCommand(params.command, Array.isArray(params.args) ? params.args.map(String) : []);
  for (const url of [t._url, t.url]) {
    if (url instanceof URL) return slug(url.hostname);
    if (typeof url === "string") {
      try {
        return slug(new URL(url).hostname);
      } catch {
        // Not a URL.
      }
    }
  }
  return undefined;
}

/* ------------------------------------------ sessions ------------------------------------------ */

interface Pending {
  method: string;
  token?: RpcId;
  messages: RpcMessage[];
  resolve: (exchange: McpExchange) => void;
  reject: (error: unknown) => void;
}

type Handlers = Pick<McpTransport, "onclose" | "onerror"> & { onmessage?: (message: RpcMessage, extra?: unknown) => void };

const WRAPPED = Symbol.for("tomiko.mcp.transport");

/**
 * One MCP connection, between the client and the real transport. The client sees a transport;
 * the server sees only what has to reach it.
 */
class Session {
  readonly handlers: Handlers = {};
  private readonly id: string | undefined;
  /** The name the server gives itself in its answer to `initialize`. */
  private serverName: string | undefined;
  private real: Promise<void> | undefined;
  /** The server has been through the handshake, the client's or one tomiko replayed to it. */
  private initialized = false;
  /** The client's handshake was answered from a cassette, so the server hasn't seen it. */
  private replayedHandshake = false;
  private handshaking: Promise<void> | undefined;
  /** The client's handshake messages, to replay to the server when a request has to go live. */
  private readonly setup: RpcMessage[] = [];
  private protocolVersion: string | undefined;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly internal = new Map<RpcId, (message: RpcMessage) => void>();
  /** Requests from the server that tomiko replayed: the client's answers to them go nowhere. */
  private readonly replayedServerRequests = new Set<RpcId>();
  private closed = false;
  private notifiedClose = false;
  private counter = 0;

  constructor(
    readonly transport: McpTransport,
    options: McpTransportOptions,
  ) {
    this.id = options.name ? slug(options.name) : nameOf(transport);
  }

  get server(): McpServer {
    return { id: this.id ?? (this.serverName ? slug(this.serverName) : "mcp"), ...(this.serverName ? { name: this.serverName } : {}) };
  }

  /** Starts nothing yet: the real transport starts when a message has to reach the server. */
  async start(): Promise<void> {}

  async send(message: RpcMessage, options?: unknown): Promise<void> {
    if (isRequest(message)) return this.request(message, options);
    if (isNotification(message)) {
      if (message.method === INITIALIZED) this.setup.push(message);
      // In a replayed session the server has nothing to hear: it never saw the handshake.
      if (this.real && this.initialized) await this.forward(message, options);
      return;
    }
    if (isResponse(message) && this.replayedServerRequests.delete(message.id!)) return;
    if (this.real) await this.forward(message, options);
  }

  private async request(message: RpcMessage, options: unknown): Promise<void> {
    const method = message.method!;
    if (HANDSHAKE.has(method)) this.setup.push(message);
    // Pings check the connection, which a replay doesn't have; they come and go with timers.
    if (method === "ping") {
      if (this.real && this.initialized) return this.forward(message, options);
      return this.deliver({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    const cassette = runtime.active as Partial<McpRecorder> | undefined;
    if (!cassette?.mcpExchange || cassette.recordsMcp === false) {
      // Straight to the server, unrecorded; send() fails if it can't be sent.
      await this.ready(method);
      this.track(message).catch(() => undefined);
      return this.forward(message, options).catch((error: unknown) => {
        this.pending.delete(message.id!);
        throw error;
      });
    }
    // The cassette takes its place in line now, so concurrent requests keep their order.
    const outcome = cassette.mcpExchange(this.server, method, paramsOf(message), () => this.exchange(message, options));
    void outcome.then(
      ({ exchange, replayed }) => {
        if (!replayed) return; // Delivered as it came.
        if (HANDSHAKE.has(method)) this.replayedHandshake = true;
        if (method === "initialize") this.learn(exchange.result);
        this.replay(message, exchange);
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        this.deliver({ jsonrpc: "2.0", id: message.id, error: { code: INTERNAL_ERROR, message: text } });
      },
    );
  }

  /** Sends a request to the server, passing on what comes back as it comes, and resolves with all of it. */
  private async exchange(message: RpcMessage, options: unknown): Promise<McpExchange> {
    await this.ready(message.method!);
    const outcome = this.track(message);
    try {
      await this.forward(message, options);
    } catch (error) {
      this.pending.delete(message.id!);
      throw error;
    }
    return outcome;
  }

  /** The server, ready for `method`: a handshake goes as it is; anything else may need one replayed first. */
  private ready(method: string): Promise<void> {
    return HANDSHAKE.has(method) ? this.started() : this.live();
  }

  /** What the server sends back for a request, until its answer. */
  private track(message: RpcMessage): Promise<McpExchange> {
    return new Promise<McpExchange>((resolve, reject) => {
      this.pending.set(message.id!, { method: message.method!, token: progressToken(message), messages: [], resolve, reject });
    });
  }

  private forward(message: RpcMessage, options?: unknown): Promise<void> {
    return bypassed(() => this.transport.send(message as never, options as never));
  }

  /** The real transport, started. */
  private started(): Promise<void> {
    this.real ??= bypassed(async () => {
      this.transport.onmessage = ((message: RpcMessage, extra?: unknown) => this.fromServer(message, extra)) as never;
      this.transport.onclose = () => this.realClosed();
      this.transport.onerror = (error: Error) => this.handlers.onerror?.(error);
      await this.transport.start();
      if (this.protocolVersion) this.transport.setProtocolVersion?.(this.protocolVersion);
    });
    return this.real;
  }

  /** The real transport, started, and its server through the handshake. */
  private async live(): Promise<void> {
    await this.started();
    if (this.replayedHandshake && !this.initialized) await (this.handshaking ??= this.handshake());
  }

  /** The client's handshake, as it sent it, replayed to the server; the server's answers go no further. */
  private async handshake(): Promise<void> {
    for (const message of this.setup) {
      if (isNotification(message)) {
        await this.forward(message);
        continue;
      }
      const id = `tomiko-${++this.counter}`;
      const answer = await new Promise<RpcMessage>((resolve, reject) => {
        this.internal.set(id, resolve);
        this.forward({ ...message, id }).catch(reject);
      });
      const result = answer.result as { protocolVersion?: unknown } | undefined;
      if (message.method === "initialize" && typeof result?.protocolVersion === "string") this.transport.setProtocolVersion?.(result.protocolVersion);
    }
    this.initialized = true;
  }

  private fromServer(message: RpcMessage, extra?: unknown): void {
    if (isResponse(message)) {
      const internal = this.internal.get(message.id!);
      if (internal) {
        this.internal.delete(message.id!);
        return internal(message);
      }
      const pending = this.pending.get(message.id!);
      if (pending) {
        this.pending.delete(message.id!);
        if (pending.method === "initialize" && message.result !== undefined) {
          this.initialized = true;
          this.learn(message.result);
        }
        this.deliver(message, extra);
        return pending.resolve({
          ...("error" in message ? { error: message.error } : { result: message.result }),
          ...(pending.messages.length > 0 ? { messages: pending.messages } : {}),
        });
      }
    } else {
      // What the server sends while it works belongs with the request it works on: a progress
      // notification names it, anything else goes with the latest one.
      const token = (message.params as { progressToken?: RpcId } | undefined)?.progressToken;
      const owners = [...this.pending.values()];
      const owner = (token !== undefined ? owners.find((p) => p.token === token) : undefined) ?? owners.at(-1);
      if (owner) owner.messages.push(stored(message, owner.token));
    }
    this.deliver(message, extra);
  }

  /** What the server said to `initialize`: its name, and the protocol the client will speak. */
  private learn(result: unknown): void {
    const name = (result as { serverInfo?: { name?: unknown } } | undefined)?.serverInfo?.name;
    if (typeof name === "string" && name) this.serverName = name;
  }

  /** A recorded outcome, delivered as the server sent it: what came first, then the answer. */
  private replay(request: RpcMessage, exchange: McpExchange): void {
    const token = progressToken(request);
    const messages = (exchange.messages ?? []).flatMap((m): RpcMessage[] => {
      if (m.method === "notifications/progress") {
        // Progress goes to the token the client gave this time, and only if it asked for progress.
        return token === undefined ? [] : [{ ...m, params: { ...m.params, progressToken: token } }];
      }
      if (isRequest(m)) this.replayedServerRequests.add(m.id!);
      return [m];
    });
    const answer: RpcMessage = exchange.error ? { jsonrpc: "2.0", id: request.id, error: exchange.error } : { jsonrpc: "2.0", id: request.id, result: exchange.result ?? {} };
    for (const m of [...messages, answer]) this.deliver(m);
  }

  private readonly outbox: [RpcMessage, unknown][] = [];

  /**
   * Passes a message to the client, one per turn of the event loop, after the send that asked for
   * it has returned. The SDK handles a notification a tick after it arrives, and an answer at once:
   * progress that arrives together with the answer that ends it would be dropped, and a server
   * often writes them together.
   */
  private deliver(message: RpcMessage, extra?: unknown): void {
    this.outbox.push([message, extra]);
    if (this.outbox.length === 1) setImmediate(() => this.flush());
  }

  private flush(): void {
    const [message, extra] = this.outbox.shift()!;
    if (!(this.closed && isResponse(message))) this.handlers.onmessage?.(message, extra);
    if (this.outbox.length > 0) setImmediate(() => this.flush());
  }

  private realClosed(): void {
    for (const pending of this.pending.values()) pending.reject(new TomikoError("The MCP connection closed before the server answered."));
    this.pending.clear();
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.notifiedClose) return;
    this.notifiedClose = true;
    this.handlers.onclose?.();
  }

  async close(...args: unknown[]): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.real) {
      await this.real.catch(() => undefined);
      await bypassed(() => (this.transport.close as (...a: unknown[]) => Promise<void>)(...args));
    }
    this.notifyClose();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    if (this.real && this.initialized) this.transport.setProtocolVersion?.(version);
  }
}

/** A message from the server as a cassette keeps it: a progress notification without its per-run token. */
function stored(message: RpcMessage, token: RpcId | undefined): RpcMessage {
  if (message.method !== "notifications/progress" || !message.params) return message;
  const { progressToken: given, ...params } = message.params;
  return given === token ? { ...message, params } : message;
}

/**
 * An MCP transport whose messages go through the active cassette: recorded, or replayed without
 * starting the server. Everything else about the transport (its process id, its stderr) is the
 * transport's own.
 *
 * ```ts
 * await client.connect(mcpTransport(new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] })));
 * ```
 *
 * Clients of the official SDK (`@modelcontextprotocol/sdk`, or `@modelcontextprotocol/client` from
 * version 2), which the OpenAI Agents SDK, Mastra and LangChain use, get this without asking.
 */
export function mcpTransport<T extends McpTransport>(transport: T, options: McpTransportOptions = {}): T {
  if ((transport as unknown as Record<symbol, unknown>)[WRAPPED]) return transport;
  const session = new Session(transport, options);
  const own: Record<PropertyKey, unknown> = {
    start: () => session.start(),
    send: (message: RpcMessage, sendOptions?: unknown) => session.send(message, sendOptions),
    close: (...args: unknown[]) => session.close(...args),
    [WRAPPED]: session,
  };
  return new Proxy(transport, {
    get(target, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      if (prop === "onmessage" || prop === "onclose" || prop === "onerror") return session.handlers[prop];
      if (prop === "setProtocolVersion") return typeof target.setProtocolVersion === "function" ? (v: string) => session.setProtocolVersion(v) : undefined;
      const value: unknown = Reflect.get(target, prop, target);
      // Another transport made like this one (the SDK probes a server's protocol on one) goes
      // through the cassette too.
      if (prop === "constructor" && typeof value === "function") return wrappedClass(value as new (...args: unknown[]) => McpTransport, options);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === "onmessage" || prop === "onclose" || prop === "onerror") {
        (session.handlers as Record<string, unknown>)[prop] = value;
        return true;
      }
      // A client that swaps start, send or close for a while swaps tomiko's, not the transport's.
      if (Object.hasOwn(own, prop)) {
        own[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
    has(target, prop) {
      return Object.hasOwn(own, prop) || Reflect.has(target, prop);
    },
  });
}

const classes = new WeakMap<object, Map<string | undefined, unknown>>();

/** A transport class whose instances come wrapped, named as `options` name them. */
function wrappedClass(cls: new (...args: unknown[]) => McpTransport, options: McpTransportOptions): unknown {
  let byName = classes.get(cls);
  if (!byName) classes.set(cls, (byName = new Map()));
  let wrapped = byName.get(options.name);
  if (!wrapped) {
    wrapped = new Proxy(cls, { construct: (target, args, newTarget) => mcpTransport(Reflect.construct(target, args, newTarget === wrapped ? target : newTarget), options) });
    byName.set(options.name, wrapped);
  }
  return wrapped;
}

/* ------------------------------------ the official SDK ------------------------------------ */

const PATCHED = Symbol.for("tomiko.mcp.patched");

type ClientModule = { Client?: { prototype: Record<PropertyKey, unknown> & { connect?: (transport: McpTransport, options?: unknown) => Promise<void> } } };

function teach(module: ClientModule): void {
  const proto = module.Client?.prototype;
  if (!proto || typeof proto.connect !== "function" || proto[PATCHED]) return;
  const connect = proto.connect;
  proto.connect = function (this: unknown, transport: McpTransport, options?: unknown) {
    return connect.call(this, transport && typeof transport === "object" ? mcpTransport(transport) : transport, options);
  };
  proto[PATCHED] = true;
}

/** The official SDK's client, version 1 and version 2, and where each keeps its ES module build. */
const SDKS = [
  { module: "@modelcontextprotocol/sdk/client/index.js", esm: (cjs: string) => cjs.replace(/([\\/]dist[\\/])cjs([\\/])/, "$1esm$2") },
  { module: "@modelcontextprotocol/client", esm: (cjs: string) => cjs.replace(/\.cjs$/, ".mjs") },
];

/**
 * Teaches the official MCP SDK's `Client`, version 1 (`@modelcontextprotocol/sdk`) or 2
 * (`@modelcontextprotocol/client`), if the project has it, to connect through tomiko, so its
 * servers are recorded without code changes. Both builds of each are taught: ES modules and
 * CommonJS each load their own copy.
 */
export function teachMcpSdk(): void {
  if (runtime.mcpPatched) return;
  runtime.mcpPatched = true;
  let require: NodeJS.Require;
  try {
    require = createRequire(join(process.cwd(), "package.json"));
  } catch {
    return;
  }
  for (const sdk of SDKS) {
    let cjs: string;
    try {
      cjs = require.resolve(sdk.module);
    } catch {
      continue; // Not installed.
    }
    try {
      teach(require(cjs) as ClientModule);
    } catch {
      // A build tomiko doesn't know.
    }
    const esm = sdk.esm(cjs);
    if (esm === cjs || !existsSync(esm)) continue;
    try {
      // Node 20.19 and 22.12 on load ES modules with require(), into the same module map as import.
      teach(require(esm) as ClientModule);
    } catch {
      void import(pathToFileURL(esm).href).then(teach, () => undefined);
    }
  }
}
