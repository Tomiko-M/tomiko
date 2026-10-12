import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { renderDiff } from "../src/commands/diff.js";
import { diffCassettes, summarizeDiff, type CassetteFile, type Interaction } from "../src/index.js";
import { paint } from "../src/terminal.js";
import { diffWords } from "../src/words.js";
import { ANTHROPIC_URL, anthropicStream, OPENAI_URL, openaiChat } from "./helpers.js";

let ids = 0;
const id = (prefix: string) => `${prefix}_${(++ids).toString(36).padStart(10, "x")}`;
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

interface Turn {
  text?: string;
  tools?: { name: string; input: unknown }[];
  stop?: string;
  output?: number;
}

function reply(turn: Turn) {
  return {
    id: id("msg"),
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      ...(turn.text !== undefined ? [{ type: "text", text: turn.text }] : []),
      ...(turn.tools ?? []).map((t) => ({ type: "tool_use", id: id("toolu"), name: t.name, input: t.input })),
    ],
    stop_reason: turn.stop ?? (turn.tools?.length ? "tool_use" : "end_turn"),
    usage: usage(1000, turn.output ?? 100),
  };
}

function exchange(body: Record<string, unknown>, turn: Turn, durationMs = 500): Interaction {
  return {
    request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-haiku-5-5", max_tokens: 1024, ...body } },
    response: { status: 200, headers: { "content-type": "application/json" }, body: { type: "json", value: reply(turn) } },
    meta: { provider: "anthropic", recordedAt: new Date(Date.now() + ids).toISOString(), durationMs },
  };
}

const file = (...interactions: Interaction[]): CassetteFile => ({ version: 1, interactions });
const ask = (content: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: "user", content }], ...extra });

/** A two-step tool loop, as an agent records it; every recording mints new ids. */
function agent(options: { tools: Turn["tools"]; answer: string; stop?: string; output?: number }): CassetteFile {
  const first = reply({ tools: options.tools });
  const user = { role: "user", content: "Plan a trip to Paris" };
  const results = first.content.map((block) => ({ type: "tool_result", tool_use_id: (block as { id: string }).id, content: "Sunny, 18°C" }));
  return file(
    { ...exchange(ask("Plan a trip to Paris"), {}), response: { status: 200, headers: {}, body: { type: "json", value: first } } },
    exchange({ messages: [user, { role: "assistant", content: first.content }, { role: "user", content: results }] }, {
      text: options.answer,
      stop: options.stop,
      output: options.output,
    }),
  );
}

