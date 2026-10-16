/**
 * Each test here failed before its fix: bugs found reviewing MCP over HTTP, met in fetch, and the
 * viewer's MCP cards.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createMCPClient, ElicitationRequestSchema } from "@ai-sdk/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitResultSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { cassette, reports } from "../src/index.js";
import { renderHtml } from "../src/view/html.js";
import { viewModel } from "../src/view/model.js";
import { offline, tmpDir } from "./helpers.js";
// @ts-expect-error A plain JavaScript fixture.
import { notesServer } from "./fixtures/notes-server.mjs";

type Connectable = { connect: (transport: StreamableHTTPServerTransport) => Promise<void> };
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Starts `handle` on a port of its own. */
async function listen(handle: Handler, path: string) {
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/**
 * A server over Streamable HTTP, a session per client, as the SDK's docs set one up. It ends its
 * sessions on `expire()`, as a server does after a while; a session it ended gets a 404.
 */
async function httpServer(make: () => Connectable = notesServer, delay = 0) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const ended = new Set<string>();
  const requests: string[] = [];
  const server = await listen(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed: unknown = body ? JSON.parse(body) : undefined;
    requests.push(`${req.method} ${(parsed as { method?: string } | undefined)?.method ?? ""}`.trim());
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? sessions.get(id) : undefined;
    if (!transport) {
      if (typeof id === "string" && ended.has(id)) return void res.writeHead(404).end();
      if (req.method !== "POST" || !isInitializeRequest(parsed)) return void res.writeHead(400).end();
      const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, created) });
      transport = created;
      await make().connect(transport);
      // A server that takes its time to open a session.
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await transport.handleRequest(req, res, parsed);
  }, "/mcp");
  const expire = () => {
    for (const sid of sessions.keys()) ended.add(sid);
    sessions.clear();
  };
  return { ...server, requests, expire };
}

/** A server that asks the client for a name while it works on `greet`. */
function greeter() {
  const mcp = new McpServer({ name: "Greeter", version: "1.0.0" });
  mcp.registerTool("greet", { description: "Greet whoever is there" }, async (extra) => {
    // Asked in the stream of the tool call it belongs to, as the SDK does for a related request.
    const answer = await extra.sendRequest(
      { method: "elicitation/create", params: { message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
      ElicitResultSchema,
    );
    return { content: [{ type: "text", text: `Hello ${String(answer.content?.name)}` }] };
  });
  return mcp;
}

/** The network, as it was before any cassette. */
const network = globalThis.fetch;

let closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
});

type Saved = { interactions: { request: { method: string; url: string; body?: unknown }; response: { body: { type: string; value?: any } }; meta: { transport?: string } }[] };
const saved = (dir: string, name = "m") => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Saved;
const kept = (dir: string) => saved(dir).interactions.filter((i) => i.request.url.endsWith("/tools/call")).map((i) => i.response.body.value);

type Client = Awaited<ReturnType<typeof createMCPClient>>;
/** Each client's tools, listed once, as an agent lists them. */
const toolsOf = new WeakMap<Client, ReturnType<Client["tools"]>>();
const readNote = async (client: Client, name: string) => {
  try {
    if (!toolsOf.has(client)) toolsOf.set(client, client.tools());
    const tools = await toolsOf.get(client)!;
    return ((await (tools.read_note as any).execute({ name }, { toolCallId: name, messages: [] })) as { content: { text: string }[] }).content[0]!.text;
  } catch (error) {
    return `failed: ${(error as Error).message.slice(0, 60)}`;
  }
};

/** The AI SDK's client over `type`: reads the notes, one after the other, calling `before` first. */
const readNotes = (url: string, names: string[], type: "http" | "sse" = "http", before: (name: string) => void = () => undefined) => async () => {
  const client = await createMCPClient({ transport: { type, url } });
  const notes: string[] = [];
  for (const name of names) {
    before(name);
    notes.push(await readNote(client, name));
  }
  await client.close();
  return notes;
};

