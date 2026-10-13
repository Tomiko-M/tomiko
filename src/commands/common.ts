import { readFile } from "node:fs/promises";
import type { Paint } from "../terminal.js";
import type { CassetteFile } from "../types.js";

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
  /** The terminal's width, for wrapping long lines. */
  columns?: number;
  env?: NodeJS.ProcessEnv;
  /** Someone is at the terminal to answer a question. */
  interactive?: boolean;
  /** Asks a yes/no question; true for yes. */
  confirm?(question: string): Promise<boolean>;
  /** Runs a shell command with extra environment variables, showing its output unless `quiet`. */
  exec?(command: string, env: Record<string, string>, options: { quiet: boolean }): Promise<ExecResult>;
}

export interface ExecResult {
  code: number;
  /** The end of the output of a quiet run. */
  output: string;
}

export type FlagSpec = Record<string, { type: "boolean" | "string" | "list"; short?: string; value?: string; help: string }>;

export interface Parsed {
  positional: string[];
  flags: Record<string, boolean | string | string[] | undefined>;
  /** Everything after `--`. */
  rest: string[];
}

/** `--flag`, `--flag value`, `--flag=value`, `-f value`; `--` ends the options. */
export function parseArgs(args: string[], spec: FlagSpec): Parsed | string {
  const parsed: Parsed = { positional: [], flags: {}, rest: [] };
  const byShort = new Map(Object.entries(spec).flatMap(([name, s]) => (s.short ? [[s.short, name] as const] : [])));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      parsed.rest = args.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      parsed.positional.push(arg);
      continue;
    }
    const [flag, inline] = arg.startsWith("--") ? [arg.slice(2).split("=")[0]!, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined] : [byShort.get(arg) ?? arg, undefined];
    const option = spec[flag];
    if (!option) return `Unknown option: ${arg}`;
    if (option.type === "boolean") {
      if (inline !== undefined) return `${arg.split("=")[0]} takes no value`;
      parsed.flags[flag] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined || value === "") return `${arg.split("=")[0]} needs a value`;
    if (option.type === "string") parsed.flags[flag] = value;
    else parsed.flags[flag] = [...((parsed.flags[flag] as string[] | undefined) ?? []), value];
  }
  return parsed;
}

export interface Command {
  name: string;
  /** Usage lines after `tomiko`. */
  usage: string[];
  /** One line for the command list. */
  summary: string;
  /** Paragraphs for the command's own help. */
  description: (p: Paint) => string[];
  flags: FlagSpec;
  /** What follows `--` is a command to run, not more paths. */
  runs?: boolean;
  run(args: Parsed, io: Io, p: Paint): Promise<number>;
}

export function commandHelp(command: Command, p: Paint): string {
  const options = Object.entries(command.flags).map(([name, f]) => {
    const flag = `${f.short ? `${f.short}, ` : ""}--${name}${f.value ? ` <${f.value}>` : ""}`;
    return [flag, f.help] as const;
  });
  const pad = Math.max(...options.map(([flag]) => flag.length), 0) + 3;
  return [
    "",
    ...command.usage.map((u) => `  ${p.bold("tomiko")} ${p.accent(u.split(" ")[0]!)}${u.slice(u.split(" ")[0]!.length)}`),
    "",
    ...command.description(p).map((line) => (line ? `  ${line}` : "")),
    ...(options.length > 0 ? ["", `  ${p.bold("Options")}`, ...options.map(([flag, help]) => `    ${p.accent(flag.padEnd(pad))}${help}`)] : []),
    "",
  ].join("\n");
}

/** A tomiko cassette file, or undefined for any other JSON. */
export function parseCassette(text: string | undefined): CassetteFile | undefined {
  if (text === undefined) return undefined;
  try {
    const data = JSON.parse(text) as Partial<CassetteFile> | null;
    return data !== null && typeof data === "object" && data.version === 1 && Array.isArray(data.interactions)
      ? (data as CassetteFile)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readCassette(file: string): Promise<CassetteFile | undefined> {
  return parseCassette(await readFile(file, "utf8").catch(() => undefined));
}

export const failure = (io: Io, p: Paint, message: string) => {
  io.error(`  ${p.red("✖")} ${message}`);
  return 1;
};
