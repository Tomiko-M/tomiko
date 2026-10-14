/**
 * Keeps API keys and other secrets out of cassettes. Cassettes are committed, so a key that ends up
 * in one (in a prompt, a tool result, an echoed config file) would be published with the repo.
 *
 * Detection is tuned for precision: known key formats, the values of your own secret environment
 * variables, and values assigned to fields named like secrets. A real finding fails the recording;
 * a false alarm would teach people to switch the guard off.
 */
import { isAbsolute, relative } from "node:path";
import { TomikoError } from "./errors.js";
import { paint, type Paint } from "./terminal.js";
import type { Interaction, RecordedRequest, SecretAction, SecretFinding, SecretsOptions, StreamEvent, TomikoOptions } from "./types.js";

type Json = unknown;
type Groups = Record<string, string | undefined>;

interface Rule {
  id: string;
  kind: string;
  pattern: RegExp;
  /** At least one must occur in a text for the pattern to be worth running. */
  hints?: string[];
  /** Or this must match it. */
  test?: RegExp;
  /** The public start of a key, which is safe to show: `sk-ant-api03-`. */
  prefix?: RegExp;
  /** `next` is the character right after the match, if any. */
  valid?: (secret: string, groups: Groups, next: string) => boolean;
  /** The secret is named after the field it is assigned to: `password=…`. */
  named?: boolean;
  /** Skips the placeholder check, for long encoded bodies that can contain `xxxx` by chance. */
  raw?: boolean;
}

/** Adds the flags every rule needs: `g` to find all matches, `d` for the secret group's position. */
function compile(pattern: RegExp): RegExp {
  const flags = new Set([...pattern.flags.replace("y", ""), "g", "d"]);
  return new RegExp(pattern.source, [...flags].join(""));
}

const rule = (r: Rule): Rule => ({ ...r, pattern: compile(r.pattern) });

