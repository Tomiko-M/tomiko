/**
 * Each test here failed before its fix: bugs found reviewing the CLI for 0.3.0.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import { renderDiagnosis } from "../src/commands/doctor.js";
import type { ExecResult } from "../src/commands/common.js";
import { project, testCommand, testDir } from "../src/commands/run.js";
import { diagnose } from "../src/doctor.js";
import type { CassetteFile, Interaction } from "../src/types.js";
import { discoverCassettes } from "../src/view/discover.js";
import { paint } from "../src/terminal.js";
import { ANTHROPIC_URL, tmpDir } from "./helpers.js";

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const meta = { provider: "anthropic", recordedAt: "2026-10-14T12:00:00Z", durationMs: 900 };
const exchange = (body: Record<string, unknown>, response: Record<string, unknown>, extra: Partial<Interaction["meta"]> = {}): Interaction => ({
  request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-sonnet-4-6", max_tokens: 1024, ...body } },
  response: { status: 200, headers: {}, body: { type: "json", value: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", stop_reason: "end_turn", ...response } } },
  meta: { ...meta, ...extra },
});
const cassetteOf = (...interactions: Interaction[]): CassetteFile => ({ version: 1, interactions });

function io(cwd: string, runs: { command: string; cwd?: string }[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    cwd,
    log: (m) => out.push(...m.split("\n")),
    error: (m) => err.push(...m.split("\n")),
    open: async () => true,
    stream: { isTTY: false, write: () => true },
    color: false,
    animate: false,
    columns: 100,
    env: {},
    interactive: false,
    exec: async (command, _env, options): Promise<ExecResult> => {
      runs.push({ command, cwd: options.cwd });
      return { code: 0, output: "" };
    },
  };
  return { io: value, out, err };
}

describe("running the project's tests", () => {
  it("runs them from the package root, wherever you are in it", async () => {
    const root = tmpDir();
    write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "*" } }));
    write(root, "test/agent.test.ts", "");
    write(root, "test/__cassettes__/agent.test.ts/a.json", JSON.stringify(cassetteOf()));
    const runs: { command: string; cwd?: string }[] = [];
    const { io: here } = io(join(root, "test"), runs);
    await main(["prune", "--dry-run"], here);
    expect(runs).toEqual([{ command: "npx vitest run", cwd: root }]);
    expect(testCommand(join(root, "test"), [], [join(root, "test", "agent.test.ts")])).toBe("npx vitest run test/agent.test.ts");
    // A command of your own runs where you are.
    expect(testDir(join(root, "test"), ["npm", "run", "test:llm"])).toBe(join(root, "test"));
  });

  it("uses the project's package manager, and gives Jest paths, not patterns", () => {
    const root = tmpDir();
    write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "*" } }));
    write(root, "pnpm-lock.yaml", "");
    expect(testCommand(root, [])).toBe("pnpm exec vitest run");
    const mono = tmpDir();
    write(mono, "yarn.lock", "");
    write(mono, "packages/app/package.json", JSON.stringify({ devDependencies: { jest: "*" } }));
    expect(project(join(mono, "packages/app"))).toEqual({ root: join(mono, "packages/app"), runner: "jest", packageManager: "yarn" });
    expect(testCommand(join(mono, "packages/app"), [], [join(mono, "packages/app/app/(shop)/cart.test.js")])).toBe("yarn jest --runTestsByPath 'app/(shop)/cart.test.js'");
    const bun = tmpDir();
    write(bun, "package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    write(bun, "bun.lock", "");
    expect(testCommand(bun, [])).toBe("bun run test");
  });

  it("says when a test file's cassettes aren't where tomiko looks", async () => {
    const root = tmpDir();
    write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "*" } }));
    write(root, "test/agent.test.ts", "");
    const { io: here, err } = io(root);
    expect(await main(["record", "test/agent.test.ts", "--yes"], here)).toBe(1);
    expect(err.join("\n")).toContain("No cassettes for test/agent.test.ts in test/__cassettes__/agent.test.ts. If your tests keep them elsewhere (the `dir` option), pass that directory");
  });
});

describe("finding cassettes", () => {
  it("leaves out the copies tomiko matrix --keep puts in .tomiko", async () => {
    const root = tmpDir();
    write(root, "test/__cassettes__/a.test.ts/x.json", JSON.stringify(cassetteOf()));
    write(root, ".tomiko/matrix/gpt-5-nano/test/__cassettes__/a.test.ts/x.json", JSON.stringify(cassetteOf()));
    expect((await discoverCassettes([], root)).map((c) => c.path)).toEqual([join("test", "__cassettes__", "a.test.ts", "x.json")]);
    expect(await discoverCassettes([join(root, ".tomiko", "matrix")], root)).toHaveLength(1);
  });

  it("reads a cassette written without meta", async () => {
    const root = tmpDir();
    const bare = { version: 1, interactions: [{ request: { method: "POST", url: ANTHROPIC_URL, body: {} }, response: { status: 200, body: { type: "json", value: {} } } }] };
    write(root, "test/__cassettes__/a.test.ts/x.json", JSON.stringify(bare));
    const { io: here, out } = io(root);
    expect(await main(["doctor"], here)).toBe(0);
    expect(out.join("\n")).toContain("Nothing to fix in 1 cassette");
  });
});

describe("tomiko diff", () => {
  it("fails on a path that is nowhere, instead of saying nothing changed", async () => {
    const root = tmpDir();
    git(root, "init", "-q");
    write(root, "test/__cassettes__/a.test.ts/x.json", JSON.stringify(cassetteOf()));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "one");
    const { io: here, err } = io(root);
    expect(await main(["diff", "old.json", "new.json", "--exit-code"], here)).toBe(1);
    expect(err.join("\n")).toContain("No such file or directory: old.json");
  });

  it("compares with nothing before the first commit", async () => {
    const root = tmpDir();
    git(root, "init", "-q");
    write(root, "test/__cassettes__/a.test.ts/x.json", JSON.stringify(cassetteOf(exchange({ messages: [] }, { content: [{ type: "text", text: "hi" }] }))));
    const { io: here, out } = io(root);
    expect(await main(["diff"], here)).toBe(0);
    expect(out.join("\n")).toContain("HEAD (no commits yet)");
    expect(out.join("\n")).toContain("x.json");
  });
});

describe("tomiko doctor", () => {
  it("doesn't count a prompt as uncached when the cache already covers it", () => {
    const system = (t: string) => [{ type: "text", text: "House rules. ".repeat(400), cache_control: { type: "ephemeral" } }, { type: "text", text: `Now: 12:00:${t}` }];
    const usage = (cacheRead: number) => ({ input_tokens: 20, output_tokens: 50, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
    const d = diagnose([
      {
        path: "c.json",
        data: cassetteOf(
          exchange({ system: system("01"), messages: [] }, { content: [{ type: "text", text: "a" }], usage: usage(1300) }),
          exchange({ system: system("09"), messages: [] }, { content: [{ type: "text", text: "b" }], usage: usage(1300) }),
        ),
      },
    ]);
    expect(d.findings).toEqual([]);
  });

  it("takes a request repeated after a fault or an empty answer for a retry", () => {
    const ask = { messages: [{ role: "user", content: "Hours?" }] };
    const answer = { content: [{ type: "text", text: "9-6" }], usage: { input_tokens: 100, output_tokens: 10 } };
    const faulted = cassetteOf(exchange(ask, answer, { fault: "empty_answer" }), exchange(ask, answer));
    const empty = cassetteOf(exchange(ask, { ...answer, content: [] }), exchange(ask, answer));
    expect(diagnose([{ path: "f.json", data: faulted }, { path: "e.json", data: empty }]).findings).toEqual([]);
  });

  it("counts the tokens of a duplicate once, though it also offers an unused tool", () => {
    const tool = { name: "unused", description: "x", input_schema: { type: "object", properties: { q: { type: "string", description: "y".repeat(2000) } } } };
    const ask = { tools: [tool], messages: [{ role: "user", content: "Hours?" }] };
    const answer = { content: [{ type: "text", text: "9-6" }], usage: { input_tokens: 1000, output_tokens: 10 } };
    const d = diagnose([{ path: "d.json", data: cassetteOf(exchange(ask, answer), exchange(ask, answer)) }]);
    const duplicate = d.findings.find((f) => f.kind === "duplicate-request")!;
    const tools = d.findings.find((f) => f.kind === "unused-tools")!;
    // The repeat is wasted whole; the tool's tokens in the first request are the only other waste.
    expect(d.savings).toBeCloseTo(duplicate.waste + tools.waste / 2, 12);
  });

  it("says once, and fits a narrow terminal", () => {
    const big = "log line\n".repeat(5000);
    const turns = [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_log", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }];
    const d = diagnose([{ path: "l.json", data: cassetteOf(exchange({ messages: turns }, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 12_000, output_tokens: 10 } })) }]);
    const lines = renderDiagnosis(d, paint(false), 40).flatMap((l) => l.split("\n"));
    expect(lines.join("\n")).toContain("sent to the model once");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(40);
  });
});
