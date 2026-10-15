/** Word-level diffs of model output, for showing how an answer changed between two recordings. */

export interface Piece {
  op: "=" | "-" | "+";
  text: string;
}

/** While diffing, an unchanged piece also keeps its spelling in the old text (spacing may differ). */
interface Run extends Piece {
  before?: string;
}

export interface WordDiff {
  pieces: Piece[];
  /** Share of words the two texts have in common, in [0, 1]. */
  similarity: number;
}

/**
 * Words and punctuation, each with the whitespace before it, so that whitespace never matches on its
 * own and a change in spacing alone is not a change.
 */
const TOKEN = /\s*(?:[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_])|\s+$/gu;
const tokenize = (text: string) => text.match(TOKEN) ?? [];
const key = (token: string) => token.trim();
const isWord = (token: string) => /[\p{L}\p{N}]/u.test(token);

/** Up to this many cells two texts are aligned with a full table; longer ones with Myers' diff. */
const MAX_CELLS = 4_000_000;
/** Above this many edits, two long texts are shown as replaced rather than aligned. */
const MAX_EDITS = 2_000;

const replaced = (a: string[], b: string[]): Run[] => [...a.map((text): Run => ({ op: "-", text })), ...b.map((text): Run => ({ op: "+", text }))];

/**
 * Myers' O(ND) diff: fast when two long texts differ in few places, as two recordings of one
 * answer do. Undefined beyond `MAX_EDITS` edits.
 */
function myers(a: string[], b: string[]): Run[] | undefined {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  /** `v` before each step d, for diagonals -d…d. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && key(a[x]!) === key(b[y]!)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): Run[] {
  const runs: Run[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + d]! < v[k + 1 + d]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + d]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) runs.push({ op: "=", text: b[--y]!, before: a[--x]! });
    if (down) runs.push({ op: "+", text: b[--y]! });
    else runs.push({ op: "-", text: a[--x]! });
  }
  while (x > 0 && y > 0) runs.push({ op: "=", text: b[--y]!, before: a[--x]! });
  return runs.reverse();
}

/** Longest common subsequence of two token lists, as edit pieces. */
function align(a: string[], b: string[]): Run[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return replaced(a, b);
  if (n * m > MAX_CELLS) return myers(a, b) ?? replaced(a, b);
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        key(a[i]!) === key(b[j]!)
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pieces: Run[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]!) === key(b[j]!)) {
      pieces.push({ op: "=", text: b[j]!, before: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      pieces.push({ op: "-", text: a[i++]! });
    } else {
      pieces.push({ op: "+", text: b[j++]! });
    }
  }
  while (i < n) pieces.push({ op: "-", text: a[i++]! });
  while (j < m) pieces.push({ op: "+", text: b[j++]! });
  return pieces;
}

/** Joins runs of the same operation, putting removals before additions within each change. */
function merge(pieces: Run[]): Run[] {
  const out: Run[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) out.push({ op: "-", text: removed });
    if (added) out.push({ op: "+", text: added });
    removed = added = "";
  };
  for (const piece of pieces) {
    if (piece.op === "-") removed += piece.text;
    else if (piece.op === "+") added += piece.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.op === "=") {
        last.text += piece.text;
        last.before = (last.before ?? "") + (piece.before ?? piece.text);
      } else out.push({ ...piece });
    }
  }
  flush();
  return out;
}

/**
 * A lone short word or punctuation mark left unchanged between two changes reads as noise
 * (`~~is~~ ~~+~~12~~°C~~`); it is folded into the change around it instead.
 */
function absorb(pieces: Run[]): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const between = i > 0 && i < pieces.length - 1 && pieces[i - 1]!.op !== "=" && pieces[i + 1]!.op !== "=";
    if (piece.op === "=" && between && tokenize(piece.text).length === 1 && key(piece.text).length <= 3) {
      out.push({ op: "-", text: piece.before ?? piece.text }, { op: "+", text: piece.text });
    } else {
      out.push(piece);
    }
  }
  return merge(out);
}

export function diffWords(before: string, after: string): WordDiff {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && key(a[start]!) === key(b[start]!)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && key(a[endA - 1]!) === key(b[endB - 1]!)) {
    endA--;
    endB--;
  }
  const same = (from: number, to: number, offset: number): Run[] =>
    b.slice(from, to).map((text, k) => ({ op: "=", text, before: a[from + offset + k]! }));
  const pieces: Piece[] = absorb(
    merge([...same(0, start, 0), ...align(a.slice(start, endA), b.slice(start, endB)), ...same(endB, b.length, endA - endB)]),
  ).map(({ op, text }) => ({ op, text }));

  const words = (text: string) => tokenize(text).filter(isWord).length;
  const total = words(before) + words(after);
  const shared = pieces.filter((p) => p.op === "=").reduce((n, p) => n + words(p.text), 0);
  return { pieces, similarity: total === 0 ? 1 : (2 * shared) / total };
}
