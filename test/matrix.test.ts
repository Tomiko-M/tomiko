import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import type { ExecResult } from "../src/commands/common.js";
import { MODEL_ENV, SHADOW_ENV, shadowed } from "../src/control.js";
import { cassette } from "../src/index.js";
import { fakeApi, GEMINI_URL, geminiResponse, json, OPENAI_URL, openaiChat, tmpDir } from "./helpers.js";

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Runs `fn` with these environment variables, then puts them back. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A project whose suite runs in this process: three tests ask a fake OpenAI API, whose models
 * answer differently, and a Vitest-style JSON report is written where the command asks.
 */
function project() {
  const root = tmpDir();
  write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "*" } }));
  const answers: Record<string, Record<string, string>> = {
    "gpt-5.4": { weather: "Sunny, 18°C.", plan: "Day 1: Alfama.", classify: '{"category":"delivery"}' },
    "gpt-5.4-mini": { weather: "Sunny and 18°C today.", plan: "Day 1: Alfama.", classify: '{"category":"delivery"}' },
    "gpt-5-nano": { weather: "Sunny.", plan: "Visit.", classify: '{"category":"other"}' },
  };
  const api = fakeApi((body) => {
    const kind = String(body.messages[0].content);
    return json({ ...openaiChat({ text: answers[body.model]?.[kind] ?? "?", model: body.model }), usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
  });
  const tests: [string, string, (answer: string) => boolean][] = [
    ["weather", "tells the weather", (a) => a.includes("18°C")],
    ["plan", "plans a trip", (a) => a.includes("Day 1")],
    ["classify", "classifies a ticket", (a) => JSON.parse(a).category === "delivery"],
  ];
  async function suite(report?: string): Promise<number> {
    const results = [];
    for (const [kind, name, check] of tests) {
      const ok = await cassette(
        `agent.test.ts/${name}`,
        async () => {
          const res = await fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: kind }] }) });
          return check((await res.json()).choices[0].message.content);
        },
        { dir: join(root, "test", "__cassettes__"), fetch: api },
      ).catch(() => false);
      results.push({ fullName: name, status: ok ? "passed" : "failed" });
    }
    const passed = results.filter((r) => r.status === "passed").length;
    if (report) {
      writeFileSync(report, JSON.stringify({ numTotalTests: results.length, numPassedTests: passed, testResults: [{ name: join(root, "test", "agent.test.ts"), assertionResults: results }] }));
    }
    return passed === results.length ? 0 : 1;
  }
  const runs: { command: string; env: Record<string, string> }[] = [];
  const exec = async (command: string, env: Record<string, string>): Promise<ExecResult> => {
    runs.push({ command, env });
    const report = /--outputFile=(\S+)/.exec(command)?.[1];
    const cwd = process.cwd();
    process.chdir(root); // the runner runs in the project, where shadow paths are relative to
    try {
      return { code: await withEnv(env, () => suite(report)), output: "" };
    } finally {
      process.chdir(cwd);
    }
  };
  const out: string[] = [];
  const err: string[] = [];
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
    exec,
  };
  return { root, io, out, err, api, runs, suite };
}

async function recorded() {
  const p = project();
  await withEnv({ TOMIKO_MODE: "record" }, () => p.suite());
  p.api.calls.length = 0;
  return p;
}

describe("tomiko matrix", () => {
  it("estimates, runs the suite on each model, and lays them side by side", async () => {
    const p = await recorded();
    const before = readFileSync(join(p.root, "test/__cassettes__/agent.test.ts/tells-the-weather.json"), "utf8");
    expect(await main(["matrix", "--models", "gpt-5.4-mini,gpt-5-nano", "--yes"], p.io)).toBe(0);

    expect(p.runs.map((r) => [r.env.TOMIKO_MODE, r.env[MODEL_ENV] ?? "", r.command.replace(/--outputFile=\S+/, "--outputFile=…")])).toEqual([
      ["replay", "", "npx vitest run --reporter=json --outputFile=…"],
      ["record", "gpt-5.4-mini", "npx vitest run --reporter=json --outputFile=…"],
      ["record", "gpt-5-nano", "npx vitest run --reporter=json --outputFile=…"],
    ]);
    // Every request reached the API as the model being tried.
    expect(p.api.calls.map((c) => (c.body as { model: string }).model)).toEqual([...Array(3).fill("gpt-5.4-mini"), ...Array(3).fill("gpt-5-nano")]);
    // The real cassettes are as they were.
    expect(readFileSync(join(p.root, "test/__cassettes__/agent.test.ts/tells-the-weather.json"), "utf8")).toBe(before);

    expect(p.out).toEqual([
      "  tomiko matrix  3 cassettes · 3 requests · 2 models",
      "",
      "  ● About $0.0039 to run your tests on 2 models, judging by the current recordings:",
      "      gpt-5.4-mini  $0.0036",
      "      gpt-5-nano    $0.00027",
      "",
      expect.stringMatching(/^ {2}model {10}tests {3}cost a run {11}time +behavior$/),
      expect.stringMatching(/^ {2}gpt-5\.4 now {4}3\/3 ✔ {3}\$0\.01 {16}\d+ms +as recorded$/),
      expect.stringMatching(/^ {2}gpt-5\.4-mini {3}3\/3 ✔ {3}\$0\.0036 {6}÷3\.3 {4}\d+ms +same, new wording in 1$/),
      expect.stringMatching(/^ {2}gpt-5-nano {5}0\/3 {5}\$0\.00027 {5}÷44\.4 {3}\d+ms +changed in 1 of 3$/),
      "",
      "  ✖ gpt-5-nano    agent.test.ts > tells the weather, agent.test.ts > plans a trip and 1 more",
      "",
      "  ◆ gpt-5.4-mini passes every test at 3.3× less than now.",
    ]);
  });

  it("can keep each model's cassettes, and asks before spending", async () => {
    const p = await recorded();
    expect(await main(["matrix", "--models", "gpt-5-nano"], p.io)).toBe(1);
    expect(p.err.join("\n")).toContain("Run your tests on 1 model? No terminal to ask in: pass --yes to go ahead.");
    expect(p.runs).toEqual([]);

    expect(await main(["matrix", "--models", "gpt-5-nano", "--yes", "--keep"], p.io)).toBe(0);
    const kept = join(p.root, ".tomiko/matrix/gpt-5-nano/test/__cassettes__/agent.test.ts/tells-the-weather.json");
    expect(JSON.parse(readFileSync(kept, "utf8")).interactions[0].request.body.model).toBe("gpt-5-nano");
    expect(p.out.at(-1)).toContain("npx tomiko view .tomiko/matrix");
  });

  it("says when nothing cheaper passes, and refuses without models or over --max-cost", async () => {
    const p = await recorded();
    expect(await main(["matrix", "--models", "gpt-5-nano", "--yes"], p.io)).toBe(0);
    expect(p.out.at(-1)).toMatch(/◆ Nothing cheaper passes every test: gpt-5\.4, what you use now, stays the best buy\. gpt-5-nano costs \d+\.\d× less but fails 3 tests\./);
    expect(await main(["matrix"], p.io)).toBe(1);
    expect(p.err.at(-1)).toContain("Name the models to try: --models gpt-5.4-mini,gpt-5-nano");
    expect(await main(["matrix", "--models", "gpt-5.4-mini", "--max-cost", "0.0001", "--yes"], p.io)).toBe(1);
    expect(p.err.at(-1)).toContain("That is more than --max-cost 0.0001. Nothing was run.");
  });
});

