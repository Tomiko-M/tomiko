<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.svg">
  <img alt="tomiko: record and replay LLM calls in your tests" src="docs/hero-light.svg" width="100%">
</picture>

<br>

[![npm](https://img.shields.io/npm/v/tomiko?color=c2491f&label=npm)](https://www.npmjs.com/package/tomiko)
[![CI](https://github.com/Tomiko-M/tomiko/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tomiko-M/tomiko/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-2f7a4b)
![dependencies](https://img.shields.io/badge/dependencies-0-2f7a4b)
[![license](https://img.shields.io/badge/license-MIT-6b6862)](LICENSE)

**The first run records real LLM responses. Every run after replays them.**<br>
Agent tests that run offline in milliseconds, cost nothing, and give the same answer every time.

[Quick start](#quick-start) · [Assertions](#assert-what-your-agent-did) · [Failures](#test-the-failure-paths) · [Viewer](#see-every-run) · [Re-record](#see-what-the-model-does-differently) · [Secrets](#keep-keys-out-of-git) · [Reference](#reference)

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
on the test replays it, with no network and no tokens. On CI it never touches the network at
all. SDKs still want some API key to build a request, so give them any value:
`ANTHROPIC_API_KEY=test`.

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
Re-record and `tomiko diff` shows what the model now does differently: other tools, a cut-off
answer, changed words, a new cost.

</td>
</tr>
<tr>
<td valign="top">

**Safe to commit**<br>
A recording with an API key in it is never saved, whether the key is in a prompt, a tool result
or the answer. Request headers are never stored.

</td>
<td valign="top">

**Works with your stack**<br>
Anthropic, OpenAI, Gemini, Vercel AI SDK, LangChain.js, plain `fetch`. Any test runner. No
dependencies.

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

## See what the model does differently

Models change under you: a provider updates one, you switch to a newer one, a prompt gets
rewritten. Re-record, and see what changed:

```sh
npx tomiko record
```

It tells you what the re-recording will cost before spending anything, runs your tests against the
live API, then shows how the answers differ from the last commit:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diff-dark.png">
  <img alt="tomiko diff showing a new tool call, an answer cut off at the token limit, a changed word in the answer, a changed field in a JSON answer, and the cost going up 67%" src="docs/diff-light.png" width="100%">
</picture>

It compares the cassettes with the last commit by what the model did, not by their bytes. Ids,
timestamps and timing are ignored, so a re-recording that changed nothing that matters says so.
Each changed cassette is labelled by its biggest change:

| | |
| --- | --- |
| **behavior changed** | other tools or arguments, another stop reason or status, different data in a JSON answer, more or fewer requests |
| **same behavior, new wording** | the same tools and data, said differently; with how many words stayed the same |
| **request changed, same answers** | you changed a prompt, a parameter or a tool, and the answers held |

Re-record only part of it, and keep the bill in check:

```sh
npx tomiko record test/agent.test.ts    # the cassettes of one test file; the rest replay
npx tomiko record --stale               # only cassettes that no longer match their tests
npx tomiko record --yes --max-cost 0.50 # no questions, but never above $0.50 (for CI)
npx tomiko record -- npm run test:llm   # your own test command
```

`--stale` replays your tests first, offline, and re-records just the cassettes that a changed
prompt or a new test left behind.

To compare without re-recording, `npx tomiko diff` compares the cassettes in your work tree with
the last commit. `--base main` compares with another revision, `--full` shows whole answers,
`--json` prints the comparison for scripts, and `--exit-code` exits with 1 when anything changed.
Without git, compare two files: `tomiko diff old.json new.json`. From code,
`diffCassettes(path, before, after)` returns the same comparison.

### Prune what your tests no longer use

Tests get renamed and deleted, prompts change, agents take fewer steps, and their old recordings
stay behind. `npx tomiko prune` replays your tests, offline and for free, and removes the cassettes
no test opened and the requests no test asked for:

```
  ✔ Replayed your tests: they use 12 of 14 cassettes.

    − test/__cassettes__/agent.test.ts/old-name.json      no test used it
    − test/__cassettes__/legacy.test.ts/greets.json       its test file is gone
    ~ test/__cassettes__/agent.test.ts/plans-a-trip.json  2 of 5 requests unused: #4, #5

  Remove 2 cassettes and 2 requests? [y/N]
```

It only trusts a run in which every test passed, and asks before removing anything; `--dry-run`
shows the list and stops. A skipped test doesn't use its cassette, so prune with the whole suite
running.

## Keep keys out of git

Cassettes get committed, so a key that ends up in one gets published. Keys find their way in more
often than you would think: an agent reads a `.env` file with a tool, a prompt includes a config, a
model repeats what it was given.

tomiko checks every recording before it saves it. When it finds a secret, it saves nothing and
fails the test with where the secret is, never the secret itself:

```
SecretsFoundError: Cassette "agent.test.ts/reads the config" was not saved: it contains 1 secret.

  ● Anthropic API key  sk-ant-api03-…f9Qa  your $ANTHROPIC_API_KEY
    #2 request body › messages[3].content[0].content

Nothing was written to __cassettes__/agent.test.ts/reads-the-config.json. To save it:
  · secrets: "redact"           replaces each one with a placeholder; replays still match
  · redact: (interaction) => …  scrubs them yourself before saving
  · secrets: { allow: [...] }   for values that are not real secrets
```

It knows 20 key formats (Anthropic, OpenAI, Google, GitHub, AWS, Stripe, Slack, Hugging Face,
Groq, xAI, private keys, JWTs and more), the values of your own environment variables named like
secrets (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`), whatever their format, and values of
fields such as `password` or `client_secret`. A key the model spelled out over several streamed
events is found too. Placeholders like `sk-ant-xxxx` and documentation examples are not flagged.

For cassettes you already have, `npx tomiko scan` finds secrets, points at the line, and says
which ones are already in git. `--fix` replaces them with placeholders, and replays keep working.
It exits with 1 when it finds any, so it can guard CI or a pre-commit hook.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/scan-dark.png">
  <img alt="tomiko scan listing a GitHub token, an Anthropic API key that matches the ANTHROPIC_API_KEY environment variable, and a password in a database URL, two of them already committed" src="docs/scan-light.png" width="100%">
</picture>

## Works with

| | Tested | Setup |
| --- | --- | --- |
| **Anthropic SDK** | messages, streaming, tools, errors and retries | none ¹ |
| **OpenAI SDK** | Chat Completions, Responses, streaming, tools, retries | none ¹ |
| **Google Gen AI SDK** | `generateContent` with function calls, streaming, errors | none |
| **Vercel AI SDK** | `generateText` tool loops (Anthropic, OpenAI, Google), `streamText` | none |
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

`npx tomiko record` does the same with a cost estimate first and a diff after. To pick cassettes
yourself, list them (files or directories) in `TOMIKO_RECORD`, separated like `PATH`: those are
re-recorded whatever the mode.

Identical requests are answered in the order they were recorded. A missing cassette only fails a
test that actually sends a request.

Transient errors (408, 429 and 5xx) are passed through while recording but not saved, so an outage
during a recording run can't replay forever; the SDK's retry is what gets recorded. To keep them,
set `recordErrors: true`, or better, simulate them with [`faults`](#test-the-failure-paths).

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
| `recordErrors` | `false` | also save transient errors (408, 429, 5xx) |
| `intercept` | every request | `(request) => boolean`; others go straight to the network |
| `redact` | none | `(interaction) => interaction`, applied before saving |
| `secrets` | `"fail"` | what to do with a secret in a recording: `"fail"`, `"redact"`, `"warn"`, or `false`; see secrets |
| `pricing` | Anthropic, OpenAI and Gemini list prices | USD per million tokens, merged over the built-in table |
| `fetch` | `globalThis.fetch` | what recording uses to reach the network |

Pass them per cassette, or set defaults once with `configure()`.

</details>

<details>
<summary><b>Secrets</b>: actions, placeholders, allowed values, your own formats</summary>

<br>

| `secrets` | A recording with a secret in it |
| --- | --- |
| `"fail"` (default) | is not saved, and the test fails with where each secret is |
| `"redact"` | is saved with each secret replaced by a placeholder such as `[REDACTED:anthropic-api-key]` |
| `"warn"` | is saved as is, with a warning in the report |
| `false` | is saved without being checked |

A redacted request still matches: tomiko replaces the same secrets in the live request before
comparing. The value of an environment variable becomes `[REDACTED:$NAME]`.

For finer control, pass an object:

```ts
configure({
  secrets: {
    action: "redact",
    allow: ["sk-test-fixture-key", /^ghp_FAKE/], // values that look like secrets but aren't
    patterns: [{ name: "Acme API key", pattern: /acme_key=(?<secret>\w{32})/ }], // `secret` marks the part to hide
    env: true, // look for the values of *_API_KEY, *_TOKEN… variables (default)
  },
});
```

A cassette recorded before the check, or with it off, gets a warning when it is replayed, pointing
to `npx tomiko scan --fix`. `findSecrets(cassette)` runs the same check from code and returns
findings with masked previews only.

To scan in CI, or on every commit with [lint-staged](https://github.com/lint-staged/lint-staged):

```json
{ "lint-staged": { "**/__cassettes__/**/*.json": "tomiko scan" } }
```

</details>

<details>
<summary><b>Cost and pricing</b></summary>

<br>

Every cassette reports tokens and estimated cost. `printSummary()` prints the totals, in color
when the output is a terminal (`NO_COLOR` and `FORCE_COLOR` are respected):

```ts
// vitest.setup.ts
import { afterAll } from "vitest";
import { printSummary, summary } from "tomiko";

afterAll(() => {
  if (summary().cassettes > 0) printSummary();
});
```

```
tomiko · 7 cassettes · 5 replayed · 1 recorded
tokens · 11.0K in · 1.9K out · 72.0K cache read · 0 cache write
cost  · $0.0960 est. · $0.0800 saved by replay
```

`formatSummary()` returns the same text as a string, plain unless you pass `{ color: true }`.

Usage is read from Anthropic, OpenAI and Gemini responses, streamed or not, with cached and
thinking tokens counted the way each provider bills them. List prices for current Anthropic,
OpenAI and Gemini models are built in, as of October 2026, at their base context tier. A dated
snapshot such as `gpt-5-2025-08-07` or `claude-haiku-4-5-20251001` has its model's price. Add or
correct others with `pricing: { "my-model": { input: 2, output: 8, cacheRead: 0.2 } }`. A model
with no price is reported, never counted as free, and `toCostLessThan` fails on it.

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
- **Checked for secrets:** everything else, before it is saved; see [secrets](#keep-keys-out-of-git).
- **Stored as is:** request and response bodies otherwise. Scrub personal data with `redact`.

</details>

## License

MIT
