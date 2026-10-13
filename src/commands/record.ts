import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { diffCassettes } from "../compare.js";
import { LOG_ENV, readUsage, RECORD_ENV, type UsageEntry } from "../control.js";
import { duration, plural } from "../format.js";
import { repoRoot } from "../git.js";
import { Spinner } from "../terminal.js";
import { discoverCassettes } from "../view/discover.js";
import { type Command, failure, type Io } from "./common.js";
import { fromGit, showComparison } from "./diff.js";
import { approve, cassettesOf, estimate, estimateLines, execute, isTestFile, testCommand, testFileOf } from "./run.js";

/** A scratch directory for the run's log and list of cassettes, removed afterwards. */
function scratch(): { dir: string; log: string; list: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "tomiko-record-"));
  return { dir, log: join(dir, "usage.jsonl"), list: join(dir, "record.txt"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const show = (io: Io, path: string) => relative(io.cwd, path) || path;
const unique = <T>(items: T[]) => [...new Set(items)];

/** Cassettes a replay found out of date: a request no recording matched, or no file at all. */
function stale(entries: UsageEntry[]): { file: string; reason: "mismatched" | "missing" }[] {
  const byFile = new Map<string, "mismatched" | "missing">();
  for (const e of entries) {
    if (e.missing) byFile.set(e.file, "missing");
    else if (e.mismatched && byFile.get(e.file) !== "missing") byFile.set(e.file, "mismatched");
  }
  return [...byFile].map(([file, reason]) => ({ file, reason })).sort((a, b) => a.file.localeCompare(b.file));
}

export const record: Command = {
  name: "record",
  usage: ["record [paths...] [options] [-- test command]"],
  summary: "Re-record cassettes, with the cost up front and a diff after",
  description: (p) => [
    "Re-records cassettes against the live API: it estimates what that costs from their last",
    "recording, asks before spending anything, runs your tests, then shows what the model now",
    "does differently.",
    "",
    "Without paths, every cassette is re-recorded. Paths pick test files or cassettes:",
    "",
    `  ${p.accent("npx tomiko record test/agent.test.ts")}`,
    `  ${p.accent("npx tomiko record --stale")}              ${p.dim("only cassettes that no longer match")}`,
    `  ${p.accent("npx tomiko record -- npm run test:llm")}  ${p.dim("with your own test command")}`,
    "",
    "Other cassettes replay. The tests run with Vitest or Jest from package.json, or npm test.",
  ],
  flags: {
    stale: { type: "boolean", help: "Only cassettes that no longer match their tests, or are missing" },
    yes: { type: "boolean", short: "-y", help: "Don't ask before spending tokens" },
    "max-cost": { type: "string", value: "usd", help: "Stop if the estimate is above this many dollars" },
  },
  runs: true,
  async run(args, io, p) {
    const yes = args.flags.yes === true;
    const maxCost = typeof args.flags["max-cost"] === "string" ? Number(args.flags["max-cost"].replace(/^\$/, "")) : undefined;
    if (maxCost !== undefined && !(maxCost >= 0)) return failure(io, p, `--max-cost takes an amount in dollars, like 0.50`);
    if (args.flags.stale && args.positional.length > 0) return failure(io, p, "--stale finds the cassettes itself; leave out the paths.");
    const exec = io.exec ?? execute(io.cwd);
    const run = scratch();
    try {
      // 1. Which cassettes.
      let chosen: string[] | "all" = "all";
      let missing = 0;
      if (args.flags.stale) {
        const spinner = new Spinner(io.stream, p, io.animate).start("Replaying your tests to find cassettes that no longer match…");
        const command = testCommand(io.cwd, args.rest);
        const result = await exec(command, { TOMIKO_MODE: "replay", [LOG_ENV]: run.log }, { quiet: true });
        await spinner.stop();
        const entries = readUsage(run.log);
        if (entries.length === 0 && result.code !== 0) {
          io.error(`  ${p.red("✖")} ${command} failed before any cassette was used (exit ${result.code}):`);
          io.error(result.output.trimEnd().split("\n").slice(-20).map((l) => `    ${l}`).join("\n"));
          return result.code;
        }
        const found = stale(entries);
        if (found.length === 0) {
          io.log(`  ${p.green("✔")} Every cassette still matches its test. Nothing to re-record.`);
          if (result.code !== 0) io.log(`    ${p.dim(`Some tests fail for other reasons (exit ${result.code}).`)}`);
          return 0;
        }
        missing = found.filter((f) => f.reason === "missing").length;
        io.log(`  ${p.yellow("~")} ${p.bold(plural(found.length, "cassette"))} out of date:`);
        const pad = Math.max(...found.map((f) => show(io, f.file).length));
        for (const f of found) {
          const mark = f.reason === "missing" ? p.green("+") : p.yellow("~");
          io.log(`    ${mark} ${show(io, f.file).padEnd(pad)}  ${p.dim(f.reason === "missing" ? "not recorded yet" : "no longer matches its test")}`);
        }
        io.log("");
        chosen = found.map((f) => f.file);
      } else if (args.positional.length > 0) {
        chosen = [];
        for (const path of args.positional.map((p) => resolve(io.cwd, p))) {
          if (isTestFile(path)) chosen.push(cassettesOf(path));
          else if (existsSync(path)) chosen.push(path);
          else return failure(io, p, `No such test file, cassette or directory: ${show(io, path)}`);
        }
      }

      // 2. What it costs.
      const present = chosen === "all" ? [] : chosen.filter((c) => existsSync(c));
      // An empty list would mean every cassette to discoverCassettes.
      const existing = chosen !== "all" && present.length === 0 ? [] : (await discoverCassettes(present, io.cwd)).map((f) => f.data);
      const cost = estimate(existing);
      const scope = chosen === "all" ? "every cassette" : plural(args.flags.stale ? chosen.length : existing.length, "cassette");
      io.log(`  ${p.bold("tomiko record")}  ${p.dim(`${scope} · ${plural(cost.requests, "request")}`)}`);
      io.log("");
      for (const line of estimateLines(p, cost, missing)) io.log(line);
      io.log("");
      if (maxCost !== undefined && cost.cost > maxCost) {
        return failure(io, p, `That is more than --max-cost ${args.flags["max-cost"] as string}. Nothing was recorded.`);
      }
      if (!(await approve(io, p, yes, chosen === "all" ? "Re-record every cassette?" : `Re-record ${plural(chosen.length, "cassette")}?`))) return 1;

      // 3. Record.
      const env: Record<string, string> = { [LOG_ENV]: run.log };
      let files: string[] = [];
      if (chosen === "all") env.TOMIKO_MODE = "record";
      else {
        writeFileSync(run.list, `${chosen.join("\n")}\n`);
        Object.assign(env, { TOMIKO_MODE: "replay", [RECORD_ENV]: `@${run.list}` });
        // Run just the test files the cassettes belong to, when every one of them is known.
        const tests = chosen.map((c) => testFileOf(c));
        if (tests.every(Boolean)) files = unique(tests as string[]);
      }
      rmSync(run.log, { force: true });
      const command = testCommand(io.cwd, args.rest, files);
      const shown = Object.entries(env)
        .filter(([key]) => key !== LOG_ENV)
        .map(([key, value]) => (key === RECORD_ENV ? `${key}=(${plural(chosen.length, "cassette")})` : `${key}=${value}`));
      io.log(`  ${p.dim("▸")} ${p.dim(shown.join(" "))} ${command}`);
      io.log("");
      const started = Date.now();
      const result = await exec(command, env, { quiet: false });
      const recorded = unique(readUsage(run.log).filter((e) => e.recorded > 0).map((e) => e.file));
      io.log("");
      const took = duration(Date.now() - started);
      if (result.code === 0) io.log(`  ${p.green("✔")} Re-recorded ${p.bold(plural(recorded.length, "cassette"))} in ${took}`);
      else io.log(`  ${p.red("✖")} Tests failed while recording (exit ${result.code}). ${plural(recorded.length, "cassette")} were saved.`);

      // 4. What changed.
      if (recorded.length > 0 && !(await repoRoot(io.cwd))) {
        io.log(`    ${p.dim("Not a git repository, so there is no earlier recording to compare with.")}`);
      } else if (recorded.length > 0) {
        try {
          const source = await fromGit(io, recorded, "HEAD");
          if (typeof source !== "string") {
            io.log("");
            showComparison(io, p, source, source.pairs.map((pair) => diffCassettes(pair.path, pair.before, pair.after)), { recorded: true });
          }
        } catch (error) {
          io.log(`    ${p.dim(`Couldn't compare with git: ${error instanceof Error ? error.message : String(error)}`)}`);
        }
      }
      return result.code;
    } finally {
      run.done();
    }
  },
};
