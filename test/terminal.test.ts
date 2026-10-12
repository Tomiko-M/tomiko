import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { formatSummary, printSummary, type Summary } from "../src/index.js";
import { animationEnabled, cassetteFrame, colorEnabled, paint, Spinner } from "../src/terminal.js";

const tty = { isTTY: true, write: () => true };
const pipe = { isTTY: false, write: () => true };

describe("colorEnabled", () => {
  it("needs a terminal, and follows NO_COLOR, FORCE_COLOR and TERM=dumb", () => {
    expect(colorEnabled(tty, {})).toBe(true);
    expect(colorEnabled(pipe, {})).toBe(false);
    expect(colorEnabled(tty, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled(tty, { NO_COLOR: "" })).toBe(true); // NO_COLOR counts only when non-empty
    expect(colorEnabled(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(colorEnabled(tty, { TERM: "dumb" })).toBe(false);
  });

  it("keeps animation out of CI logs and pipes", () => {
    expect(animationEnabled(tty, {})).toBe(true);
    expect(animationEnabled(tty, { CI: "true" })).toBe(false);
    expect(animationEnabled(pipe, { FORCE_COLOR: "1" })).toBe(false);
  });
});

describe("paint", () => {
  it("adds nothing when disabled", () => {
    const p = paint(false);
    expect(p.accent(p.bold("x")) + p.link("y", "https://z")).toBe("xy");
  });

  it("uses truecolor only where the terminal says it can", () => {
    expect(paint(true, { COLORTERM: "truecolor" }).accent("x")).toBe("\x1b[38;2;240;136;91mx\x1b[39m");
    expect(paint(true, {}).accent("x")).toBe("\x1b[38;5;209mx\x1b[39m");
  });
});

describe("Spinner", () => {
  it("turns the cassette's reels and restores the cursor", async () => {
    const drawn: string[] = [];
    const spinner = new Spinner({ isTTY: true, write: (c: string) => drawn.push(c) }, paint(false), true).start("Working…");
    await spinner.stop("done", 200);
    const output = drawn.join("");
    expect([0, 1, 2, 3].map(cassetteFrame)).toEqual(["[◴═◴]", "[◷═◷]", "[◶═◶]", "[◵═◵]"]);
    expect(output).toContain("[◷═◷] Working…");
    expect(output.endsWith("\x1b[?25hdone\n")).toBe(true);
  });

  it("only prints the final line when not animating", async () => {
    const drawn: string[] = [];
    await new Spinner({ write: (c: string) => drawn.push(c) }, paint(false), false).start("Working…").stop("done", 1000);
    expect(drawn).toEqual(["done\n"]);
  });
});

describe("summary output", () => {
  const s: Summary = {
    cassettes: 2,
    replayed: 3,
    recorded: 1,
    usage: { inputTokens: 1500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0.01,
    savedCost: 0.0075,
    unpricedModels: [],
    warnings: ["Fuzzy match"],
  };

  it("is the same text with or without color", () => {
    const plain = formatSummary(s);
    const colored = formatSummary(s, { color: true });
    expect(plain).not.toContain("\x1b");
    expect(colored).toContain("\x1b[32m$0.0075 saved by replay\x1b[39m");
    expect(stripVTControlCharacters(colored)).toBe(plain.replace("  Fuzzy match", "  ! Fuzzy match"));
    expect(plain.split("\n")[0]).toBe("tomiko · 2 cassettes · 3 replayed · 1 recorded");
  });

  it("printSummary colors only for terminals", () => {
    const written: string[] = [];
    const stream = (isTTY: boolean) => ({ isTTY, write: (c: string) => written.push(c) }) as unknown as NodeJS.WriteStream;
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    try {
      printSummary(s, stream(false));
      printSummary(s, stream(true));
    } finally {
      Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
    }
    expect(written[0]).not.toContain("\x1b");
    expect(written[1]).toContain("\x1b[");
  });
});
