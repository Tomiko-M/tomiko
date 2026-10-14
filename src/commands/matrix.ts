import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { diffCassettes, sideOf } from "../compare.js";
import { LOG_ENV, MODEL_ENV, SHADOW_ENV } from "../control.js";
import { duration, money, plural, shortModel } from "../format.js";
import { costOf, defaultPricing, priceFor } from "../pricing.js";
import { type Paint, Spinner, width } from "../terminal.js";
import type { CassetteFile } from "../types.js";
import { extractUsage } from "../usage.js";
import { discoverCassettes } from "../view/discover.js";
import { type Command, failure, type Io } from "./common.js";
import { approve, execute, jsonReport, readReport, testCommand, type TestResults } from "./run.js";

interface Row {
  model: string;
  /** The recordings as they are, not a trial. */
  now: boolean;
  tests?: TestResults;
  /** Exit code of the run, when there is no report. */
  code: number;
  cost: number | null;
  durationMs: number;
  /** Cassettes whose behavior (or only wording) differs from the recordings as they are. */
  behavior: number;
  wording: number;
  compared: number;
}

const slug = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, "-");

/** Cost of the recorded requests at `model`'s price, or null when it has none. Judges keep theirs. */
function costAt(files: CassetteFile[], model: string): number | null {
  const price = priceFor(model, defaultPricing);
  if (!price) return null;
  let total = 0;
  for (const file of files) {
    for (const interaction of file.interactions) {
      if (interaction.meta.judge) continue;
      const { usage } = extractUsage(interaction.response.body, interaction.response.headers);
      if (usage) total += costOf(usage, price);
    }
  }
  return total;
}

function totals(files: CassetteFile[]): { cost: number | null; durationMs: number; models: Map<string, number> } {
  let cost = 0;
  let priced = 0;
  let durationMs = 0;
  const models = new Map<string, number>();
  for (const file of files) {
    for (const interaction of file.interactions) {
      const side = sideOf(interaction, defaultPricing);
      durationMs += side.durationMs;
      if (side.cost !== null) {
        cost += side.cost;
        priced++;
      }
      if (side.model && !interaction.meta.judge) models.set(side.model, (models.get(side.model) ?? 0) + 1);
    }
  }
  return { cost: priced > 0 ? cost : null, durationMs, models };
}

const passedAll = (row: Row) => (row.tests ? row.tests.failed.length === 0 && row.tests.passed > 0 : row.code === 0);

function testsCell(p: Paint, row: Row): string {
  if (!row.tests) return row.code === 0 ? p.green("passed") : p.red(`failed (exit ${row.code})`);
  const { passed, total } = row.tests;
  const text = `${passed}/${total}`;
  return passed === total ? p.green(`${text} ✔`) : passed >= total * 0.8 ? p.yellow(text) : p.red(text);
}

function ratio(p: Paint, cost: number | null, now: number | null): string {
  if (cost === null || now === null || now === 0 || cost === now) return "";
  return cost > now ? p.yellow(`×${(cost / now).toFixed(1)}`) : p.green(`÷${(now / cost).toFixed(1)}`);
}

