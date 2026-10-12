import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import type { CassetteFile, Interaction } from "../src/types.js";
import { discoverCassettes } from "../src/view/discover.js";
import { renderHtml } from "../src/view/html.js";
import { cassetteView, viewModel } from "../src/view/model.js";
import { ANTHROPIC_URL, anthropicStream, openaiChat, tmpDir } from "./helpers.js";

const meta = { recordedAt: "2026-10-10T12:00:00.000Z", durationMs: 40 };
const ok = (value: unknown) => ({ status: 200, headers: {}, body: { type: "json" as const, value } });
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const reply = (content: unknown[], stop_reason: string) => ({ type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, usage });

/** A two-step Anthropic tool loop: each request carries the full history. */
function agentRun(): CassetteFile {
  const system = "You book tables.";
  const tools = [{ name: "book_table", description: "Book it", input_schema: {} }];
  const user = { role: "user", content: "Table for two" };
  const call = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "book_table", input: { guests: 2 } }] };
  const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Booked #12" }] };
  const interactions: Interaction[] = [
    { request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-opus-5-5", system, tools, messages: [user] } }, response: ok(reply(call.content, "tool_use")), meta },
    {
      request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-opus-5-5", system, tools, messages: [user, call, result] } },
      response: ok(reply([{ type: "text", text: "Booked table 12." }], "end_turn")),
      meta,
    },
  ];
  return { version: 1, interactions };
}

describe("view model", () => {
  it("shows only what is new in each step of an agent loop", () => {
    const view = cassetteView("a.json", agentRun());
    const [first, second] = view.interactions;
    expect(first).toMatchObject({
      system: "You book tables.",
      systemRepeated: false,
      tools: [{ name: "book_table", description: "Book it" }],
      messages: [{ role: "user", parts: [{ kind: "text", text: "Table for two" }] }],
      response: { toolCalls: [{ name: "book_table", input: { guests: 2 } }], stopReason: "tool_use", streamed: false },
    });
    expect(second).toMatchObject({
      systemRepeated: true,
      earlierMessages: 1,
      repeatsPreviousResponse: true,
      messages: [{ role: "user", parts: [{ kind: "tool_result", content: "Booked #12", id: "t1" }] }],
      response: { text: "Booked table 12.", stopReason: "end_turn" },
    });
    // 2 × (1000 in × $4/M + 100 out × $20/M)
    expect(view.cost).toBeCloseTo(0.012);
    expect(view.usage.inputTokens).toBe(2000);
  });

  it("reads OpenAI Chat Completions, and lists models without a price", () => {
    const view = cassetteView("b.json", {
      version: 1,
      interactions: [
        {
          request: {
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            body: {
              model: "gpt-test",
              messages: [
                { role: "system", content: "Be brief." },
                { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "lookup", arguments: '{"q":1}' } }] },
                { role: "tool", tool_call_id: "c1", content: "found" },
              ],
              tools: [{ type: "function", function: { name: "lookup", description: "Search" } }],
            },
          },
          response: ok(openaiChat({ text: "Done." })),
          meta,
        },
      ],
    });
    const [i] = view.interactions;
    expect(i!.provider).toBe("openai");
    expect(i!.tools).toEqual([{ name: "lookup", description: "Search" }]);
    expect(i!.messages.map((m) => [m.role, m.parts[0]!.kind])).toEqual([
      ["system", "text"],
      ["assistant", "tool_call"],
      ["tool", "tool_result"],
    ]);
    expect(i!.messages[1]!.parts[0]).toMatchObject({ name: "lookup", input: { q: 1 } });
    expect(i!.response).toMatchObject({ text: "Done.", stopReason: "stop" });
    expect(view).toMatchObject({ cost: null, unpricedModels: ["gpt-test"] });
  });

  it("reads OpenAI Responses API input items", () => {
    const view = cassetteView("c.json", {
      version: 1,
      interactions: [
        {
          request: {
            method: "POST",
            url: "https://api.openai.com/v1/responses",
            body: {
              model: "gpt-test",
              instructions: "Be kind.",
              input: [
                { role: "user", content: [{ type: "input_text", text: "Hi" }] },
                { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
                { type: "function_call_output", call_id: "c1", output: "42" },
              ],
            },
          },
          response: ok({ object: "response", status: "completed", output: [] }),
          meta,
        },
      ],
    });
    const [i] = view.interactions;
    expect(i!.system).toBe("Be kind.");
    expect(i!.messages.map((m) => m.parts[0]!.kind)).toEqual(["text", "tool_call", "tool_result"]);
    expect(i!.response.stopReason).toBe("completed");
  });

  it("assembles streamed responses", () => {
    const chunks = anthropicStream(["Hel", "lo"]).map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    const view = cassetteView("d.json", {
      version: 1,
      interactions: [{ request: { method: "POST", url: ANTHROPIC_URL, body: {} }, response: { status: 200, headers: {}, body: { type: "sse", chunks } }, meta }],
    });
    expect(view.interactions[0]!.response).toMatchObject({ text: "Hello", streamed: true, stopReason: "end_turn" });
    expect(view.interactions[0]!.rawResponse).toBe(chunks.join(""));
  });
});

