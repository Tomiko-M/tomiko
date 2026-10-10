<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.svg">
  <img alt="tomiko: record and replay LLM calls in your tests" src="docs/hero-light.svg" width="100%">
</picture>

<br>

[![npm](https://img.shields.io/npm/v/tomiko?color=c2491f&label=npm)](https://www.npmjs.com/package/tomiko)
[![CI](https://github.com/saykachi/tomiko/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/saykachi/tomiko/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-2f7a4b)
![dependencies](https://img.shields.io/badge/dependencies-0-2f7a4b)
[![license](https://img.shields.io/badge/license-MIT-6b6862)](LICENSE)

**The first run records real LLM responses. Every run after replays them.**<br>
Agent tests that run offline in milliseconds, cost nothing, and give the same answer every time.

[Quick start](#quick-start) · [Assertions](#assert-what-your-agent-did) · [Failures](#test-the-failure-paths) · [Viewer](#see-every-run) · [Reference](#reference)

</div>

<br>

## Quick start

```sh
npm install --save-dev tomiko
```

```ts
import { useCassette } from "tomiko/vitest";

test("books a table", async () => {
  await useCassette(async (c) => {
    const answer = await agent.run("Table for two at 7pm, by the window");

    expect(answer).toContain("Booked");
    expect(c).toHaveCalledTool("book_table", { guests: 2 });
    expect(c).toCostLessThan(0.05);
  });
});
```

Run it once with your API key: tomiko records every request to
`__cassettes__/booking.test.ts/books-a-table.json` next to the test. Commit that file. From then
on the test replays it, with no network, no key, and no tokens. On CI it never touches the
network at all.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <img alt="First run: tomiko asks the LLM API and records the answers to a cassette. Every run after: tomiko replays the cassette and the API is not called." src="docs/how-it-works-light.svg" width="100%">
</picture>

## Why tomiko

HTTP recorders like nock or Polly capture bytes. tomiko knows it is looking at LLM traffic.

<table>
<tr>
<td width="50%" valign="top">

**Streams replay exactly**<br>
SSE responses come back chunk by chunk, so `stream()`, `finalMessage()` and streamed tool calls
behave as they did live.

</td>
<td width="50%" valign="top">

**Assertions about behavior**<br>
Which tools the model called, with what arguments, in what order, how many requests it took, and
what it cost.

</td>
</tr>
<tr>
<td valign="top">

**Failures on demand**<br>
Replay with rate limits, overloads, dropped connections and slow responses to test your retry
paths.

</td>
<td valign="top">

**Diffs you can read**<br>
Change a prompt and the failure shows the changed words, not two blobs of JSON.

</td>
</tr>
<tr>
<td valign="top">

**Safe to commit**<br>
API keys and request headers are never written to disk. Secret query parameters are redacted.

</td>
<td valign="top">

**Works with your stack**<br>
Anthropic, OpenAI, Vercel AI SDK, LangChain.js, plain `fetch`. Any test runner. No dependencies.

</td>
</tr>
</table>

## Assert what your agent did

Importing `tomiko/vitest` adds matchers that read the requests and responses in the cassette:

```ts
expect(c).toHaveCalledTool("book_table", { guests: 2, table: expect.any(Number) });
expect(c).toHaveCalledToolsInOrder(["search_tables", "book_table"]);
expect(c).not.toHaveCalledTool("cancel_booking");
expect(c).toHaveMadeRequests({ max: 5 }); // no runaway loops
```

When one fails, you see what the agent did instead:

```
expected cassette "booking.test.ts/books a table" to call tool "cancel_booking".
Tool calls:
  search_tables({"time":"19:00","guests":2})
  book_table({"table":12,"guests":2,"note":"window"})
```

| Matcher | Passes when |
| --- | --- |
| `toHaveCalledTool(name, input?)` | the tool was called; `input` must be contained in its arguments |
| `toHaveCalledToolTimes(name, n)` | the tool was called exactly `n` times |
| `toHaveCalledToolsInOrder(names)` | the tools were called in this order, others allowed in between |
| `toHaveMadeRequests(n \| {min, max})` | the number of requests is `n`, or in range |
| `toHaveUsedModel(model \| regex)` | a request went to the model |
| `toCostLessThan(usd)` | the estimated cost is below `usd` |
| `toHaveUsedFewerTokensThan(n)` | all tokens add up to fewer than `n` |

## Test the failure paths

Live APIs rarely fail on cue. Recordings can:

```ts
import { fault } from "tomiko";

await useCassette(run, { faults: [fault.rateLimit({ times: 2 })] }); // 429, 429, then the recording
await useCassette(run, { faults: [fault.cutStream({ afterEvents: 3 })] }); // connection drops mid-stream
```

`rateLimit` · `overloaded` · `serverError` · `networkError` · `cutStream` · `latency`

Errors use each provider's real format, so SDKs throw their usual typed errors, and tell SDKs to
retry right away instead of waiting out a real backoff. Target requests with `on: [1, 3]`, `times: n` or `when: (request) => …`.

## See every run

```sh
npx tomiko view
```

Every cassette as a conversation: system prompt, tool calls and results, the response, and the
tokens, cost and time of each step. One HTML file, no server, ready to attach to a CI run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/viewer-dark.png">
  <img alt="tomiko view showing an agent run as a conversation, with tool calls, results and per-step cost" src="docs/viewer-light.png" width="100%">
</picture>

## Works with

| | Tested | Setup |
| --- | --- | --- |
| **Anthropic SDK** | messages, streaming, tools, errors and retries | none ¹ |
| **OpenAI SDK** | Chat Completions, Responses, streaming, tools, retries | none ¹ |
| **Vercel AI SDK** | `generateText` tool loops, `streamText` | none |
| **LangChain.js** | `ChatAnthropic`, `ChatOpenAI`, bound tools | none ² |
| **Anything on `fetch`** | | none |

<sub>¹ For a client created once at module load, pass `fetch` from `tomiko`, see
[below](#clients-created-before-a-test). ² If the model may be called before any test runs, pass
`fetch` the same way.</sub>

Each row is covered by tests that record against a fake API, replay offline, and require identical
results.

## Reference

<details>
<summary><b>Modes and CI</b></summary>

<br>

| Mode | Recording matches | No recording matches | Default when |
| --- | --- | --- | --- |
| `auto` | replayed | sent to the API and recorded | running locally |
| `replay` | replayed | test fails, nothing is sent | `CI` is set |
| `record` | ignored | everything is re-recorded | never |

Set a mode with `{ mode }`, with `configure({ mode })`, or for one run with the environment, which
wins over both:

```sh
TOMIKO_MODE=record npm test   # refresh every cassette
```

Identical requests are answered in the order they were recorded. A missing cassette only fails a
test that actually sends a request.

</details>

<details>
<summary><b>Without Vitest</b>: <code>cassette()</code>, <code>openCassette()</code>, Jest</summary>

<br>

`cassette(name, fn)` works with any test runner. It routes `globalThis.fetch` through the cassette
while `fn` runs, then saves new recordings to `__cassettes__/<name>.json`.

```ts
import { cassette } from "tomiko";

const answer = await cassette("support/refund", () => agent.run("I want a refund"));
```

`openCassette(name)` touches no globals: pass `c.fetch` to a client and call `await c.close()` to
save.

For Jest, register the matchers yourself: `expect.extend(matchers)` with
`import { matchers } from "tomiko"`.

</details>

<details>
<summary><b>Vitest helpers</b>: naming, <code>setupCassettes()</code>, types</summary>

<br>

`useCassette(fn)` names the cassette after the test, one directory per `describe` block, next to
the test file. For several cassettes in one test, add a suffix: `useCassette("second turn", fn)`.

To give every test a cassette with no wrapper, add to a setup file:

```ts
import { setupCassettes } from "tomiko/vitest";

setupCassettes();
```

Then read the current one with `currentCassette()`. Tests that make no requests leave no file
behind. Both helpers patch the global `fetch`, so they don't work with `test.concurrent`.

Matcher types are declared for Vitest 5. On older versions, declare them in your project following
your version's custom matcher docs, with the exported `TomikoMatchers` interface.

</details>

<details>
<summary id="clients-created-before-a-test"><b>Clients created before a test</b></summary>

<br>

The Anthropic and OpenAI SDKs capture `fetch` when a client is constructed. A client created inside
a test picks up tomiko automatically. For one created at module load, pass tomiko's `fetch`. It
routes to the active cassette and to the real network otherwise, so it is safe to leave in
production code.

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { fetch } from "tomiko";

export const anthropic = new Anthropic({ fetch });
export const openai = new OpenAI({ fetch });
// LangChain: new ChatAnthropic({ clientOptions: { fetch } }), new ChatOpenAI({ configuration: { fetch } })
```

</details>

<details>
<summary><b>When a prompt changes</b>: diffs, fuzzy matching, ignored fields</summary>

<br>

In `replay` mode, a request with no recording fails with the closest one and what changed:

```
RequestMismatchError: No recorded interaction in cassette "agent/booking" matches POST https://api.anthropic.com/v1/messages.
Closest recording (94% similar) differs in:
  ~ system: "…for a small restaurant. [-Always-]{+Never+} confirm the time and…"
  + temperature: 0.2
```

Re-record with `TOMIKO_MODE=record`, or allow near matches: with `{ fuzzy: 0.9 }`, a request at
least 90% similar replays the recording and the diff becomes a warning. A recording from a
different model is never used.

Leave volatile fields out of matching with `ignore: ["metadata.user_id", "messages.*.cache_control"]`.

</details>

<details>
<summary><b>Options</b></summary>

<br>

| Option | Default | |
| --- | --- | --- |
| `dir` | `"__cassettes__"` | where cassettes live (`tomiko/vitest`: next to each test) |
| `mode` | `auto`, or `replay` on CI | see modes |
| `fuzzy` | `false` | similarity threshold for near matches |
| `ignore` | `[]` | request body paths left out of matching |
| `faults` | `[]` | simulated failures |
| `intercept` | every request | `(request) => boolean`; others go straight to the network |
| `redact` | none | `(interaction) => interaction`, applied before saving |
| `pricing` | Anthropic list prices | USD per million tokens, merged over the built-in table |
| `fetch` | `globalThis.fetch` | what recording uses to reach the network |

Pass them per cassette, or set defaults once with `configure()`.

</details>

<details>
<summary><b>Cost and pricing</b></summary>

<br>

Every cassette reports tokens and estimated cost; `formatSummary()` prints a summary:

```
tomiko · 7 cassettes · 5 replayed · 1 recorded
tokens · 11.0K in · 1.9K out · 72.0K cache read · 0 cache write
cost  · $0.0960 est. · $0.0800 saved by replay
```

Usage is read from Anthropic and OpenAI responses, streamed or not. Anthropic prices are built in;
add others with `pricing: { "my-model": { input: 2, output: 8 } }`. A model with no price is
reported, never counted as free, and `toCostLessThan` fails on it.

</details>

<details>
<summary><b>What a cassette stores</b></summary>

<br>

Plain JSON, so a changed prompt shows up in code review next to the code that changed it:

```json
{
  "version": 1,
  "interactions": [
    {
      "request": { "method": "POST", "url": "https://api.anthropic.com/v1/messages", "body": { "model": "claude-opus-5-5", "messages": [] } },
      "response": { "status": 200, "headers": { "content-type": "text/event-stream" }, "body": { "type": "sse", "chunks": ["event: message_start\n…"] } },
      "meta": { "provider": "anthropic", "model": "claude-opus-5-5", "usage": { "inputTokens": 120, "outputTokens": 42 }, "durationMs": 1830 }
    }
  ]
}
```

- **Never stored:** request headers, including `x-api-key` and `authorization`.
- **Response headers:** only `content-type`, `retry-after`, `request-id`, `x-request-id`.
- **Redacted:** query parameters such as `key`, `api_key`, `token`.
- **Stored as is:** request and response bodies. Scrub personal data with `redact`.

</details>

## License

MIT
