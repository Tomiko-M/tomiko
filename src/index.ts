import { Cassette } from "./cassette.js";
import { activate, assertNoActiveCassette, mergeOptions, runtime } from "./runtime.js";
import type { TomikoOptions } from "./types.js";

export { Cassette, resolveMode } from "./cassette.js";
export { CassetteNotFoundError, NestedCassetteError, RequestMismatchError, TomikoError } from "./errors.js";
export { fault, type Fault, type FaultName, type FaultRequest, type FaultTarget } from "./faults.js";
export { matchers, type RequestCount, type TomikoMatchers } from "./matchers.js";
export { defaultPricing, costOf, priceFor } from "./pricing.js";
export { formatSummary, reports, resetReports, summary, type Summary } from "./report.js";
export type * from "./types.js";

/** Sets defaults for every cassette opened afterwards, e.g. in a test setup file. */
export function configure(options: TomikoOptions): void {
  runtime.defaults = mergeOptions(runtime.defaults, options);
}

export function resetConfig(): void {
  runtime.defaults = {};
}

/**
 * Opens a cassette without touching `globalThis.fetch`. Pass `cassette.fetch` to your client
 * (e.g. `new Anthropic({ fetch: c.fetch })`) and call `close()` when done to save it.
 */
export function openCassette(name: string, options?: TomikoOptions): Promise<Cassette> {
  return Cassette.open(name, mergeOptions(runtime.defaults, options));
}

/**
 * Runs `fn` with `globalThis.fetch` routed through the named cassette, then saves any new
 * recordings. Clients that captured `fetch` before this call should use the exported `fetch`.
 */
export async function cassette<T>(
  name: string,
  fn: (cassette: Cassette) => T | Promise<T>,
  options?: TomikoOptions,
): Promise<T> {
  assertNoActiveCassette(name);
  const c = await openCassette(name, options);
  const deactivate = activate(c);

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn(c) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    deactivate();
  }

  try {
    await c.close();
  } catch (closeError) {
    // A failing test is the more useful error to surface.
    throw outcome.ok ? closeError : outcome.error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

const nativeFetch = globalThis.fetch;

/**
 * A stable fetch that routes to whichever cassette is active and to the real network otherwise.
 * Hand it to clients created once at module load: `new Anthropic({ fetch })`.
 */
export const fetch: typeof globalThis.fetch = (input, init) => {
  if (runtime.active) return runtime.active.fetch(input, init);
  const current = globalThis.fetch === fetch ? nativeFetch : globalThis.fetch;
  return current(input, init);
};
