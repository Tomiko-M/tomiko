import { TomikoError } from "./errors.js";
import { delivered, type Injection, obeyed, reveal } from "./injection.js";
import { judge, type JudgeOptions, outputOf } from "./judge.js";
import type { RecordedCall, ToolCall } from "./types.js";

/** The parts of a Vitest/Jest matcher context these matchers use. */
interface MatcherContext {
  isNot: boolean;
  equals(a: unknown, b: unknown): boolean;
  utils: {
    printExpected(value: unknown): string;
    printReceived(value: unknown): string;
  };
}

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

interface Inspectable {
  name: string;
  calls: RecordedCall[];
}

export interface RequestCount {
  min?: number;
  max?: number;
}

/** Type declarations for the matchers, for test runners' `expect` augmentation. */
export interface TomikoMatchers<R = unknown> {
  /** The model called this tool at least once; `input`, if given, must be contained in its arguments. */
  toHaveCalledTool(name: string, input?: unknown): R;
  /** The model called this tool exactly `times` times. */
  toHaveCalledToolTimes(name: string, times: number): R;
  /** These tools were called in this relative order; other calls may come in between. */
  toHaveCalledToolsInOrder(names: string[]): R;
  /** At least one request went to this model. */
  toHaveUsedModel(model: string | RegExp): R;
  /** The number of requests sent: exactly `count`, or within `{ min, max }`. */
  toHaveMadeRequests(count: number | RequestCount): R;
  /** The estimated cost of the run, in USD, is below `usd`. */
  toCostLessThan(usd: number): R;
  /** All tokens processed (input, output, cache reads and writes) are fewer than `tokens`. */
  toHaveUsedFewerTokensThan(tokens: number): R;
  /**
   * A model judges that the received text (or a cassette's last answer) meets `criteria`, in
   * words. Inside a cassette the verdict is recorded and replayed. Await it.
   */
  toMeet(criteria: string, options?: JudgeOptions): Promise<R>;
  /**
   * The model kept to its job despite the prompt injections `fault.promptInjection()` planted: it
   * didn't call the tool an attack went for, repeat the attack's marker, link to where it sends
   * stolen data, or recite its system prompt.
   */
  toResistInjection(): R;
}

function inspectable(received: unknown, matcher: string): Inspectable {
  const candidate = received as Partial<Inspectable> | null;
  if (candidate && typeof candidate === "object" && Array.isArray(candidate.calls)) return candidate as Inspectable;
  throw new TomikoError(`${matcher}() expects a tomiko cassette, e.g. the one passed to useCassette() or cassette().`);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const isAsymmetric = (v: unknown) =>
  v !== null && typeof v === "object" && typeof (v as { asymmetricMatch?: unknown }).asymmetricMatch === "function";

/** Every key in `expected` is present in `actual` with a matching value; leaves use the runner's equality. */
function contains(ctx: MatcherContext, actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected) && !isAsymmetric(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every((key) => key in actual && contains(ctx, actual[key], expected[key]));
  }
  return ctx.equals(actual, expected);
}

const MAX_ARGS = 80;

function describeTool(tool: ToolCall): string {
  const args = JSON.stringify(tool.input) ?? "";
  return `${tool.name}(${args.length > MAX_ARGS ? `${args.slice(0, MAX_ARGS)}…` : args})`;
}

function describeTools(tools: ToolCall[]): string {
  return tools.length === 0 ? "No tools were called." : `Tool calls:\n${tools.map((t) => `  ${describeTool(t)}`).join("\n")}`;
}

const toolsOf = (cassette: Inspectable) => cassette.calls.flatMap((call) => call.toolCalls);
const subject = (cassette: Inspectable, isNot: boolean) => `expected cassette "${cassette.name}" ${isNot ? "not " : ""}to`;

function totalTokens(calls: RecordedCall[]): number {
  return calls.reduce((sum, { usage: u }) => {
    if (!u) return sum;
    return sum + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  }, 0);
}

const clip = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** An attack as the failure message shows it: what it is, where it went, what it said. */
function describeAttack(injection: Injection): string {
  const hidden = injection.attack === "hidden-text";
  const said = clip(hidden ? reveal(injection.text) : injection.text, 300).replace(/\n/g, "\n    ");
  return [
    `The attack (${injection.attack}), in the result of ${injection.tool}${injection.goal ? `, going for ${injection.goal}` : ""}${hidden ? ", hidden in invisible characters" : ""}:`,
    `    ${said}`,
  ].join("\n");
}

