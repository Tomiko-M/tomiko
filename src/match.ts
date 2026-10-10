type Json = unknown;

/** Removes the given dot paths (with `*` wildcards) from a deep copy of `value`. */
export function stripPaths(value: Json, paths: readonly string[]): Json {
  if (paths.length === 0) return value;
  const copy = structuredClone(value);
  for (const path of paths) removePath(copy, path.split("."));
  return copy;
}

function removePath(node: Json, segments: string[]): void {
  if (node === null || typeof node !== "object") return;
  const [head, ...rest] = segments;
  if (head === undefined) return;
  const record = node as Record<string, Json>;
  const keys = head === "*" ? Object.keys(record) : [head];
  // Walk arrays from the end so splicing doesn't shift indexes still to visit.
  if (Array.isArray(record)) keys.reverse();
  for (const key of keys) {
    if (!(key in record)) continue;
    if (rest.length === 0) {
      if (Array.isArray(record)) record.splice(Number(key), 1);
      else delete record[key];
    } else {
      removePath(record[key], rest);
    }
  }
}

/** JSON serialization with sorted object keys, so key order never affects matching. */
export function canonical(value: Json): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, Json>)[key]);
    return out;
  }
  return value;
}

/** Flattens a JSON value into `path -> leaf` pairs, e.g. `messages[0].content`. */
export function flatten(value: Json, prefix = "", out = new Map<string, Json>()): Map<string, Json> {
  // Empty containers are leaves too, except at the root where they would only add noise.
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out.set(prefix, []);
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0 && prefix) out.set(prefix, {});
    for (const key of keys) flatten((value as Record<string, Json>)[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** Dice coefficient over word multisets: 1 for identical text, near 1 for a one-word edit. */
function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

const leafText = (leaf: Json) => (typeof leaf === "string" ? leaf : canonical(leaf));

/**
 * Similarity of two JSON values in [0, 1]. Each leaf is weighted by its length, so a small edit
 * inside a long prompt barely moves the score while a changed model name or tool does.
 */
export function similarity(a: Json, b: Json): number {
  const fa = flatten(a);
  const fb = flatten(b);
  let total = 0;
  let score = 0;
  for (const path of new Set([...fa.keys(), ...fb.keys()])) {
    const inA = fa.has(path);
    const inB = fb.has(path);
    const la = inA ? leafText(fa.get(path)) : "";
    const lb = inB ? leafText(fb.get(path)) : "";
    const weight = Math.max(la.length, lb.length, 1);
    total += weight;
    if (!inA || !inB) continue;
    const va = fa.get(path);
    const vb = fb.get(path);
    if (canonical(va) === canonical(vb)) score += weight;
    else if (typeof va === "string" && typeof vb === "string") score += weight * textSimilarity(va, vb);
  }
  return total === 0 ? 1 : score / total;
}

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: Json;
  after?: Json;
}

/** Leaf-level differences going from the recorded value `before` to the live value `after`. */
export function diff(before: Json, after: Json): DiffEntry[] {
  const fa = flatten(before);
  const fb = flatten(after);
  const entries: DiffEntry[] = [];
  for (const path of new Set([...fa.keys(), ...fb.keys()])) {
    if (!fb.has(path)) entries.push({ path, kind: "removed", before: fa.get(path) });
    else if (!fa.has(path)) entries.push({ path, kind: "added", after: fb.get(path) });
    else if (canonical(fa.get(path)) !== canonical(fb.get(path)))
      entries.push({ path, kind: "changed", before: fa.get(path), after: fb.get(path) });
  }
  return entries;
}

const MAX_VALUE = 120;
const CONTEXT_WORDS = 4;

function clip(text: string): string {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** Shows only the changed span of two strings, as `…context [-old-]{+new+} context…`. */
function inlineTextDiff(a: string, b: string): string {
  const wa = a.split(/(\s+)/);
  const wb = b.split(/(\s+)/);
  let start = 0;
  while (start < wa.length && start < wb.length && wa[start] === wb[start]) start++;
  let endA = wa.length;
  let endB = wb.length;
  while (endA > start && endB > start && wa[endA - 1] === wb[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - CONTEXT_WORDS * 2);
  const lead = (from > 0 ? "…" : "") + wa.slice(from, start).join("");
  const tailEnd = Math.min(wa.length, endA + CONTEXT_WORDS * 2);
  const tail = wa.slice(endA, tailEnd).join("") + (tailEnd < wa.length ? "…" : "");
  const removed = wa.slice(start, endA).join("");
  const added = wb.slice(start, endB).join("");
  const change = `${removed ? `[-${clip(removed)}-]` : ""}${added ? `{+${clip(added)}+}` : ""}`;
  return JSON.stringify(lead + change + tail);
}

export function formatDiff(entries: DiffEntry[], limit = 12): string {
  const lines = entries.slice(0, limit).map((e) => {
    const path = e.path || "(body)";
    if (e.kind === "added") return `  + ${path}: ${clip(canonical(e.after))}`;
    if (e.kind === "removed") return `  - ${path}: ${clip(canonical(e.before))}`;
    if (typeof e.before === "string" && typeof e.after === "string")
      return `  ~ ${path}: ${inlineTextDiff(e.before, e.after)}`;
    return `  ~ ${path}: ${clip(canonical(e.before))} → ${clip(canonical(e.after))}`;
  });
  if (entries.length > limit) lines.push(`  … and ${entries.length - limit} more`);
  return lines.join("\n");
}
