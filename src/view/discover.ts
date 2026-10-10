import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CassetteFile } from "../types.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo"]);
const DEFAULT_DIR = "__cassettes__";

function isCassette(data: unknown): data is CassetteFile {
  const d = data as Partial<CassetteFile> | null;
  return d !== null && typeof d === "object" && d.version === 1 && Array.isArray(d.interactions);
}

async function readCassette(file: string): Promise<CassetteFile | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    return isCassette(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

async function walk(dir: string, inside: boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) await walk(path, inside || entry.name === DEFAULT_DIR, out);
    } else if (inside && entry.name.endsWith(".json")) {
      out.push(path);
    }
  }
}

/**
 * Finds cassettes under the given paths. A directory given explicitly is searched in full; the
 * default (the working directory) only inside `__cassettes__` directories, so a whole project
 * can be scanned without opening every JSON file in it.
 */
export async function discoverCassettes(
  paths: string[],
  root: string,
): Promise<{ path: string; file: string; data: CassetteFile }[]> {
  const explicit = paths.length > 0;
  const candidates: string[] = [];
  for (const target of explicit ? paths : [root]) {
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new Error(`No such file or directory: ${target}`);
    if (info.isFile()) candidates.push(target);
    else await walk(target, explicit, candidates);
  }
  const found = [];
  for (const file of [...new Set(candidates)].sort()) {
    const data = await readCassette(file);
    if (data) found.push({ path: relative(root, file) || file, file, data });
  }
  return found;
}
