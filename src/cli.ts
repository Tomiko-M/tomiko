import { spawn } from "node:child_process";
import { type Command, commandHelp, type Io, parseArgs } from "./commands/common.js";
import { diff } from "./commands/diff.js";
import { prune } from "./commands/prune.js";
import { record } from "./commands/record.js";
import { ask, execute } from "./commands/run.js";
import { scan } from "./commands/scan.js";
import { view } from "./commands/view.js";
import { animationEnabled, colorEnabled, paint, type Paint } from "./terminal.js";

export type { Io } from "./commands/common.js";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const COMMANDS: Command[] = [view, diff, record, scan, prune];

function help(p: Paint): string {
  const usage = COMMANDS.map((c) => c.usage[0]!.replace(/ \[options\]| \[-- test command\]/g, ""));
  const pad = Math.max(...usage.map((u) => u.length)) + 3;
  return [
    "",
    `  ${p.bold("tomiko")}${p.accent(".")}  ${p.dim("record & replay LLM API calls in tests")}`,
    "",
    `  ${p.bold("Usage")}`,
    `    tomiko ${p.accent("<command>")} ${p.dim("[options]")}`,
    "",
    `  ${p.bold("Commands")}`,
    ...COMMANDS.map((c, i) => `    ${p.accent(c.name)}${usage[i]!.slice(c.name.length).padEnd(pad - c.name.length)}${c.summary}`),
    "",
    `  ${p.bold("Options")}`,
    `    ${p.accent("-v, --version".padEnd(pad))}Show the version`,
    `    ${p.accent("-h, --help".padEnd(pad))}Show this help, or a command's with ${p.bold("tomiko <command> --help")}`,
    "",
  ].join("\n");
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
  columns: process.stdout.columns,
  env: process.env,
  interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
  confirm: ask,
  exec: execute(process.cwd()),
});

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const p = paint(io.color);
  const [name, ...rest] = argv;
  if (name === "-v" || name === "--version" || name === "version") {
    io.log(VERSION);
    return 0;
  }
  if (!name || name === "-h" || name === "--help" || name === "help") {
    const topic = name === "help" ? COMMANDS.find((c) => c.name === rest[0]) : undefined;
    io.log(topic ? commandHelp(topic, p) : help(p));
    return name ? 0 : 1;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    io.error(`  ${p.red("✖")} Unknown command: ${name}\n${help(p)}`);
    return 1;
  }
  const own = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (own.includes("-h") || own.includes("--help")) {
    io.log(commandHelp(command, p));
    return 0;
  }
  const args = parseArgs(rest, command.flags);
  if (typeof args === "string") {
    io.error(`  ${p.red("✖")} ${args}\n${commandHelp(command, p)}`);
    return 1;
  }
  if (!command.runs) args.positional.push(...args.rest.splice(0));
  return command.run(args, io, p);
}
