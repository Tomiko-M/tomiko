# Changelog

## 0.2.0 (2026-10-13)

### Find the cheapest model that passes: `tomiko matrix`

```sh
npx tomiko matrix --models gpt-5.4-mini,gpt-5-nano
```

- Runs your tests on each model against the live API, every request sent to it instead of the model in your code
- Estimates the cost from your current recordings and asks before spending anything; `--yes`, `--max-cost`
- Lays the models side by side with what you use now: tests passed, cost of a run and how many times less, time, and in how many cassettes the model behaves differently
- Ends with a verdict: the cheapest model that passes every test, or that nothing cheaper does
- Your cassettes are left alone; `--keep` saves each model's to `.tomiko/matrix/<model>`

### Find where you overpay: `tomiko doctor`

Reads your cassettes offline and prices what is spent on nothing:

- A system prompt that changes between requests (a timestamp, an id), so the prompt cache never hits, with the part that changes
- Tools offered to the model and never called
- Huge tool results sent back on every turn of the loop
- The same request sent twice
- `max_tokens` far above what answers use, as a risk per request

Each finding says what it costs a run; the total counts shared tokens once. `--json` for scripts, `diagnose()` from code.

### Assert what the answer means: `toMeet`

```ts
await expect(answer).toMeet("apologizes and offers a refund");
```

- A model judges the output against your criteria; on failure you get its reason and the output
- The judge's request and verdict are recorded in the cassette, so every run after replays it: offline, free, the same every time
- `claude-haiku-5-5` by default; any Anthropic, OpenAI or Gemini model with `{ model }` or `configure({ judge })`
- Judge requests don't count in tool calls, request counts or cost assertions, and faults never hit them
- `judge(output, criteria)` returns `{ pass, reason }` outside a matcher

### A model that misbehaves, on demand

```ts
fault.hallucinatedTool()          // calls a tool that doesn't exist
fault.brokenArguments({ on: 2 })  // cut-off or missing tool arguments
fault.refusal()
fault.maxTokens()                 // stops at the token limit
fault.emptyAnswer()
```

The answer is rewritten in the provider's own format (Anthropic, OpenAI Chat Completions and Responses, Gemini), streamed or not, with the matching stop reason. The cassette keeps the real answer; `c.calls[i].fault` says which fault hit.

### Re-record with one command: `tomiko record`

```sh
npx tomiko record
```

- Estimates what re-recording costs from the last recording, and asks before spending anything
- Runs your tests against the live API, then shows what the model now does differently
- `tomiko record test/agent.test.ts` re-records one test file's cassettes; the rest replay
- `--stale` replays first and re-records only cassettes that no longer match their tests, or are missing
- `--yes --max-cost 0.50` for CI; `-- npm run test:llm` for your own test command

### See what the model does differently: `tomiko diff`

- Tool calls that appeared, disappeared or got other arguments
- Answers cut off at the token limit, other stop reasons and statuses
- Changed fields in JSON answers, also inside a code fence
- Word-level diffs of answers and prompts, with how much stayed the same
- Tokens, cost and time to record, before and after
- Each cassette labelled: behavior changed, same behavior in new wording, or request changed with the same answers

Ids, timestamps and timing are ignored. `--base <ref>`, `--full`, `--json`, `--exit-code`, and `tomiko diff old.json new.json` without git. From code: `diffCassettes()`.

### Keys stay out of git

- Every recording is checked before it is saved: 20 key formats, the values of your own `*_API_KEY` / `*_TOKEN` variables, and fields like `password`. A key streamed over several events is found too.
- By default a cassette with a secret is not saved and the test fails, saying where the secret is without printing it. `secrets: "redact"` saves it with placeholders (replays still match), `"warn"` saves as is.
- `npx tomiko scan` checks the cassettes you already have, points at the line and flags secrets that are already committed; `--fix` replaces them.
- `tomiko view` warns when the cassettes it shows hold a secret.

### Clean up: `tomiko prune`

Replays your tests offline and removes the cassettes no test opened and the requests no test asked for. Only after a passing run, with `--dry-run` and a confirmation.

### Gemini, and prices for OpenAI and Gemini

- Gemini works end to end: usage with cached and thinking tokens, function calls, streaming, stop reasons, simulated errors in Gemini's format, the viewer and diffs. Tested with `@google/genai` and the AI SDK's Google provider.
- Fixed: AI SDK tool loops on Gemini didn't replay, because the SDK invents new function-call ids on every run.
- Built-in prices for current OpenAI and Gemini models, next to Anthropic's.
- A pricing key now matches only snapshots of its model (`gpt-5-2025-08-07`, `gemini-3-pro-preview`), so a different model such as `gpt-5.6` gets no price rather than a wrong one. If you relied on a key matching other models by prefix, add them to `pricing`.

### Also

- `tomiko <command> --help` for every command
- `TOMIKO_MODEL` and `TOMIKO_SHADOW` environment variables, which `matrix` uses, for your own runs

### Upgrade

```sh
npm install --save-dev tomiko@0.2.0
```

Your cassettes and tests work as they are. The only change to watch for is the stricter matching of `pricing` keys above.

## Earlier versions

See the [GitHub releases](https://github.com/Tomiko-M/tomiko/releases) for 0.1.2 and before.
