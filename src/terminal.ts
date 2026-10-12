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
  link(text: string, url: string): string;
}

const wrap = (open: string, close: string) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;

export function paint(enabled: boolean, env: NodeJS.ProcessEnv = process.env): Paint {
  if (!enabled) {
    const plain = (text: string) => text;
    return { enabled, bold: plain, dim: plain, accent: plain, green: plain, red: plain, yellow: plain, link: plain };
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

export class Spinner {
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
    this.render();
    this.timer = setInterval(() => this.render(), 90);
    return this;
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
      clearInterval(this.timer);
      this.timer = undefined;
      this.stream.write("\r\x1b[2K");
      this.restoreCursor();
      process.removeListener("exit", this.restoreCursor);
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
