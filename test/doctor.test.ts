import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import { renderDiagnosis } from "../src/commands/doctor.js";
import { diagnose } from "../src/doctor.js";
import { paint } from "../src/terminal.js";
import type { CassetteFile, Interaction } from "../src/types.js";
import { ANTHROPIC_URL, tmpDir } from "./helpers.js";

const meta = { provider: "anthropic", recordedAt: "2026-10-13T12:00:00Z", durationMs: 900 };
const usage = (input: number, output: number, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
const reply = (content: unknown[], input: number, output: number, cacheRead = 0) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: "end_turn",
  usage: usage(input, output, cacheRead),
});
const exchange = (body: Record<string, unknown>, response: unknown): Interaction => ({
  request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-sonnet-5-5", max_tokens: 1024, ...body } },
  response: { status: 200, headers: {}, body: { type: "json", value: response } },
  meta,
});
const file = (...interactions: Interaction[]): CassetteFile => ({ version: 1, interactions });
const tool = (name: string) => ({ name, description: `${name} things`, input_schema: { type: "object", properties: { q: { type: "string", description: "x".repeat(400) } } } });
const call = (name: string, id: string) => ({ type: "tool_use", id, name, input: { q: "a" } });

/** A healthy agent loop: a stable, cached prompt; tools that get called; small results. */
function healthy(): CassetteFile {
  const system = "You help with orders. ".repeat(50);
  const tools = [tool("find_order")];
  const user = { role: "user", content: "Where is order 12?" };
  return file(
    exchange({ system, tools, messages: [user] }, reply([call("find_order", "t1")], 1500, 40)),
    exchange(
      { system, tools, messages: [user, { role: "assistant", content: [call("find_order", "t1")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Shipped." }] }] },
      reply([{ type: "text", text: "It shipped." }], 100, 20, 1500),
    ),
  );
}

describe("diagnose", () => {
  it("finds nothing wrong with a healthy agent", () => {
    const d = diagnose([{ path: "ok.json", data: healthy() }]);
    expect(d.findings).toEqual([]);
    expect(d.requests).toBe(2);
    expect(d.cost).toBeGreaterThan(0);
  });

  it("notices a system prompt that changes with the time, and what caching it would save", () => {
    const system = (t: string) => `${"House rules. ".repeat(100)}Now: 2026-10-13T12:00:${t}Z.`;
    const loop = file(
      exchange({ system: system("01"), messages: [{ role: "user", content: "a" }] }, reply([{ type: "text", text: "b" }], 10_000, 50)),
      exchange({ system: system("09"), messages: [{ role: "user", content: "a" }] }, reply([{ type: "text", text: "c" }], 12_000, 50)),
    );
    const [finding] = diagnose([{ path: "loop.json", data: loop }]).findings;
    expect(finding).toMatchObject({ kind: "volatile-prompt", tokens: 10_000, where: [{ path: "loop.json", requests: [2] }] });
    // 10K tokens at Sonnet 5.5's input price instead of its cache-read price.
    expect(finding!.waste).toBeCloseTo((10_000 * (2 - 0.2)) / 1e6, 10);
    expect(finding!.detail.change!.filter((p) => p.op !== "=").map((p) => p.text.trim())).toEqual(["01Z", "09Z"]);
  });

  it("doesn't take a real change of prompt for a timestamp", () => {
    const loop = file(
      exchange({ system: "Be brief.", messages: [] }, reply([], 1000, 10)),
      exchange({ system: "Be thorough.", messages: [] }, reply([], 1000, 10)),
    );
    expect(diagnose([{ path: "x.json", data: loop }]).findings).toEqual([]);
  });

  it("finds tools that are offered and never called, across all cassettes", () => {
    const tools = [tool("find_order"), tool("send_email"), tool("refund")];
    const a = file(exchange({ tools, messages: [] }, reply([call("find_order", "1")], 2000, 10)));
    const b = file(exchange({ tools, messages: [] }, reply([call("refund", "2")], 2000, 10)));
    const [finding] = diagnose([
      { path: "a.json", data: a },
      { path: "b.json", data: b },
    ]).findings;
    expect(finding).toMatchObject({ kind: "unused-tools", detail: { tools: ["send_email"] }, where: [{ path: "a.json" }, { path: "b.json" }] });
    expect(finding!.tokens).toBe(2 * Math.ceil(JSON.stringify(tool("send_email")).length / 4));
  });

  it("finds a huge tool result sent back on every turn", () => {
    const big = "log line\n".repeat(5000);
    const user = { role: "user", content: "Why did it fail?" };
    const turns = [user, { role: "assistant", content: [call("read_log", "t1")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }];
    const loop = file(
      exchange({ tools: [tool("read_log")], messages: [user] }, reply([call("read_log", "t1")], 500, 10)),
      exchange({ tools: [tool("read_log")], messages: turns }, reply([call("read_log", "t2")], 12_000, 10)),
      exchange({ tools: [tool("read_log")], messages: [...turns, { role: "assistant", content: [{ type: "text", text: "Checking." }] }] }, reply([], 12_100, 10)),
    );
    const finding = diagnose([{ path: "log.json", data: loop }]).findings.find((f) => f.kind === "large-tool-result");
    expect(finding).toMatchObject({ tokens: Math.ceil(big.length / 4), where: [{ requests: [2, 3] }], detail: { tool: "read_log", sends: 2 } });
  });

  it("finds the same request sent twice, but not a retry after an error", () => {
    const ask = { messages: [{ role: "user", content: "Hours?" }] };
    const twice = file(exchange(ask, reply([{ type: "text", text: "9-6" }], 100, 10)), exchange(ask, reply([{ type: "text", text: "9-6" }], 100, 10)));
    expect(diagnose([{ path: "dup.json", data: twice }]).findings).toMatchObject([{ kind: "duplicate-request", where: [{ requests: [1, 2] }], detail: { sends: 2 } }]);

    const failed = exchange(ask, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    failed.response.status = 529;
    const retry = file(failed, exchange(ask, reply([{ type: "text", text: "9-6" }], 100, 10)));
    expect(diagnose([{ path: "retry.json", data: retry }]).findings).toEqual([]);
  });

  it("flags a token limit far above what answers use as a risk, not a cost", () => {
    const loose = file(exchange({ max_tokens: 32_000, messages: [] }, reply([{ type: "text", text: "ok" }], 100, 300)));
    const [finding] = diagnose([{ path: "loose.json", data: loose }]).findings;
    expect(finding).toMatchObject({ kind: "max-tokens", waste: 0, detail: { limit: 32_000, used: 300 } });
    expect(finding!.risk).toBeCloseTo((32_000 * 10) / 1e6, 10);
  });

  it("counts tokens once in the total when two findings share them", () => {
    const big = "x".repeat(40_000);
    const system = (t: string) => `Rules. Now: 12:00:${t}.`;
    const turns = [{ role: "user", content: "go" }, { role: "assistant", content: [call("fetch", "t1")] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }];
    const loop = file(
      exchange({ system: system("01"), tools: [tool("fetch")], messages: turns.slice(0, 1) }, reply([call("fetch", "t1")], 500, 10)),
      exchange({ system: system("02"), tools: [tool("fetch")], messages: turns }, reply([], 11_000, 10)),
      exchange({ system: system("03"), tools: [tool("fetch")], messages: turns }, reply([], 11_000, 10)),
    );
    const d = diagnose([{ path: "both.json", data: loop }]);
    const sum = d.findings.reduce((n, f) => n + f.waste, 0);
    expect(d.findings.map((f) => f.kind).sort()).toEqual(["large-tool-result", "volatile-prompt"]);
    expect(d.savings).toBeLessThan(sum);
    expect(d.savings).toBeLessThanOrEqual(d.cost);
  });
});

describe("tomiko doctor", () => {
  function project(files: Record<string, CassetteFile>) {
    const root = tmpDir();
    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(root, "test", "__cassettes__", path, ".."), { recursive: true });
      writeFileSync(join(root, "test", "__cassettes__", path), JSON.stringify(data));
    }
    const out: string[] = [];
    const io: Io = { cwd: root, log: (m) => out.push(...m.split("\n")), error: (m) => out.push(...m.split("\n")), open: async () => true, stream: { isTTY: false, write: () => true }, color: false, animate: false, columns: 100, env: {} };
    return { io, out };
  }

  it("says so when there is nothing to fix", async () => {
    const { io, out } = project({ "a.test.ts/ok.json": healthy() });
    expect(await main(["doctor"], io)).toBe(0);
    expect(out).toEqual([expect.stringMatching(/^ {2}✔ Nothing to fix in 1 cassette · 2 requests · \$0\.\d+ a run$/)]);
  });

  it("lists findings, costliest first, with what each costs and what to do", async () => {
    const ask = { max_tokens: 32_000, tools: [tool("lookup"), tool("unused")], messages: [{ role: "user", content: "Hours?" }] };
    const r = reply([call("lookup", "t")], 3000, 100);
    const { io, out } = project({ "faq.test.ts/hours.json": file(exchange(ask, r), exchange(ask, r)) });
    expect(await main(["doctor"], io)).toBe(0);
    const text = out.join("\n");
    expect(out[0]).toBe("  tomiko doctor  1 cassette · 2 requests · $0.01 a run");
    expect(text).toMatch(/▲ The same request is sent twice +≈ \$0\.007 a run\n {4}faq\.test\.ts\/hours\.json #1 and #2\n {4}Reuse the first answer/);
    expect(text).toMatch(/● 1 tool is offered to the model and never called +≈ \$0\.00\d+ a run\n {4}unused · ≈ \d+ tokens in each of 2 requests/);
    expect(text).toMatch(/○ max_tokens is 32,000, and answers use at most 100 +up to \$0\.32 a request/);
    expect(text).toMatch(/◆ Fixing all of it saves ≈ \$0\.\d+ of \$0\.01 a run \(\d+%\)\./);
  });

  it("prints JSON for scripts", async () => {
    const ask = { messages: [{ role: "user", content: "Hours?" }] };
    const { io, out } = project({ "x.test.ts/dup.json": file(exchange(ask, reply([], 100, 10)), exchange(ask, reply([], 100, 10))) });
    expect(await main(["doctor", "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ cassettes: 1, requests: 2, findings: [{ kind: "duplicate-request" }] });
  });

  it("colors the severity of each finding", () => {
    const ask = { messages: [{ role: "user", content: "Hours?" }] };
    const d = diagnose([{ path: "d.json", data: file(exchange(ask, reply([], 100, 10)), exchange(ask, reply([], 100, 10))) }]);
    expect(renderDiagnosis(d, paint(true)).join("\n")).toContain("\x1b[31m▲\x1b[39m");
  });
});
