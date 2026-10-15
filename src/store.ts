import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { TomikoError } from "./errors.js";
import type { CassetteFile } from "./types.js";

/**
 * `"agent/booking flow"` → `<dir>/agent/booking-flow.json`. Slashes create subdirectories; letters
 * in any script are kept, and `..` cannot escape the directory.
 */
export function cassettePath(dir: string, name: string): string {
  const segments = name
    .split("/")
    .map((s) =>
      s
        .trim()
        .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
        .replace(/^[.-]+|-+$/g, ""),
    )
    .filter(Boolean);
  if (segments.length === 0) throw new TomikoError(`Invalid cassette name: "${name}"`);
  return join(resolve(dir), ...segments) + ".json";
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A cassette as tomiko reads it, or undefined when `data` isn't one. Fields a hand-edited or older
 * file may lack (`meta`, headers) get their empty defaults.
 */
export function asCassette(data: unknown): CassetteFile | undefined {
  if (!isObj(data) || data.version !== 1 || !Array.isArray(data.interactions)) return undefined;
  for (const i of data.interactions) {
    if (!isObj(i) || !isObj(i.request) || !isObj(i.response)) return undefined;
    if (typeof i.request.method !== "string" || typeof i.request.url !== "string") return undefined;
    if (!isObj(i.response.body) || typeof i.response.status !== "number") return undefined;
    if (!isObj(i.response.headers)) i.response.headers = {};
    if (!isObj(i.meta)) i.meta = {};
    const meta = i.meta as Record<string, unknown>;
    if (typeof meta.recordedAt !== "string") meta.recordedAt = "";
    if (typeof meta.durationMs !== "number") meta.durationMs = 0;
  }
  return data as unknown as CassetteFile;
}

export async function loadCassette(file: string): Promise<CassetteFile | undefined> {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new TomikoError(`Cassette ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = asCassette(parsed);
  if (!data) throw new TomikoError(`Unsupported cassette format in ${file}`);
  return data;
}

/** Writes via a temp file and rename so an interrupted run never leaves a half-written cassette. */
export async function saveCassette(file: string, data: CassetteFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
