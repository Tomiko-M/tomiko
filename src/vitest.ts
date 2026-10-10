import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { Cassette } from "./cassette.js";
import { TomikoError } from "./errors.js";
import { cassette } from "./index.js";
import { matchers, type TomikoMatchers } from "./matchers.js";
import { activate, mergeOptions, runtime } from "./runtime.js";
import type { TomikoOptions } from "./types.js";

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends TomikoMatchers<R> {}
}

// Importing tomiko/vitest is enough to use the matchers.
expect.extend(matchers);

interface CassetteLocation {
  dir: string;
  name: string;
}

/**
 * Where a test's cassette lives. By default it sits next to the test file, like Vitest snapshots:
 * `test/__cassettes__/booking.test.ts/<describe>/<test>.json`. With an explicit `dir`, the test
 * file's path relative to the working directory is kept instead: `<dir>/test/booking.test.ts/...`.
 */
export function locateCassette(testPath: string, testName: string, dir?: string): CassetteLocation {
  // Vitest joins describe blocks and the test name with " > "; each becomes a directory level.
  const segments = testName.split(" > ").map((s) => s.replaceAll("/", "-"));
  if (dir !== undefined) return { dir, name: [relative(process.cwd(), testPath), ...segments].join("/") };
  return { dir: join(dirname(testPath), "__cassettes__"), name: [basename(testPath), ...segments].join("/") };
}

function currentTest(caller: string): { testPath: string; testName: string } {
  const { testPath, currentTestName } = expect.getState();
  if (!testPath || !currentTestName) {
    throw new TomikoError(`${caller}() must be called while a test is running.`);
  }
  return { testPath, testName: currentTestName };
}

function locateCurrent(caller: string, options: TomikoOptions, suffix?: string): CassetteLocation {
  const { testPath, testName } = currentTest(caller);
  const location = locateCassette(testPath, testName, options.dir ?? runtime.defaults.dir);
  if (suffix) location.name += `/${suffix.replaceAll("/", "-")}`;
  return location;
}

type Body<T> = (cassette: Cassette) => T | Promise<T>;

/**
 * Like `cassette()`, named after the running test. Pass a suffix to use more than one cassette in
 * the same test: `useCassette("second turn", fn)`.
 */
export function useCassette<T>(fn: Body<T>, options?: TomikoOptions): Promise<T>;
export function useCassette<T>(suffix: string, fn: Body<T>, options?: TomikoOptions): Promise<T>;
export function useCassette<T>(
  first: string | Body<T>,
  second?: Body<T> | TomikoOptions,
  third?: TomikoOptions,
): Promise<T> {
  const [suffix, fn, options = {}] =
    typeof first === "string" ? [first, second as Body<T>, third] : [undefined, first, second as TomikoOptions];
  const { dir, name } = locateCurrent("useCassette", options, suffix);
  return cassette(name, fn, { ...options, dir });
}

/**
 * Gives every test in scope its own cassette, named after the test. Call it at the top of a
 * setup file to cover the whole suite, or inside a `describe` block to cover just that block.
 * A test that makes no requests leaves no file behind.
 */
export function setupCassettes(options: TomikoOptions = {}): void {
  let current: { cassette: Cassette; deactivate: () => void } | undefined;

  beforeEach(async () => {
    const { dir, name } = locateCurrent("setupCassettes", options);
    if (runtime.active) {
      throw new TomikoError(
        `Cannot attach a cassette to "${name}": cassette "${runtime.active.name}" is still active. ` +
          `setupCassettes() does not support concurrent tests or useCassette() inside the same test.`,
      );
    }
    const opened = await Cassette.open(name, mergeOptions(runtime.defaults, { ...options, dir }));
    current = { cassette: opened, deactivate: activate(opened) };
  });

  afterEach(async () => {
    if (!current) return;
    const { cassette: opened, deactivate } = current;
    current = undefined;
    deactivate();
    await opened.close();
  });
}

/**
 * The cassette attached to the running test by setupCassettes() (or an enclosing useCassette()),
 * for assertions: `expect(currentCassette()).toHaveCalledTool("search")`.
 */
export function currentCassette(): Cassette {
  if (!runtime.active) {
    throw new TomikoError(
      "No cassette is active. currentCassette() works inside tests covered by setupCassettes() or inside useCassette().",
    );
  }
  return runtime.active as Cassette;
}
