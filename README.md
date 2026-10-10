# tomiko

**Record & replay LLM API calls in your tests.** The first run hits the real API and saves every
response to a cassette file. Every run after that replays it: zero tokens, millisecond tests,
the same answer every time, and no API keys in CI.

```ts
import { cassette } from "tomiko";

test("agent books a table", async () => {
  await cassette("agent/booking", async () => {
    const result = await agent.run("Book a table for two at 7pm");
    expect(result.toolCalls).toContainEqual(expect.objectContaining({ name: "book_table" }));
  });
});
```

Generic HTTP recorders (vcr, Polly, nock) capture bytes. tomiko knows it is looking at LLM
traffic:

- **Streaming replays exactly.** SSE responses are stored chunk by chunk and streamed back the same
  way, so SDK stream parsers, `finalMessage()`, and tool-call deltas behave as they did live.
- **Diffs you can read.** When a prompt changes, the failure shows which words changed, not two
  blobs of JSON.
- **Fuzzy matching, if you want it.** Opt in to replaying a near-identical recording after a small
  prompt tweak, with a warning instead of a failure.
- **Cost report.** Token usage and estimated spend per cassette, including how much replay saved.
- **Safe to commit.** Request headers are never written to disk, response headers go through an
  allowlist, and secret-looking query parameters are redacted.
- **Built on `fetch`, no dependencies.** Tested with `@anthropic-ai/sdk` and plain `fetch`; any
  client that uses the standard `fetch` (or accepts a custom one) can be recorded.

## Install

```sh
npm install --save-dev tomiko
```

Requires Node.js 20 or newer. Works with any test runner.

## Usage

### Wrap a test in a cassette

`cassette(name, fn)` routes `globalThis.fetch` through the cassette while `fn` runs, then saves
any new recordings to `__cassettes__/<name>.json`. Commit that directory.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { cassette } from "tomiko";

test("summarizes a ticket", async () => {
  const summary = await cassette("summarize-ticket", async () => {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Summarize: printer on fire, again." }],
    });
    return message.content[0].type === "text" ? message.content[0].text : "";
  });
  expect(summary).toMatch(/printer/i);
});
```

### Vitest: name cassettes after the test

`tomiko/vitest` names each cassette after the running test, so there is nothing to invent, nothing
to copy-paste wrong, and renaming a test renames its cassette. Cassettes are stored next to the test
file, like snapshots, with one directory level per `describe` block:

```ts
import { useCassette } from "tomiko/vitest";

describe("agent", () => {
  test("books a table", async () => {
    // → __cassettes__/booking.test.ts/agent/books-a-table.json
    await useCassette(async () => {
      const result = await agent.run("Book a table for two at 7pm");
      expect(result.toolCalls).toContainEqual(expect.objectContaining({ name: "book_table" }));
    });
  });
});
```

Need two cassettes in one test? Give each a suffix: `useCassette("second turn", fn)`.

Or skip the wrapper and give every test a cassette with one line in a setup file:

```ts
// vitest.setup.ts  (add it to `test.setupFiles` in vitest.config.ts)
import { setupCassettes } from "tomiko/vitest";

setupCassettes();
```

Tests that make no requests leave no file behind, and in `replay` mode they pass without one: a
missing cassette only fails a test when it actually sends a request. `setupCassettes()` can also be
called inside a `describe` block to cover only that block. Both helpers patch the global `fetch`,
so they don't work with `test.concurrent`.

`tomiko/vitest` is ESM only, as Vitest is, and needs Vitest 1 or newer.

### Clients created at module load

SDK clients capture `fetch` when they are constructed. If you build a client once, outside the
test, give it tomiko's `fetch`. It routes to whichever cassette is active and to the real network
otherwise, so it is safe to leave in place.

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { fetch } from "tomiko";

export const anthropic = new Anthropic({ fetch });
export const openai = new OpenAI({ fetch });
```

### Without touching globals

```ts
import { openCassette } from "tomiko";

const c = await openCassette("booking");
const client = new Anthropic({ fetch: c.fetch });
// ...
const report = await c.close(); // saves new recordings
```

## Modes

| Mode     | Matching recording | No matching recording        | Default when            |
| -------- | ------------------ | ---------------------------- | ----------------------- |
| `auto`   | replayed           | sent to the API and recorded | running locally         |
| `replay` | replayed           | `RequestMismatchError`       | the `CI` env var is set |
| `record` | ignored            | everything is re-recorded    | never                   |

Set the mode per cassette with `{ mode }`, globally with `configure({ mode })`, or for one run with
the environment, which overrides both:

```sh
TOMIKO_MODE=record npm test   # refresh every cassette
```

A cassette missing in `replay` mode fails on the first request that needs it, with
`CassetteNotFoundError`.

