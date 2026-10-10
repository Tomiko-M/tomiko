import { NestedCassetteError } from "./errors.js";
import type { CassetteReport, TomikoOptions } from "./types.js";

interface ActiveCassette {
  readonly name: string;
  readonly fetch: typeof globalThis.fetch;
}

interface Runtime {
  defaults: TomikoOptions;
  active: ActiveCassette | undefined;
  reports: CassetteReport[];
}

/**
 * Process-wide state lives on `globalThis` so that every copy of tomiko shares it: the ESM and
 * CJS builds, and the `tomiko/vitest` entry, which bundles its own copy of the core.
 */
const KEY = Symbol.for("tomiko.runtime");
const holder = globalThis as typeof globalThis & { [KEY]?: Runtime };
export const runtime: Runtime = (holder[KEY] ??= { defaults: {}, active: undefined, reports: [] });

export function mergeOptions(base: TomikoOptions, extra: TomikoOptions = {}): TomikoOptions {
  return { ...base, ...extra, pricing: { ...base.pricing, ...extra.pricing } };
}

export function assertNoActiveCassette(name: string): void {
  if (runtime.active) throw new NestedCassetteError(runtime.active.name, name);
}

/** Routes `globalThis.fetch` through the cassette. Returns the function that undoes it. */
export function activate(cassette: ActiveCassette): () => void {
  assertNoActiveCassette(cassette.name);
  const original = globalThis.fetch;
  runtime.active = cassette;
  globalThis.fetch = cassette.fetch;
  return () => {
    globalThis.fetch = original;
    runtime.active = undefined;
  };
}