describe("diffCassettes", () => {
  it("sees no change between two recordings that differ only in ids, timestamps and timing", () => {
    const tools = [{ name: "get_weather", input: { city: "Paris" } }];
    const result = diffCassettes("trip.json", agent({ tools, answer: "Sunny." }), agent({ tools, answer: "Sunny." }));
    expect(result.status).toBe("unchanged");
    expect(result.impact).toBe("none");
    expect(result.requests.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("calls a change in tools, their arguments or the stop reason a change in behavior", () => {
    const before = agent({ tools: [{ name: "get_weather", input: { city: "Paris" } }], answer: "Sunny." });
    const after = agent({
      tools: [
        { name: "search_flights", input: { to: "CDG" } },
        { name: "get_weather", input: { city: "Paris", units: "metric" } },
      ],
      answer: "Sunny.",
      stop: "max_tokens",
    });
    const result = diffCassettes("trip.json", before, after);
    expect(result.impact).toBe("behavior");
    const [first, second] = result.requests;
    expect(first!.response!.tools).toEqual({
      before: ["get_weather"],
      after: ["search_flights", "get_weather"],
      inputs: [{ name: "get_weather", occurrence: 0, changes: [{ path: "units", kind: "added", after: "metric" }] }],
    });
    expect(second!.response!.stopReason).toEqual({ before: "end_turn", after: "max_tokens" });
    // The second request's history changed only because the first answer did.
    expect(second!.request?.history).toBe(true);
  });

  it("calls the same behavior in other words a change in wording, and measures it", () => {
    const result = diffCassettes(
      "faq.json",
      file(exchange(ask("Hours?"), { text: "We're open 9am to 6pm, Monday to Friday." })),
      file(exchange(ask("Hours?"), { text: "We are open from 9am to 6pm on weekdays." })),
    );
    expect(result.impact).toBe("wording");
    const text = result.requests[0]!.response!.text!;
    expect(text.similarity).toBeGreaterThan(0.4);
    expect(text.similarity).toBeLessThan(0.9);
    expect(text.pieces.filter((p) => p.op !== "=").length).toBeGreaterThan(0);
  });

  it("compares JSON answers by their data, also inside a code fence", () => {
    const fenced = (data: object) => `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    const result = diffCassettes(
      "ticket.json",
      file(exchange(ask("Classify"), { text: fenced({ category: "delivery", urgent: true }) })),
      file(exchange(ask("Classify"), { text: JSON.stringify({ urgent: false, category: "delivery" }) })),
    );
    expect(result.impact).toBe("behavior");
    expect(result.requests[0]!.response).toEqual({ data: [{ path: "urgent", kind: "changed", before: true, after: false }] });

    const prose = diffCassettes(
      "ticket.json",
      file(exchange(ask("Classify"), { text: '{"category":"delivery"}' })),
      file(exchange(ask("Classify"), { text: "It is about a delivery." })),
    );
    expect(prose.requests[0]!.response!.format).toEqual({ before: "json", after: "text" });
    expect(prose.impact).toBe("behavior");
  });

  it("tells a changed request with the same answer apart, and says what changed in it", () => {
    const result = diffCassettes(
      "greets.json",
      file(exchange(ask("Hi!", { system: "You are friendly.", temperature: 1, tools: [{ name: "lookup", input_schema: {} }] }), { text: "Hello!" })),
      file(exchange(ask("Hi!", { system: "You are concise.", temperature: 0, tools: [{ name: "search", input_schema: {} }] }), { text: "Hello!" })),
    );
    expect(result.impact).toBe("request");
    const request = result.requests[0]!.request!;
    expect(request.system?.before).toBe("You are friendly.");
    expect(request.params).toEqual([{ path: "temperature", kind: "changed", before: 1, after: 0 }]);
    expect(request.tools).toEqual({ added: ["search"], removed: ["lookup"], changed: [] });
    expect(request.history).toBe(false);
    expect(result.requests[0]!.response).toBeUndefined();
  });

  it("pairs requests per endpoint in order and reports the ones that are new or gone", () => {
    const openai = (text: string): Interaction => ({
      request: { method: "POST", url: `${OPENAI_URL}/chat/completions`, body: { model: "gpt-test", messages: [] } },
      response: { status: 200, headers: {}, body: { type: "json", value: openaiChat({ text }) } },
      meta: { recordedAt: "", durationMs: 1 },
    });
    const result = diffCassettes(
      "mixed.json",
      file(exchange(ask("a"), { text: "A" }), exchange(ask("b"), { text: "B" }), openai("x")),
      file(openai("x"), exchange(ask("a"), { text: "A" })),
    );
    expect(result.requests.map((r) => [r.index, r.beforeIndex, r.status])).toEqual([
      [1, 3, "unchanged"],
      [2, 1, "unchanged"],
      [2, 2, "removed"],
    ]);
    expect(result.impact).toBe("behavior");
  });

  it("compares streamed answers by their content", () => {
    const streamed = (parts: string[]): Interaction => ({
      request: { method: "POST", url: ANTHROPIC_URL, body: { model: "claude-opus-5-5", stream: true, messages: [] } },
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: { type: "sse", chunks: [anthropicStream(parts).map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")] },
      },
      meta: { recordedAt: "", durationMs: 1 },
    });
    expect(diffCassettes("s.json", file(streamed(["Hel", "lo"])), file(streamed(["Hello"]))).status).toBe("unchanged");
    expect(diffCassettes("s.json", file(streamed(["Hello"])), file(streamed(["Goodbye"]))).impact).toBe("wording");
  });

  it("counts new and removed cassettes and sums cost on each side", () => {
    const before = file(exchange(ask("a"), { text: "A", output: 100 }));
    const after = file(exchange(ask("a"), { text: "A, at length", output: 300 }));
    const summary = summarizeDiff([
      diffCassettes("a.json", before, after),
      diffCassettes("b.json", undefined, before),
      diffCassettes("c.json", before, undefined),
      diffCassettes("d.json", before, before),
    ]);
    expect(summary).toMatchObject({ cassettes: 4, changed: 1, added: 1, removed: 1, unchanged: 1, impact: { behavior: 0, wording: 1, request: 0 } });
    expect(summary.before.requests).toBe(3);
    expect(summary.after.usage.outputTokens).toBe(300 + 100 + 100);
    expect(summary.after.cost).toBeGreaterThan(summary.before.cost!);
  });
});

describe("diffWords", () => {
  it("diffs by word, ignoring changes in spacing", () => {
    expect(diffWords("a  b\nc", "a b c").pieces.every((p) => p.op === "=")).toBe(true);
    const { pieces, similarity } = diffWords("The weather is +12°C in Moscow", "The weather is 12 degrees in Moscow");
    expect(pieces.map((p) => [p.op, p.text])).toEqual([
      ["=", "The weather is"],
      ["-", " +12°C"],
      ["+", " 12 degrees"],
      ["=", " in Moscow"],
    ]);
    // "The weather is … in Moscow": 5 of 7 words on each side.
    expect(similarity).toBeCloseTo((2 * 5) / (7 + 7), 5);
  });

  it("folds a lone short word between two changes into them", () => {
    const { pieces } = diffWords("red fox and blue cat", "green dog and pink bird");
    expect(pieces.map((p) => p.op)).toEqual(["-", "+"]);
  });

  it("handles texts too long to align by replacing the middle", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 3000 }, (_, i) => `v${i}`).join(" ");
    const started = performance.now();
    expect(diffWords(a, b).similarity).toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("renderDiff", () => {
  const before = agent({ tools: [{ name: "get_weather", input: { city: "Paris" } }], answer: "Pack light: it will be sunny and 18°C in Paris this weekend." });
  const after = agent({
    tools: [{ name: "get_weather", input: { city: "Paris", units: "metric" } }],
    answer: "Pack light: Paris will be sunny at around 18 degrees all weekend.",
    stop: "max_tokens",
    output: 400,
  });

  it("shows what the model did differently, in plain text without a terminal", () => {
    const lines = renderDiff([diffCassettes("test/__cassettes__/trip.json", before, after)], { columns: 100 });
    expect(lines).toEqual([
      "  ~ test/__cassettes__/trip.json  ● behavior changed",
      "    #1  POST /v1/messages  claude-haiku-5-5",
      '       calls   get_weather  + units  "metric"',
      "    #2  POST /v1/messages  claude-haiku-5-5",
      "       stop    end_turn → max_tokens  cut off at the token limit",
      "       answer  48% the same words",
      "               Pack light: [-it-] {+Paris+} will be sunny [-and 18°C in Paris this-] {+at around 18",
      "               degrees all+} weekend.",
      "       tokens  1.1K → 1.4K  +27%  $0.0001 → $0.0003",
      "",
      "  ────────────────────────────────────────────────────────",
      "  ~ 1 changed",
      "  ● 1 behavior",
      "  cost    $0.0003 → $0.0004  +50%",
      "  tokens  2.2K → 2.5K        +14%",
      "  time    1.0s",
    ]);
  });

  it("strikes out and colors in a terminal, and hides secrets", () => {
    const leaked = agent({ tools: [], answer: "Use token ghp_" + "Zx81Qw7Lp0Kd2Mv5Rt9Yb3Nc6Hf4Js1Ga8Ue now." });
    const lines = renderDiff([diffCassettes("t.json", before, leaked)], {
      color: paint(true),
      columns: 100,
      mask: (text) => text.replace(/ghp_\w+/g, "ghp_…8Ue"),
    }).join("\n");
    expect(lines).toContain("\x1b[9m"); // strikethrough
    expect(stripVTControlCharacters(lines)).toContain("ghp_…8Ue");
    expect(lines).not.toContain("Zx81Qw7Lp0Kd2Mv5");
  });

  it("wraps long answers to the terminal and keeps a few words of context around each change", () => {
    const long = (word: string) => `${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6)}${word} ${"Sed do eiusmod tempor incididunt ut labore. ".repeat(6)}`;
    const lines = renderDiff([diffCassettes("l.json", file(exchange(ask("x"), { text: long("alpha") })), file(exchange(ask("x"), { text: long("omega") })))], {
      columns: 60,
    });
    const answer = lines.slice(lines.findIndex((l) => l.includes("answer")) + 1, lines.findIndex((l) => l === ""));
    expect(answer.map((l) => l.trim()).join(" ")).toBe("… dolor sit amet, consectetur adipiscing elit. [-alpha-] {+omega+} Sed do eiusmod tempor incididunt ut …");
    expect(answer.every((l) => l.length <= 60)).toBe(true);
  });
});
