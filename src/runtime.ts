import { AsyncLocalStorage } from "node:async_hooks";
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
  /** The cassette name each file was opened under in this process, to catch two names sharing one file. */
  files?: Map<string, string>;
  /** Set while tomiko itself talks to an MCP server it records: those requests skip the cassette. */
  bypass?: AsyncLocalStorage<true>;
  /** The MCP SDK's client has been taught to record its servers. */
  mcpPatched?: boolean;
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
  if (runtime.active && !bypassing()) return runtime.active.fetch(input, init);
  return realFetch()(input, init);
});

const bypass = (runtime.bypass ??= new AsyncLocalStorage<true>());

/** Runs `fn` with its requests, and everything they set off, kept out of any cassette. */
export function bypassed<T>(fn: () => T): T {
  return bypass.run(true, fn);
}

export const bypassing = (): boolean => bypass.getStore() === true;

/** The fetch to reach the network: the current global one, unless that is tomiko's dispatcher. */
export function realFetch(): typeof globalThis.fetch {
  return globalThis.fetch === dispatch ? runtime.native : globalThis.fetch;
}

/**
 * `secrets: "redact"` on one cassette keeps the values and formats `configure()` allowed: lists
 * add up, the rest is overridden.
 */
function mergeSecrets(base: TomikoOptions["secrets"], extra: TomikoOptions["secrets"]): TomikoOptions["secrets"] {
  if (extra === undefined) return base;
  if (extra === false || base === undefined || base === false) return extra;
  const a = typeof base === "string" ? { action: base } : base;
  const b = typeof extra === "string" ? { action: extra } : extra;
  return { ...a, ...b, allow: [...(a.allow ?? []), ...(b.allow ?? [])], patterns: [...(a.patterns ?? []), ...(b.patterns ?? [])] };
}

export function mergeOptions(base: TomikoOptions, extra: TomikoOptions = {}): TomikoOptions {
  const merged: TomikoOptions = { ...base, ...extra, pricing: { ...base.pricing, ...extra.pricing } };
  const secrets = mergeSecrets(base.secrets, extra.secrets);
  if (secrets !== undefined) merged.secrets = secrets;
  return merged;
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
