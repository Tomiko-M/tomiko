# Changelog

Notable changes to tomiko. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Unreleased

The first release.

### Added

- Record and replay of LLM API calls at the `fetch` level, with `auto`, `replay` and `record` modes;
  `replay` is the default on CI and `TOMIKO_MODE` overrides everything.
- Streaming responses recorded and replayed chunk for chunk.
- Word-level diffs when a request no longer matches a recording; opt-in fuzzy matching that never
  crosses models; `ignore` for volatile request fields.
- `tomiko/vitest`: cassettes named after the running test (`useCassette`, `setupCassettes`,
  `currentCassette`).
- Matchers for agent behavior: `toHaveCalledTool`, `toHaveCalledToolTimes`,
  `toHaveCalledToolsInOrder`, `toHaveMadeRequests`, `toHaveUsedModel`, `toCostLessThan`,
  `toHaveUsedFewerTokensThan`.
- Fault injection: `fault.rateLimit`, `overloaded`, `serverError`, `networkError`, `cutStream` and
  `latency`, in each provider's real error format.
- Token usage and cost estimates per cassette, with built-in Anthropic pricing.
- `npx tomiko view`: a self-contained HTML page showing cassettes as conversations.
- Tested with `@anthropic-ai/sdk`, `openai`, the Vercel AI SDK and LangChain.js.

[Unreleased]: https://github.com/saykachi/tomiko/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saykachi/tomiko/releases/tag/v0.1.0
