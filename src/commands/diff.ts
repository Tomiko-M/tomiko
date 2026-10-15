import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  type CassetteDiff,
  diffCassettes,
  type DiffSummary,
  type Impact,
  type RequestDiff,
  type Side,
  summarizeDiff,
  type TextChange,
  type Totals,
} from "../compare.js";
import { change, duration, plural, shortModel, tokens, usd } from "../format.js";
import { changedFiles, EMPTY_TREE, GitError, hasCommits, readAt, repoRoot, resolveRevision } from "../git.js";
import { canonical, type DiffEntry } from "../match.js";
import { maskJson, maskSecrets, redactInteractions, secretGuard } from "../secrets.js";
import { paint, type Paint, type Span, Spinner, wrapSpans } from "../terminal.js";
import type { CassetteFile, Usage } from "../types.js";
import { diffWords, type Piece } from "../words.js";
import { type Command, failure, type Io, parseCassette } from "./common.js";

export interface RenderOptions {
  /** Whole answers instead of the changed parts. */
  full?: boolean;
  columns?: number;
  /** Hides secrets in what is shown; `key` is the field a value belongs to. */
  mask?: (text: string, key?: string) => string;
}

interface Ctx {
  p: Paint;
  full: boolean;
  columns: number;
  mask: (text: string, key?: string) => string;
}

/** A JSON value with its strings masked, each knowing the field it is in. */
function maskDeep(ctx: Ctx, v: unknown, key?: string): unknown {
  if (typeof v === "string") return ctx.mask(v, key);
  if (Array.isArray(v)) return v.map((item) => maskDeep(ctx, item, key));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(ctx, x, k)]));
  return v;
}

/** `messages[2].content` → `content`, `tags[0]` → `tags`: the field a diff entry's value is in. */
const fieldOf = (path: string) => path.split(".").pop()?.replace(/(?:\[\d+\])+$/, "") || undefined;

/* ---------------------------------------- layout ------------------------------------------- */

const INDENT = "       ";
const LABEL = 8;

/** A labelled field whose value wraps under itself: `       calls   get_weather → search`. */
function field(ctx: Ctx, label: string, spans: Span[]): string[] {
  const pad = " ".repeat(INDENT.length + LABEL);
  const lines = wrapSpans(spans, ctx.columns - pad.length);
  return lines.map((line, i) => (i === 0 ? INDENT + ctx.p.dim(label.padEnd(LABEL)) : pad) + line);
}

const total = (u: Usage | undefined) => (u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0);

/** `+17%` in yellow when a cost goes up, in green when it goes down. */
function delta(p: Paint, before: number, after: number): string {
  const text = change(before, after);
  if (!text) return "";
  return after > before ? p.yellow(text) : p.green(text);
}

/** At most `max` characters, never splitting an emoji or other character in two. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/* ------------------------------------- text and values ------------------------------------- */

const CONTEXT = 6;
const MAX_HUNKS = 4;
const MAX_CHANGE = 240;

/** Keeps the changed parts of a word diff and a few words around each, up to `MAX_HUNKS` of them. */
function compact(pieces: Piece[]): { pieces: Piece[]; hidden: number } {
  const words = (text: string) => text.match(/\s*\S+|\s+$/g) ?? [];
  const out: Piece[] = [];
  let hunks = 0;
  let hidden = 0;
  pieces.forEach((piece, i) => {
    const starts = piece.op !== "=" && (i === 0 || pieces[i - 1]!.op === "=");
    if (starts) hunks++;
    if (hunks > MAX_HUNKS) {
      if (starts) hidden++;
      return;
    }
    if (piece.op !== "=") {
      out.push({ ...piece, text: clip(piece.text, MAX_CHANGE) });
      return;
    }
    const w = words(piece.text);
    const leading = i === 0;
    // The last piece shown: the end of the text, or the context before a change left out.
    const trailing = i === pieces.length - 1 || hunks === MAX_HUNKS;
    // A few words more than the context are shown rather than replaced by an ellipsis.
    const long = (n: number) => w.length > n + 3;
    if (leading && trailing) out.push(piece);
    else if (leading) out.push(long(CONTEXT) ? { op: "=", text: `…${w.slice(-CONTEXT).join("")}` } : piece);
    else if (trailing) {
      const end = i < pieces.length - 1;
      out.push(long(CONTEXT) || end ? { op: "=", text: `${w.slice(0, CONTEXT).join("")} …` } : piece);
    } else if (long(CONTEXT * 2)) {
      out.push({ op: "=", text: `${w.slice(0, CONTEXT).join("")} …${w.slice(-CONTEXT).join("")}` });
    } else out.push(piece);
  });
  return { pieces: out, hidden };
}

