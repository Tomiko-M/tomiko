import { resolve } from "node:path";
import { diagnose, type Diagnosis, type Finding } from "../doctor.js";
import { money, plural, tokens } from "../format.js";
import { maskSecrets, secretGuard } from "../secrets.js";
import { type Paint, type Span, Spinner, width, wrapSpans } from "../terminal.js";
import { discoverCassettes } from "../view/discover.js";
import type { Piece } from "../words.js";
import { type Command, failure, type Io } from "./common.js";

/** `test/__cassettes__/agent.test.ts/x.json` → `agent.test.ts/x.json`: the part people recognize. */
const short = (path: string) => path.replace(/^(?:.*[\\/])?__cassettes__[\\/]/, "");

/** `#2`, `#2 and #3`, `#3–#7`. */
function requests(list: number[]): string {
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  if (sorted.length === 1) return `#${sorted[0]}`;
  if (sorted.length === 2) return `#${sorted[0]} and #${sorted[1]}`;
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return run ? `#${sorted[0]}–#${sorted.at(-1)}` : `${sorted.slice(0, 3).map((n) => `#${n}`).join(", ")}${sorted.length > 3 ? "…" : ""}`;
}

const times = (n: number) => (n === 2 ? "twice" : `${n} times`);

/** The changed part of a prompt with a little context, on one line. */
function snippet(p: Paint, pieces: Piece[], mask: (t: string) => string): Span[] {
  const at = pieces.findIndex((piece) => piece.op !== "=");
  const before = pieces[at - 1]?.op === "=" ? pieces[at - 1]!.text : "";
  // About forty characters before the change, starting at a word.
  const flat = before.replace(/\s+/g, " ");
  const lead = flat.length > 40 ? flat.slice(-40).replace(/^\S*\s/, "") : flat;
  const changed = pieces.slice(at).filter((piece, i, all) => piece.op !== "=" || (i < all.length - 1 && all.slice(i + 1).some((x) => x.op !== "=")));
  const end = pieces.slice(at).find((piece) => piece.op === "=");
  const spans: Span[] = [{ text: `“…${mask(lead)}`, style: p.dim }];
  for (const piece of changed.slice(0, 4)) {
    const text = mask(piece.text.replace(/\s+/g, " "));
    if (piece.op === "=") spans.push({ text, style: p.dim });
    else if (!p.enabled) spans.push({ text: piece.op === "-" ? `[-${text.trim()}-]` : `{+${text.trim()}+}` });
    else spans.push({ text, style: piece.op === "-" ? (t) => p.red(p.strike(t)) : p.green });
  }
  spans.push({ text: `${end ? mask(end.text.replace(/\s+/g, " ").slice(0, 24)) : ""}…”`, style: p.dim });
  return spans;
}

interface Shown {
  title: string;
  amount: string;
  lines: Span[][];
  advice: string;
}

function show(f: Finding, p: Paint, mask: (t: string) => string): Shown {
  const first = f.where[0]!;
  const more = f.where.length > 1 ? ` and ${plural(f.where.length - 1, "more cassette")}` : "";
  const place = `${short(first.path)} ${requests(first.requests)}${more}`;
  const perRun = `≈ ${money(f.waste)} a run`;
  switch (f.kind) {
    case "volatile-prompt":
      return {
        title: "The system prompt changes between requests, so it is never cached",
        amount: perRun,
        lines: [[{ text: place, style: p.dim }], snippet(p, f.detail.change ?? [], mask)],
        advice: "Keep the system prompt the same from request to request: move the time to the user's message, or round it to the day.",
      };
    case "unused-tools": {
      const names = f.detail.tools ?? [];
      const listed = names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "");
      const sent = f.where.reduce((n, w) => n + w.requests.length, 0);
      return {
        title: `${names.length === 1 ? "1 tool is" : `${names.length} tools are`} offered to the model and never called`,
        amount: perRun,
        lines: [[{ text: listed }, { text: ` · ≈ ${tokens(Math.round(f.tokens / Math.max(sent, 1)))} tokens in each of ${plural(sent, "request")}`, style: p.dim }]],
        advice: "Offer each request only the tools it can use; every definition is paid for on every request.",
      };
    }
    case "large-tool-result":
      return {
        title: `${f.detail.tool} returns ≈ ${tokens(f.tokens)} tokens, sent to the model ${times(f.detail.sends ?? 1)}`,
        amount: perRun,
        lines: [[{ text: place, style: p.dim }]],
        advice: "Return less: the part that matters, a summary, or a page at a time. Each turn of the loop sends it again.",
      };
    case "duplicate-request":
      return {
        title: `The same request is sent ${times(f.detail.sends ?? 2)}${f.where.length > 1 ? `, in ${plural(f.where.length, "test")}` : ""}`,
        amount: perRun,
        lines: [[{ text: place, style: p.dim }]],
        advice: "Reuse the first answer instead of asking again.",
      };
    case "max-tokens":
      return {
        title: `max_tokens is ${f.detail.limit!.toLocaleString("en-US")}, and answers use at most ${f.detail.used!.toLocaleString("en-US")}`,
        amount: `up to ${money(f.risk ?? 0)} a request`,
        lines: [[{ text: place, style: p.dim }]],
        advice: "Lower it: a runaway answer costs up to the limit, and some APIs count the limit against your rate limits.",
      };
  }
}