function table(p: Paint, rows: Row[], now: Row): string[] {
  const cells = rows.map((row) => [
    row.now ? `${p.bold(shortModel(row.model))} ${p.dim("now")}` : p.bold(shortModel(row.model)),
    testsCell(p, row),
    row.cost === null ? p.dim("no price") : money(row.cost),
    row.now ? "" : ratio(p, row.cost, now.cost),
    duration(row.durationMs),
    row.now ? p.dim("as recorded") : row.compared === 0 ? p.dim("—") : row.behavior > 0 ? p.yellow(`changed in ${row.behavior} of ${row.compared}`) : row.wording > 0 ? p.cyan(`same, new wording in ${row.wording}`) : p.green("the same"),
  ]);
  const head = ["model", "tests", "cost a run", "", "time", "behavior"];
  const visible = (s: string) => width(s.replace(/\x1b\[[0-9;]*m/g, ""));
  const widths = head.map((h, i) => Math.max(visible(h), ...cells.map((c) => visible(c[i]!))));
  const line = (row: string[]) => `  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - visible(cell) + 3))).join("").trimEnd()}`;
  return [line(head.map((h) => p.dim(h))), ...cells.map(line)];
}

function verdict(p: Paint, rows: Row[], now: Row): string {
  const passing = rows.filter((r) => passedAll(r) && r.cost !== null).sort((a, b) => a.cost! - b.cost!);
  const best = passing[0];
  const cheapest = rows.filter((r) => r.cost !== null).sort((a, b) => a.cost! - b.cost!)[0];
  if (!best) return `${p.yellow("◆")} No model passes every test.${passedAll(now) ? "" : " Not even the recordings as they are: fix those first."}`;
  if (best.now) {
    const note =
      cheapest && !cheapest.now && cheapest.cost! < now.cost!
        ? ` ${shortModel(cheapest.model)} costs ${(now.cost! / cheapest.cost!).toFixed(1)}× less but fails ${plural(cheapest.tests?.failed.length ?? 1, "test")}.`
        : "";
    return `${p.accent("◆")} Nothing cheaper passes every test: ${p.bold(shortModel(now.model))}, what you use now, stays the best buy.${note}`;
  }
  const factor = now.cost && best.cost ? now.cost / best.cost : undefined;
  const saving = factor && factor > 1 ? ` at ${factor.toFixed(1)}× less than now` : factor && factor < 1 ? `, though it costs ${(1 / factor).toFixed(1)}× more` : "";
  return `${p.accent("◆")} ${p.bold(shortModel(best.model))} passes every test${saving}.`;
}

function failures(p: Paint, rows: Row[]): string[] {
  const pad = Math.max(...rows.map((r) => shortModel(r.model).length));
  return rows
    .filter((r) => r.tests && r.tests.failed.length > 0)
    .map((r) => {
      const shown = r.tests!.failed.slice(0, 2).join(", ") + (r.tests!.failed.length > 2 ? ` and ${r.tests!.failed.length - 2} more` : "");
      return `  ${p.red("✖")} ${shortModel(r.model).padEnd(pad)}  ${p.dim(shown)}`;
    });
}

export const matrix: Command = {
  name: "matrix",
  usage: ["matrix --models <a,b,…> [paths...] [options] [-- test command]"],
  summary: "Run your tests on other models: which pass, and what they cost",
  description: (p) => [
    "Runs your tests against other models of the same API, live, and lays them side by side",
    "with what you use now: how many tests pass, what a run costs, how long it takes, and in",
    "how many cassettes the model behaves differently. Your cassettes are left as they are.",
    "",
    `  ${p.accent("npx tomiko matrix --models gpt-5.4-mini,gpt-5-nano")}`,
    "",
    "Asks before spending anything, with an estimate from the current recordings. Tests that",
    "assert a model by name fail on any other, as they should.",
  ],
  flags: {
    models: { type: "string", value: "list", help: "The models to try, separated by commas" },
    yes: { type: "boolean", short: "-y", help: "Don't ask before spending tokens" },
    "max-cost": { type: "string", value: "usd", help: "Stop if the estimate is above this many dollars" },
    keep: { type: "boolean", help: "Keep each model's cassettes in .tomiko/matrix/<model>" },
  },
  runs: true,
  async run(args, io: Io, p) {
    const models = [...new Set(String(args.flags.models ?? "").split(",").map((m) => m.trim()).filter(Boolean))];
    if (models.length === 0) return failure(io, p, `Name the models to try: ${p.bold("--models gpt-5.4-mini,gpt-5-nano")}`);
    const maxCost = typeof args.flags["max-cost"] === "string" ? Number(args.flags["max-cost"].replace(/^\$/, "")) : undefined;
    if (maxCost !== undefined && !(maxCost >= 0)) return failure(io, p, "--max-cost takes an amount in dollars, like 0.50");

    const found = await discoverCassettes(args.positional.map((path) => resolve(io.cwd, path)), io.cwd).catch((e: unknown) => e as Error);
    if (found instanceof Error) return failure(io, p, found.message);
    if (found.length === 0) return failure(io, p, "No cassettes yet. Record your tests first, then compare models against them.");
    const files = found.map((f) => f.data);
    const base = totals(files);
    const nowModel = [...base.models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "now";
    const requests = files.reduce((n, f) => n + f.interactions.filter((i) => !i.meta.judge).length, 0);

    io.log(`  ${p.bold("tomiko matrix")}  ${p.dim(`${plural(found.length, "cassette")} · ${plural(requests, "request")} · ${plural(models.length, "model")}`)}`);
    io.log("");
    const estimates = models.map((model) => ({ model, cost: costAt(files, model) }));
    const total = estimates.reduce((sum, e) => sum + (e.cost ?? 0), 0);
    io.log(`  ${p.accent("●")} About ${p.bold(money(total))} to run your tests on ${plural(models.length, "model")}, judging by the current recordings:`);
    const pad = Math.max(...models.map((m) => shortModel(m).length));
    for (const e of estimates) io.log(`      ${shortModel(e.model).padEnd(pad)}  ${e.cost === null ? p.dim("no price, so not counted") : money(e.cost)}`);
    io.log("");
    if (maxCost !== undefined && total > maxCost) return failure(io, p, `That is more than --max-cost ${args.flags["max-cost"] as string}. Nothing was run.`);
    if (!(await approve(io, p, args.flags.yes === true, `Run your tests on ${plural(models.length, "model")}?`))) return 1;

    const exec = io.exec ?? execute(io.cwd);
    const scratch = mkdtempSync(join(tmpdir(), "tomiko-matrix-"));
    try {
      const run = async (label: string, env: Record<string, string>, report: string) => {
        const spinner = new Spinner(io.stream, p, io.animate).start(label);
        const command = testCommand(io.cwd, args.rest, [], jsonReport(io.cwd, args.rest, report));
        const result = await exec(command, env, { quiet: true });
        await spinner.stop();
        return { code: result.code, tests: readReport(report) };
      };

      // The recordings as they are: replayed, so free.
      const baseline = await run("Replaying your tests as recorded…", { TOMIKO_MODE: "replay" }, join(scratch, "now.json"));
      const now: Row = { model: nowModel, now: true, ...baseline, cost: base.cost, durationMs: base.durationMs, behavior: 0, wording: 0, compared: 0 };
      const rows: Row[] = [now];
      for (const [i, model] of models.entries()) {
        const shadow = join(scratch, slug(model));
        const result = await run(
          `Running your tests on ${p.bold(model)}… ${p.dim(`${i + 1}/${models.length}`)}`,
          { TOMIKO_MODE: "record", [MODEL_ENV]: model, [SHADOW_ENV]: shadow, [LOG_ENV]: join(scratch, `${slug(model)}.log`) },
          join(scratch, `${slug(model)}.json`),
        );
        const trial = await discoverCassettes([shadow], shadow).catch(() => []);
        const t = totals(trial.map((f) => f.data));
        let behavior = 0;
        let wording = 0;
        for (const cassette of trial) {
          const own = found.find((f) => relative(io.cwd, f.file) === cassette.path);
          if (!own) continue;
          const impact = diffCassettes(cassette.path, own.data, cassette.data).impact;
          if (impact === "behavior") behavior++;
          else if (impact === "wording") wording++;
        }
        rows.push({ model, now: false, ...result, cost: t.cost, durationMs: t.durationMs, behavior, wording, compared: trial.length });
        if (args.flags.keep) cpSync(shadow, join(io.cwd, ".tomiko", "matrix", slug(model)), { recursive: true });
      }

      for (const line of table(p, rows, now)) io.log(line);
      const failed = failures(p, rows);
      if (failed.length > 0) io.log(["", ...failed].join("\n"));
      io.log("");
      io.log(`  ${verdict(p, rows, now)}`);
      if (args.flags.keep) io.log(`    ${p.dim("Each model's cassettes are in .tomiko/matrix; see them with")} ${p.bold("npx tomiko view .tomiko/matrix")}`);
      return 0;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};
