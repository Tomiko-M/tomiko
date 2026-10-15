import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import type { ExecResult } from "../src/commands/common.js";
import { cassettesOf, quote, testCommand, testFileOf } from "../src/commands/run.js";
import { chosenForRecording, LOG_ENV, readUsage, RECORD_ENV } from "../src/control.js";
import { cassette } from "../src/index.js";
import { ANTHROPIC_URL, anthropicMessage, fakeApi, json, offline, tmpDir } from "./helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * A project whose "test suite" runs in this process: each test opens a cassette the way
 * tomiko/vitest names it, asks the fake API, and fails when a cassette can't answer.
 */
function project(options: { tests?: Record<string, string[]> } = {}) {
  const root = tmpDir();
  write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "*" } }));
  const tests = options.tests ?? { "agent.test.ts": ["weather", "echo"], "faq.test.ts": ["hours"] };
  for (const file of Object.keys(tests)) write(root, `test/${file}`, "// a test file\n");
  const state = { answers: "v1", prompt: "hello", tests, runs: [] as { command: string; env: Record<string, string>; quiet: boolean }[] };

  const api = fakeApi((body) => {
    const q: string = body.messages[0].content;
    return json(anthropicMessage(q.includes("weather") ? (state.answers === "v1" ? "Sunny, 18°C." : "Rainy, 9°C.") : `You said: ${q}`, "claude-haiku-5-5"));
  });

  async function suite(): Promise<number> {
    let failed = 0;
    for (const [file, names] of Object.entries(state.tests)) {
      for (const name of names) {
        const question = name === "weather" ? "What's the weather?" : name === "echo" ? state.prompt : "When are you open?";
        await cassette(
          `${file}/${name}`,
          () => fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: question }] }) }),
          { dir: join(root, "test", "__cassettes__"), fetch: api },
        ).catch(() => failed++);
      }
    }
    return failed ? 1 : 0;
  }

  const exec = async (command: string, env: Record<string, string>, { quiet }: { quiet: boolean }): Promise<ExecResult> => {
    state.runs.push({ command, env, quiet });
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      return { code: await suite(), output: "1 failed" };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const out: string[] = [];
  const err: string[] = [];
  const answers: boolean[] = [];
  const io: Io = {
    cwd: root,
    log: (m) => out.push(...m.split("\n")),
    error: (m) => err.push(...m.split("\n")),
    open: async () => true,
    stream: { isTTY: false, write: () => true },
    color: false,
    animate: false,
    columns: 100,
    env: {},
    interactive: false,
    confirm: async () => answers.shift() ?? false,
    exec,
  };
  const file = (path: string) => join(root, "test", "__cassettes__", path);
  return { root, io, out, err, state, api, suite, file, answers };
}

/** A project with its cassettes recorded and committed. */
async function recorded(options?: Parameters<typeof project>[0]) {
  const p = project(options);
  process.env.TOMIKO_MODE = "record";
  await p.suite();
  delete process.env.TOMIKO_MODE;
  git(p.root, "init", "-q");
  git(p.root, "add", "-A");
  git(p.root, "commit", "-qm", "recorded");
  p.api.calls.length = 0;
  return p;
}

