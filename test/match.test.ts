import { describe, expect, it } from "vitest";
import { canonical, diff, formatDiff, similarity, stripPaths } from "../src/match.js";

const prompt = (system: string, extra: object = {}) => ({
  model: "m",
  system,
  messages: [{ role: "user", content: "Book a table for two at seven tonight please" }],
  ...extra,
});

const LONG = "You are a concise assistant that books tables at a small family restaurant near the river in Lisbon.";

describe("similarity", () => {
  it("is 1 for identical values and stays high for a one-word prompt edit", () => {
    expect(similarity(prompt(LONG), prompt(LONG))).toBe(1);
    const edited = similarity(prompt(LONG), prompt(LONG.replace("concise", "friendly")));
    expect(edited).toBeGreaterThan(0.9);
    expect(edited).toBeLessThan(1);
  });

  it("drops sharply when the structure changes", () => {
    const a = prompt(LONG);
    const b = { ...prompt(LONG), messages: [{ role: "user", content: "Cancel my order" }], tools: [{ name: "cancel" }] };
    expect(similarity(a, b)).toBeLessThan(0.8);
  });
});

describe("stripPaths", () => {
  it("removes nested and wildcard paths without mutating the input", () => {
    const body = { metadata: { user_id: "u", keep: 1 }, messages: [{ a: 1, cache_control: {} }, { a: 2, cache_control: {} }] };
    const stripped = stripPaths(body, ["metadata.user_id", "messages.*.cache_control"]);
    expect(stripped).toEqual({ metadata: { keep: 1 }, messages: [{ a: 1 }, { a: 2 }] });
    expect(body.messages[0]).toHaveProperty("cache_control");
  });

  it("removes array elements by wildcard without skipping any", () => {
    expect(stripPaths({ list: [1, 2, 3] }, ["list.*"])).toEqual({ list: [] });
  });
});

describe("diff", () => {
  it("shows only the changed words of a long string", () => {
    const text = formatDiff(diff(prompt(LONG), prompt(LONG.replace("concise", "friendly"))));
    expect(text).toBe('  ~ system: "You are a [-concise-]{+friendly+} assistant that books tables…"');
  });

  it("reports added, removed and changed leaves", () => {
    const text = formatDiff(diff({ a: 1, b: 2 }, { a: 3, c: [] }));
    expect(text.split("\n").sort()).toEqual(["  + c: []", "  - b: 2", "  ~ a: 1 → 3"]);
  });

  it("caps the number of lines", () => {
    const before = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(formatDiff(diff(before, {}), 5)).toContain("… and 15 more");
  });

  it("canonicalizes key order", () => {
    expect(canonical({ b: 1, a: { d: 1, c: 2 } })).toBe(canonical({ a: { c: 2, d: 1 }, b: 1 }));
  });
});