export function renderDiagnosis(d: Diagnosis, p: Paint, columns = 100, mask: (t: string) => string = (t) => t): string[] {
  const head = `  ${p.bold("tomiko doctor")}  ${p.dim(`${plural(d.cassettes, "cassette")} · ${plural(d.requests, "request")} · ${money(d.cost)} a run`)}`;
  if (d.findings.length === 0) {
    return [`  ${p.green("✔")} Nothing to fix in ${plural(d.cassettes, "cassette")} ${p.dim(`· ${plural(d.requests, "request")} · ${money(d.cost)} a run`)}`];
  }
  const shown = d.findings.map((f) => ({ f, s: show(f, p, mask) }));
  const right = Math.min(Math.max(...shown.map(({ s }) => width(s.title))) + 4, Math.max(columns - 26, 40));
  const lines = [head, ""];
  for (const { f, s } of shown) {
    const share = d.cost > 0 ? f.waste / d.cost : 0;
    const mark = f.waste === 0 ? p.dim("○") : share >= 0.1 ? p.red("▲") : p.yellow("●");
    const pad = " ".repeat(Math.max(2, right - width(s.title)));
    lines.push(`  ${mark} ${p.bold(s.title)}${pad}${f.waste > 0 ? p.bold(s.amount) : p.dim(s.amount)}`);
    for (const spans of s.lines) lines.push(...wrapSpans(spans, columns - 4).map((line) => `    ${line}`));
    lines.push(...wrapSpans([{ text: s.advice, style: p.dim }], columns - 4).map((line) => `    ${line}`));
    lines.push("");
  }
  const saved = d.savings;
  lines.push(`  ${p.dim("─".repeat(Math.max(20, Math.min(columns - 4, 56))))}`);
  if (saved > 0) {
    const pct = d.cost > 0 ? ` (${Math.round((saved / d.cost) * 100)}%)` : "";
    lines.push(`  ${p.accent("◆")} Fixing all of it saves ${p.bold(`≈ ${money(saved)}`)} of ${money(d.cost)} a run${pct}.`);
    lines.push(`    ${p.dim("A live run of these tests spends that; your app spends the same per conversation like them.")}`);
  } else {
    lines.push(`  ${p.dim("Nothing costs more than it needs to today; the notes above are about risk.")}`);
  }
  if (d.unpriced.length > 0) lines.push(`    ${p.dim(`No price for ${d.unpriced.join(", ")}: their share is left out of the amounts.`)}`);
  return lines;
}

export const doctor: Command = {
  name: "doctor",
  usage: ["doctor [paths...] [options]"],
  summary: "Find where your LLM calls cost more than they need to",
  description: () => [
    "Reads your cassettes, offline, for money left on the table: a system prompt that changes",
    "on every request and so is never cached, tools offered and never called, huge tool",
    "results sent back on every turn, the same request sent twice, and token limits far above",
    "what answers use. Each finding says what it costs a run.",
  ],
  flags: {
    json: { type: "boolean", help: "Print the findings as JSON" },
  },
  async run(args, io: Io, p) {
    const json = args.flags.json === true;
    const spinner = new Spinner(io.stream, p, io.animate && !json).start("Reading your cassettes…");
    let found;
    try {
      found = await discoverCassettes(args.positional.map((path) => resolve(io.cwd, path)), io.cwd);
    } catch (error) {
      await spinner.stop();
      return failure(io, p, error instanceof Error ? error.message : String(error));
    }
    const diagnosis = diagnose(found);
    await spinner.stop(undefined, json ? 0 : 500);
    if (json) {
      io.log(JSON.stringify(diagnosis, null, 2));
      return 0;
    }
    if (found.length === 0) return failure(io, p, `No cassettes found. tomiko looks in ${p.bold("__cassettes__")} directories; pass a path if yours are elsewhere.`);
    const guard = secretGuard("warn", io.env ?? process.env);
    for (const line of renderDiagnosis(diagnosis, p, io.columns ?? 100, (t) => maskSecrets(t, guard))) io.log(line);
    return 0;
  },
};
