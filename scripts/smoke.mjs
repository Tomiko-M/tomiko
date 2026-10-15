// Exercises the built package without a test runner, so it can run on every supported Node version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { awsRequestHandler, cassette, summary } from "../dist/index.js";

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
assert.match(output, /✔ 1 cassette, 1 request\n/);
assert.ok(!output.includes("\x1b"), "no colors when the output is not a terminal");
assert.match(readFileSync(page, "utf8"), /claude-opus-5-5/);

// The other commands run from the build too: a clean scan, and a diff of the cassette with itself.
const cli = (...args) => execFileSync(process.execPath, [new URL("../bin/tomiko.js", import.meta.url).pathname, ...args], { encoding: "utf8", cwd: dir });
assert.match(cli("scan", dir), /✔ No secrets in 1 cassette/);
const file = join(dir, "smoke.json");
assert.match(cli("diff", file, file), /✔ 1 cassette re-recorded, and the model behaves the same/);

// Amazon Bedrock through the AWS SDK's request handler: recorded, then replayed offline, from both builds.
const converse = async () =>
  new Response(JSON.stringify({ output: { message: { role: "assistant", content: [{ text: "Sunny." }] } }, stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 } }), {
    headers: { "content-type": "application/json" },
  });
const ask = (handler) => async () => {
  const { response } = await handler.handle({
    method: "POST",
    protocol: "https:",
    hostname: "bedrock-runtime.us-east-1.amazonaws.com",
    path: "/model/us.amazon.nova-lite-v1%3A0/converse",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "Weather?" }] }] }),
  });
  let text = "";
  for await (const chunk of response.body) text += chunk;
  return { status: response.statusCode, text: JSON.parse(text).output.message.content[0].text };
};
const { awsRequestHandler: cjsHandler } = createRequire(import.meta.url)("../dist/index.cjs");
assert.deepEqual(await cassette("bedrock", ask(awsRequestHandler), { dir, fetch: converse }), { status: 200, text: "Sunny." });
assert.deepEqual(await cassette("bedrock", ask(cjsHandler), { dir, mode: "replay", fetch: offline }), { status: 200, text: "Sunny." });

console.log(`smoke ok on node ${process.version}`);
