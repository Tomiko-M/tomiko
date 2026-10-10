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
  /** globalThis.fetch as it was when tomiko first loaded. */
  native: typeof globalThis.fetch;
  dispatch?: typeof globalThis.fetch;
}

/**
 * Process-wide state lives on `globalThis` so that every copy of tomiko shares it: the ESM and
 * CJS builds, and the `tomiko/vitest` entry, which bundles its own copy of the core.
 */
const KEY = Symbol.for("tomiko.runtime");
const holder = globalThis as typeof globalThis & { [KEY]?: Runtime };
export const runtime: Runtime = (holder[KEY] ??= {
  defaults: {},
  active: undefined,
  reports: [],
  native: globalThis.fetch,
});

/**
 * The fetch tomiko installs globally while a cassette is active, also exported for clients built
 * once. It routes to whichever cassette is active at call time, so a client that captured it
 * during one test (LangChain caches its SDK client lazily, for one) keeps working in the next.
 */
export const dispatch: typeof globalThis.fetch = (runtime.dispatch ??= (input, init) => {
  if (runtime.active) return runtime.active.fetch(input, init);
  return realFetch()(input, init);
});

/** The fetch to reach the network: the current global one, unless that is tomiko's dispatcher. */
export function realFetch(): typeof globalThis.fetch {
  return globalThis.fetch === dispatch ? runtime.native : globalThis.fetch;
}

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
  globalThis.fetch = dispatch;
  return () => {
    globalThis.fetch = original;
    runtime.active = undefined;
  };
}
