export class TomikoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CassetteNotFoundError extends TomikoError {
  constructor(readonly file: string) {
    super(
      `Cassette not found: ${file}\n` +
        `Running in replay mode, so tomiko will not hit the network. ` +
        `Record it first by running the test locally (mode "auto") or with TOMIKO_MODE=record.`,
    );
  }
}

export class RequestMismatchError extends TomikoError {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly cassette: string,
    readonly diff: string | null,
    readonly similarity: number | null,
  ) {
    const mcp = method === "MCP" ? /^mcp:\/\/([^/]+)\/(.+)$/.exec(url) : null;
    const head = mcp
      ? `No recorded request to MCP server "${mcp[1]}" in cassette "${cassette}" matches ${mcp[2]}.`
      : `No recorded interaction in cassette "${cassette}" matches ${method} ${url}.`;
    const body =
      diff === null
        ? `\nNothing was recorded for this endpoint.`
        : `\nClosest recording (${Math.round((similarity ?? 0) * 100)}% similar) differs in:\n${diff}`;
    const hint =
      `\n\nIf the change is intentional, re-record with TOMIKO_MODE=record, ` +
      `or allow near matches with the \`fuzzy\` option.`;
    super(head + body + hint);
  }
}

export class NestedCassetteError extends TomikoError {
  constructor(active: string, requested: string) {
    super(`Cannot open cassette "${requested}" while "${active}" is active. Cassettes do not nest.`);
  }
}
