/** Terminal output: colors, links and a spinner, all of which turn themselves off where unwanted. */

type Stream = { isTTY?: boolean; write(chunk: string): unknown };

function isCI(env: NodeJS.ProcessEnv): boolean {
  return env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI.toLowerCase() !== "false";
}

/** Colors follow the NO_COLOR and FORCE_COLOR conventions, and otherwise need an interactive terminal. */
export function colorEnabled(stream: Stream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

/** Animation rewrites the current line, so it also stays off in CI logs and piped output. */
export function animationEnabled(stream: Stream = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && colorEnabled(stream, env) && !isCI(env) && env.TERM !== "dumb";
}

export interface Paint {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  strike(text: string): string;
  link(text: string, url: string): string;
}

const wrap = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;

export function paint(enabled: boolean, env: NodeJS.ProcessEnv = process.env): Paint {
  if (!enabled) {
    const plain = (text: string) => text;
    return { enabled, bold: plain, dim: plain, accent: plain, green: plain, red: plain, yellow: plain, cyan: plain, strike: plain, link: plain };
  }
  const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
  return {
    enabled,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    // tomiko's orange: #f0885b where the terminal can show it, the nearest of 256 colors otherwise.
    accent: wrap(truecolor ? "38;2;240;136;91" : "38;5;209", "39"),
    green: wrap("32", "39"),
    red: wrap("31", "39"),
    yellow: wrap("33", "39"),
    cyan: wrap("36", "39"),
    strike: wrap("9", "29"),
    // OSC 8 hyperlinks: clickable in most modern terminals, invisible in the rest.
    link: (text, url) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`,
  };
}

/** A cassette whose reels turn: [◴═◴] → [◷═◷] → [◶═◶] → [◵═◵]. */
const REELS = ["◴", "◷", "◶", "◵"];
export const cassetteFrame = (i: number) => {
  const reel = REELS[i % REELS.length]!;
  return `[${reel}═${reel}]`;
};

/** Spinners turning now, so a failure or Ctrl-C can stop them and give the cursor back. */
const turning = new Set<Spinner>();

function onSignal(signal: NodeJS.Signals): void {
  for (const spinner of turning) spinner.halt();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

export class Spinner {
  /** Stops every spinner still turning, as when a command fails in the middle of one. */
  static stopAll(): void {
    for (const spinner of [...turning]) spinner.halt();
  }

  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private text = "";
  private readonly startedAt = Date.now();

  constructor(
    private readonly stream: Stream,
    private readonly p: Paint,
    private readonly animate: boolean,
  ) {}

  start(text: string): this {
    this.text = text;
    if (!this.animate) return this;
    this.stream.write("\x1b[?25l"); // hide the cursor while the reels turn
    process.once("exit", this.restoreCursor);
    if (turning.size === 0) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }
    turning.add(this);
    this.render();
    // The reels never keep the process alive on their own.
    this.timer = setInterval(() => this.render(), 90);
    this.timer.unref?.();
    return this;
  }

  /** Stops at once, clearing the line and giving the cursor back. */
  halt(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write("\r\x1b[2K");
    this.restoreCursor();
    process.removeListener("exit", this.restoreCursor);
    turning.delete(this);
    if (turning.size === 0) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }

  update(text: string): void {
    this.text = text;
  }

  /**
   * Stops the animation and replaces its line with `line`. When the work was quicker than the eye,
   * the reels keep turning for `minMs` so the animation reads as one rather than a flicker.
   */
  async stop(line?: string, minMs = 0): Promise<void> {
    if (this.timer) {
      const left = minMs - (Date.now() - this.startedAt);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      this.halt();
    }
    if (line !== undefined) this.stream.write(`${line}\n`);
  }

  private render(): void {
    this.stream.write(`\r\x1b[2K  ${this.p.accent(cassetteFrame(this.frame++))} ${this.text}`);
  }

  private readonly restoreCursor = () => {
    this.stream.write("\x1b[?25h");
  };
}

/** Columns a text takes in a terminal: wide East Asian characters and emoji take two. */
export function width(text: string): number {
  let n = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x300 && code < 0x370) || code === 0x200b || code === 0xfe0f) continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

/** A run of text drawn in one style. */
export interface Span {
  text: string;
  style?: (text: string) => string;
}

/**
 * Lays styled text out in lines of at most `columns` columns, breaking at spaces where it can.
 * Styles are applied per line, so a wrapped span never bleeds its color into the margin.
 */
/** `text` padded with spaces to `columns` wide, counting wide characters as two. */
export const padTo = (text: string, columns: number) => text + " ".repeat(Math.max(0, columns - width(text)));

export function wrapSpans(spans: Span[], columns: number): string[] {
  const max = Math.max(columns, 10);
  const lines: Span[][] = [[]];
  let used = 0;
  /** The current line was started by wrapping rather than by a line break in the text. */
  let wrapped = false;
  const put = (text: string, style: Span["style"]) => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last && last.style === style) last.text += text;
    else line.push({ text, style });
    used += width(text);
  };
  const newline = (soft = true) => {
    lines.push([]);
    used = 0;
    wrapped = soft;
  };
  for (const span of spans) {
    for (const part of span.text.split(/(\n)/)) {
      if (part === "\n") {
        newline(false);
        continue;
      }
      for (const word of part.match(/\s+|\S+/g) ?? []) {
        const space = /^\s/.test(word);
        if (space && used === 0 && wrapped) continue; // no leading spaces on a wrapped line
        if (used + width(word) <= max) {
          put(word, span.style);
        } else if (space) {
          newline();
        } else if (width(word) <= max) {
          newline();
          put(word, span.style);
        } else {
          for (const char of word) {
            if (used + width(char) > max) newline();
            put(char, span.style);
          }
        }
      }
    }
  }
  // Trim before styling, so a styled line doesn't keep its trailing space inside the color codes.
  return lines.map((line) =>
    line
      .map((s, i) => (i === line.length - 1 ? { ...s, text: s.text.trimEnd() } : s))
      .map((s) => (s.style ? s.style(s.text) : s.text))
      .join("")
      .trimEnd(),
  );
}

/**
 * Colored text wrapped at spaces to `columns`, each line after the first starting with `indent`.
 * Color codes take no room.
 */
export function wrapAnsi(text: string, columns: number, indent = ""): string {
  const visible = (s: string) => width(s.replace(/\x1b\[[0-9;]*m/g, ""));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const room = columns - (lines.length > 0 ? visible(indent) : 0);
    if (line && visible(`${line} ${word}`) > room) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.join(`\n${indent}`);
}

