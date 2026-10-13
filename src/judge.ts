/**
 * A model as the judge of what another model said: "apologizes and offers a refund". Its requests
 * go through the active cassette like any other, so a verdict is recorded once and replayed after:
 * free, instant and the same on every run.
 */
import { TomikoError } from "./errors.js";
import { dispatch, runtime } from "./runtime.js";

export interface JudgeOptions {
  /**
   * The model that judges: an Anthropic, OpenAI or Gemini model, told apart by its name.
   * Default: `claude-haiku-5-5`. The API key comes from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
   * `GEMINI_API_KEY`; replays need none.
   */
  model?: string;
}

export interface Verdict {
  pass: boolean;
  /** One sentence on why. */
  reason: string;
  model: string;
}

/** Marks a request as the judge's, so assertions about what the model did leave it out. */
export const JUDGE_HEADER = "x-tomiko-judge";

const DEFAULT_MODEL = "claude-haiku-5-5";

const SYSTEM = [
  "You grade the output of an AI system for an automated test.",
  "Decide whether the OUTPUT meets every part of the CRITERIA. Judge only what the output says, not what it could have said.",
  'Reply with JSON only, no other text: {"pass": true or false, "reason": "one short sentence"}',
].join("\n");

const prompt = (output: string, criteria: string) => `CRITERIA:\n${criteria}\n\nOUTPUT:\n${output}`;

function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

type Provider = "anthropic" | "openai" | "google";

function providerOf(model: string): Provider {
  if (/^claude|anthropic/i.test(model)) return "anthropic";
  if (/^(gpt|o\d|chatgpt)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  throw new TomikoError(`tomiko can't tell which API serves the judge model "${model}". Use a claude-, gpt- or gemini- model.`);
}

/** The judge's request, in its provider's format. The key header is left out when there is none. */
function request(provider: Provider, model: string, output: string, criteria: string): { url: string; headers: Record<string, string>; body: unknown } {
  const headers: Record<string, string> = { "content-type": "application/json", [JUDGE_HEADER]: "1" };
  if (provider === "anthropic") {
    const key = env("ANTHROPIC_API_KEY");
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: `${(env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
      headers,
      body: { model, max_tokens: 300, temperature: 0, system: SYSTEM, messages: [{ role: "user", content: prompt(output, criteria) }] },
    };
  }
  if (provider === "openai") {
    const key = env("OPENAI_API_KEY");
    if (key) headers.authorization = `Bearer ${key}`;
    return {
      url: `${(env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
      headers,
      body: {
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt(output, criteria) },
        ],
      },
    };
  }
  const key = env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY");
  if (key) headers["x-goog-api-key"] = key;
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers,
    body: {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt(output, criteria) }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function answerText(provider: Provider, body: unknown): string {
  if (!isObj(body)) return "";
  if (provider === "anthropic" && Array.isArray(body.content)) {
    return body.content.filter(isObj).map((b) => (typeof b.text === "string" ? b.text : "")).join("");
  }
  if (provider === "openai" && Array.isArray(body.choices)) {
    const message = isObj(body.choices[0]) && isObj(body.choices[0].message) ? body.choices[0].message : {};
    return typeof message.content === "string" ? message.content : "";
  }
  if (provider === "google" && Array.isArray(body.candidates)) {
    const content = isObj(body.candidates[0]) && isObj(body.candidates[0].content) ? body.candidates[0].content : {};
    return (Array.isArray(content.parts) ? content.parts.filter(isObj) : []).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/** The verdict in the judge's answer: JSON, also inside a code fence or after a few words. */
export function parseVerdict(text: string): { pass: boolean; reason: string } | undefined {
  const candidates = [text.trim(), ...(text.match(/\{[\s\S]*\}/g) ?? [])];
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      if (isObj(value) && typeof value.pass === "boolean") return { pass: value.pass, reason: typeof value.reason === "string" ? value.reason : "" };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** What a value says, as the judge reads it: text as is, anything else as JSON. */
export function outputOf(value: unknown): string {
  if (typeof value === "string") return value;
  // A cassette: the last thing the model said in it.
  const calls = isObj(value) && Array.isArray((value as { calls?: unknown }).calls) ? (value as { calls: { text?: string }[] }).calls : undefined;
  if (calls) return calls.at(-1)?.text ?? "";
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * Asks a model whether `output` meets `criteria`. Inside a cassette, the question and the verdict
 * are recorded with everything else and replayed after.
 */
export async function judge(output: unknown, criteria: string, options: JudgeOptions = {}): Promise<Verdict> {
  if (typeof criteria !== "string" || !criteria.trim()) throw new TomikoError("judge() needs criteria: what the output must do, in words.");
  const model = options.model ?? runtime.defaults.judge?.model ?? DEFAULT_MODEL;
  const provider = providerOf(model);
  const { url, headers, body } = request(provider, model, outputOf(output), criteria);
  const response = await dispatch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ` Set ${{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" }[provider]} to record a verdict.` : "";
    throw new TomikoError(`The judge (${model}) answered ${response.status}: ${text.slice(0, 300)}${hint}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const answer = answerText(provider, parsed);
  const verdict = parseVerdict(answer);
  if (!verdict) throw new TomikoError(`The judge (${model}) didn't answer with a verdict: ${JSON.stringify(answer.slice(0, 300))}`);
  return { ...verdict, model };
}