describe("the model override", () => {
  it("rewrites the model in the body, or in Gemini's path", async () => {
    const api = fakeApi((_body, request) => json(request.url.includes("gemini") ? geminiResponse({ text: "hi" }) : openaiChat({ text: "hi" })));
    await withEnv({ [MODEL_ENV]: "gpt-5-nano" }, () =>
      cassette("o", () => fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4", messages: [] }) }), { dir: tmpDir(), fetch: api }),
    );
    await withEnv({ [MODEL_ENV]: "gemini-3.1-pro" }, () =>
      cassette("g", () => fetch(`${GEMINI_URL}/models/gemini-2.5-flash:generateContent`, { method: "POST", body: JSON.stringify({ contents: [] }) }), { dir: tmpDir(), fetch: api }),
    );
    expect(api.calls.map((c) => [c.url, (c.body as { model?: string }).model])).toEqual([
      [`${OPENAI_URL}/chat/completions`, "gpt-5-nano"],
      [`${GEMINI_URL}/models/gemini-3.1-pro:generateContent`, undefined],
    ]);
  });

  it("refuses a model of another API", async () => {
    const run = withEnv({ [MODEL_ENV]: "claude-haiku-5-5" }, () =>
      cassette("x", () => fetch(`${OPENAI_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-5.4" }) }), { dir: tmpDir(), fetch: fakeApi(() => json({})) }),
    );
    await expect(run).rejects.toThrow("TOMIKO_MODEL=claude-haiku-5-5 is a model of another API: this request goes to the openai API.");
  });

  it("puts shadow cassettes at the same place under the shadow directory", () => {
    const shadow = tmpDir();
    expect(shadowed(join(process.cwd(), "test", "__cassettes__", "a.json"), { [SHADOW_ENV]: shadow })).toBe(join(shadow, "test", "__cassettes__", "a.json"));
    expect(shadowed("/elsewhere/a.json", {})).toBe("/elsewhere/a.json");
    expect(existsSync(shadow)).toBe(true);
  });
});

describe("tomiko matrix, fixed", () => {
  it("runs only the tests of the cassettes it is given", async () => {
    const p = await recorded();
    write(p.root, "test/agent.test.ts", "// the test file\n");
    expect(await main(["matrix", "--models", "gpt-5-nano", "--yes", "test/__cassettes__/agent.test.ts/tells-the-weather.json"], p.io)).toBe(0);
    expect(p.runs.map((r) => r.command.replace(/--outputFile=\S+/, "--outputFile=…"))).toEqual([
      "npx vitest run test/agent.test.ts --reporter=json --outputFile=…",
      "npx vitest run test/agent.test.ts --reporter=json --outputFile=…",
    ]);
  });

  it("keeps what it can when a model's run records nothing, and trusts the exit code over the report", async () => {
    const p = await recorded();
    const real = p.io.exec!;
    // The second model fails before any test runs; the first passes every test but exits with 1.
    p.io.exec = async (command, env, options) => {
      if (env[MODEL_ENV] === "gpt-4.1-nano") return { code: 1, output: "crashed" };
      const result = await real(command, env, options);
      return env[MODEL_ENV] === "gpt-5.4-mini" ? { ...result, code: 1 } : result;
    };
    expect(await main(["matrix", "--models", "gpt-5.4-mini,gpt-4.1-nano", "--yes", "--keep"], p.io)).toBe(0);
    expect(p.out.at(-2)).toContain("◆ Nothing cheaper passes every test");
    expect(existsSync(join(p.root, ".tomiko/matrix/gpt-5.4-mini"))).toBe(true);
    expect(existsSync(join(p.root, ".tomiko/matrix/gpt-4.1-nano"))).toBe(false);
  });
});