describe("discovery", () => {
  const project = () => {
    const root = tmpDir();
    const cassette = JSON.stringify(agentRun());
    const put = (path: string, content: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    put("test/__cassettes__/booking.test.ts/books.json", cassette);
    put("node_modules/pkg/__cassettes__/theirs.json", cassette);
    put("test/__cassettes__/broken.json", "{ not json");
    put("test/__cassettes__/package.json", JSON.stringify({ name: "not a cassette" }));
    put("recordings/custom.json", cassette);
    return root;
  };

  it("finds __cassettes__ directories by default, skipping node_modules and non-cassettes", async () => {
    const root = project();
    const found = await discoverCassettes([], root);
    expect(found.map((f) => f.path)).toEqual([join("test", "__cassettes__", "booking.test.ts", "books.json")]);
  });

  it("searches a named directory in full", async () => {
    const root = project();
    const found = await discoverCassettes([join(root, "recordings")], root);
    expect(found.map((f) => f.path)).toEqual([join("recordings", "custom.json")]);
  });
});

describe("html", () => {
  it("embeds cassette content so it cannot break out of the page", () => {
    const run = agentRun();
    const hostile = "</script><script>alert(1)</script><img src=x onerror=alert(2)> ";
    (run.interactions[0]!.request.body as { system: string }).system = hostile;
    const html = renderHtml(viewModel("/repo", [{ path: "x.json", data: run }]));
    expect(html.match(/<\/script>/g)).toHaveLength(2); // only the page's own two script elements
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(" ");
    const data = html.slice(html.indexOf('type="application/json">') + 24, html.indexOf("</script>"));
    expect(JSON.parse(data).cassettes[0].interactions[0].system).toBe(hostile);
  });
});

describe("cli", () => {
  function fakeIo(cwd: string, options: { color?: boolean; animate?: boolean } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const drawn: string[] = [];
    const io: Io = {
      cwd,
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      open: async (file) => {
        opened.push(file);
        return true;
      },
      stream: { isTTY: options.animate, write: (chunk: string) => drawn.push(chunk) },
      color: options.color ?? false,
      animate: options.animate ?? false,
    };
    return { io, out, err, opened, drawn };
  }

  const withCassette = () => {
    const root = tmpDir();
    mkdirSync(join(root, "__cassettes__"));
    writeFileSync(join(root, "__cassettes__", "run.json"), JSON.stringify(agentRun()));
    return root;
  };

  it("writes the viewer and opens it", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "__cassettes__"));
    writeFileSync(join(root, "__cassettes__", "run.json"), JSON.stringify(agentRun()));
    const { io, out, opened } = fakeIo(root);
    expect(await main(["view", "--out", "report/view.html"], io)).toBe(0);
    const file = join(root, "report", "view.html");
    expect(readFileSync(file, "utf8")).toContain("<title>tomiko cassettes</title>");
    expect(out).toEqual([
      "  ✔ 1 cassette, 2 requests",
      "    2.2K tokens · $0.0120 to record · claude-opus-5-5",
      `    → ${join("report", "view.html")}`,
      "    Opened in your browser.",
    ]);
    expect(opened).toEqual([file]);
  });

  it("animates a cassette while it works and colors the result in a terminal", async () => {
    const { io, out, drawn } = fakeIo(withCassette(), { color: true, animate: true });
    expect(await main(["view", "--no-open", "--out", "v.html"], io)).toBe(0);
    const frames = drawn.join("");
    expect(frames).toContain("\x1b[?25l"); // cursor hidden while the reels turn
    expect(frames).toMatch(/\[◴═◴\][^]*\[◷═◷\]/); // the reels turned at least once
    expect(frames.endsWith("\x1b[?25h")).toBe(true); // and the cursor came back
    expect(out[0]).toContain("\x1b[32m✔\x1b[39m");
    expect(out[2]).toContain("\x1b]8;;file://"); // a clickable link to the page
    expect(stripVTControlCharacters(out.join("\n"))).toContain("1 cassette, 2 requests");
  });

  it("can skip opening the browser", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "__cassettes__"));
    writeFileSync(join(root, "__cassettes__", "run.json"), JSON.stringify(agentRun()));
    const { io, opened } = fakeIo(root);
    expect(await main(["view", "--no-open", `--out=${join(root, "v.html")}`], io)).toBe(0);
    expect(opened).toEqual([]);
  });

  it("explains when there is nothing to show", async () => {
    const { io, err } = fakeIo(tmpDir());
    expect(await main(["view", "--no-open"], io)).toBe(1);
    expect(err[0]).toContain("No cassettes found");
  });

  it("prints help and rejects unknown input", async () => {
    const { io, out, err } = fakeIo(tmpDir());
    expect(await main(["--help"], io)).toBe(0);
    expect(out[0]).toContain("tomiko view [paths...]");
    expect(await main(["frobnicate"], io)).toBe(1);
    expect(await main(["view", "--bogus"], io)).toBe(1);
    expect(err.map((e) => e.split("\n")[0])).toEqual(["  ✖ Unknown command: frobnicate", "  ✖ Unknown option: --bogus"]);
  });

  it("prints its version", async () => {
    const { io, out } = fakeIo(tmpDir());
    expect(await main(["--version"], io)).toBe(0);
    expect(out).toEqual(["dev"]); // the build replaces it with package.json's version
  });
});