describe("MCP over Streamable HTTP fixes", () => {
  it("leaves an HTTP server alone with `mcp: false`, as it does one over stdio", async () => {
    const http = await httpServer();
    closing.push(http.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(http.url, ["todo"]), { dir, mcp: false })).toEqual(["call the plumber"]);
    expect(existsSync(join(dir, "m.json"))).toBe(false);
  });

  it("sends a client's initialize as it is when the rest of its handshake was replayed", async () => {
    const http = await httpServer();
    closing.push(http.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(http.url, ["todo"]), { dir })).toEqual(["call the plumber"]);
    // A newer client: its initialize no longer matches the recording, its server/discover still does.
    const file = saved(dir);
    const init = file.interactions.find((i) => i.request.url.endsWith("/initialize"))!;
    (init.request.body as { clientInfo: { version: string } }).clientInfo.version = "0.0.1-old";
    writeFileSync(join(dir, "m.json"), JSON.stringify(file));
    expect(await cassette("m", readNotes(http.url, ["todo"]), { dir })).toEqual(["call the plumber"]);
    const answers = saved(dir).interactions.filter((i) => i.request.url.endsWith("/initialize")).map((i) => i.response.body.value);
    expect(answers.map((v) => v.result?.serverInfo?.name)).toEqual(["Notes Server", "Notes Server"]);
  });

  it("records nothing when the handshake it replays to the server fails, and tries again on the next request", async () => {
    const http = await httpServer();
    closing.push(http.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(http.url, ["todo"]), { dir })).toEqual(["call the plumber"]);
    // The server is busy for a moment: the initialize tomiko replays to it gets a 503.
    let busy = true;
    const flaky: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (busy && text.includes('"initialize"')) {
        busy = false;
        return new Response("busy", { status: 503 });
      }
      return network(request);
    };
    const notes = await cassette("m", readNotes(http.url, ["todo", "groceries", "groceries"]), { dir, fetch: flaky });
    expect(notes).toEqual(["call the plumber", expect.stringContaining("HTTP 503"), "eggs, milk"]);
    expect(reports().at(-1)!.warnings).toEqual([
      'MCP server "notes-server" never answered tools/call (the server answered the handshake tomiko replayed to it with HTTP 503), so it was not saved.',
    ]);
    expect(kept(dir).filter((v) => v.http)).toEqual([]);
  });

  it("opens another session when the server ends the one tomiko opened, and keeps no 404", async () => {
    const http = await httpServer();
    closing.push(http.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(http.url, ["todo"]), { dir })).toEqual(["call the plumber"]);
    // The handshake is replayed; groceries goes live in a session tomiko opens; then the server ends it.
    const expireBefore = (name: string) => name === "shopping" && http.expire();
    expect(await cassette("m", readNotes(http.url, ["todo", "groceries", "shopping"], "http", expireBefore), { dir })).toEqual([
      "call the plumber",
      "eggs, milk",
      "No note called shopping.",
    ]);
    expect(kept(dir).filter((v) => v.http)).toEqual([]);
    expect(await cassette("m", readNotes(http.url, ["todo", "groceries", "shopping"]), { dir, mode: "replay", fetch: offline })).toEqual([
      "call the plumber",
      "eggs, milk",
      "No note called shopping.",
    ]);
  });

  it("keeps each client's session its own: a second client's handshake doesn't end the first's", async () => {
    const http = await httpServer();
    closing.push(http.close);
    const dir = tmpDir();
    const one = async () => {
      const first = await createMCPClient({ transport: { type: "http", url: http.url } });
      const note = await readNote(first, "todo");
      await first.close();
      return note;
    };
    expect(await cassette("m", one, { dir })).toBe("call the plumber");
    // The test now opens a second client too: the first one's handshake is replayed, the second's
    // goes to the server, then the first asks for something new.
    const two = async () => {
      const first = await createMCPClient({ transport: { type: "http", url: http.url } });
      const second = await createMCPClient({ transport: { type: "http", url: http.url }, clientName: "second" });
      const notes = [await readNote(first, "todo"), await readNote(first, "groceries"), await readNote(second, "todo")];
      await second.close();
      await first.close();
      return notes;
    };
    expect(await cassette("m", two, { dir })).toEqual(["call the plumber", "eggs, milk", "call the plumber"]);
  });

  it("streams a tool call's answer as the server sends it, so the client can answer what the server asks in it", async () => {
    const http = await httpServer(greeter);
    closing.push(http.close);
    const dir = tmpDir();
    const greet = async () => {
      const asked: string[] = [];
      const client = await createMCPClient({ transport: { type: "http", url: http.url }, capabilities: { elicitation: {} } });
      client.onElicitationRequest(ElicitationRequestSchema, async (request) => {
        asked.push(request.params.message);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { action: "accept", content: { name: "Ada" } };
      });
      try {
        const tools = await client.tools();
        const out = (await (tools.greet as any).execute({}, { toolCallId: "t1", messages: [] })) as { content: { text: string }[] };
        return { greeting: out.content[0]!.text, asked };
      } finally {
        await client.close();
      }
    };
    const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, new Promise<string>((resolve) => setTimeout(() => resolve(`no answer in ${ms}ms`), ms))]);
    expect(await within(5000, cassette("m", greet, { dir }))).toEqual({ greeting: "Hello Ada", asked: ["Your name?"] });
    const call = saved(dir).interactions.find((i) => i.request.url.endsWith("/tools/call"))!;
    expect(call.response.body.value.messages.map((m: { method: string }) => m.method)).toEqual(["elicitation/create"]);
    // A replay asks the client too, and answers the tool call once the client has answered.
    const sent = http.requests.length;
    expect(await within(5000, cassette("m", greet, { dir, mode: "replay", fetch: offline }))).toEqual({ greeting: "Hello Ada", asked: ["Your name?"] });
    expect(http.requests.length).toBe(sent);
  }, 20000);

  it("names a server by what it calls itself, so two on one host get their own answers in a replay", async () => {
    const hello = () => {
      const mcp = new McpServer({ name: "Greeter", version: "1.0.0" });
      mcp.registerTool("greet", { description: "Say hello" }, async () => ({ content: [{ type: "text", text: "Hello" }] }));
      return mcp;
    };
    // Two servers a test starts on ports of its own; the notes server is slow to open a session,
    // so its tools are listed after the greeter's while recording, and before them in a replay.
    const notes = await httpServer(notesServer, 300);
    const greeting = await httpServer(hello);
    closing.push(notes.close, greeting.close);
    const dir = tmpDir();
    const both = () =>
      cassette("m", async () => {
        const names = async (url: string) => {
          const client = await createMCPClient({ transport: { type: "http", url } });
          const tools = Object.keys(await client.tools());
          await client.close();
          return tools;
        };
        const [a, b] = await Promise.all([names(notes.url), names(greeting.url)]);
        return { notes: a, greeter: b };
      }, { dir });
    const recorded = await both();
    expect(recorded).toEqual({ notes: ["read_note", "add_note", "count"], greeter: ["greet"] });
    expect(saved(dir).interactions.map((i) => i.request.url).filter((url) => url.endsWith("/tools/list")).sort()).toEqual(["mcp://greeter/tools/list", "mcp://notes-server/tools/list"]);
    expect(await both()).toEqual(recorded);
  }, 20000);

  it("treats JSON-RPC that isn't MCP's as any other request: an A2A agent's stream replays in its order", async () => {
    // An A2A agent streams several JSON-RPC responses to one request: its task's progress, then its result.
    const events = [
      { kind: "status-update", status: { state: "working" }, final: false },
      { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "Paris" }] } },
      { kind: "status-update", status: { state: "completed" }, final: true },
    ];
    const agent: typeof fetch = async () =>
      new Response(events.map((result) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const ask = async () => {
      const response = await fetch("https://agent.example.com/a2a", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/stream", params: { message: { role: "user", parts: [{ kind: "text", text: "Capital of France?" }], messageId: "m1" } } }),
      });
      const lines = (await response.text()).split("\n").filter((line) => line.startsWith("data:"));
      return lines.map((line) => {
        const { result } = JSON.parse(line.slice(5)) as { result: { kind: string; status?: { state: string } } };
        return result.status ? `${result.kind} ${result.status.state}` : result.kind;
      });
    };
    const dir = tmpDir();
    const order = ["status-update working", "artifact-update", "status-update completed"];
    expect(await cassette("m", ask, { dir, fetch: agent })).toEqual(order);
    expect(saved(dir).interactions.map((i) => i.request.method)).toEqual(["POST"]);
    expect(await cassette("m", ask, { dir, mode: "replay", fetch: offline })).toEqual(order);
  });
});

