import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { plural } from "../format.js";
import { readAt, repoRoot } from "../git.js";
import { formatFindings, redactInteractions, scanInteractions, secretGuard, summarize } from "../secrets.js";
import { saveCassette } from "../store.js";
import { Spinner, padTo, width } from "../terminal.js";
import type { SecretFinding } from "../types.js";
import { discoverCassettes } from "../view/discover.js";
import { type Command, failure, parseCassette } from "./common.js";

interface Located extends SecretFinding {
  /** 1-based position of its first appearance in the file, when it appears there in one piece. */
  line?: number;
  column?: number;
  /** The secret is in the file as committed at HEAD, so fixing the file doesn't unpublish it. */
  committed: boolean;
}

interface Report {
  path: string;
  file: string;
  findings: Located[];
}

/** Where `value` first appears in a JSON file, as written there (escaped). */
function locate(text: string, value: string): { line: number; column: number } | undefined {
  const at = text.indexOf(JSON.stringify(value).slice(1, -1));
  if (at === -1) return undefined;
  const before = text.slice(0, at);
  const line = before.split("\n").length;
  return { line, column: at - before.lastIndexOf("\n") };
}

export const scan: Command = {
  name: "scan",
  usage: ["scan [paths...] [options]"],
  summary: "Find API keys and other secrets in cassettes",
  description: (p) => [
    "Finds API keys, tokens and passwords in your cassettes: 20 known key formats, the",
    "values of your own secret environment variables (*_API_KEY, *_TOKEN, …), and values",
    "of fields named like secrets. Exits with 1 when it finds any, so it can guard CI or",
    "a pre-commit hook. Without paths, scans every __cassettes__ directory below this one.",
    "",
    `Recording already refuses to save a cassette with a secret; see the ${p.bold("secrets")} option.`,
  ],
  flags: {
    fix: { type: "boolean", help: "Replace them with placeholders; replays keep working" },
    allow: { type: "list", value: "value", help: "A value that is not a secret (repeatable)" },
    json: { type: "boolean", help: "Print the findings as JSON" },
  },
  async run(args, io, p) {
    const json = args.flags.json === true;
    const fix = args.flags.fix === true;
    const spinner = new Spinner(io.stream, p, io.animate && !json).start("Looking for secrets…");
    let found;
    try {
      found = await discoverCassettes(
        args.positional.map((path) => resolve(io.cwd, path)),
        io.cwd,
      );
    } catch (error) {
      await spinner.stop();
      return failure(io, p, error instanceof Error ? error.message : String(error));
    }

    const guard = secretGuard({ action: "redact", allow: (args.flags.allow as string[] | undefined) ?? [] }, io.env)!;
    const root = await repoRoot(io.cwd);
    const reports: Report[] = [];
    let requests = 0;
    for (const [n, cassette] of found.entries()) {
      spinner.update(`Looking for secrets… ${p.dim(`${n + 1}/${found.length}`)}`);
      requests += cassette.data.interactions.length;
      const secrets = summarize(scanInteractions(cassette.data.interactions, guard));
      if (secrets.length === 0) continue;
      const text = await readFile(cassette.file, "utf8");
      // The committed file is scanned the same way, so a key split over stream events or inside a
      // base64 body is recognized there too.
      const head = root ? parseCassette(await readAt(io.cwd, "HEAD", relative(root, cassette.file).split(sep).join("/"))) : undefined;
      const committed = new Set(head ? summarize(scanInteractions(head.interactions, guard)).map((s) => s.value) : []);
      reports.push({
        path: cassette.path,
        file: cassette.file,
        findings: secrets.map(({ value, ...finding }) => ({ ...finding, ...locate(text, value), committed: committed.has(value) })),
      });
      if (fix) {
        const { interactions } = redactInteractions(cassette.data.interactions, guard);
        await saveCassette(cassette.file, { ...cassette.data, interactions });
      }
    }
    await spinner.stop(undefined, json ? 0 : 500);

    const total = reports.reduce((n, r) => n + r.findings.length, 0);
    const committed = reports.reduce((n, r) => n + r.findings.filter((f) => f.committed).length, 0);
    if (json) {
      io.log(JSON.stringify({ cassettes: found.length, secrets: total, fixed: fix, files: reports.map(({ file: _file, ...r }) => r) }, null, 2));
      return total > 0 && !fix ? 1 : 0;
    }

    if (found.length === 0) {
      io.log(`  ${p.green("✔")} No cassettes to scan${args.positional.length > 0 ? ` in ${args.positional.join(", ")}` : ""}.`);
      return 0;
    }
    if (total === 0) {
      io.log(`  ${p.green("✔")} No secrets in ${p.bold(plural(found.length, "cassette"))} ${p.dim(`· ${plural(requests, "request")}`)}`);
      return 0;
    }

    const revoke = (n: number) =>
      `  ${p.yellow("!")} ${n === 1 ? "One of them is" : `${n} of them are`} in git already. ` +
      `Revoke ${n === 1 ? "it" : "them"}: a fix doesn't remove ${n === 1 ? "it" : "them"} from history.`;

    if (fix) {
      io.log(`  ${p.green("✔")} Replaced ${p.bold(plural(total, "secret"))} in ${p.bold(plural(reports.length, "cassette"))} with placeholders`);
      const pad = Math.max(...reports.map((r) => width(r.path)));
      for (const r of reports) {
        io.log(`    ${p.link(padTo(r.path, pad), pathToFileURL(r.file).href)}  ${p.dim(plural(r.findings.length, "secret"))}`);
      }
      if (committed > 0) io.log(revoke(committed));
      return 0;
    }

    io.log(`  ${p.red("✖")} ${p.bold(plural(total, "secret"))} in ${p.bold(`${reports.length} of ${plural(found.length, "cassette")}`)}`);
    for (const r of reports) {
      io.log("");
      io.log(`  ${p.bold(p.link(r.path, pathToFileURL(r.file).href))}`);
      r.findings.forEach((f, i) => {
        const [what, where] = formatFindings([f], p, "    ");
        const at = f.line ? `${r.path}:${f.line}:${f.column}` : r.path;
        io.log(what!);
        io.log(where!);
        io.log(`      ${p.dim(at)}${f.committed ? `  ${p.red("committed")}` : ""}`);
        if (i < r.findings.length - 1) io.log("");
      });
    }
    io.log("");
    io.log(`  ${p.dim("Run")} ${p.bold("npx tomiko scan --fix")} ${p.dim("to replace them with placeholders; replays keep working.")}`);
    if (committed > 0) io.log(revoke(committed));
    io.log(`  ${p.dim("Not a secret? Allow it with")} ${p.bold("--allow <value>")} ${p.dim("here and")} ${p.bold("secrets: { allow }")} ${p.dim("in tests.")}`);
    return 1;
  },
};
