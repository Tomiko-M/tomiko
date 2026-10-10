import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderHtml } from "./view/html.js";
import { discoverCassettes } from "./view/discover.js";
import { viewModel } from "./view/model.js";

const HELP = `tomiko: record & replay LLM API calls in tests

Usage:
  tomiko view [paths...] [--out file.html] [--no-open]

Commands:
  view    Build a browsable HTML page of your cassettes and open it.
          Without paths, finds every __cassettes__ directory under the current
          directory. A directory you name is searched in full.

Options:
  --out <file>  Where to write the page (default: a temporary file)
  --no-open     Don't open the page in a browser
  -h, --help    Show this help
`;

export interface Io {
  cwd: string;
  log(message: string): void;
  error(message: string): void;
  open(file: string): Promise<boolean>;
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

const defaultIo: Io = {
  cwd: process.cwd(),
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  open: openInBrowser,
};

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

async function view(args: ViewArgs, io: Io): Promise<number> {
  const paths = args.paths.map((p) => resolve(io.cwd, p));
  const found = await discoverCassettes(paths, io.cwd);
  if (found.length === 0) {
    io.error(
      args.paths.length > 0
        ? `No cassettes found in ${args.paths.join(", ")}.`
        : `No cassettes found. tomiko looks in __cassettes__ directories; pass a path if yours are elsewhere.`,
    );
    return 1;
  }
  const model = viewModel(io.cwd, found);
  const out = args.out ? resolve(io.cwd, args.out) : join(tmpdir(), `tomiko-view-${Date.now()}.html`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderHtml(model), "utf8");
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  io.log(`${plural(found.length, "cassette")}, ${plural(model.requests, "request")} → ${out}`);
  if (args.open && !(await io.open(out))) io.log("Could not open a browser; open the file above.");
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    io.log(HELP);
    return command ? 0 : 1;
  }
  if (command === "view") {
    const args = parseView(rest);
    if (typeof args === "string") {
      io.error(`${args}\n\n${HELP}`);
      return 1;
    }
    return view(args, io);
  }
  io.error(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}