Identical requests are served in the order they were recorded, so an agent that sends the same
request twice gets both recorded answers back.

## When a request changes

In `replay` mode, a request with no recording fails with the closest recording and what changed:

```
RequestMismatchError: No recorded interaction in cassette "agent/booking" matches POST https://api.anthropic.com/v1/messages.
Closest recording (94% similar) differs in:
  ~ system: "…for a small restaurant. [-Always-]{+Never+} confirm the time and…"
  + temperature: 0.2

If the change is intentional, re-record with TOMIKO_MODE=record, or allow near matches with the `fuzzy` option.
```

### Fuzzy matching

```ts
await cassette("agent/booking", run, { fuzzy: 0.9 });
```

With `fuzzy` set, a request at least that similar to an unused recording replays it, and the diff
is reported as a warning. Similarity is weighted by length, so editing one word in a long system
prompt scores high, while a changed tool, parameter, or message scores low. A recording made with a
different `model` is never used as a fuzzy match.

### Ignoring volatile fields

```ts
configure({ ignore: ["metadata.user_id", "messages.*.cache_control"] });
```

Paths use dots, and `*` matches every key or array index. JSON key order never matters.

## Cost report

Every cassette produces a report, and `summary()` / `formatSummary()` aggregate the ones closed in
the current process:

```
tomiko · 7 cassettes · 5 replayed · 1 recorded
tokens · 11.0K in · 1.9K out · 72.0K cache read · 0 cache write
cost  · $0.0960 est. · $0.0800 saved by replay
```

To print it after each test file with Vitest:

```ts
// vitest.setup.ts
import { afterAll } from "vitest";
import { formatSummary, summary } from "tomiko";

afterAll(() => {
  if (summary().cassettes > 0) console.log(formatSummary());
});
```

Usage is read from Anthropic Messages responses and streams, and from OpenAI Chat Completions and
Responses API responses and streams. Built-in prices cover Anthropic models. Add others, or
override any price (USD per million tokens), with `pricing`:

```ts
configure({
  pricing: {
    "my-model": { input: 2, output: 8, cacheRead: 0.5 },
  },
});
```

A key also matches model ids that start with it, so `"claude-opus-5"` covers dated snapshots.
Models without a price are listed in the report instead of being silently counted as free.

## Options

| Option      | Default              | Description                                                                 |
| ----------- | -------------------- | --------------------------------------------------------------------------- |
| `dir`       | `"__cassettes__"`    | Where cassettes are stored. `tomiko/vitest` defaults to next to each test.  |
| `mode`      | `auto` / `replay`    | See [Modes](#modes).                                                        |
| `fuzzy`     | `false`              | Similarity threshold in (0, 1] for replaying near matches.                  |
| `ignore`    | `[]`                 | Request body paths left out of matching.                                    |
| `intercept` | all requests         | `(request) => boolean`. Others go straight to the network, unrecorded.      |
| `redact`    | none                 | `(interaction) => interaction`, applied before each save.                   |
| `pricing`   | Anthropic list price | Merged over the built-in pricing table.                                     |
| `fetch`     | `globalThis.fetch`   | The fetch used to reach the network while recording.                        |

Pass options per cassette, or set defaults once with `configure()` in a setup file.

## What a cassette looks like

```json
{
  "version": 1,
  "interactions": [
    {
      "request": {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "body": { "model": "claude-opus-5-5", "max_tokens": 1024, "messages": [ ... ] }
      },
      "response": {
        "status": 200,
        "headers": { "content-type": "text/event-stream", "request-id": "req_..." },
        "body": { "type": "sse", "chunks": ["event: message_start\ndata: {...}\n\n", "..."] }
      },
      "meta": {
        "provider": "anthropic",
        "model": "claude-opus-5-5",
        "usage": { "inputTokens": 120, "outputTokens": 42, "cacheReadTokens": 2000, "cacheWriteTokens": 0 },
        "recordedAt": "2026-10-10T12:00:00.000Z",
        "durationMs": 1830
      }
    }
  ]
}
```

Cassettes are plain JSON, so they diff well in code review: a changed prompt shows up next to the
code that changed it.

## What is stored, and what isn't

- **Never stored:** request headers (`x-api-key`, `authorization`, and the rest).
- **Response headers:** only `content-type`, `retry-after`, `request-id`, and `x-request-id`.
- **Redacted:** query parameters named like `key`, `api_key`, `token`, `access_token`, `sig`.
- **Stored as is:** request and response bodies. If prompts or answers contain personal data, scrub
  them with `redact`.

## Roadmap

- Test-name based cassette naming for Jest
- Simulated streaming latency for UI tests
- `tomiko prune` to drop recordings no test used
- MCP (Model Context Protocol) traffic over stdio

## License

MIT
