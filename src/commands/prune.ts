import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { LOG_ENV, readUsage } from "../control.js";
import { plural } from "../format.js";
import { loadCassette, saveCassette } from "../store.js";
import { Spinner, padTo, width } from "../terminal.js";
import { discoverCassettes } from "../view/discover.js";
import { type Command, failure } from "./common.js";
import { approve, conventionalTestFile, execute, testCommand, testDir } from "./run.js";

interface Plan {
  /** Cassettes no test opened, or opened without using any of their requests. */
  remove: { file: string; reason: string }[];
  /** Cassettes with some requests no test used: their positions, from 0. */
  trim: { file: string; unused: number[]; size: number }[];
}

const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

/** Removes directories left empty, up to and including the `__cassettes__` directory. */
function removeEmptyParents(file: string): void {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    if (basename(dir) === "__cassettes__") return;
  }
}

export const prune: Command = {
  name: "prune",
  usage: ["prune [paths...] [options] [-- test command]"],
  summary: "Remove cassettes and requests your tests no longer use",
  description: (p) => [
    "Replays your tests, offline and for free, noting which recordings they use. Then it removes",
    "the cassettes no test opened (a test deleted or renamed) and the requests no test asked for",
    "(a prompt that changed, a step an agent no longer takes).",
    "",
    "It only trusts a run in which every test passed. Skipped tests count as not using their",
    `cassettes, so prune with the whole suite running. Paths limit where it removes anything.`,
    "",
    `  ${p.accent("npx tomiko prune --dry-run")}   ${p.dim("see what would go")}`,
  ],
  flags: {
    "dry-run": { type: "boolean", help: "Show what would be removed, and remove nothing" },
    yes: { type: "boolean", short: "-y", help: "Don't ask before removing" },
  },
  runs: true,
  async run(args, io, p) {
    const scratch = mkdtempSync(join(tmpdir(), "tomiko-prune-"));
    const log = join(scratch, "usage.jsonl");
    try {
      const scope = args.positional.map((path) => resolve(io.cwd, path));
      let cassettes;
      try {
        cassettes = await discoverCassettes(scope, io.cwd);
      } catch (error) {
        return failure(io, p, error instanceof Error ? error.message : String(error));
      }
      if (cassettes.length === 0) {
        io.log(`  ${p.green("✔")} No cassettes to prune${args.positional.length > 0 ? ` in ${args.positional.join(", ")}` : ""}.`);
        return 0;
      }

      const command = testCommand(io.cwd, args.rest);
      const spinner = new Spinner(io.stream, p, io.animate).start(`Replaying your tests to see which recordings they use… ${p.dim(command)}`);
      const result = await (io.exec ?? execute(io.cwd))(command, { TOMIKO_MODE: "replay", [LOG_ENV]: log }, { quiet: true, cwd: testDir(io.cwd, args.rest) });
      await spinner.stop();
      if (result.code !== 0) {
        io.error(`  ${p.red("✖")} ${command} failed (exit ${result.code}), so tomiko can't tell which recordings your tests need.`);
        const tail = result.output.trimEnd().split("\n").slice(-15);
        if (tail.join("").trim()) io.error(tail.map((line) => `    ${p.dim(line)}`).join("\n"));
        io.error(`    Fix the failing tests, or re-record what changed with ${p.bold("npx tomiko record --stale")}, then prune again.`);
        return 1;
      }

      const used = new Map<string, Set<number>>();
      for (const entry of readUsage(log)) {
        const set = used.get(entry.file) ?? new Set();
        for (const i of entry.used) set.add(i);
        used.set(entry.file, set);
      }
      if (used.size === 0) {
        return failure(io, p, `${command} opened no cassettes. Is it the command that runs your tests? Pass yours after --.`);
      }

      const plan: Plan = { remove: [], trim: [] };
      for (const { file, data } of cassettes) {
        const served = used.get(file);
        if (!served || served.size === 0) {
          const test = conventionalTestFile(file);
          const reason = served ? "opened, but none of its requests used" : test && !existsSync(test) ? "its test file is gone" : "no test used it";
          plan.remove.push({ file, reason });
        } else if (served.size < data.interactions.length) {
          plan.trim.push({ file, size: data.interactions.length, unused: data.interactions.map((_, i) => i).filter((i) => !served.has(i)) });
        }
      }
      const requests = plan.trim.reduce((n, t) => n + t.unused.length, 0);
      const opened = cassettes.length - plan.remove.filter((r) => !used.has(r.file)).length;
      if (plan.remove.length + plan.trim.length === 0) {
        io.log(`  ${p.green("✔")} Nothing to prune: your tests use every request in ${plural(cassettes.length, "cassette")}.`);
        return 0;
      }

      io.log(`  ${p.green("✔")} Replayed your tests: they use ${opened} of ${plural(cassettes.length, "cassette")}.`);
      io.log("");
      const shown = (file: string) => relative(io.cwd, file) || file;
      const pad = Math.max(...[...plan.remove, ...plan.trim].map((x) => width(shown(x.file))));
      for (const r of plan.remove) io.log(`    ${p.red("−")} ${padTo(shown(r.file), pad)}  ${p.dim(r.reason)}`);
      for (const t of plan.trim) {
        io.log(`    ${p.yellow("~")} ${padTo(shown(t.file), pad)}  ${p.dim(`${t.unused.length} of ${plural(t.size, "request")} unused: #${t.unused.map((i) => i + 1).join(", #")}`)}`);
      }
      io.log("");

      const what = [
        plan.remove.length > 0 ? plural(plan.remove.length, "cassette") : "",
        requests > 0 ? plural(requests, "request") : "",
      ].filter(Boolean).join(" and ");
      if (args.flags["dry-run"]) {
        io.log(`  ${p.dim(`Dry run: nothing removed. Without --dry-run, ${what} would go.`)}`);
        return 0;
      }
      if (!(await approve(io, p, args.flags.yes === true, `Remove ${what}?`))) return 1;

      let freed = 0;
      for (const r of plan.remove) {
        freed += statSync(r.file).size;
        unlinkSync(r.file);
        removeEmptyParents(r.file);
      }
      for (const t of plan.trim) {
        const before = statSync(t.file).size;
        const data = (await loadCassette(t.file))!;
        const unused = new Set(t.unused);
        await saveCassette(t.file, { ...data, interactions: data.interactions.filter((_, i) => !unused.has(i)) });
        freed += before - statSync(t.file).size;
      }
      io.log(`  ${p.green("✔")} Removed ${p.bold(what)} ${p.dim(`· ${bytes(freed)}`)}`);
      return 0;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