const PLACEHOLDER =
  /redacted|example|placeholder|your[-_ ]?(?:api|key|token|secret|password)|dummy|fake|sample|changeme|xxxx|\*{3}|•{3}|\.{3}|…|<[^>]*>|\$\{|\{\{|%s/i;

/** Documentation and fixture values: `sk-ant-xxxxxxxx`, AWS's `…EXAMPLE` keys, `<your key>`. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || /(.)\1{5,}/.test(value);
}

/** jwt.io's sample token, which turns up whenever a model explains JWTs. */
const KNOWN_EXAMPLES = new Set([
  // The access token, refresh token, code and client secret in the OAuth 2.0 spec (RFC 6749).
  "2YotnFZFEjr1zCsicMWpAA",
  "tGzv3JOkF0XG5Qx2TlKWIA",
  "SplxlOBeZQQYbYS6WxSbIA",
  "7Fjfp0ZBr1KtDRbnfVdmIw",
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join("."),
]);

const SECRET_NAME =
  /(?:^|_)(?:api_?key|secret(?:_?key)?|client_?secret|access_?key|private_?key|(?:access|refresh|auth|bearer|session|id)?_?token|password|passwd|passphrase)$/;
const COUNTER_NAME = /(?:^|_)(?:max|min|input|output|total|prompt|completion|cache|reasoning|page|next|continuation|cursor|num|count)_?tokens?$/;

/** `ANTHROPIC_API_KEY`, `client_secret`, `refreshToken`, `db.password`; not `max_tokens`. */
export function isSecretName(name: string): boolean {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return SECRET_NAME.test(snake) && !COUNTER_NAME.test(snake);
}

/** Shannon entropy of a text in bits: how much a value could be guessed. */
function entropyBits(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) perChar -= (n / value.length) * Math.log2(n / value.length);
  return perChar * value.length;
}

/**
 * An identifier made of words, `OAuth2AccessToken` or `generate_key_v2`, as code is full of. In a
 * generated secret, letters fall into short runs that read as no word at all.
 */
function wordy(value: string): boolean {
  const pieces = value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  const letters = pieces.reduce((n, piece) => n + piece.length, 0);
  const inWords = pieces.filter((piece) => piece.length >= 3 && /[aeiouy]/i.test(piece)).reduce((n, piece) => n + piece.length, 0);
  return letters > 0 && inWords / letters >= 0.8;
}

const classes = (value: string) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;

/**
 * Whether a value assigned to a secret-named field is a real secret rather than code, a path, a
 * placeholder or a guessable demo value. Generated secrets mix letters and digits at random;
 * `self.password`, `OAuth2Token` and `postgres123` don't.
 */
function looksLikeSecret(value: string): boolean {
  if (value.length < 8 || value.length > 4096 || /\s/.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (isPlaceholder(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false; // config.apiKey2
  if (/^(?:\/|\.\.?\/|~\/|[A-Za-z]:\\|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) return false; // paths and URLs
  if (/^[A-Za-z_$][\w$]*$/.test(value) && wordy(value)) return false; // identifiers
  if (classes(value) < 3 && entropyBits(value) < 40) return false; // guessable
  return true;
}

const mixed = (secret: string) => /[0-9]/.test(secret) && /[A-Za-z]/.test(secret);

/** Known formats, most specific first: when two rules match the same text, the first one names it. */
const FORMATS = (
  [
    { id: "anthropic-api-key", kind: "Anthropic API key", pattern: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{32,}/, hints: ["sk-ant-"], prefix: /^sk-ant-[a-z]+\d*-/ },
    { id: "openrouter-api-key", kind: "OpenRouter API key", pattern: /\bsk-or-v\d+-[A-Za-z0-9]{40,}/, hints: ["sk-or-"], prefix: /^sk-or-v\d+-/ },
    {
      id: "openai-api-key",
      kind: "OpenAI API key",
      // Bounded before the marker, so a long run of key-like text can't make the search quadratic.
      pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9_-]{16,300}?T3BlbkFJ[A-Za-z0-9_-]{16,})/,
      hints: ["sk-"],
      prefix: /^sk-(?:proj-|svcacct-|admin-)?/,
    },
    { id: "google-api-key", kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, hints: ["AIza"], prefix: /^AIza/ },
    { id: "groq-api-key", kind: "Groq API key", pattern: /\bgsk_[A-Za-z0-9]{40,}/, hints: ["gsk_"], prefix: /^gsk_/ },
    { id: "xai-api-key", kind: "xAI API key", pattern: /\bxai-[A-Za-z0-9]{60,}/, hints: ["xai-"], prefix: /^xai-/ },
    { id: "huggingface-token", kind: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{30,}/, hints: ["hf_"], prefix: /^hf_/ },
    { id: "replicate-api-token", kind: "Replicate API token", pattern: /\br8_[A-Za-z0-9]{30,}/, hints: ["r8_"], prefix: /^r8_/ },
    { id: "perplexity-api-key", kind: "Perplexity API key", pattern: /\bpplx-[A-Za-z0-9]{40,}/, hints: ["pplx-"], prefix: /^pplx-/ },
    {
      id: "github-token",
      kind: "GitHub token",
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/,
      hints: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
      prefix: /^(?:gh[pousr]_|github_pat_)/,
    },
    { id: "gitlab-token", kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, hints: ["glpat-"], prefix: /^glpat-/ },
    { id: "slack-token", kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, hints: ["xox"], prefix: /^xox[a-z]-/ },
    {
      id: "slack-webhook",
      kind: "Slack webhook URL",
      pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/,
      hints: ["hooks.slack.com"],
      prefix: /^https:\/\/hooks\.slack\.com\/services\//,
    },
    { id: "stripe-secret-key", kind: "Stripe secret key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/, hints: ["k_live_", "k_test_"], prefix: /^[rs]k_(?:live|test)_/ },
    { id: "aws-access-key-id", kind: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, hints: ["AKIA", "ASIA"], prefix: /^(?:AKIA|ASIA)/ },
    { id: "npm-token", kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/, hints: ["npm_"], prefix: /^npm_/ },
    { id: "sendgrid-api-key", kind: "SendGrid API key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/, hints: ["SG."], prefix: /^SG\./ },
    {
      id: "private-key",
      kind: "Private key",
      pattern: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{40,20000}?-----END[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
      hints: ["PRIVATE KEY"],
      prefix: /^-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
      // The body is base64, its line breaks real or written as `\n`; `...` stands in for one in docs.
      valid: (secret) => !/\.\.\.|…|<[^>]*>/.test(secret) && /[A-Za-z0-9+/]{40,}/.test(secret.replace(/\\[nr]|\s+/g, "")),
      raw: true,
    },
    { id: "jwt", kind: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, hints: ["eyJ"], prefix: /^eyJ/ },
    // DeepSeek, Moonshot, DashScope and other OpenAI-compatible APIs use plain `sk-` keys.
    { id: "api-key", kind: "API key", pattern: /\bsk-[A-Za-z0-9]{32,}(?![A-Za-z0-9_-])/, hints: ["sk-"], prefix: /^sk-/, valid: mixed },
  ] satisfies Rule[]
).map(rule);

/** Secrets recognized by where they appear rather than by their format. */
const CONTEXTS = (
  [
    { id: "bearer-token", kind: "Bearer token", pattern: /\b[Bb]earer[ \t]+(?<secret>[A-Za-z0-9._~+/-]{20,}=*)/, hints: ["earer"], valid: mixed },
    {
      id: "url-password",
      kind: "Password in a URL",
      pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/?#@"'<>]{1,256}:(?<secret>[^\s/?#@"'<>]{3,256})@/i,
      hints: ["://"],
      valid: (secret) => !/^(?:pass(?:word)?|secret|pwd)$/i.test(secret),
    },
    {
      id: "assignment",
      kind: "Secret",
      // The lookbehind starts names only at word starts, keeping long unbroken strings linear.
      // A quoted value runs to its closing quote, whatever it contains; a bare one to the first
      // character that can't be in one.
      pattern:
        /(?<![A-Za-z0-9_.-])(?<name>[A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?:(?<q>["'`])(?<secret>(?:\\.|(?!\k<q>)[^\\\n]){8,4096})\k<q>|(?<bare>[^\s"'`,;&(){}<>[\]\\]{8,}))/,
      test: /key|secret|token|passw|passphrase/i,
      // `token=base64url(random32)`, `key: Map<…>`, `secret = keys[0]`: code, not a value.
      valid: (secret, groups, next) => isSecretName(groups.name ?? "") && looksLikeSecret(secret) && !"(<[".includes(next || "-"),
      named: true,
    },
  ] satisfies Rule[]
).map(rule);

/* -------------------------------------------------------------------------------------------- */

export interface Guard {
  action: SecretAction;
  rules: Rule[];
  allow: (string | RegExp)[];
  /** Secret environment variables, longest value first, so a value containing another one wins. */
  env: { name: string; value: string }[];
}

const ACTIONS: readonly SecretAction[] = ["fail", "redact", "warn"];

/** Environment variables named like secrets, with values long enough to search for safely. */
function secretEnv(env: NodeJS.ProcessEnv): Guard["env"] {
  const found: Guard["env"] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 12 || value.length > 4096 || !isSecretName(name)) continue;
    if (/\s/.test(value) || isPlaceholder(value) || /^(?:\/|\.\.?\/|~\/|[A-Za-z]:\\)/.test(value)) continue;
    found.push({ name, value });
  }
  return found.sort((a, b) => b.value.length - a.value.length);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "secret";

/** Resolves the `secrets` option. `undefined` means the guard is off. */
export function secretGuard(option: TomikoOptions["secrets"], env: NodeJS.ProcessEnv = process.env): Guard | undefined {
  if (option === false) return undefined;
  const options: SecretsOptions = typeof option === "string" ? { action: option } : (option ?? {});
  const action = options.action ?? "fail";
  if (!ACTIONS.includes(action)) {
    throw new TomikoError(`Unknown secrets action "${String(action)}". Expected one of: ${ACTIONS.join(", ")}.`);
  }
  const custom = (options.patterns ?? []).map((p, i): Rule => {
    const { name, pattern } = p instanceof RegExp ? { name: undefined, pattern: p } : p;
    if (!(pattern instanceof RegExp)) throw new TomikoError(`secrets.patterns[${i}] is not a regular expression.`);
    return rule({ id: name ? slug(name) : "custom", kind: name ?? "Secret", pattern });
  });
  for (const value of options.allow ?? []) {
    if (typeof value !== "string" && !(value instanceof RegExp)) {
      throw new TomikoError("secrets.allow takes strings and regular expressions.");
    }
  }
  return {
    action,
    // Your own formats come first: you know them best.
    rules: [...custom, ...FORMATS, ...CONTEXTS],
    allow: options.allow ?? [],
    env: options.env === false ? [] : secretEnv(env),
  };
}

/* -------------------------------------------------------------------------------------------- */

interface Hit {
  start: number;
  end: number;
  value: string;
  id: string;
  kind: string;
  /** Names the placeholder: `[REDACTED:anthropic-api-key]`. */
  label: string;
  prefix?: RegExp;
  env?: string;
  priority: number;
}

function allowed(value: string, guard: Guard): boolean {
  if (KNOWN_EXAMPLES.has(value)) return true;
  return guard.allow.some((a) => (typeof a === "string" ? a === value : new RegExp(a.source, a.flags.replace(/[gy]/g, "")).test(value)));
}

/** Every secret in `text`, without overlaps. `key` is the JSON field the text is the value of. */
function scanText(text: string, guard: Guard, key?: string): Hit[] {
  const hits: Hit[] = [];
  const rules = guard.rules;
  const envPriority = rules.findIndex((r) => CONTEXTS.includes(r));
  rules.forEach((r, priority) => {
    if (r.hints && !r.hints.some((h) => text.includes(h))) return;
    if (r.test && !r.test.test(text)) return;
    for (const m of text.matchAll(r.pattern)) {
      const groups: Groups = m.groups ?? {};
      const [start, end] = m.indices?.groups?.secret ?? m.indices?.groups?.bare ?? m.indices![0]!;
      const value = text.slice(start, end);
      const next = text[m.index + m[0].length] ?? "";
      if (value.length === 0 || (!r.raw && isPlaceholder(value)) || (r.valid && !r.valid(value, groups, next))) continue;
      const name = r.named ? groups.name : undefined;
      hits.push({
        start,
        end,
        value,
        id: r.id,
        kind: name ? `Value of "${name}"` : r.kind,
        label: name ? slug(name) : r.id,
        prefix: r.prefix,
        priority,
      });
    }
  });
  for (const { name, value } of guard.env) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
      hits.push({ start: at, end: at + value.length, value, id: "env", kind: `Value of $${name}`, label: `$${name}`, env: name, priority: envPriority - 0.5 });
    }
  }
  if (key !== undefined && hits.length === 0 && isSecretName(key) && looksLikeSecret(text)) {
    hits.push({ start: 0, end: text.length, value: text, id: "field", kind: `Value of "${key}"`, label: slug(key), priority: rules.length });
  }

  // The most specific rule names each secret; your environment variable, if it is one, is noted.
  const kept: Hit[] = [];
  for (const hit of hits.filter((h) => !allowed(h.value, guard)).sort((a, b) => a.priority - b.priority || a.start - b.start)) {
    const overlap = kept.find((k) => hit.start < k.end && k.start < hit.end);
    if (!overlap) kept.push(hit);
    else if (hit.env && !overlap.env && hit.start <= overlap.start && hit.end >= overlap.end) overlap.env = hit.env;
  }
  return kept.sort((a, b) => a.start - b.start);
}

export const placeholder = (hit: { label: string }) => `[REDACTED:${hit.label}]`;

/** `sk-ant-api03-…f9Qa`: the public prefix and the last four characters, never more. */
function preview(hit: Hit): string {
  const head = hit.prefix?.exec(hit.value)?.[0] ?? "";
  // A key's body is all secret, and its line breaks may be written as `\n`: show the header only.
  if (hit.id === "private-key") return `${head}…`;
  return hit.value.length - head.length >= 16 ? `${head}…${hit.value.slice(-4)}` : `${head}••••••••`;
}

/* -------------------------------------------------------------------------------------------- */

/** One piece of a string as it is stored; a streamed text is spread over many events. */
interface Segment {
  text: string;
  write(text: string): void;
}

/** A string in an interaction worth scanning, and how to rewrite it. */
interface Site {
  part: string;
  path: string;
  key?: string;
  segments: Segment[];
}

type Visit = (text: string, path: string, key: string | undefined, write: (text: string) => void) => void;

function walk(node: Json, path: string, key: string | undefined, write: (text: string) => void, visit: Visit): void {
  if (typeof node === "string") {
    visit(node, path, key, write);
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, key, (text) => (node[i] = text), visit));
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, Json>;
    for (const k of Object.keys(record)) {
      walk(record[k], path ? `${path}.${k}` : k, k, (text) => (record[k] = text), visit);
    }
  }
}

function jsonSites(part: string, value: Json, write: (text: string) => void, sites: Site[], prefix = ""): void {
  walk(value, prefix, undefined, write, (text, path, key, set) => {
    sites.push({ part, path, key, segments: [{ text, write: set }] });
  });
}

/** Fields that streaming APIs spread over many events: text, tool arguments, reasoning. */
const STREAMED = new Set(["text", "partial_json", "content", "arguments", "delta", "thinking", "refusal", "reasoning_content", "input", "generation", "outputText"]);

interface SseLine {
  start: number;
  end: number;
  text: string;
  event?: { prefix: string; value: Json; dirty: boolean };
}

/**
 * The strings in a recorded event stream. A text that was streamed in pieces is scanned whole, so
 * a key the model spelled out over several events is still found, and redacting it rewrites each
 * event it touched.
 */
function streamSites(chunks: string[], replace: (chunks: string[]) => void, sites: Site[]): () => void {
  const raw = chunks.join("");
  const lines: SseLine[] = [];
  for (const m of raw.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (m[0] === "") continue;
    const content = m[0].replace(/[\r\n]+$/, "");
    const line: SseLine = { start: m.index, end: m.index + content.length, text: content };
    const data = /^data: ?/.exec(content);
    if (data) {
      try {
        const value: Json = JSON.parse(content.slice(data[0].length));
        if (value !== null && typeof value === "object") line.event = { prefix: data[0], value, dirty: false };
      } catch {
        // Not JSON: scanned as a plain line.
      }
    }
    lines.push(line);
  }

  const leaves: Leaf[] = [];
  let events = 0;
  for (const line of lines) {
    const event = line.event;
    if (!event) {
      if (line.text.trim() && line.text !== "data: [DONE]") {
        sites.push({
          part: "response stream",
          path: "",
          segments: [{ text: line.text, write: (text) => (line.text = text) }],
        });
      }
      continue;
    }
    const n = ++events;
    walk(event.value, "", undefined, () => {}, (text, path, key, set) => {
      leaves.push({
        event: n,
        path,
        key,
        segment: {
          text,
          write: (value) => {
            set(value);
            event.dirty = true;
          },
        },
      });
    });
  }

  channelSites(leaves, sites);

  // Rewrites only the lines that changed and keeps the chunking of everything else, so a replay
  // still arrives in the same pieces.
  return () => {
    const edits = lines
      .map((line) => ({
        start: line.start,
        end: line.end,
        text: line.event?.dirty ? line.event.prefix + JSON.stringify(line.event.value) : line.text,
      }))
      .filter((edit) => edit.text !== raw.slice(edit.start, edit.end));
    if (edits.length > 0) replace(rechunk(chunks, edits));
  };
}

interface Leaf {
  event: number;
  path: string;
  key?: string;
  segment: Segment;
}

/** A field streamed over several events is one site, so a secret split across them is found. */
function channelSites(leaves: Leaf[], sites: Site[]): void {
  const counts = new Map<string, number>();
  for (const leaf of leaves) counts.set(leaf.path, (counts.get(leaf.path) ?? 0) + 1);
  const channels = new Map<string, Site>();
  for (const leaf of leaves) {
    if (leaf.key !== undefined && STREAMED.has(leaf.key) && (counts.get(leaf.path) ?? 0) > 1) {
      const channel = channels.get(leaf.path) ?? { part: "response stream", path: leaf.path, key: leaf.key, segments: [] };
      channel.segments.push(leaf.segment);
      channels.set(leaf.path, channel);
    } else {
      sites.push({ part: "response stream", path: `event ${leaf.event} › ${leaf.path}`, key: leaf.key, segments: [leaf.segment] });
    }
  }
  sites.push(...channels.values());
}

/** The strings in a Bedrock event stream, which a cassette stores decoded, so edits go straight in. */
function awsStreamSites(events: StreamEvent[], sites: Site[]): void {
  const leaves: Leaf[] = [];
  events.forEach((event, i) => {
    for (const field of ["data", "bytes"] as const) {
      if (event[field] === undefined) continue;
      walk(event[field] as Json, "", undefined, (text) => (event[field] = text), (text, path, key, set) => {
        leaves.push({ event: i + 1, path, key, segment: { text, write: set } });
      });
    }
    const text = event.base64 === undefined ? undefined : decodeText(event.base64);
    if (text !== undefined) {
      sites.push({
        part: "response stream",
        path: `event ${i + 1}`,
        segments: [{ text, write: (value) => (event.base64 = Buffer.from(value, "utf8").toString("base64")) }],
      });
    }
  });
  channelSites(leaves, sites);
}

/** Applies `edits` to the concatenated chunks, keeping every chunk boundary outside an edit. */
function rechunk(chunks: string[], edits: { start: number; end: number; text: string }[]): string[] {
  const raw = chunks.join("");
  let text = "";
  let at = 0;
  const shifts: { at: number; end: number; delta: number }[] = [];
  for (const edit of edits) {
    text += raw.slice(at, edit.start) + edit.text;
    shifts.push({ at: edit.start, end: edit.end, delta: edit.text.length - (edit.end - edit.start) });
    at = edit.end;
  }
  text += raw.slice(at);

  const bounds: number[] = [];
  let offset = 0;
  for (const chunk of chunks.slice(0, -1)) {
    offset += chunk.length;
    if (shifts.some((s) => offset > s.at && offset < s.end)) continue;
    bounds.push(offset + shifts.filter((s) => s.end <= offset).reduce((sum, s) => sum + s.delta, 0));
  }
  const out: string[] = [];
  let from = 0;
  for (const bound of [...bounds, text.length]) {
    if (bound > from) out.push(text.slice(from, bound));
    from = Math.max(from, bound);
  }
  return out;
}

function requestSites(request: RecordedRequest, sites: Site[]): void {
  sites.push({ part: "request URL", path: "", segments: [{ text: request.url, write: (text) => (request.url = text) }] });
  jsonSites("request body", request.body, (text) => (request.body = text), sites);
}

interface Sites {
  sites: Site[];
  /** Writes edits that span more than one site back into the interaction. */
  commit(): void;
}

function interactionSites(interaction: Interaction): Sites {
  const sites: Site[] = [];
  let commit = () => {};
  requestSites(interaction.request, sites);
  const { response } = interaction;
  for (const name of Object.keys(response.headers ?? {})) {
    sites.push({
      part: "response header",
      path: name,
      segments: [{ text: response.headers[name]!, write: (text) => (response.headers[name] = text) }],
    });
  }
  const body = response.body;
  switch (body.type) {
    case "json":
      jsonSites("response body", body.value, (text) => (body.value = text), sites);
      break;
    case "text":
      sites.push({ part: "response body", path: "", segments: [{ text: body.value, write: (text) => (body.value = text) }] });
      break;
    case "sse":
      commit = streamSites(body.chunks, (chunks) => (body.chunks = chunks), sites);
      break;
    case "eventstream":
      awsStreamSites(body.events, sites);
      break;
    case "base64": {
      const text = decodeText(body.value);
      if (text !== undefined) {
        sites.push({
          part: "response body",
          path: "",
          segments: [{ text, write: (value) => (body.value = Buffer.from(value, "utf8").toString("base64")) }],
        });
      }
      break;
    }
    case "empty":
      break;
  }
  return { sites, commit };
}

/** A binary body that is really text (served without a content type), or undefined. */
function decodeText(base64: string): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Replaces each hit with its placeholder, editing every segment a hit spans. */
function redactSite(site: Site, hits: Hit[]): void {
  const edits = site.segments.map(() => [] as { start: number; end: number; text: string }[]);
  let offset = 0;
  const bounds = site.segments.map((s) => {
    const range = { start: offset, end: offset + s.text.length };
    offset = range.end;
    return range;
  });
  for (const hit of hits) {
    let first = true;
    bounds.forEach((b, i) => {
      if (hit.start >= b.end || hit.end <= b.start || b.end === b.start) return;
      edits[i]!.push({
        start: Math.max(hit.start, b.start) - b.start,
        end: Math.min(hit.end, b.end) - b.start,
        text: first ? placeholder(hit) : "",
      });
      first = false;
    });
  }
  site.segments.forEach((segment, i) => {
    const list = edits[i]!;
    if (list.length === 0) return;
    let text = segment.text;
    for (const edit of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    segment.write(text);
  });
}

/* -------------------------------------------------------------------------------------------- */

/** A secret found in a cassette, with its value. Internal: only previews leave this module. */
export interface Found {
  interaction: number;
  part: string;
  path: string;
  hit: Hit;
}

function scanSites(sites: Site[], guard: Guard, interaction: number, found: Found[]): Map<Site, Hit[]> {
  const bySite = new Map<Site, Hit[]>();
  for (const site of sites) {
    const text = site.segments.map((s) => s.text).join("");
    const hits = scanText(text, guard, site.segments.length === 1 ? site.key : undefined);
    if (hits.length === 0) continue;
    bySite.set(site, hits);
    for (const hit of hits) found.push({ interaction, part: site.part, path: site.path, hit });
  }
  return bySite;
}

/** Every secret in the interactions, in order of appearance. */
export function scanInteractions(interactions: readonly Interaction[], guard: Guard): Found[] {
  const found: Found[] = [];
  interactions.forEach((interaction, i) => scanSites(interactionSites(interaction).sites, guard, i, found));
  return found;
}

/**
 * Copies of the interactions with every secret replaced by a placeholder such as
 * `[REDACTED:anthropic-api-key]`. Interactions without secrets are returned as they are.
 */
export function redactInteractions(interactions: readonly Interaction[], guard: Guard): { interactions: Interaction[]; found: Found[] } {
  const found: Found[] = [];
  const out = interactions.map((interaction, i) => {
    if (scanSites(interactionSites(interaction).sites, guard, i, []).size === 0) return interaction;
    const copy = structuredClone(interaction);
    const { sites, commit } = interactionSites(copy);
    for (const [site, hits] of scanSites(sites, guard, i, found)) redactSite(site, hits);
    commit();
    return copy;
  });
  return { interactions: out, found };
}

/**
 * The request as matching sees it: with secrets replaced by the placeholders a redacted recording
 * holds, so a cassette saved with `secrets: "redact"` still matches the live request.
 */
export function withoutSecrets(request: RecordedRequest, guard: Guard): RecordedRequest {
  const sites: Site[] = [];
  requestSites(request, sites);
  if (scanSites(sites, guard, 0, []).size === 0) return request;
  const copy = structuredClone(request);
  const copySites: Site[] = [];
  requestSites(copy, copySites);
  for (const [site, hits] of scanSites(copySites, guard, 0, [])) redactSite(site, hits);
  return copy;
}

/**
 * Replaces secrets in a text for display: `sk-ant-api03-…f9Qa`. `key` is the field the text is the
 * value of, so that `api_key: "…"` is masked whatever its format.
 */
export function maskSecrets(text: string, guard: Guard | undefined = secretGuard(undefined), key?: string): string {
  if (!guard) return text;
  let out = text;
  for (const hit of scanText(text, guard, key).reverse()) out = out.slice(0, hit.start) + preview(hit) + out.slice(hit.end);
  return out;
}

/** A copy of a JSON value with every secret in it masked, for printing it whole. */
export function maskJson(value: unknown, guard: Guard | undefined, key?: string): unknown {
  if (typeof value === "string") return maskSecrets(value, guard, key);
  if (Array.isArray(value)) return value.map((item) => maskJson(item, guard, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskJson(v, guard, k)]));
  }
  return value;
}

const location = (f: Found) => (f.path ? `${f.part} › ${f.path}` : f.part);

/** One entry per distinct secret, at its first appearance, counting every other place it appears. */
export function summarize(found: readonly Found[]): (SecretFinding & { value: string })[] {
  const byValue = new Map<string, SecretFinding & { value: string }>();
  for (const f of found) {
    const existing = byValue.get(f.hit.value);
    if (existing) {
      existing.occurrences++;
      existing.env ??= f.hit.env;
      continue;
    }
    byValue.set(f.hit.value, {
      kind: f.hit.kind,
      rule: f.hit.id,
      ...(f.hit.env ? { env: f.hit.env } : {}),
      preview: preview(f.hit),
      request: f.interaction + 1,
      location: location(f),
      occurrences: 1,
      value: f.hit.value,
    });
  }
  return [...byValue.values()];
}

/** Findings as they are shown to people and returned from the API: without the secret itself. */
export function publicFindings(found: readonly Found[]): SecretFinding[] {
  return summarize(found).map(({ value: _value, ...finding }) => finding);
}

/**
 * Secrets in a cassette's interactions. Only a masked preview of each is returned. The options are
 * those of the `secrets` option; the action is ignored.
 */
export function findSecrets(
  cassette: { interactions: readonly Interaction[] } | readonly Interaction[],
  options: SecretsOptions = {},
): SecretFinding[] {
  const interactions = "interactions" in cassette ? cassette.interactions : cassette;
  const guard = secretGuard({ ...options, action: "warn" })!;
  return publicFindings(scanInteractions(interactions, guard));
}

/* -------------------------------------------------------------------------------------------- */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * ```
 * ● Anthropic API key  sk-ant-api03-…f9Qa  your $ANTHROPIC_API_KEY
 *   #1 request body › messages[0].content · and 2 more places
 * ```
 */
export function formatFindings(findings: readonly SecretFinding[], p: Paint = paint(false), indent = "  "): string[] {
  return findings.flatMap((f) => {
    const env = f.env && f.rule !== "env" ? `  ${p.yellow(`your $${f.env}`)}` : "";
    const more = f.occurrences > 1 ? p.dim(` · and ${plural(f.occurrences - 1, "more place")}`) : "";
    return [
      `${indent}${p.red("●")} ${p.bold(f.kind)}  ${p.dim(f.preview)}${env}`,
      `${indent}  ${p.dim(`#${f.request} ${f.location}`)}${more}`,
    ];
  });
}

/** Relative to the working directory when the file is below it. */
function shortPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

export class SecretsFoundError extends TomikoError {
  constructor(
    readonly cassette: string,
    readonly file: string,
    readonly findings: SecretFinding[],
  ) {
    super(
      [
        `Cassette "${cassette}" was not saved: it contains ${plural(findings.length, "secret")}.`,
        "",
        ...formatFindings(findings),
        "",
        `Nothing was written to ${shortPath(file)}. To save it:`,
        `  · secrets: "redact"           replaces each one with a placeholder; replays still match`,
        `  · redact: (interaction) => …  scrubs them yourself before saving`,
        `  · secrets: { allow: [...] }   for values that are not real secrets`,
      ].join("\n"),
    );
  }
}