/** Removed words struck through in red, added ones in green; `[-…-]{+…+}` without color. */
function pieceSpans(ctx: Ctx, pieces: Piece[]): Span[] {
  const { p } = ctx;
  return pieces.flatMap((piece): Span[] => {
    if (piece.op === "=") return [{ text: piece.text }];
    const lead = /^\s*/.exec(piece.text)![0];
    const text = piece.text.slice(lead.length);
    if (!p.enabled) return [{ text: lead }, { text: piece.op === "-" ? `[-${text}-]` : `{+${text}+}` }];
    return [{ text: lead }, { text, style: piece.op === "-" ? (t) => p.red(p.strike(t)) : (t) => p.green(t) }];
  });
}

/** In the short form, line breaks become `↵` so a change reads as one line. */
const flat = (ctx: Ctx, text: string) => (ctx.full ? ctx.mask(text) : ctx.mask(text).replace(/[ \t]*\r?\n\s*/g, " ↵ ").trim());

function textLines(ctx: Ctx, label: string, change: TextChange, meter: boolean): string[] {
  const { p } = ctx;
  const { pieces, similarity } = diffWords(flat(ctx, change.before), flat(ctx, change.after));
  const shown = ctx.full ? { pieces, hidden: 0 } : compact(pieces);
  const pct = Math.round(similarity * 100);
  const lines: string[] = [];
  if (meter) {
    const filled = Math.round(similarity * 10);
    const bar = p.enabled ? `${p.accent("▰".repeat(filled))}${p.dim("▱".repeat(10 - filled))} ` : "";
    lines.push(...field(ctx, label, [{ text: `${bar}${pct}% the same words`, style: p.dim }]));
    lines.push(...field(ctx, "", pieceSpans(ctx, shown.pieces)));
  } else {
    lines.push(...field(ctx, label, pieceSpans(ctx, shown.pieces)));
  }
  if (shown.hidden > 0) lines.push(...field(ctx, "", [{ text: `and ${plural(shown.hidden, "more change")}`, style: p.dim }]));
  return lines;
}

function value(ctx: Ctx, v: unknown, key?: string): string {
  const text = typeof v === "string" ? JSON.stringify(ctx.mask(v, key)) : canonical(maskDeep(ctx, v, key));
  return ctx.full ? text : clip(text, 80);
}

/** `city "Moscow" → "Paris"`, `+ units "metric"`, `− days 3`, one per line, after `lead`. */
function entryLines(ctx: Ctx, label: string, entries: DiffEntry[], limit = 8, lead: Span[] = []): string[] {
  const { p } = ctx;
  const shown = ctx.full ? entries : entries.slice(0, limit);
  const lines = shown.flatMap((e, i) => {
    const name = e.path || "(value)";
    const key = fieldOf(e.path);
    let spans: Span[];
    if (e.kind === "added") spans = [{ text: "+ ", style: p.green }, { text: `${name}  ` }, { text: value(ctx, e.after, key), style: p.green }];
    else if (e.kind === "removed") spans = [{ text: "− ", style: p.red }, { text: `${name}  ` }, { text: value(ctx, e.before, key), style: p.red }];
    else if (typeof e.before === "string" && typeof e.after === "string" && Math.max(e.before.length, e.after.length) > 40) {
      const { pieces } = diffWords(flat(ctx, ctx.mask(e.before, key)), flat(ctx, ctx.mask(e.after, key)));
      spans = [{ text: `${name}  ` }, ...pieceSpans(ctx, ctx.full ? pieces : compact(pieces).pieces)];
    } else {
      spans = [
        { text: `${name}  ` },
        { text: value(ctx, e.before, key), style: p.enabled ? (t) => p.red(p.strike(t)) : undefined },
        { text: " → ", style: p.dim },
        { text: value(ctx, e.after, key), style: p.green },
      ];
    }
    return field(ctx, i === 0 ? label : "", [...lead, ...spans]);
  });
  if (entries.length > shown.length) lines.push(...field(ctx, "", [{ text: `and ${entries.length - shown.length} more`, style: p.dim }]));
  return lines;
}

