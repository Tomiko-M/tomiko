import type { ModelPrice, PricingTable, Usage } from "./types.js";

/**
 * List prices, USD per 1M tokens, standard tier, as of October 2026. Models with tiered pricing
 * (higher rates above a context length) are listed at their base tier. Prices change, and only
 * models whose prices could be confirmed are listed: override or extend with the `pricing` option.
 */
export const defaultPricing: PricingTable = {
  // Anthropic
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
  // Haiku 5.5 is billed higher above 100K input tokens.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },

  // OpenAI. Caching is automatic and writing to the cache costs nothing extra. GPT-5.5 and
  // GPT-5.4 are billed higher above about 270K input tokens.
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  "o3-pro": { input: 20, output: 80 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },

  // Google Gemini. Thinking tokens are billed as output. Pro models are billed higher above
  // 200K input tokens; cache storage is billed by the hour and not counted here.
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
};

/** Strips platform decorations: Bedrock's `anthropic.` and region prefixes, Vertex's `@version`, Gemini's `models/`. */
function normalizeModel(model: string): string {
  return model
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\.|^models\//, "")
    .replace(/@.*$/, "");
}

/**
 * What may follow a model id in a snapshot of it: a date or build (`-20251001`, `-2025-08-07`,
 * `-001`), a platform version (`-v1:0`), `-latest`, `-preview` or `-exp`. A short number is a
 * model of its own: `claude-opus-5-5` is not a snapshot of `claude-opus-5`.
 */
const SNAPSHOT = /^-(?:\d{3,}|v\d|latest\b|preview\b|exp\b)/;

/**
 * Exact match first, otherwise the longest key the model id is a snapshot of: `gpt-5-2025-08-07`,
 * `claude-haiku-4-5-20251001` or `gemini-3-pro-preview` have their model's price, while a model of
 * its own (`gpt-5.6`, `gpt-5.4-pro`, `o3-deep-research`) gets none rather than a wrong one.
 */
export function priceFor(model: string, table: PricingTable): ModelPrice | undefined {
  const id = normalizeModel(model);
  if (table[id]) return table[id];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && SNAPSHOT.test(id.slice(key.length)) && (best === undefined || key.length > best.length)) best = key;
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
