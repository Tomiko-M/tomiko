import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { animationEnabled, colorEnabled, paint, type Paint, Spinner } from "./terminal.js";
import { renderHtml } from "./view/html.js";
import { discoverCassettes } from "./view/discover.js";
import { viewModel } from "./view/model.js";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

function help(p: Paint): string {
  const head = (text: string) => p.bold(text);
  const cmd = (text: string) => p.accent(text);
  return [
    "",
    `  ${p.bold("tomiko")}${p.accent(".")}  ${p.dim("record & replay LLM API calls in tests")}`,
    "",
    `  ${head("Usage")}`,
    `    ${cmd("tomiko view")} ${p.dim("[paths...] [--out file.html] [--no-open]")}`,
    "",
    `  ${head("Commands")}`,
    `    ${cmd("view")}          Build a browsable page of your cassettes and open it.`,
    `                  Without paths, finds every __cassettes__ directory below`,
    `                  this one. A directory you name is searched in full.`,
    "",
    `  ${head("Options")}`,
    `    ${cmd("--out")} <file>  Where to write the page ${p.dim("(default: a temporary file)")}`,
    `    ${cmd("--no-open")}     Don't open the page in a browser`,
    `    ${cmd("-v, --version")} Show the version`,
    `    ${cmd("-h, --help")}    Show this help`,
    "",
  ].join("\n");
}

type Stream = { isTTY?: boolean; write(chunk: string): unknown };

export interface Io {
  cwd: string;
  log(message: string): void;
  error(message: string): void;
  open(file: string): Promise<boolean>;
  /** Where the spinner draws. */
  stream: Stream;
  color: boolean;
  animate: boolean;
}

function openInBrowser(file: string): Promise<boolean> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => done(false));
    child.on("spawn", () => {
      child.unref();
      done(true);
    });
  });
}

const defaultIo = (): Io => ({
  cwd: process.cwd(),
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  open: openInBrowser,
  stream: process.stderr,
  color: colorEnabled(process.stdout),
  animate: animationEnabled(process.stderr),
});

interface ViewArgs {
  paths: string[];
  out?: string;
  open: boolean;
}

function parseView(args: string[]): ViewArgs | string {
  const parsed: ViewArgs = { paths: [], open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-open") parsed.open = false;
    else if (arg === "--out" || arg === "-o") {
      const value = args[++i];
      if (!value) return `${arg} needs a file path`;
      parsed.out = value;
    } else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg.startsWith("-")) return `Unknown option: ${arg}`;
    else parsed.paths.push(arg);
  }
  return parsed;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);
const usd = (n: number) => (n > 0 && n < 0.0001 ? "<$0.0001" : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);

async function view(args: ViewArgs, io: Io, p: Paint): Promise<number> {
  const spinner = new Spinner(io.stream, p, io.animate).start("Reading cassettes…");
  const paths = args.paths.map((path) => resolve(io.cwd, path));
  let found;
  try {
    found = await discoverCassettes(paths, io.cwd);
  } catch (error) {
    await spinner.stop();
    io.error(`  ${p.red("✖")} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (found.length === 0) {
    await spinner.stop();
    io.error(
      `  ${p.red("✖")} ` +
        (args.paths.length > 0
          ? `No cassettes found in ${args.paths.join(", ")}.`
          : `No cassettes found. tomiko looks in ${p.bold("__cassettes__")} directories; pass a path if yours are elsewhere.`),
    );
    return 1;
  }

  spinner.update(`Building the page from ${plural(found.length, "cassette")}…`);
  const model = viewModel(io.cwd, found);
  const out = args.out ? resolve(io.cwd, args.out) : join(tmpdir(), `tomiko-view-${Date.now()}.html`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderHtml(model), "utf8");
  await spinner.stop(undefined, 600);

  const models = [...new Set(model.cassettes.flatMap((c) => c.interactions.map((i) => i.model)).filter(Boolean))];
  const allTokens = model.usage.inputTokens + model.usage.outputTokens + model.usage.cacheReadTokens + model.usage.cacheWriteTokens;
  const details = [
    `${tokens(allTokens)} tokens`,
    model.cost === null ? "no price" : `${usd(model.cost)} to record`,
    models.join(", "),
  ].filter(Boolean);
  const shown = relative(io.cwd, out).startsWith("..") ? out : relative(io.cwd, out);

  io.log(`  ${p.green("✔")} ${p.bold(plural(found.length, "cassette"))}, ${p.bold(plural(model.requests, "request"))}`);
  io.log(`    ${p.dim(details.join(" · "))}`);
  io.log(`    ${p.accent("→")} ${p.link(shown, pathToFileURL(out).href)}`);
  if (args.open) {
    io.log(`    ${p.dim((await io.open(out)) ? "Opened in your browser." : "Couldn't open a browser; open the file above.")}`);
  }
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const p = paint(io.color);
  const [command, ...rest] = argv;
  if (command === "-v" || command === "--version" || command === "version") {
    io.log(VERSION);
    return 0;
  }
  if (!command || command === "-h" || command === "--help" || command === "help") {
    io.log(help(p));
    return command ? 0 : 1;
  }
  if (command === "view") {
    const args = parseView(rest);
    if (typeof args === "string") {
      io.error(`  ${p.red("✖")} ${args}\n${help(p)}`);
      return 1;
    }
    return view(args, io, p);
  }
  io.error(`  ${p.red("✖")} Unknown command: ${command}\n${help(p)}`);
  return 1;
}
