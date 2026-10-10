// Exercises the built package without a test runner, so it can run on every supported Node version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cassette, summary } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "tomiko-smoke-"));
const url = "https://api.anthropic.com/v1/messages";
const body = JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] });

let calls = 0;
const network = async () => {
  calls++;
  const events = [
    { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ];
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
};
const offline = async () => {
  throw new Error("network used during replay");
};

const run = (fetchImpl, mode) =>
  cassette("smoke", async () => (await fetch(url, { method: "POST", body })).text(), { dir, mode, fetch: fetchImpl });

const recorded = await run(network, "auto");
const replayed = await run(offline, "replay");
assert.equal(replayed, recorded);
assert.equal(calls, 1);
const s = summary();
assert.equal(s.recorded, 1);
assert.equal(s.replayed, 1);
// Usage counts every served response: the recorded one and its replay.
assert.deepEqual(s.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
// The CLI builds a viewer page from the cassette just recorded.
const page = join(dir, "view.html");
const output = execFileSync(process.execPath, [new URL("../bin/tomiko.js", import.meta.url).pathname, "view", dir, "--no-open", "--out", page], {
  encoding: "utf8",
});
assert.match(output, /1 cassette, 1 request → /);
assert.match(readFileSync(page, "utf8"), /claude-opus-5-5/);

console.log(`smoke ok on node ${process.version}`);
