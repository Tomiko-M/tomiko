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

export type Runner = "vitest" | "jest" | "npm";
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** How each package manager runs a project's own binary, and its test script. */
const EXEC: Record<PackageManager, string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };
const TEST_SCRIPT: Record<PackageManager, string> = { npm: "npm test", pnpm: "pnpm test", yarn: "yarn test", bun: "bun run test" };
const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export interface Project {
  /** The directory of the nearest package.json, where its tests run from. */
  root: string;
  runner: Runner;
  packageManager: PackageManager;
}

function readPackage(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The project `cwd` is in: the nearest package.json, its test runner (Vitest or Jest, run
 * directly; anything else through its test script), and its package manager, by the lockfile
 * here or in a workspace above, so the runner is the project's own and not one npx downloads.
 */
export function project(cwd: string): Project {
  let root: string | undefined;
  let runner: Runner = "npm";
  let declared: string | undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (root === undefined && existsSync(join(dir, "package.json"))) {
      root = dir;
      const pkg = readPackage(join(dir, "package.json"));
      const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>;
      runner = deps.vitest ? "vitest" : deps.jest ? "jest" : "npm";
      if (typeof pkg?.packageManager === "string") declared = pkg.packageManager;
    }
    if (root !== undefined) {
      const lock = LOCKFILES.find(([name]) => existsSync(join(dir, name)));
      if (lock) return { root, runner, packageManager: lock[1] };
      const pkg = dir === root ? undefined : readPackage(join(dir, "package.json"));
      if (typeof pkg?.packageManager === "string") declared ??= pkg.packageManager;
    }
    if (dirname(dir) === dir) break;
  }
  const manager = (["pnpm", "yarn", "bun"] as const).find((m) => declared?.startsWith(`${m}@`)) ?? "npm";
  return { root: root ?? resolve(cwd), runner, packageManager: manager };
}

export const runner = (cwd: string): Runner => project(cwd).runner;

/** Where the test command runs: the project's root, or here for a command of your own. */
export const testDir = (cwd: string, given: string[]) => (given.length > 0 ? resolve(cwd) : project(cwd).root);

/**
 * The command that runs the tests, from `testDir`: `--` and what follows it when given, otherwise
 * the project's runner, limited to `files` when the runner can take them.
 */
export function testCommand(cwd: string, given: string[], files: string[] = [], extra: string[] = []): string {
  if (given.length > 0) return given.map(quote).join(" ");
  const { root, runner: tool, packageManager } = project(cwd);
  const paths = files.map((f) => relative(root, f) || f);
  const exec = EXEC[packageManager];
  if (tool === "vitest") return [`${exec} vitest run`, ...[...paths, ...extra].map(quote)].join(" ");
  // Jest reads file arguments as patterns: `app/(shop)` would match nothing.
  if (tool === "jest") return [`${exec} jest`, ...(paths.length > 0 ? ["--runTestsByPath"] : []), ...[...paths, ...extra].map(quote)].join(" ");
  return TEST_SCRIPT[packageManager];
}

/** Arguments that make the runner write its results as JSON to `file`, when it can. */
export function jsonReport(cwd: string, given: string[], file: string): string[] {
  if (given.length > 0) return [];
  const tool = runner(cwd);
  if (tool === "vitest") return ["--reporter=json", `--outputFile=${file}`];
  if (tool === "jest") return ["--json", `--outputFile=${file}`];
  return [];
}

export interface TestResults {
  total: number;
  passed: number;
  /** `agent.test.ts > plans a trip` */
  failed: string[];
}

/** Reads a Vitest or Jest JSON report: they share a format. */
export function readReport(file: string): TestResults | undefined {
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numPendingTests?: number;
      numTodoTests?: number;
      testResults?: { name?: string; assertionResults?: { fullName?: string; title?: string; status?: string }[] }[];
    };
    const failed = (report.testResults ?? []).flatMap((suite) =>
      (suite.assertionResults ?? [])
        .filter((test) => test.status === "failed")
        .map((test) => `${basename(suite.name ?? "")} > ${test.fullName ?? test.title ?? "?"}`),
    );
    // Skipped tests neither pass nor fail.
    const total = (report.numTotalTests ?? 0) - (report.numPendingTests ?? 0) - (report.numTodoTests ?? 0);
    return { total, passed: report.numPassedTests ?? 0, failed };
  } catch {
    return undefined;
  }
}

/** Runs a shell command, its output passed through, or kept (the last 64 KB) when quiet. */
export function execute(cwd: string): NonNullable<Io["exec"]> {
  return (command, env, { quiet, cwd: dir }) =>
    new Promise<ExecResult>((done) => {
      const child = spawn(command, {
        cwd: dir ?? cwd,
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
