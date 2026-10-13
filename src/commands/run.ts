/** Running the project's tests from `tomiko record` and `tomiko prune`. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { sideOf } from "../compare.js";
import { plural, usd } from "../format.js";
import { defaultPricing } from "../pricing.js";
import type { Paint } from "../terminal.js";
import type { CassetteFile } from "../types.js";
import type { ExecResult, Io } from "./common.js";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export const isTestFile = (path: string) => TEST_FILE.test(path) && existsSync(path) && statSync(path).isFile();

/** Where `tomiko/vitest` keeps a test file's cassettes: `test/__cassettes__/agent.test.ts`. */
export const cassettesOf = (testFile: string) => join(dirname(testFile), "__cassettes__", basename(testFile));

/** The test file a cassette belongs to by that convention, whether or not it still exists. */
export function conventionalTestFile(cassette: string): string | undefined {
  const parts = resolve(cassette).split(sep);
  const at = parts.lastIndexOf("__cassettes__");
  if (at <= 0 || at + 1 >= parts.length || !TEST_FILE.test(parts[at + 1]!)) return undefined;
  return [...parts.slice(0, at), parts[at + 1]!].join(sep) || sep;
}

/** The test file a cassette belongs to, when it exists. */
export function testFileOf(cassette: string): string | undefined {
  const file = conventionalTestFile(cassette);
  return file && isTestFile(file) ? file : undefined;
}

/** A shell word, quoted only when it has to be. */
export function quote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return process.platform === "win32" ? `"${word.replace(/"/g, '""')}"` : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The nearest package.json's test runner: Vitest or Jest run directly, anything else through `npm test`. */
function runner(cwd: string): "vitest" | "jest" | "npm" {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vitest) return "vitest";
        if (deps.jest) return "jest";
      } catch {
        // Unreadable: fall back to npm test.
      }
      return "npm";
    }
    if (dirname(dir) === dir) return "npm";
  }
}

/**
 * The command that runs the tests: `--` and what follows it when given, otherwise the project's
 * runner, limited to `files` when the runner can take them.
 */
export function testCommand(cwd: string, given: string[], files: string[] = []): string {
  if (given.length > 0) return given.map(quote).join(" ");
  const tool = runner(cwd);
  const only = files.map((f) => quote(relative(cwd, f) || f)).join(" ");
  if (tool === "vitest") return `npx vitest run${only ? ` ${only}` : ""}`;
  if (tool === "jest") return `npx jest${only ? ` ${only}` : ""}`;
  return "npm test";
}

/** Runs a shell command, its output passed through, or kept (the last 64 KB) when quiet. */
export function execute(cwd: string): NonNullable<Io["exec"]> {
  return (command, env, { quiet }) =>
    new Promise<ExecResult>((done) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...env },
        stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-65_536);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (error) => done({ code: 127, output: `${output}\n${error.message}` }));
      child.on("close", (code, signal) => done({ code: code ?? (signal ? 130 : 1), output }));
    });
}

export function ask(question: string): Promise<boolean> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      done(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

/** `--yes`, or a yes at the terminal. Without a terminal there is no one to ask, so no. */
export async function approve(io: Io, p: Paint, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (io.interactive && io.confirm) {
    const answer = await io.confirm(`  ${question} ${p.dim("[y/N]")} `);
    if (!answer) io.log(`  ${p.dim("Nothing changed.")}`);
    return answer;
  }
  io.error(`  ${p.red("✖")} ${question} No terminal to ask in: pass ${p.bold("--yes")} to go ahead.`);
  return false;
}

export interface Estimate {
  requests: number;
  /** USD at today's prices, over the requests with a known price. */
  cost: number;
  priced: number;
  /** Requests per model without a price. */
  unpriced: Map<string, number>;
}

/** What recording these cassettes again costs, judging by what their last recording used. */
export function estimate(files: CassetteFile[]): Estimate {
  const result: Estimate = { requests: 0, cost: 0, priced: 0, unpriced: new Map() };
  for (const file of files) {
    for (const interaction of file.interactions) {
      result.requests++;
      const side = sideOf(interaction, defaultPricing);
      if (side.cost !== null) {
        result.cost += side.cost;
        result.priced++;
      } else if (side.usage) {
        const model = side.model ?? "(unknown model)";
        result.unpriced.set(model, (result.unpriced.get(model) ?? 0) + 1);
      }
    }
  }
  return result;
}

export function estimateLines(p: Paint, e: Estimate, unknown = 0): string[] {
  const lines = [`  ${p.accent("●")} About ${p.bold(usd(e.cost))} at today's prices, judging by the last recording.`];
  if (e.priced === 0 && e.unpriced.size === 0 && unknown === 0) lines[0] = `  ${p.accent("●")} No recorded usage to estimate the cost from.`;
  for (const [model, n] of e.unpriced) {
    lines.push(`    ${p.yellow("!")} ${p.dim(`tomiko has no price for ${model}, so its ${plural(n, "request")} aren't counted.`)}`);
  }
  if (unknown > 0) lines.push(`    ${p.dim(`${plural(unknown, "cassette")} not recorded yet can't be estimated.`)}`);
  return lines;
}
