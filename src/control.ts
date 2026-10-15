/**
 * How `tomiko record` and `tomiko prune` steer the test runs they start, through the environment,
 * since the tests run in other processes: which cassettes to re-record, and where each cassette
 * reports what it served.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { delimiter, join, relative, resolve, sep } from "node:path";

/** What a cassette served in a run, one JSON line per cassette closed. */
export interface UsageEntry {
  file: string;
  /** The cassette's own file, when this run kept it in `TOMIKO_SHADOW` instead. */
  source?: string;
  mode: string;
  /** The file existed when the cassette was opened. */
  exists: boolean;
  /** Interactions in the file when it was opened. */
  size: number;
  /** Positions of the interactions it served, from 0. */
  used: number[];
  recorded: number;
  /** A request had no recording to match: the cassette is out of date. */
  mismatched: boolean;
  /** A request needed the file, and replay mode found none. */
  missing: boolean;
}

/**
 * `TOMIKO_RECORD`: cassette files and directories to re-record whatever the mode, separated like
 * `PATH`, or `@<file>` naming a file with one per line.
 */
export const RECORD_ENV = "TOMIKO_RECORD";
/** `TOMIKO_LOG`: a file each cassette appends its `UsageEntry` to when it closes. */
export const LOG_ENV = "TOMIKO_LOG";
/** `TOMIKO_MODEL`: the model every request is sent to instead of its own, for `tomiko matrix`. */
export const MODEL_ENV = "TOMIKO_MODEL";
/**
 * `TOMIKO_SHADOW`: a directory cassettes are read from and written to instead of their own place,
 * at the same path relative to the working directory, so a trial run leaves the real ones alone.
 */
export const SHADOW_ENV = "TOMIKO_SHADOW";

/** Where a cassette lives in this run: its own place, or its place in `TOMIKO_SHADOW`. */
export function shadowed(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const shadow = env[SHADOW_ENV];
  if (!shadow) return file;
  // A cassette outside the working directory keeps its path, without the way up.
  const inside = relative(process.cwd(), file).split(sep).map((part) => (part === ".." ? "_" : part));
  return join(resolve(shadow), ...inside);
}

export const modelOverride = (env: NodeJS.ProcessEnv = process.env) => env[MODEL_ENV] || undefined;

let cached: { value: string; paths: string[] } | undefined;

function chosenPaths(value: string): string[] {
  if (cached?.value === value) return cached.paths;
  const list = value.startsWith("@") ? readFileSync(value.slice(1), "utf8").split(/\r?\n/) : value.split(delimiter);
  const paths = list.map((p) => p.trim()).filter(Boolean).map((p) => resolve(p));
  cached = { value, paths };
  return paths;
}

/** Whether `TOMIKO_RECORD` names this cassette file or a directory it is in. */
export function chosenForRecording(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[RECORD_ENV];
  if (!value) return false;
  return chosenPaths(value).some((path) => file === path || file.startsWith(path.endsWith(sep) ? path : path + sep));
}

/** Appends to `TOMIKO_LOG`, if set. A log that can't be written never fails a test. */
export function logUsage(entry: UsageEntry, env: NodeJS.ProcessEnv = process.env): void {
  const log = env[LOG_ENV];
  if (!log) return;
  try {
    appendFileSync(log, `${JSON.stringify(entry)}\n`);
  } catch {
    // The command that asked for the log reports what is missing from it.
  }
}

export function readUsage(log: string): UsageEntry[] {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageEntry];
      } catch {
        return [];
      }
    });
}
