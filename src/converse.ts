/**
 * Bedrock's Converse API, read the way tomiko reads Anthropic's Messages API. Its requests say
 * the same things in other words: content blocks keyed by kind (`{ text }`, `{ toolUse }`,
 * `{ toolResult }`) instead of typed, tools under `toolConfig`, `max_tokens` under
 * `inferenceConfig`. The viewer, `diff` and `doctor` read the translation; matching and the
 * cassette keep the request as it was sent.
 */
import { BEDROCK_PATH } from "./usage.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A Converse or ConverseStream request. */
export function isConverse(request: { url: string; body?: unknown }): boolean {
  const kind = BEDROCK_PATH.exec(pathOf(request.url))?.[2];
  return kind === "converse" || kind === "converse-stream";
}

function block(b: Obj): Obj | undefined {
  if (typeof b.text === "string") return { type: "text", text: b.text };
  if (isObj(b.toolUse)) return { type: "tool_use", id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input };
  if (isObj(b.toolResult)) {
    const result = b.toolResult;
    const content = (Array.isArray(result.content) ? result.content.filter(isObj) : []).map((c) => {
      if (typeof c.text === "string") return { type: "text", text: c.text };
      if (c.json !== undefined) return { type: "text", text: JSON.stringify(c.json) };
      return { type: Object.keys(c)[0] ?? "content" };
    });
    return { type: "tool_result", tool_use_id: result.toolUseId, content, ...(result.status === "error" ? { is_error: true } : {}) };
  }
  if (isObj(b.reasoningContent)) {
    const reasoning = isObj(b.reasoningContent.reasoningText) ? b.reasoningContent.reasoningText : {};
    return { type: "thinking", thinking: str(reasoning.text) ?? "", signature: reasoning.signature };
  }
  if (isObj(b.guardContent) && isObj(b.guardContent.text)) return { type: "text", text: b.guardContent.text.text };
  // Where the prompt cache ends: says nothing.
  if (isObj(b.cachePoint)) return undefined;
  const kind = Object.keys(b)[0];
  return kind ? { type: kind, ...(isObj(b[kind]) ? (b[kind] as Obj) : {}) } : undefined;
}

const blocks = (content: unknown): Obj[] =>
  (Array.isArray(content) ? content.filter(isObj) : []).flatMap((b) => {
    const out = block(b);
    return out ? [out] : [];
  });

/** A Converse request body as Anthropic's Messages API would say it. */
export function fromConverse(body: Obj): Obj {
  const { system, messages, toolConfig, inferenceConfig, ...rest } = body;
  const out: Obj = { ...rest };
  if (system !== undefined) out.system = blocks(system);
  out.messages = (Array.isArray(messages) ? messages.filter(isObj) : []).map((m) => ({ role: m.role, content: blocks(m.content) }));
  if (isObj(toolConfig)) {
    const { tools, toolChoice, ...other } = toolConfig;
    out.tools = (Array.isArray(tools) ? tools.filter(isObj) : []).map((t) => {
      const spec = isObj(t.toolSpec) ? t.toolSpec : undefined;
      if (!spec) return t;
      const schema = isObj(spec.inputSchema) ? spec.inputSchema.json : undefined;
      return { name: spec.name, description: spec.description, input_schema: schema };
    });
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    Object.assign(out, other);
  }
  if (isObj(inferenceConfig)) {
    const { maxTokens, topP, stopSequences, ...other } = inferenceConfig;
    if (maxTokens !== undefined) out.max_tokens = maxTokens;
    if (topP !== undefined) out.top_p = topP;
    if (stopSequences !== undefined) out.stop_sequences = stopSequences;
    Object.assign(out, other);
  }
  return out;
}

/** The request body to read: Converse translated, anything else as it is. */
export function readableBody(request: { url: string; body?: unknown }): unknown {
  return isConverse(request) && isObj(request.body) ? fromConverse(request.body) : request.body;
}
