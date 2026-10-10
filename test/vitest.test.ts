import { existsSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { locateCassette, setupCassettes, useCassette } from "../src/vitest.js";
import { ANTHROPIC_URL, fakeApi, json, offline, tmpDir } from "./helpers.js";

const thisFile = fileURLToPath(import.meta.url);
const originalFetch = globalThis.fetch;
const send = (body: unknown, fetchImpl: typeof fetch = globalThis.fetch) =>
  fetchImpl(ANTHROPIC_URL, { method: "POST", body: JSON.stringify(body) });

/** The cassette directory tomiko keeps for this test file under an explicit `dir`. */
const underDir = (dir: string, ...segments: string[]) => join(dir, relative(process.cwd(), thisFile), ...segments);

describe("locateCassette", () => {
  it("puts cassettes next to the test file, one directory level per describe block", () => {
    expect(locateCassette("/repo/test/booking.test.ts", "agent > books a table")).toEqual({
      dir: "/repo/test/__cassettes__",
      name: "booking.test.ts/agent/books a table",
    });
  });

  it("keeps the test file's relative path under an explicit dir", () => {
    const testPath = join(process.cwd(), "test", "booking.test.ts");
    expect(locateCassette(testPath, "books a table", "/cassettes")).toEqual({
      dir: "/cassettes",
      name: "test/booking.test.ts/books a table",
    });
  });

  it("does not let slashes in test names create directories", () => {
    expect(locateCassette("/repo/a.test.ts", "GET /v1/models").name).toBe("a.test.ts/GET -v1-models");
  });
});

describe("useCassette", () => {
  const dir = tmpDir();

  it("names the cassette after the test", async () => {
    await useCassette(() => send({ a: 1 }), { dir, fetch: fakeApi(() => json({ ok: true })) });
    expect(existsSync(underDir(dir, "useCassette", "names-the-cassette-after-the-test.json"))).toBe(true);
  });

  it("takes a suffix for more than one cassette per test", async () => {
    const api = fakeApi(() => json({ ok: true }));
    await useCassette("first turn", () => send({ turn: 1 }), { dir, fetch: api });
    await useCassette("second turn", () => send({ turn: 2 }), { dir, fetch: api });
    const base = underDir(dir, "useCassette", "takes-a-suffix-for-more-than-one-cassette-per-test");
    expect(existsSync(join(base, "first-turn.json"))).toBe(true);
    expect(existsSync(join(base, "second-turn.json"))).toBe(true);
  });

  it("stores cassettes next to the test file by default", async () => {
    const home = join(dirname(thisFile), "__cassettes__", "vitest.test.ts");
    try {
      await useCassette(() => send({ b: 2 }), { fetch: fakeApi(() => json({ ok: true })) });
      expect(existsSync(join(home, "useCassette", "stores-cassettes-next-to-the-test-file-by-default.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      try {
        rmdirSync(dirname(home)); // only succeeds when nothing else is in there
      } catch {}
    }
  });

  let outside: unknown;
  try {
    void useCassette(() => {});
  } catch (error) {
    outside = error;
  }
  it("refuses to run outside a test", () => {
    expect(String(outside)).toContain("useCassette() must be called while a test is running");
  });
});

const shared = tmpDir();
const api = fakeApi((body) => json({ answer: `re: ${body.q}` }));
afterAll(() => rmSync(shared, { recursive: true, force: true }));

describe("flow", () => {
  setupCassettes({ dir: shared, fetch: api });

  it("asks", async () => {
    expect(await (await send({ q: "hello" })).json()).toEqual({ answer: "re: hello" });
  });

  it("idles", () => {});
});

// Same describe and test names as above, so these tests resolve to the cassettes recorded there.
describe("flow", () => {
  setupCassettes({ dir: shared, mode: "replay", fetch: offline });

  it("asks", async () => {
    // A fresh copy of the module, as when ESM and CJS builds are both loaded, sees the same cassette.
    vi.resetModules();
    const copy = await import("../src/index.js");
    expect(await (await send({ q: "hello" }, copy.fetch)).json()).toEqual({ answer: "re: hello" });
    expect(api.calls).toHaveLength(1);
  });

  it("idles", () => {});
});

describe("after setupCassettes", () => {
  it("saved cassettes only for tests that made requests", () => {
    expect(existsSync(underDir(shared, "flow", "asks.json"))).toBe(true);
    expect(existsSync(underDir(shared, "flow", "idles.json"))).toBe(false);
  });

  it("left globalThis.fetch alone outside the block", () => {
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
