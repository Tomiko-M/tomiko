import { costOf, priceFor } from "./pricing.js";
import { runtime } from "./runtime.js";
import type { CassetteReport, Interaction, Mode, PricingTable, Usage } from "./types.js";
import { addUsage, emptyUsage } from "./usage.js";

interface ReportInput {
  name: string;
  file: string;
  mode: Mode;
  replayed: Interaction[];
  recorded: Interaction[];
  warnings: string[];
  saved: boolean;
  pricing: PricingTable;
}

interface Tally {
  usage: Usage;
  cost: number;
  priced: number;
  unpriced: Set<string>;
}

function tally(interactions: Interaction[], pricing: PricingTable): Tally {
  const result: Tally = { usage: emptyUsage(), cost: 0, priced: 0, unpriced: new Set() };
  for (const { meta } of interactions) {
    if (!meta.usage) continue;
    result.usage = addUsage(result.usage, meta.usage);
    const price = meta.model ? priceFor(meta.model, pricing) : undefined;
    if (price) {
      result.cost += costOf(meta.usage, price);
      result.priced++;
    } else {
      result.unpriced.add(meta.model ?? "(unknown model)");
    }
  }
  return result;
}

export function buildReport(input: ReportInput): CassetteReport {
  const all = tally([...input.replayed, ...input.recorded], input.pricing);
  const replayed = tally(input.replayed, input.pricing);
  return {
    name: input.name,
    file: input.file,
    mode: input.mode,
    replayed: input.replayed.length,
    recorded: input.recorded.length,
    usage: all.usage,
    cost: all.priced > 0 ? all.cost : null,
    savedCost: replayed.priced > 0 ? replayed.cost : null,
    unpricedModels: [...all.unpriced].sort(),
    warnings: [...input.warnings],
    saved: input.saved,
  };
}

/** Cassettes that served nothing (e.g. auto-attached to a test without LLM calls) are left out. */
export function recordReport(report: CassetteReport): void {
  if (report.replayed + report.recorded > 0 || report.warnings.length > 0) runtime.reports.push(report);
}

/** Reports of every cassette closed in this process that served at least one request, oldest first. */
export function reports(): readonly CassetteReport[] {
  return runtime.reports;
}

export function resetReports(): void {
  runtime.reports.length = 0;
}

export interface Summary {
  cassettes: number;
  replayed: number;
  recorded: number;
  usage: Usage;
  cost: number | null;
  savedCost: number | null;
  unpricedModels: string[];
  warnings: string[];
}

const sumNullable = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((acc, v) => acc + (v ?? 0), 0) : null;

export function summary(list: readonly CassetteReport[] = runtime.reports): Summary {
  return {
    cassettes: list.length,
    replayed: list.reduce((n, r) => n + r.replayed, 0),
    recorded: list.reduce((n, r) => n + r.recorded, 0),
    usage: list.reduce((u, r) => addUsage(u, r.usage), emptyUsage()),
    cost: sumNullable(list.map((r) => r.cost)),
    savedCost: sumNullable(list.map((r) => r.savedCost)),
    unpricedModels: [...new Set(list.flatMap((r) => r.unpricedModels))].sort(),
    warnings: list.flatMap((r) => r.warnings),
  };
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/** Human-readable summary, e.g. for a test runner's global teardown. */
export function formatSummary(s: Summary = summary()): string {
  const lines = [
    `tomiko · ${s.cassettes} cassette${s.cassettes === 1 ? "" : "s"} · ${s.replayed} replayed · ${s.recorded} recorded`,
    `tokens · ${tokens(s.usage.inputTokens)} in · ${tokens(s.usage.outputTokens)} out · ` +
      `${tokens(s.usage.cacheReadTokens)} cache read · ${tokens(s.usage.cacheWriteTokens)} cache write`,
  ];
  if (s.cost !== null) {
    lines.push(`cost  · ${usd(s.cost)} est. · ${usd(s.savedCost ?? 0)} saved by replay`);
  }
  if (s.unpricedModels.length > 0) lines.push(`no price for · ${s.unpricedModels.join(", ")}`);
  if (s.warnings.length > 0) lines.push(`${s.warnings.length} warning(s):`, ...s.warnings.map((w) => `  ${w}`));
  return lines.join("\n");
}