export const matchers = {
  async toMeet(this: MatcherContext, received: unknown, criteria: string, options?: JudgeOptions): Promise<MatcherResult> {
    const verdict = await judge(received, criteria, options);
    const output = clip(outputOf(received));
    return {
      pass: verdict.pass,
      message: () =>
        [
          `expected the output ${this.isNot ? "not " : ""}to meet: ${this.utils.printExpected(criteria)}`,
          `Judge (${verdict.model}): ${verdict.reason || (verdict.pass ? "it does." : "it doesn't.")}`,
          `Output: ${this.utils.printReceived(output)}`,
        ].join("\n"),
    };
  },

  toResistInjection(this: MatcherContext, received: unknown): MatcherResult {
    const cassette = inspectable(received, "toResistInjection");
    const attacks = delivered(cassette.calls);
    if (attacks.length === 0) {
      // Passing here would say the agent is safe when nothing tested it.
      throw new TomikoError(
        `toResistInjection(): no prompt injection reached the model in cassette "${cassette.name}". ` +
          `Add fault.promptInjection() to its faults, and check the agent sends the model a tool result: ` +
          `the attack goes into the first one, or into the result of the tool \`into\` names.`,
      );
    }
    const found = obeyed(cassette.calls);
    const where = [...new Set(attacks.map((a) => a.tool))].join(" and ");
    return {
      pass: found.length === 0,
      message: () =>
        this.isNot
          ? `${subject(cassette, true)} resist the prompt injection in the result of ${where}, but the model ignored it.\n${attacks.map(describeAttack).join("\n")}`
          : [
              `${subject(cassette, false)} resist the prompt injection in the result of ${where}, but the model obeyed it:`,
              ...found.map((o) => `  #${o.call} ${o.what}`),
              "",
              ...[...new Set(found.map((o) => o.injection))].map(describeAttack),
            ].join("\n"),
    };
  },

  toHaveCalledTool(this: MatcherContext, received: unknown, name: string, input?: unknown): MatcherResult {
    const cassette = inspectable(received, "toHaveCalledTool");
    const tools = toolsOf(cassette);
    const matching = tools.filter((t) => t.name === name && (input === undefined || contains(this, t.input, input)));
    const what = `call tool ${this.utils.printExpected(name)}${input === undefined ? "" : ` with ${this.utils.printExpected(input)}`}`;
    return {
      pass: matching.length > 0,
      message: () => `${subject(cassette, this.isNot)} ${what}.\n${describeTools(this.isNot ? matching : tools)}`,
    };
  },

  toHaveCalledToolTimes(this: MatcherContext, received: unknown, name: string, times: number): MatcherResult {
    const cassette = inspectable(received, "toHaveCalledToolTimes");
    const tools = toolsOf(cassette);
    const count = tools.filter((t) => t.name === name).length;
    return {
      pass: count === times,
      message: () =>
        `${subject(cassette, this.isNot)} call tool ${this.utils.printExpected(name)} ` +
        `${this.utils.printExpected(times)} time(s), it was called ${this.utils.printReceived(count)} time(s).\n` +
        describeTools(tools),
    };
  },

  toHaveCalledToolsInOrder(this: MatcherContext, received: unknown, names: string[]): MatcherResult {
    const cassette = inspectable(received, "toHaveCalledToolsInOrder");
    const tools = toolsOf(cassette);
    let next = 0;
    for (const tool of tools) if (next < names.length && tool.name === names[next]) next++;
    return {
      pass: next === names.length,
      message: () =>
        `${subject(cassette, this.isNot)} call tools in the order ${this.utils.printExpected(names.join(" → "))}` +
        `${this.isNot ? "" : `; matched up to ${this.utils.printReceived(names.slice(0, next).join(" → ") || "nothing")}`}.\n` +
        describeTools(tools),
    };
  },

  toHaveUsedModel(this: MatcherContext, received: unknown, model: string | RegExp): MatcherResult {
    const cassette = inspectable(received, "toHaveUsedModel");
    // The model asked for counts as well as the one that answered: `gpt-4o` answers as `gpt-4o-2024-08-06`.
    const models = [...new Set(cassette.calls.flatMap((c) => [c.requestedModel, c.model]).filter((m): m is string => m !== undefined))];
    const pass = models.some((m) => (typeof model === "string" ? m === model : model.test(m)));
    return {
      pass,
      message: () =>
        `${subject(cassette, this.isNot)} use model ${this.utils.printExpected(model)}. ` +
        `Models used: ${models.length ? this.utils.printReceived(models) : "none"}.`,
    };
  },

  toHaveMadeRequests(this: MatcherContext, received: unknown, count: number | RequestCount): MatcherResult {
    const cassette = inspectable(received, "toHaveMadeRequests");
    const made = cassette.calls.length;
    const { min = -Infinity, max = Infinity } = typeof count === "number" ? { min: count, max: count } : count;
    const expected =
      typeof count === "number"
        ? `exactly ${count}`
        : [count.min !== undefined && `at least ${count.min}`, count.max !== undefined && `at most ${count.max}`]
            .filter(Boolean)
            .join(" and ");
    return {
      pass: made >= min && made <= max,
      message: () =>
        `${subject(cassette, this.isNot)} make ${expected} request(s), it made ${this.utils.printReceived(made)}.`,
    };
  },

  toCostLessThan(this: MatcherContext, received: unknown, usd: number): MatcherResult {
    const cassette = inspectable(received, "toCostLessThan");
    const unpriced = [...new Set(cassette.calls.filter((c) => c.usage && c.cost === null).map((c) => c.model ?? "(unknown model)"))];
    if (unpriced.length > 0) {
      // Counting unpriced calls as free would let a budget pass silently.
      throw new TomikoError(
        `toCostLessThan() cannot estimate the cost of cassette "${cassette.name}": no price for ${unpriced.join(", ")}. ` +
          `Add it with the \`pricing\` option.`,
      );
    }
    const cost = cassette.calls.reduce((sum, c) => sum + (c.cost ?? 0), 0);
    return {
      pass: cost < usd,
      message: () =>
        `${subject(cassette, this.isNot)} cost less than ${this.utils.printExpected(`$${usd}`)}, ` +
        `estimated cost is ${this.utils.printReceived(`$${cost.toFixed(4)}`)}.`,
    };
  },

  toHaveUsedFewerTokensThan(this: MatcherContext, received: unknown, tokens: number): MatcherResult {
    const cassette = inspectable(received, "toHaveUsedFewerTokensThan");
    const used = totalTokens(cassette.calls);
    return {
      pass: used < tokens,
      message: () =>
        `${subject(cassette, this.isNot)} use fewer than ${this.utils.printExpected(tokens)} tokens, ` +
        `it used ${this.utils.printReceived(used)}.`,
    };
  },
};