describe("MCP over the older HTTP+SSE transport", () => {
  /** The notes server over HTTP+SSE: a stream that names where to post, then carries the answers. */
  async function sseServer() {
    const transports = new Map<string, SSEServerTransport>();
    const requests: string[] = [];
    const server = await listen(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        await notesServer().connect(transport);
        return;
      }
      const transport = req.method === "POST" && url.pathname === "/messages" ? transports.get(url.searchParams.get("sessionId") ?? "") : undefined;
      if (!transport) return void res.writeHead(404).end();
      await transport.handlePostMessage(req, res);
    }, "/sse");
    return { ...server, requests };
  }

  it("is recorded as MCP, replayed with nothing sent, and carries a new request to the server", async () => {
    const sse = await sseServer();
    closing.push(sse.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(sse.url, ["todo"], "sse"), { dir })).toEqual(["call the plumber"]);
    expect(saved(dir).interactions.map((i) => `${i.request.method} ${i.request.url} ${i.meta.transport}`)).toEqual([
      "MCP mcp://127.0.0.1/initialize sse",
      "MCP mcp://notes-server/tools/list sse",
      "MCP mcp://notes-server/tools/call sse",
    ]);
    const sent = sse.requests.length;
    expect(await cassette("m", readNotes(sse.url, ["todo"], "sse"), { dir, mode: "replay", fetch: offline })).toEqual(["call the plumber"]);
    expect(sse.requests.length).toBe(sent);
    // groceries has no recording: tomiko opens the stream, replays the handshake, and sends it.
    expect(await cassette("m", readNotes(sse.url, ["todo", "groceries"], "sse"), { dir })).toEqual(["call the plumber", "eggs, milk"]);
    expect(sse.requests.slice(sent)).toEqual(["GET /sse", "POST /messages", "POST /messages", "POST /messages"]);
  }, 20000);

  it("is left alone with `mcp: false`", async () => {
    const sse = await sseServer();
    closing.push(sse.close);
    const dir = tmpDir();
    expect(await cassette("m", readNotes(sse.url, ["todo"], "sse"), { dir, mcp: false })).toEqual(["call the plumber"]);
    expect(existsSync(join(dir, "m.json"))).toBe(false);
  });
});

describe("the viewer's MCP cards", () => {
  it("lay out JSON a tool returned after a line break", () => {
    const html = renderHtml(viewModel("/repo", []));
    const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    // The function as the browser gets it.
    const source = /function pretty\(text\) \{[\s\S]*?\n\}/.exec(script)![0];
    const pretty = new Function(`${source}; return pretty;`)() as (text: string) => string;
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(pretty('\n{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});
