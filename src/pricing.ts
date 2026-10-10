import type { ModelPrice, PricingTable, Usage } from "./types.js";

/**
 * Anthropic first-party list prices, USD per 1M tokens, as of October 2026.
 * Prices change: override or extend with the `pricing` option. Other providers have no
 * built-in entries; add the models you use.
 */
export const defaultPricing: PricingTable = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  // Haiku 5.5 is billed higher above 100K input tokens; this is the base tier.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Strips platform decorations: Bedrock's `anthropic.` prefix and Vertex's `@version` suffix. */
function normalizeModel(model: string): string {
  return model.replace(/^anthropic\./, "").replace(/@.*$/, "");
}

/** Exact match first, otherwise the longest table key the model id starts with. */
export function priceFor(model: string, table: PricingTable): ModelPrice | undefined {
  const id = normalizeModel(model);
  if (table[id]) return table[id];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table[best];
}

export function costOf(usage: Usage, price: ModelPrice): number {
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000
  );
}
