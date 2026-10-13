import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import { parseArgs } from "../src/commands/common.js";
import type { CassetteFile, Interaction } from "../src/types.js";
import { ANTHROPIC_URL, anthropicMessage, keys, tmpDir } from "./helpers.js";

function fakeIo(cwd: string, options: { color?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd,
    log: (m) => out.push(...m.split("\n")),
    error: (m) => err.push(...m.split("\n")),
    open: async () => true,
    stream: { isTTY: false, write: () => true },
    color: options.color ?? false,
    animate: false,
    columns: 100,
    env: options.env ?? {},
  };
  return { io, out, err };
}

const exchange = (question: string, answer: string, extra: Record<string, unknown> = {}): Interaction => ({
  request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-opus-5-5", messages: [{ role: "user", content: question }], ...extra } },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { type: "json", value: anthropicMessage(answer) } },
  meta: { provider: "anthropic", recordedAt: "2026-10-10T12:00:00.000Z", durationMs: 800 },
});
const cassetteFile = (...interactions: Interaction[]): CassetteFile => ({ version: 1, interactions });

function write(root: string, path: string, data: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
}

/** Commits never sign here, whatever the machine's git config says. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function repo(): string {
  const root = tmpDir();
  git(root, "init", "-q");
  write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", "We're open 9 to 6, Monday to Friday.")));
  write(root, "test/__cassettes__/faq.test.ts/greets.json", cassetteFile(exchange("Hi", "Hello!")));
  write(root, "test/__cassettes__/old.test.ts/gone.json", cassetteFile(exchange("ping", "pong")));
  write(root, "test/__cassettes__/notes.json", '{"not": "a cassette"}');
  write(root, "src/data.json", cassetteFile(exchange("elsewhere", "not under __cassettes__")));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "recorded");
  return root;
}

describe("tomiko diff", () => {
  it("compares the cassettes in the work tree with HEAD", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", "We are open from 9 to 6 on weekdays.")));
    // Re-recorded, but the model said the same thing: not a change.
    const same = exchange("Hi", "Hello!");
    same.meta.durationMs = 650;
    write(root, "test/__cassettes__/faq.test.ts/greets.json", cassetteFile(same));
    rmSync(join(root, "test/__cassettes__/old.test.ts"), { recursive: true });
    write(root, "test/__cassettes__/new.test.ts/añadido 新しい.json", cassetteFile(exchange("New?", "Yes.")));
    write(root, "src/data.json", cassetteFile(exchange("elsewhere", "changed, but not a test cassette")));

    const { io, out } = fakeIo(join(root, "test"));
    expect(await main(["diff"], io)).toBe(0);
    const text = out.join("\n");
    expect(out[0]).toMatch(/^ {2}tomiko diff {2}HEAD [0-9a-f]{7,} → working tree$/);
    expect(text).toContain("~ __cassettes__/faq.test.ts/hours.json  ● same behavior, new wording");
    expect(text).toContain("+ __cassettes__/new.test.ts/añadido 新しい.json  new");
    expect(text).toContain("− __cassettes__/old.test.ts/gone.json  removed");
    expect(text).not.toContain("greets.json");
    expect(text).not.toContain("data.json");
    expect(text).toContain("~ 1 changed  ·  + 1 new  ·  − 1 removed  ·  1 unchanged");
    expect(text).toContain("● 1 wording");
  });

  it("can compare with another revision, a subset of paths, or exit with 1 on changes", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", "Closed.")));
    git(root, "commit", "-qam", "re-recorded");

    const clean = fakeIo(root);
    expect(await main(["diff"], clean.io)).toBe(0);
    expect(clean.out[0]).toMatch(/✔ No cassette changed since HEAD [0-9a-f]+\./);

    const base = fakeIo(root);
    expect(await main(["diff", "--base", "HEAD~1", "--exit-code"], base.io)).toBe(1);
    expect(base.out.join("\n")).toContain("hours.json  ● same behavior, new wording");

    const scoped = fakeIo(root);
    expect(await main(["diff", "--base=HEAD~1", "test/__cassettes__/old.test.ts"], scoped.io)).toBe(0);
    expect(scoped.out[0]).toContain("No cassette changed");
  });

  it("says so when re-recorded cassettes behave the same", async () => {
    const root = repo();
    const again = exchange("Hours?", "We're open 9 to 6, Monday to Friday.");
    again.meta.durationMs = 400;
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(again));
    const { io, out } = fakeIo(root);
    expect(await main(["diff", "--exit-code"], io)).toBe(0);
    expect(out[0]).toBe("  ✔ 1 cassette re-recorded, and the model behaves the same in all of them.");
    expect(out).toEqual([
      "  ✔ 1 cassette re-recorded, and the model behaves the same in all of them.",
      "    cost    $0.0080",
      "    tokens  1.2K",
      "    time    800ms → 400ms  −50%",
    ]);
  });

  it("prints JSON for scripts", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", "Closed.")));
    const { io, out } = fakeIo(root);
    expect(await main(["diff", "--json"], io)).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.base).toEqual({ ref: "HEAD", commit: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(report.summary).toMatchObject({ changed: 1, impact: { wording: 1 } });
    expect(report.cassettes[0].requests[0].response.text.before).toBe("We're open 9 to 6, Monday to Friday.");
  });

  it("compares two files without git", async () => {
    const dir = tmpDir();
    write(dir, "a.json", cassetteFile(exchange("Q", "A", { temperature: 1 })));
    write(dir, "b.json", cassetteFile(exchange("Q", "A", { temperature: 0 })));
    const { io, out } = fakeIo(dir);
    expect(await main(["diff", "a.json", "b.json"], io)).toBe(0);
    expect(out[0]).toBe("  tomiko diff  a.json → b.json");
    expect(out).toContain("  ~ b.json  ● request changed, same answers");
    expect(out).toContain("       params  temperature  1 → 0");
  });

  it("explains what it needs when it can't compare", async () => {
    const dir = tmpDir();
    const outside = fakeIo(dir);
    expect(await main(["diff"], outside.io)).toBe(1);
    expect(outside.err[0]).toContain("not a git repository (or git is not installed). Compare two files instead: tomiko diff old.json new.json");

    const root = repo();
    const unknown = fakeIo(root);
    expect(await main(["diff", "--base", "nope"], unknown.io)).toBe(1);
    expect(unknown.err[0]).toBe("  ✖ Unknown git revision: nope");

    write(dir, "x.json", "{}");
    write(dir, "y.json", cassetteFile());
    const invalid = fakeIo(dir);
    expect(await main(["diff", "x.json", "y.json"], invalid.io)).toBe(1);
    expect(invalid.err[0]).toBe("  ✖ x.json is not a tomiko cassette.");
  });
});

describe("tomiko scan", () => {
  it("passes a clean project", async () => {
    const { io, out } = fakeIo(repo());
    expect(await main(["scan"], io)).toBe(0);
    expect(out).toEqual(["  ✔ No secrets in 3 cassettes · 3 requests"]);
  });

  it("finds secrets, says where, notes the committed ones and exits with 1", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", `Open 9 to 6. Token: ${keys.github}`)));
    git(root, "commit", "-qam", "leaked");
    write(root, "test/__cassettes__/faq.test.ts/greets.json", cassetteFile(exchange(`Hi, my key is ${keys.openai}`, "Hello!")));

    const { io, out } = fakeIo(root, { env: { OPENAI_API_KEY: keys.openai } });
    expect(await main(["scan"], io)).toBe(1);
    const text = out.join("\n");
    expect(out[0]).toBe("  ✖ 2 secrets in 2 of 3 cassettes");
    expect(text).toContain("● OpenAI API key  sk-proj-…" + keys.openai.slice(-4) + "  your $OPENAI_API_KEY");
    expect(text).toContain("#1 request body › messages[0].content");
    expect(text).toMatch(/test\/__cassettes__\/faq\.test\.ts\/greets\.json:\d+:\d+\n/);
    expect(text).toMatch(/hours\.json:\d+:\d+ {2}committed/);
    expect(text).toContain("! One of them is in git already. Revoke it: a fix doesn't remove it from history.");
    expect(text).not.toContain(keys.github);
    expect(text).not.toContain(keys.openai);
  });

  it("fixes them in place, and the cassettes still replay", async () => {
    const root = repo();
    const file = join(root, "test/__cassettes__/faq.test.ts/hours.json");
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange(`Use ${keys.stripe}`, `Token: ${keys.github}`)));
    const fixed = fakeIo(root);
    expect(await main(["scan", "--fix"], fixed.io)).toBe(0);
    expect(fixed.out[0]).toBe("  ✔ Replaced 2 secrets in 1 cassette with placeholders");
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain("Use [REDACTED:stripe-secret-key]");
    expect(saved).toContain("Token: [REDACTED:github-token]");

    const again = fakeIo(root);
    expect(await main(["scan"], again.io)).toBe(0);
  });

  it("can allow a value, scan given files only, and print JSON", async () => {
    const root = repo();
    write(root, "fixtures/a.json", cassetteFile(exchange("Q", `Fixture key ${keys.github}`)));
    const allowed = fakeIo(root);
    expect(await main(["scan", "fixtures/a.json", "--allow", keys.github], allowed.io)).toBe(0);

    const json = fakeIo(root);
    expect(await main(["scan", "fixtures", "--json"], json.io)).toBe(1);
    const report = JSON.parse(json.out.join("\n"));
    expect(report).toMatchObject({ cassettes: 1, secrets: 1, fixed: false });
    expect(report.files[0]).toMatchObject({ path: join("fixtures", "a.json"), findings: [{ kind: "GitHub token", line: expect.any(Number), committed: false }] });
    expect(json.out.join("\n")).not.toContain(keys.github);
  });
});

describe("tomiko view", () => {
  it("points out secrets in the cassettes it shows", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", `Token: ${keys.github}`)));
    const { io, out } = fakeIo(root);
    expect(await main(["view", "--no-open", "--out", "v.html"], io)).toBe(0);
    expect(out.at(-1)).toBe("    ! 1 secret in 1 cassette: see them with npx tomiko scan");
  });

  it("takes -o for the output file", async () => {
    const root = repo();
    const { io, out } = fakeIo(root);
    expect(await main(["view", "--no-open", "-o", "page.html"], io)).toBe(0);
    expect(out[2]).toBe("    → page.html");
    expect(readFileSync(join(root, "page.html"), "utf8")).toContain("<title>tomiko cassettes</title>");
  });
});

describe("help and arguments", () => {
  it("lists the commands, and each command explains itself", async () => {
    const { io, out } = fakeIo(tmpDir());
    expect(await main(["--help"], io)).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("view [paths...]");
    expect(help).toContain("diff [paths...]");
    expect(help).toContain("scan [paths...]");

    const diff = fakeIo(tmpDir());
    expect(await main(["diff", "--help"], diff.io)).toBe(0);
    expect(diff.out.join("\n")).toContain("--base <ref>");
    expect(diff.out.join("\n")).toContain("npx tomiko record");

    const scan = fakeIo(tmpDir());
    expect(await main(["help", "scan"], scan.io)).toBe(0);
    expect(scan.out.join("\n")).toContain("--allow <value>");
  });

  it("parses flags in their usual forms", () => {
    const spec = {
      out: { type: "string", short: "-o", help: "" },
      open: { type: "boolean", help: "" },
      allow: { type: "list", help: "" },
    } as const;
    expect(parseArgs(["a", "-o", "x", "--allow", "1", "--allow=2", "--open", "--", "--b"], spec)).toEqual({
      positional: ["a"],
      flags: { out: "x", allow: ["1", "2"], open: true },
      rest: ["--b"],
    });
    expect(parseArgs(["--out"], spec)).toBe("--out needs a value");
    expect(parseArgs(["--open=yes"], spec)).toBe("--open takes no value");
    expect(parseArgs(["--nope"], spec)).toBe("Unknown option: --nope");
  });

  it("colors its output only when asked", async () => {
    const root = repo();
    write(root, "test/__cassettes__/faq.test.ts/hours.json", cassetteFile(exchange("Hours?", "Closed.")));
    const plain = fakeIo(root);
    await main(["diff"], plain.io);
    expect(plain.out.join("\n")).not.toContain("\x1b");
    const colored = fakeIo(root, { color: true });
    await main(["diff"], colored.io);
    expect(colored.out.join("\n")).toContain("\x1b[");
    expect(stripVTControlCharacters(colored.out.join("\n"))).toContain("Closed.");
  });
});
