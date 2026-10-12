/** Number formatting shared by the command line. */

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`;

export const usd = (n: number) => (n > 0 && n < 0.0001 ? "<$0.0001" : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);

export const duration = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** `+17%`, `−8%`; undefined when there is nothing to compare against or no change. */
export function change(before: number, after: number): string | undefined {
  if (before === after) return undefined;
  if (before === 0) return "new";
  const pct = ((after - before) / before) * 100;
  const rounded = Math.abs(pct) < 1 ? pct.toFixed(1) : Math.round(pct).toString();
  if (Number(rounded) === 0) return undefined;
  return pct > 0 ? `+${rounded}%` : `−${rounded.replace("-", "")}%`;
}