/** Tool names in call order; a name missing on the other side is colored. */
function names(ctx: Ctx, list: string[], other: string[], style: (t: string) => string): Span[] {
  if (list.length === 0) return [{ text: "(none)", style: ctx.p.dim }];
  const left = new Map<string, number>();
  for (const name of other) left.set(name, (left.get(name) ?? 0) + 1);
  return list.flatMap((name, i) => {
    const n = left.get(name) ?? 0;
    left.set(name, n - 1);
    return [...(i > 0 ? [{ text: ", " }] : []), n > 0 ? { text: name } : { text: name, style }];
  });
}

/* ---------------------------------------- requests ----------------------------------------- */

function requestHeader(ctx: Ctx, r: RequestDiff): string {
  const { p } = ctx;
  // Masked whole, since some secrets are recognized by their host (a Slack webhook), then cut down
  // to the path.
  const path = (ctx.mask(r.url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "") || "/")
    // A Bedrock path holds the model, shown next to it anyway.
    .replace(/^\/model\/[^/]+\//, "/model/…/");
  const modelBefore = r.before?.model && shortModel(r.before.model);
  const modelAfter = r.after?.model && shortModel(r.after.model);
  const model =
    r.status === "changed" && modelBefore !== modelAfter
      ? `${p.red(modelBefore ?? "?")} ${p.dim("→")} ${p.green(modelAfter ?? "?")}`
      : p.dim(modelAfter ?? modelBefore ?? "");
  const tag = r.status === "added" ? `  ${p.green("new request")}` : r.status === "removed" ? `  ${p.red("gone")}` : "";
  const moved = r.beforeIndex !== undefined && r.beforeIndex !== r.index && r.status !== "removed" ? p.dim(` (was #${r.beforeIndex})`) : "";
  return `    ${p.bold(`#${r.index}`)}${moved}  ${r.method} ${path}${model ? `  ${model}` : ""}${tag}`;
}

/** What a request that exists on one side only did. */
function sideLines(ctx: Ctx, side: Side, style: (t: string) => string): string[] {
  const { p } = ctx;
  const lines: string[] = [];
  if (side.status >= 400) lines.push(...field(ctx, "status", [{ text: String(side.status), style: p.red }]));
  if (side.toolCalls.length > 0) lines.push(...field(ctx, "calls", [{ text: side.toolCalls.map((t) => t.name).join(", "), style }]));
  if (side.text) lines.push(...field(ctx, side.status >= 400 ? "error" : "answer", [{ text: clip(flat(ctx, side.text), ctx.full ? Infinity : 160), style }]));
  return lines;
}

const CUT_OFF = new Set(["max_tokens", "length", "incomplete", "model_context_window_exceeded", "MAX_TOKENS"]);

function requestLines(ctx: Ctx, r: RequestDiff, explained: boolean): string[] {
  const { p } = ctx;
  const lines = [requestHeader(ctx, r)];
  if (r.status === "added") return [...lines, ...sideLines(ctx, r.after!, p.green)];
  if (r.status === "removed") return [...lines, ...sideLines(ctx, r.before!, p.dim)];

  const req = r.request;
  if (req) {
    if (req.system) lines.push(...textLines(ctx, "system", req.system, false));
    if (req.prompt) lines.push(...textLines(ctx, "prompt", req.prompt, false));
    if (req.params.length > 0) lines.push(...entryLines(ctx, "params", req.params, 4));
    const { added, removed, changed } = req.tools;
    if (added.length + removed.length + changed.length > 0) {
      const spans: Span[] = [
        ...added.map((n) => ({ text: `+${n}  `, style: p.green })),
        ...removed.map((n) => ({ text: `−${n}  `, style: p.red })),
        ...changed.map((n) => ({ text: `~${n}  `, style: p.yellow })),
      ];
      lines.push(...field(ctx, "tools", spans));
    }
    if (req.history && !explained) lines.push(...field(ctx, "history", [{ text: "earlier turns differ", style: p.dim }]));
  }

  const res = r.response;
  if (res) {
    if (res.status) {
      const after = res.status.after >= 400 ? p.red : p.green;
      lines.push(...field(ctx, "status", [{ text: String(res.status.before), style: p.dim }, { text: " → ", style: p.dim }, { text: String(res.status.after), style: after }]));
    }
    if (res.stopReason) {
      const { before, after } = res.stopReason;
      const note = CUT_OFF.has(after ?? "")
        ? { text: "  cut off at the token limit", style: p.yellow }
        : CUT_OFF.has(before ?? "")
          ? { text: "  no longer cut off", style: p.green }
          : { text: "" };
      lines.push(...field(ctx, "stop", [{ text: before ?? "(none)", style: p.red }, { text: " → ", style: p.dim }, { text: after ?? "(none)", style: p.green }, note]));
    }
    if (res.tools) {
      const { before, after, inputs } = res.tools;
      if (canonical(before) !== canonical(after)) {
        lines.push(...field(ctx, "calls", [...names(ctx, before, after, p.red), { text: " → ", style: p.dim }, ...names(ctx, after, before, p.green)]));
      }
      inputs.forEach((input, i) => {
        const label = i === 0 && canonical(before) === canonical(after) ? "calls" : "";
        const name: Span = { text: `${input.name}${input.occurrence > 0 ? ` #${input.occurrence + 1}` : ""}`, style: p.bold };
        // One change fits on the tool's line; more go under it.
        if (input.changes.length === 1) lines.push(...entryLines(ctx, label, input.changes, 1, [name, { text: "  " }]));
        else lines.push(...field(ctx, label, [name]), ...entryLines(ctx, "", input.changes, 6, [{ text: "  " }]));
      });
    }
    if (res.format) lines.push(...field(ctx, "format", [{ text: res.format.before, style: p.red }, { text: " → ", style: p.dim }, { text: res.format.after, style: p.green }]));
    if (res.data) lines.push(...entryLines(ctx, "data", res.data));
    if (res.text) lines.push(...textLines(ctx, r.after!.status >= 400 ? "error" : "answer", res.text, true));
  }

  const [a, b] = [total(r.before?.usage), total(r.after?.usage)];
  const moved = a > 0 && Math.abs(b - a) / a >= 0.05;
  if (moved) {
    const cost = r.before!.cost !== null && r.after!.cost !== null ? [{ text: `  ${usd(r.before!.cost)} → ${usd(r.after!.cost)}`, style: p.dim }] : [];
    lines.push(...field(ctx, "tokens", [{ text: `${tokens(a)} → ${tokens(b)}  ` }, { text: delta(p, a, b) }, ...cost]));
  }
  return lines;
}

/* ---------------------------------------- cassettes ---------------------------------------- */

const IMPACT_LABEL: Record<Impact, string> = {
  behavior: "behavior changed",
  wording: "same behavior, new wording",
  request: "request changed, same answers",
  none: "",
};

function impactLabel(p: Paint, impact: Impact): string {
  if (impact === "behavior") return p.accent(`● ${IMPACT_LABEL.behavior}`);
  if (impact === "wording") return p.cyan(`● ${IMPACT_LABEL.wording}`);
  return p.dim(`● ${IMPACT_LABEL[impact]}`);
}

function totalsLine(p: Paint, t: Totals): string {
  const cost = t.cost === null ? "no price" : usd(t.cost);
  return p.dim(`${plural(t.requests, "request")} · ${tokens(total(t.usage))} tokens · ${cost}`);
}

function cassetteLines(ctx: Ctx, c: CassetteDiff): string[] {
  const { p } = ctx;
  if (c.status === "added") return [`  ${p.green("+")} ${p.bold(c.path)}  ${p.green("new")}`, `    ${totalsLine(p, c.after!)}`];
  if (c.status === "removed") return [`  ${p.red("−")} ${p.bold(c.path)}  ${p.red("removed")}`, `    ${totalsLine(p, c.before!)}`];

  const lines = [`  ${p.yellow("~")} ${p.bold(c.path)}  ${impactLabel(p, c.impact)}`];
  let explained = false;
  const same = c.requests.filter((r) => r.status === "unchanged").length;
  for (const r of c.requests) {
    if (r.status !== "unchanged") lines.push(...requestLines(ctx, r, explained));
    // Once an answer changes, every later request carries a different history.
    if (r.response || r.status === "added" || r.status === "removed") explained = true;
  }
  if (same > 0) lines.push(`    ${p.dim(`${plural(same, "other request")} the same`)}`);
  return lines;
}

/** Cost, tokens and time to record, before and after; a value that didn't move is shown once. */
function totalsRows(p: Paint, s: DiffSummary): string[] {
  const rows: [string, number, number, (n: number) => string][] = [];
  if (s.before.cost !== null || s.after.cost !== null) rows.push(["cost", s.before.cost ?? 0, s.after.cost ?? 0, usd]);
  const [ta, tb] = [total(s.before.usage), total(s.after.usage)];
  if (ta + tb > 0) rows.push(["tokens", ta, tb, tokens]);
  if (s.before.durationMs + s.after.durationMs > 0) rows.push(["time", s.before.durationMs, s.after.durationMs, duration]);
  const values = rows.map(([, a, b, show]) => (show(a) === show(b) ? show(b) : `${show(a)} → ${show(b)}`));
  const pad = Math.max(...values.map((v) => v.length), 0) + 2;
  return rows.map(([label, a, b], i) => {
    const d = values[i]!.includes("→") ? delta(p, a, b) : "";
    return `  ${p.dim(label.padEnd(8))}${d ? values[i]!.padEnd(pad) + d : values[i]}`;
  });
}

function summaryLines(ctx: Ctx, s: DiffSummary): string[] {
  const { p } = ctx;
  const counts = [
    s.changed > 0 ? `${p.yellow("~")} ${p.bold(String(s.changed))} changed` : "",
    s.added > 0 ? `${p.green("+")} ${p.bold(String(s.added))} new` : "",
    s.removed > 0 ? `${p.red("−")} ${p.bold(String(s.removed))} removed` : "",
    s.unchanged > 0 ? p.dim(`${s.unchanged} unchanged`) : "",
  ].filter(Boolean);
  const impacts = [
    s.impact.behavior > 0 ? p.accent(`● ${s.impact.behavior} behavior`) : "",
    s.impact.wording > 0 ? p.cyan(`● ${s.impact.wording} wording`) : "",
    s.impact.request > 0 ? p.dim(`● ${s.impact.request} request only`) : "",
  ].filter(Boolean);
  return [
    `  ${p.dim("─".repeat(Math.max(20, Math.min(ctx.columns - 4, 56))))}`,
    `  ${counts.join(p.dim("  ·  "))}`,
    ...(impacts.length > 0 ? [`  ${impacts.join("   ")}`] : []),
    ...totalsRows(p, s),
  ];
}

/** The comparison as terminal lines. */
export function renderDiff(cassettes: readonly CassetteDiff[], options: RenderOptions & { color?: Paint } = {}): string[] {
  const ctx: Ctx = {
    p: options.color ?? paint(false),
    full: options.full === true,
    columns: Math.max(options.columns ?? 100, 40),
    mask: options.mask ?? ((text) => text),
  };
  const shown = cassettes.filter((c) => c.status !== "unchanged");
  const lines: string[] = [];
  for (const c of shown) lines.push(...cassetteLines(ctx, c), "");
  lines.push(...summaryLines(ctx, summarizeDiff(cassettes)));
  return lines;
}

/* ----------------------------------------- sources ----------------------------------------- */

interface Pair {
  path: string;
  before?: CassetteFile;
  after?: CassetteFile;
}

export interface Source {
  /** `HEAD (2456a7f) → working tree` */
  from: string;
  to: string;
  base: { ref: string; commit: string } | { file: string };
  pairs: Pair[];
}

const DEFAULT_PATHSPEC = ":(glob)**/__cassettes__/**/*.json";

/** Cassettes under `paths` (default: every `__cassettes__` directory) that differ from `ref`. */
export async function fromGit(io: Io, paths: string[], ref: string): Promise<Source | string> {
  const root = await repoRoot(io.cwd);
  if (!root) {
    return "tomiko diff compares cassettes with a git revision, and this is not a git repository (or git is not installed). Compare two files instead: tomiko diff old.json new.json";
  }
  // Before the first commit, every cassette is new: compared with git's empty tree.
  const unborn = ref === "HEAD" && !(await hasCommits(io.cwd));
  const revision = unborn ? { ref, short: "(no commits yet)" } : await resolveRevision(io.cwd, ref);
  const base = unborn ? EMPTY_TREE : ref;
  const files = await changedFiles(io.cwd, base, paths.length > 0 ? paths : [DEFAULT_PATHSPEC]);
  const pairs: Pair[] = [];
  for (const file of files.filter((f) => f.path.endsWith(".json"))) {
    const absolute = join(root, file.path);
    const before = file.status === "added" ? undefined : parseCassette(await readAt(io.cwd, base, file.path));
    const after = file.status === "deleted" ? undefined : parseCassette(await readFile(absolute, "utf8").catch(() => undefined));
    if (before || after) pairs.push({ path: relative(io.cwd, absolute), before, after });
  }
  // A path that is nowhere, now or at the revision, is a typo rather than a cassette with no changes.
  for (const path of paths) {
    const absolute = resolve(io.cwd, path);
    if (await stat(absolute).then(() => true, () => false)) continue;
    // Deleted since the revision: its cassettes are in the comparison, or the file is in git.
    if (pairs.some((pair) => resolve(io.cwd, pair.path).startsWith(absolute))) continue;
    if (!unborn && (await readAt(io.cwd, base, relative(root, absolute).split(sep).join("/"))) !== undefined) continue;
    return `No such file or directory: ${path}`;
  }
  return { from: `${ref} ${revision.short}`, to: "working tree", base: { ref, commit: revision.short }, pairs };
}

async function fromFiles(io: Io, a: string, b: string): Promise<Source | string> {
  const [before, after] = await Promise.all([a, b].map((f) => readFile(resolve(io.cwd, f), "utf8").then(parseCassette)));
  if (!before) return `${a} is not a tomiko cassette.`;
  if (!after) return `${b} is not a tomiko cassette.`;
  return { from: a, to: b, base: { file: a }, pairs: [{ path: b, before, after }] };
}

const isFile = (cwd: string, path: string) =>
  stat(resolve(cwd, path)).then(
    (s) => s.isFile(),
    () => false,
  );

export const diff: Command = {
  name: "diff",
  usage: ["diff [paths...] [options]", "diff <old.json> <new.json>"],
  summary: "Show what changed in re-recorded cassettes",
  description: (p) => [
    "Shows how cassettes changed since a git revision, by what the model did: which tools",
    "it called and with what arguments, why it stopped, what it answered, and what that",
    "cost. Ids, timestamps and other noise are ignored.",
    "",
    `To see how the model answers today, re-record: ${p.accent("npx tomiko record")} shows this comparison`,
    "when it is done.",
    "",
    "Without paths, compares every cassette in a __cassettes__ directory below this one. Two",
    "files are compared with each other, or each with git when --base is given.",
  ],
  flags: {
    base: { type: "string", value: "ref", help: "Compare with this git revision (default: HEAD)" },
    full: { type: "boolean", help: "Show whole answers, not just the changed parts" },
    json: { type: "boolean", help: "Print the comparison as JSON" },
    "exit-code": { type: "boolean", help: "Exit with 1 when anything changed" },
  },
  async run(args, io, p) {
    const json = args.flags.json === true;
    const ref = typeof args.flags.base === "string" ? args.flags.base : "HEAD";
    const paths = args.positional;
    // Two files are compared with each other, unless --base asks for git.
    const pairwise = args.flags.base === undefined && paths.length === 2 && (await isFile(io.cwd, paths[0]!)) && (await isFile(io.cwd, paths[1]!));
    const spinner = new Spinner(io.stream, p, io.animate && !json).start(pairwise ? "Comparing…" : `Comparing cassettes with ${ref}…`);

    let source: Source | string;
    try {
      source = pairwise ? await fromFiles(io, paths[0]!, paths[1]!) : await fromGit(io, paths, ref);
    } catch (error) {
      await spinner.stop();
      return failure(io, p, error instanceof GitError || error instanceof Error ? error.message : String(error));
    }
    if (typeof source === "string") {
      await spinner.stop();
      return failure(io, p, source);
    }

    spinner.update(`Comparing ${plural(source.pairs.length, "cassette")}…`);
    // For JSON, secrets are taken out before comparing: a key split across the pieces of a word
    // diff would no longer look like one to mask.
    const guard = json ? secretGuard("redact", io.env ?? process.env) : undefined;
    const clean = (c: CassetteFile | undefined) => (c && guard ? { ...c, interactions: redactInteractions(c.interactions, guard).interactions } : c);
    const cassettes = source.pairs.map((pair) => diffCassettes(pair.path, clean(pair.before), clean(pair.after)));
    const summary = summarizeDiff(cassettes);
    await spinner.stop(undefined, json ? 0 : 500);
    const changed = summary.changed + summary.added + summary.removed;

    if (json) {
      // Every string, masked too, paths and urls included.
      io.log(JSON.stringify(maskJson({ base: source.base, summary, cassettes }, guard), null, 2));
      return args.flags["exit-code"] && changed > 0 ? 1 : 0;
    }

    showComparison(io, p, source, cassettes, { full: args.flags.full === true });
    return args.flags["exit-code"] && changed > 0 ? 1 : 0;
  },
};

/**
 * Prints a comparison: what changed, or that nothing did. After `tomiko record` there is no point
 * suggesting a re-recording.
 */
export function showComparison(
  io: Io,
  p: Paint,
  source: Source,
  cassettes: CassetteDiff[],
  options: { full?: boolean; recorded?: boolean } = {},
): void {
  const summary = summarizeDiff(cassettes);
  const changed = summary.changed + summary.added + summary.removed;
  if (cassettes.length === 0) {
    io.log(`  ${p.green("✔")} No cassette changed since ${p.bold(source.from)}.`);
    if (!options.recorded) {
      io.log(`    ${p.dim("Re-record them to see how the model answers today:")} ${p.accent("npx tomiko record")}`);
    }
    return;
  }
  if (changed === 0) {
    io.log(`  ${p.green("✔")} ${p.bold(plural(cassettes.length, "cassette"))} re-recorded, and the model behaves the same in all of them.`);
    for (const line of totalsRows(p, summary)) io.log(`  ${line}`);
    return;
  }
  const guard = secretGuard("warn", io.env ?? process.env);
  io.log(`  ${p.bold("tomiko diff")}  ${p.dim(source.from)} ${p.accent("→")} ${p.dim(source.to)}`);
  io.log("");
  for (const line of renderDiff(cassettes, { color: p, full: options.full, columns: io.columns, mask: (t, key) => maskSecrets(t, guard, key) })) {
    io.log(line);
  }
}