describe("tomiko record", () => {
  it("estimates the cost, asks, re-records everything and shows what changed", async () => {
    const p = await recorded();
    p.state.answers = "v2";
    expect(await main(["record"], p.io)).toBe(1);
    expect(p.err.join("\n")).toContain("Re-record every cassette? No terminal to ask in: pass --yes to go ahead.");
    expect(p.state.runs).toEqual([]);

    expect(await main(["record", "--yes"], p.io)).toBe(0);
    expect(p.state.runs).toEqual([{ command: "npx vitest run", env: expect.objectContaining({ TOMIKO_MODE: "record" }), quiet: false }]);
    expect(p.api.calls).toHaveLength(3);
    const text = p.out.join("\n");
    expect(text).toContain("tomiko record  every cassette · 3 requests");
    expect(text).toMatch(/● About \$0\.000\d at today's prices, judging by the last recording\./);
    expect(text).toContain("▸ TOMIKO_MODE=record npx vitest run");
    expect(text).toMatch(/✔ Re-recorded 3 cassettes in \d/);
    expect(text).toContain("~ test/__cassettes__/agent.test.ts/weather.json  ● same behavior, new wording");
    expect(text).toContain("[-Sunny, 18-]{+Rainy, 9+}°C.");
  });

  it("asks at a terminal, and does nothing on no", async () => {
    const p = await recorded();
    p.io.interactive = true;
    p.answers.push(false);
    expect(await main(["record"], p.io)).toBe(1);
    expect(p.state.runs).toEqual([]);
    expect(p.out).toContain("  Nothing changed.");
  });

  it("refuses to go over --max-cost", async () => {
    const p = await recorded();
    expect(await main(["record", "--yes", "--max-cost", "0.00001"], p.io)).toBe(1);
    expect(p.err[0]).toBe("  ✖ That is more than --max-cost 0.00001. Nothing was recorded.");
    expect(p.state.runs).toEqual([]);
    expect(await main(["record", "--max-cost", "lots"], p.io)).toBe(1);
  });

  it("re-records the cassettes of the test files it is given, running only those files", async () => {
    const p = await recorded();
    p.state.answers = "v2";
    expect(await main(["record", "test/agent.test.ts", "--yes"], p.io)).toBe(0);
    const [run] = p.state.runs;
    expect(run!.command).toBe("npx vitest run test/agent.test.ts");
    expect(run!.env).toMatchObject({ TOMIKO_MODE: "replay", [RECORD_ENV]: expect.stringMatching(/^@/) });
    // Only agent.test.ts's two cassettes reached the API; faq.test.ts replayed.
    expect(p.api.calls).toHaveLength(2);
    expect(p.out.join("\n")).toContain("tomiko record  2 cassettes · 2 requests");
    expect(p.out.join("\n")).toContain("TOMIKO_RECORD=(2 cassettes)");
  });

  it("with --stale, finds what no longer matches and re-records just that", async () => {
    const p = await recorded();
    p.state.prompt = "hi there";
    p.state.tests["new.test.ts"] = ["first"];
    write(p.root, "test/new.test.ts", "// new\n");
    expect(await main(["record", "--stale", "--yes"], p.io)).toBe(0);
    const [check, rec] = p.state.runs;
    expect(check).toMatchObject({ quiet: true, env: { TOMIKO_MODE: "replay", [LOG_ENV]: expect.any(String) } });
    expect(rec!.command).toBe("npx vitest run test/agent.test.ts test/new.test.ts");
    const text = p.out.join("\n");
    expect(text).toContain("~ 2 cassettes out of date:");
    expect(text).toContain("~ test/__cassettes__/agent.test.ts/echo.json  no longer matches its test");
    expect(text).toContain("+ test/__cassettes__/new.test.ts/first.json   not recorded yet");
    expect(text).toContain("tomiko record  2 cassettes · 1 request");
    expect(text).toContain("1 cassette not recorded yet can't be estimated.");
    expect(p.api.calls.map((c) => (c.body as { messages: { content: string }[] }).messages[0]!.content)).toEqual(["hi there", "When are you open?"]);
    expect(existsSync(p.file("new.test.ts/first.json"))).toBe(true);
  });

  it("says so when every cassette still matches", async () => {
    const p = await recorded();
    expect(await main(["record", "--stale"], p.io)).toBe(0);
    expect(p.out).toEqual(["  ✔ Every cassette still matches its test. Nothing to re-record."]);
    expect(p.state.runs).toHaveLength(1);
  });

  it("uses the test command given after --", async () => {
    const p = await recorded();
    expect(await main(["record", "--yes", "--", "npm", "run", "test:llm", "--", "--grep", "agent tools"], p.io)).toBe(0);
    expect(p.state.runs[0]!.command).toBe("npm run test:llm -- --grep 'agent tools'");
  });
});

describe("tomiko prune", () => {
  it("lists what no test uses, and removes it when told to", async () => {
    const p = await recorded();
    // A test was deleted, a test file is gone, and a cassette holds a request no test sends.
    p.state.tests = { "agent.test.ts": ["weather"], "faq.test.ts": ["hours"] };
    write(p.root, "test/__cassettes__/gone.test.ts/old.json", readFileSync(p.file("faq.test.ts/hours.json"), "utf8"));
    const hours = JSON.parse(readFileSync(p.file("faq.test.ts/hours.json"), "utf8"));
    hours.interactions.push({ ...hours.interactions[0], request: { ...hours.interactions[0].request, body: { messages: [{ role: "user", content: "old" }] } } });
    writeFileSync(p.file("faq.test.ts/hours.json"), JSON.stringify(hours));

    expect(await main(["prune", "--dry-run"], p.io)).toBe(0);
    expect(p.out).toEqual([
      "  ✔ Replayed your tests: they use 2 of 4 cassettes.",
      "",
      "    − test/__cassettes__/agent.test.ts/echo.json  no test used it",
      "    − test/__cassettes__/gone.test.ts/old.json    its test file is gone",
      "    ~ test/__cassettes__/faq.test.ts/hours.json   1 of 2 requests unused: #2",
      "",
      "  Dry run: nothing removed. Without --dry-run, 2 cassettes and 1 request would go.",
    ]);
    expect(p.state.runs[0]).toMatchObject({ command: "npx vitest run", quiet: true, env: { TOMIKO_MODE: "replay" } });
    expect(existsSync(p.file("agent.test.ts/echo.json"))).toBe(true);

    p.out.length = 0;
    expect(await main(["prune", "--yes"], p.io)).toBe(0);
    expect(p.out.at(-1)).toMatch(/^ {2}✔ Removed 2 cassettes and 1 request · [\d.]+ KB$/);
    expect(existsSync(p.file("agent.test.ts/echo.json"))).toBe(false);
    expect(existsSync(p.file("gone.test.ts"))).toBe(false); // the empty directory went too
    expect(JSON.parse(readFileSync(p.file("faq.test.ts/hours.json"), "utf8")).interactions).toHaveLength(1);

    p.out.length = 0;
    expect(await main(["prune"], p.io)).toBe(0);
    expect(p.out).toEqual(["  ✔ Nothing to prune: your tests use every request in 2 cassettes."]);
    // The trimmed cassette still replays.
    expect(await p.suite()).toBe(0);
  });

  it("only trusts a passing run", async () => {
    const p = await recorded();
    p.state.prompt = "changed";
    expect(await main(["prune", "--yes"], p.io)).toBe(1);
    expect(p.err[0]).toBe("  ✖ npx vitest run failed (exit 1), so tomiko can't tell which recordings your tests need.");
    expect(p.err.at(-1)).toContain("npx tomiko record --stale");
    expect(existsSync(p.file("agent.test.ts/echo.json"))).toBe(true);
  });

  it("notices a command that runs no cassettes", async () => {
    const p = await recorded();
    p.io.exec = async () => ({ code: 0, output: "" });
    expect(await main(["prune", "--yes"], p.io)).toBe(1);
    expect(p.err[0]).toContain("opened no cassettes. Is it the command that runs your tests? Pass yours after --.");
  });
});

describe("the run protocol", () => {
  it("records the cassettes TOMIKO_RECORD names, and logs what each one served", async () => {
    const dir = tmpDir();
    const ask = (q: string) => fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: q }] }) });
    const api = fakeApi(() => json(anthropicMessage("hi")));
    await cassette("a", async () => (await ask("one"), await ask("two")), { dir, fetch: api });

    const log = join(tmpDir(), "usage.jsonl");
    process.env[LOG_ENV] = log;
    process.env[RECORD_ENV] = join(dir, "b.json");
    try {
      await cassette("a", () => ask("two"), { dir, mode: "replay", fetch: offline });
      await cassette("b", () => ask("three"), { dir, mode: "replay", fetch: api });
      await cassette("a", () => ask("four"), { dir, mode: "replay", fetch: offline }).catch(() => {});
      await cassette("c", () => ask("five"), { dir, mode: "replay", fetch: offline }).catch(() => {});
    } finally {
      delete process.env[LOG_ENV];
      delete process.env[RECORD_ENV];
    }
    expect(readUsage(log)).toEqual([
      { file: join(dir, "a.json"), mode: "replay", exists: true, size: 2, used: [1], recorded: 0, mismatched: false, missing: false },
      { file: join(dir, "b.json"), mode: "record", exists: false, size: 0, used: [], recorded: 1, mismatched: false, missing: false },
      { file: join(dir, "a.json"), mode: "replay", exists: true, size: 2, used: [], recorded: 0, mismatched: true, missing: false },
      { file: join(dir, "c.json"), mode: "replay", exists: false, size: 0, used: [], recorded: 0, mismatched: false, missing: true },
    ]);
  });

  it("reads TOMIKO_RECORD as a path list or from a file", () => {
    const dir = tmpDir();
    const list = join(dir, "list.txt");
    writeFileSync(list, `${join(dir, "x")}\n${join(dir, "y.json")}\n`);
    expect(chosenForRecording(join(dir, "x", "deep", "a.json"), { [RECORD_ENV]: `@${list}` })).toBe(true);
    expect(chosenForRecording(join(dir, "y.json"), { [RECORD_ENV]: `@${list}` })).toBe(true);
    expect(chosenForRecording(join(dir, "xy.json"), { [RECORD_ENV]: `@${list}` })).toBe(false);
    expect(chosenForRecording(join(dir, "z.json"), { [RECORD_ENV]: [join(dir, "q"), join(dir, "z.json")].join(process.platform === "win32" ? ";" : ":") })).toBe(true);
    expect(chosenForRecording(join(dir, "z.json"), {})).toBe(false);
  });

  it("finds a project's test runner and the test files cassettes belong to", () => {
    const root = tmpDir();
    write(root, "package.json", JSON.stringify({ devDependencies: { jest: "*" } }));
    write(root, "src/a.test.ts", "");
    expect(testCommand(join(root, "src"), [], [join(root, "src", "a.test.ts")])).toBe("npx jest --runTestsByPath src/a.test.ts");
    write(root, "package.json", JSON.stringify({ scripts: { test: "mocha" } }));
    expect(testCommand(root, [])).toBe("npm test");
    expect(cassettesOf(join(root, "src", "a.test.ts"))).toBe(join(root, "src", "__cassettes__", "a.test.ts"));
    expect(testFileOf(join(root, "src", "__cassettes__", "a.test.ts", "deep", "x.json"))).toBe(join(root, "src", "a.test.ts"));
    expect(testFileOf(join(root, "src", "__cassettes__", "gone.test.ts", "x.json"))).toBeUndefined();
    expect(quote("plain-word.ts")).toBe("plain-word.ts");
    expect(quote("it's here")).toBe(`'it'\\''s here'`);
  });
});
