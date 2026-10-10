import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TomikoError } from "./errors.js";
import type { CassetteFile } from "./types.js";

/** `"agent/booking flow"` → `<dir>/agent/booking-flow.json`. Slashes create subdirectories. */
export function cassettePath(dir: string, name: string): string {
  const segments = name
    .split("/")
    .map((s) => s.trim().replace(/[^\w.-]+/g, "-").replace(/^\.+/, ""))
    .filter(Boolean);
  if (segments.length === 0) throw new TomikoError(`Invalid cassette name: "${name}"`);
  return join(resolve(dir), ...segments) + ".json";
}

export async function loadCassette(file: string): Promise<CassetteFile | undefined> {
  if (!existsSync(file)) return undefined;
  const data = JSON.parse(await readFile(file, "utf8")) as CassetteFile;
  if (data?.version !== 1 || !Array.isArray(data.interactions)) {
    throw new TomikoError(`Unsupported cassette format in ${file}`);
  }
  return data;
}

/** Writes via a temp file and rename so an interrupted run never leaves a half-written cassette. */
export async function saveCassette(file: string, data: CassetteFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
