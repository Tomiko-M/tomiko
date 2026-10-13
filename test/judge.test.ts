import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { cassette, configure, fault, judge } from "../src/index.js";
import { parseVerdict } from "../src/judge.js";
import "../src/vitest.js";
import { ANTHROPIC_URL, anthropicMessage, fakeApi, geminiResponse, json, offline, openaiChat, tmpDir } from "./helpers.js";

const verdict = (pass: boolean, reason: string) => JSON.stringify({ pass, reason });
const apology = "We're sorry your order arrived late. We've refunded the delivery fee to your card.";

/** A fake API that answers the judge, and anything else with `answer`. */
function api(pass = true, reason = "It apologizes and refunds the fee.") {
  const headers: string[] = [];
  const fake = fakeApi((body, request) => {
    headers.push([...request.headers.keys()].join(","));
    const isJudge = JSON.stringify(body).includes("CRITERIA:");
    return json(anthropicMessage(isJudge ? verdict(pass, reason) : apology));
  });
  return Object.assign(fake, { headers });
}

const askSupport = () => fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Where is my order?" }] }) }).then((r) => r.json());

describe("toMeet", () => {
  it("asks a judge once, records the verdict, and replays it offline", async () => {
    const dir = tmpDir();
    const live = api();
    const run = async () => {
      const answer = (await askSupport()).content[0].text as string;
      await expect(answer).toMeet("apologizes and offers a refund");
      return answer;
    };
    await cassette("support", run, { dir, fetch: live });
    expect(live.calls).toHaveLength(2);
    expect(live.headers.join(",")).not.toContain("x-tomiko-judge"); // the marker never leaves tomiko
    const saved = JSON.parse(readFileSync(join(dir, "support.json"), "utf8"));
    expect(saved.interactions.map((i: { meta: { judge?: boolean } }) => i.meta.judge ?? false)).toEqual([false, true]);

    await cassette("support", run, { dir, mode: "replay", fetch: offline });
  });

  it("explains a failing verdict with the judge's reason and the output", async () => {
    const error = await cassette(
      "fail",
      async () => {
        await expect(apology).toMeet("offers a full refund of the order");
      },
      { dir: tmpDir(), fetch: api(false, "It refunds only the delivery fee, not the order.") },
    ).then(
      () => new Error("passed"),
      (e: unknown) => e as Error,
    );
    expect(stripVTControlCharacters(error.message)).toBe(
      [
        'expected the output to meet: "offers a full refund of the order"',
        "Judge (claude-haiku-5-5): It refunds only the delivery fee, not the order.",
        `Output: "${apology}"`,
      ].join("\n"),
    );
  });

  it("works with .not, and judges a cassette by its last answer", async () => {
    await cassette(
      "not",
      async (c) => {
        await askSupport();
        await expect(c).not.toMeet("blames the customer");
      },
      { dir: tmpDir(), fetch: api(false, "It doesn't blame anyone.") },
    );
  });

  it("leaves the judge out of what the code under test did, and out of faults", async () => {
    await cassette(
      "counts",
      async (c) => {
        await askSupport();
        await expect(apology).toMeet("apologizes");
        expect(c).toHaveMadeRequests(1);
        // The agent's request was refused; the judge's, which came second, was neither refused nor
        // rate limited, and doesn't count as a request.
        expect(c.calls.map((call) => [call.text, call.fault])).toEqual([["I'm sorry, but I can't help with that.", "refusal"]]);
      },
      { dir: tmpDir(), fetch: api(), faults: [fault.refusal({ times: Infinity }), fault.rateLimit({ on: 2 })] },
    );
  });
});

describe("judge()", () => {
  it("speaks each provider's API, picked by the model's name", async () => {
    const seen: { url: string; body: any; key: string | null }[] = [];
    const fake = fakeApi((body, request) => {
      seen.push({ url: request.url, body, key: request.headers.get("authorization") ?? request.headers.get("x-goog-api-key") });
      if (request.url.includes("openai")) return json(openaiChat({ text: verdict(true, "Yes.") }));
      return json(geminiResponse({ text: "```json\n" + verdict(false, "No.") + "\n```" }));
    });
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const results = await cassette(
        "providers",
        async () => [await judge("hi", "greets", { model: "gpt-5-mini" }), await judge({ answer: 42 }, "is a string", { model: "gemini-2.5-flash" })],
        { dir: tmpDir(), fetch: fake },
      );
      expect(results).toEqual([
        { pass: true, reason: "Yes.", model: "gpt-5-mini" },
        { pass: false, reason: "No.", model: "gemini-2.5-flash" },
      ]);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
    expect(seen[0]).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", key: "Bearer sk-test", body: { model: "gpt-5-mini", response_format: { type: "json_object" } } });
    expect(seen[1]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(seen[1]!.body.contents[0].parts[0].text).toContain('OUTPUT:\n{\n  "answer": 42\n}');
  });

  it("uses the model configure() names", async () => {
    configure({ judge: { model: "gpt-5-nano" } });
    const fake = fakeApi(() => json(openaiChat({ text: verdict(true, "ok") })));
    expect((await cassette("cfg", () => judge("x", "anything"), { dir: tmpDir(), fetch: fake })).model).toBe("gpt-5-nano");
  });

  it("says what is wrong when it can't get a verdict", async () => {
    const unauthorized = fakeApi(() => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    await expect(cassette("401", () => judge("x", "y"), { dir: tmpDir(), fetch: unauthorized })).rejects.toThrow(
      /The judge \(claude-haiku-5-5\) answered 401: .*invalid x-api-key.* Set ANTHROPIC_API_KEY to record a verdict\./,
    );
    const rambling = fakeApi(() => json(anthropicMessage("Well, it depends.")));
    await expect(cassette("ramble", () => judge("x", "y"), { dir: tmpDir(), fetch: rambling })).rejects.toThrow(
      `The judge (claude-haiku-5-5) didn't answer with a verdict: "Well, it depends."`,
    );
    await expect(judge("x", "y", { model: "llama-3" })).rejects.toThrow('tomiko can\'t tell which API serves the judge model "llama-3"');
  });

  it("reads a verdict however the model wraps it", () => {
    expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: "ok" });
    expect(parseVerdict('```json\n{"pass": false, "reason": "no"}\n```')).toEqual({ pass: false, reason: "no" });
    expect(parseVerdict('Here you go: {"pass": true} — done.')).toEqual({ pass: true, reason: "" });
    expect(parseVerdict("pass")).toBeUndefined();
  });
});
