/**
 * Each test here failed before its fix: bugs found reviewing MCP servers in cassettes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { cassette, reports } from "../src/index.js";
import { nameFromCommand } from "../src/mcp.js";
import { anthropicMessage, fakeApi, json, offline, tmpDir } from "./helpers.js";

const BUSY = join(import.meta.dirname, "fixtures", "busy-server.mjs");
const NOTES = join(import.meta.dirname, "fixtures", "notes-server.mjs");
const MODEL_URL = "http://127.0.0.1:9/v1/messages";

const busy = (log: string, env: Record<string, string> = {}) =>
  new StdioClientTransport({ command: "node", args: [BUSY], env: { ...process.env, BUSY_LOG: log, ...env } as Record<string, string> });

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]?.text;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);

/** Connects a client that answers the server's sampling requests with `sample()`, if given. */
async function connect(transport: StdioClientTransport, sample?: () => Promise<string>) {
  const client = new Client({ name: "fixes", version: "1.0.0" }, { capabilities: sample ? { sampling: {} } : {} });
  if (sample) {
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      model: "claude-sonnet-5-5",
      role: "assistant" as const,
      content: { type: "text" as const, text: await sample() },
    }));
  }
  await client.connect(transport);
  return client;
}

describe("MCP fixes", () => {
  it("leaves out a request the client cancelled, which would replay as an empty success", async () => {
    const dir = tmpDir();
    const run = async (mode: "auto" | "replay") => {
      // As in a beforeAll: the client connects outside the cassette.
      const client = await connect(busy(join(dir, "log")));
      try {
        return await cassette(
          "m",
          () =>
            client.callTool({ name: "slow", arguments: { ms: 600 } }, undefined, { timeout: 100 }).then(
              (result) => `answered ${JSON.stringify(result)}`,
              (error: Error) => `failed: ${error.message}`,
            ),
          { dir, mode },
        );
      } finally {
        await client.close();
      }
    };
    expect(await run("auto")).toContain("Request timed out");
    expect(existsSync(join(dir, "m.json"))).toBe(false);
    expect(reports().at(-1)!.warnings).toEqual([
      'MCP server "busy-server" never answered tools/call (The MCP client cancelled the request before the server answered.), so it was not saved.',
    ]);
    expect(await run("replay")).toMatch(/^failed: /);
  });

  it("leaves out a request still waiting for its answer when the cassette closes, with a warning", async () => {
    const dir = tmpDir();
    const run = async (mode: "auto" | "replay") => {
      const client = await connect(busy(join(dir, "log")));
      let call: Promise<unknown> | undefined;
      // The test starts a call and ends without waiting for it.
      await cassette("m", async () => void (call = client.callTool({ name: "slow", arguments: { ms: 200 } })), { dir, mode });
      const result = await call!.then((r) => JSON.stringify(r), (e: Error) => `failed: ${e.message}`);
      await client.close();
      return result;
    };
    // The client still gets the server's answer.
    expect(await run("auto")).toBe('{"content":[{"type":"text","text":"waited 200"}]}');
    expect(existsSync(join(dir, "m.json"))).toBe(false);
    expect(reports().at(-1)!.warnings).toEqual([
      'MCP server "busy-server" had not answered tools/call when cassette "m" closed, so it was not saved. Await the call before the test ends.',
    ]);
    expect(await run("replay")).toMatch(/^failed: /);
  });

  it("fails a request whose server dies during the handshake tomiko replays to it, and saves nothing for it", async () => {
    const dir = tmpDir();
    const log = join(dir, "log");
    const echo = (words: string, mode: "auto" | "replay", env: Record<string, string> = {}) =>
      cassette(
        "m",
        async () => {
          const client = await connect(busy(log, env));
          try {
            return text(await client.callTool({ name: "echo", arguments: { text: words } }));
          } catch (error) {
            return `failed: ${(error as Error).message}`;
          } finally {
            await client.close();
          }
        },
        { dir, mode, fetch: mode === "replay" ? offline : undefined },
      );
    expect(await echo("a", "auto")).toBe("a");
    // The handshake replays from the cassette; "b" has to go live, and the server dies as it starts.
    expect(await echo("b", "auto", { BUSY_CRASH: "1" })).toMatch(/^failed: /);
    const saved = JSON.parse(readFileSync(join(dir, "m.json"), "utf8")) as { interactions: { request: { url: string; body?: { arguments?: unknown } } }[] };
    expect(saved.interactions.map((i) => i.request.url)).toEqual(["mcp://busy-server/initialize", "mcp://busy-server/tools/call"]);
    expect(saved.interactions[1]!.request.body?.arguments).toEqual({ text: "a" });
    expect(await echo("b", "replay")).toMatch(/^failed: /);
  });

  it("runs the client's handlers for what the server asks in the cassette, so a sampling handler's model call is recorded", async () => {
    const dir = tmpDir();
    const model = fakeApi(() => json(anthropicMessage("blue")));
    const outcome = await cassette(
      "m",
      async (c) => {
        // The sampling handler asks the model through the global fetch, as an agent's would.
        const client = await connect(busy(join(dir, "log")), async () => {
          // A local URL: if the request went around the cassette, it would fail.
          const response = await fetch(MODEL_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "colour?" }] }),
          });
          return ((await response.json()) as { content: { text: string }[] }).content[0]!.text;
        });
        const result = text(await client.callTool({ name: "ask", arguments: { question: "colour?" } }));
        await client.close();
        return { result, calls: c.calls.length };
      },
      { dir, fetch: model },
    );
    expect(outcome).toEqual({ result: "model said: blue", calls: 1 });
    expect(model.calls).toHaveLength(1);
  });

  it("replays the answer to a tool call only after the client answered the server's request in it, as the server did", async () => {
    const dir = tmpDir();
    const run = (mode: "auto" | "replay") =>
      cassette(
        "m",
        async () => {
          let answered = false;
          const client = await connect(busy(join(dir, "log")), async () => {
            await sleep(50);
            answered = true;
            return "blue";
          });
          const result = text(await client.callTool({ name: "ask", arguments: { question: "colour?" } }));
          const seen = answered;
          await client.close();
          return { result, answeredBeforeResult: seen };
        },
        { dir, mode, fetch: mode === "replay" ? offline : undefined },
      );
    const recorded = await run("auto");
    expect(recorded).toEqual({ result: "model said: blue", answeredBeforeResult: true });
    expect(await run("replay")).toEqual(recorded);
    // The replay never started the server.
    expect(lines(join(dir, "log"))).toEqual(["start", "initialized", "ask colour?"]);
  });

  it("counts MCP requests as recorded in TOMIKO_LOG, so `tomiko record` lists a re-recorded MCP-only cassette", async () => {
    const dir = tmpDir();
    const usage = join(dir, "usage.jsonl");
    process.env.TOMIKO_LOG = usage;
    try {
      await cassette(
        "m",
        async () => {
          const client = new Client({ name: "fixes", version: "1.0.0" });
          await client.connect(new StdioClientTransport({ command: "node", args: [NOTES], env: { ...process.env, NOTES_LOG: join(dir, "log") } as Record<string, string> }));
          await client.listTools();
          await client.close();
        },
        { dir, mode: "record" },
      );
    } finally {
      delete process.env.TOMIKO_LOG;
    }
    expect(JSON.parse(readFileSync(join(dir, "m.json"), "utf8")).interactions).toHaveLength(2);
    expect(lines(usage).map((line) => (JSON.parse(line) as { recorded: number }).recorded)).toEqual([2]);
  });

  it("names a server started through `cmd /c`, `sh -c` or with valued flags by what it runs", () => {
    expect(nameFromCommand("cmd", ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\data"])).toBe("server-filesystem");
    expect(nameFromCommand("cmd", ["/c", "npx", "-y", "@modelcontextprotocol/server-github"])).toBe("server-github");
    expect(nameFromCommand("sh", ["-c", "npx -y @modelcontextprotocol/server-memory"])).toBe("server-memory");
    expect(nameFromCommand("docker", ["run", "-i", "--rm", "-e", "GITHUB_TOKEN", "ghcr.io/github/github-mcp-server"])).toBe("github-mcp-server");
    expect(nameFromCommand("uvx", ["--from", "git+https://example.com/tools", "mcp-server-fetch"])).toBe("mcp-server-fetch");
  });
});
