import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { plural, tokens, usd } from "../format.js";
import { publicFindings, scanInteractions, secretGuard } from "../secrets.js";
import { Spinner } from "../terminal.js";
import { discoverCassettes } from "../view/discover.js";
import { renderHtml } from "../view/html.js";
import { viewModel } from "../view/model.js";
import { type Command, failure } from "./common.js";

export const view: Command = {
  name: "view",
  usage: ["view [paths...] [options]"],
  summary: "Open a browsable page of your cassettes",
  description: () => [
    "Builds a page of your cassettes, with every prompt, tool call and answer, and opens it.",
    "Without paths, finds every __cassettes__ directory below this one. A directory you",
    "name is searched in full.",
  ],
  flags: {
    out: { type: "string", short: "-o", value: "file", help: "Where to write the page (default: a temporary file)" },
    "no-open": { type: "boolean", help: "Don't open the page in a browser" },
  },
  async run(args, io, p) {
    const spinner = new Spinner(io.stream, p, io.animate).start("Reading cassettes…");
    const paths = args.positional.map((path) => resolve(io.cwd, path));
    let found;
    try {
      found = await discoverCassettes(paths, io.cwd);
    } catch (error) {
      await spinner.stop();
      return failure(io, p, error instanceof Error ? error.message : String(error));
    }
    if (found.length === 0) {
      await spinner.stop();
      return failure(
        io,
        p,
        args.positional.length > 0
          ? `No cassettes found in ${args.positional.join(", ")}.`
          : `No cassettes found. tomiko looks in ${p.bold("__cassettes__")} directories; pass a path if yours are elsewhere.`,
      );
    }

    spinner.update(`Building the page from ${plural(found.length, "cassette")}…`);
    const model = viewModel(io.cwd, found);
    const guard = secretGuard("warn", io.env)!;
    const secrets = found.map((f) => publicFindings(scanInteractions(f.data.interactions, guard)).length);
    const out = typeof args.flags.out === "string" ? resolve(io.cwd, args.flags.out) : join(tmpdir(), `tomiko-view-${Date.now()}.html`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, renderHtml(model), "utf8");
    await spinner.stop(undefined, 600);

    const models = [...new Set(model.cassettes.flatMap((c) => c.interactions.map((i) => i.model)).filter(Boolean))];
    const allTokens = model.usage.inputTokens + model.usage.outputTokens + model.usage.cacheReadTokens + model.usage.cacheWriteTokens;
    const details = [
      `${tokens(allTokens)} tokens`,
      model.cost === null ? "no price" : `${usd(model.cost)} to record`,
      models.join(", "),
    ].filter(Boolean);
    const shown = relative(io.cwd, out).startsWith("..") ? out : relative(io.cwd, out);

    io.log(`  ${p.green("✔")} ${p.bold(plural(found.length, "cassette"))}, ${p.bold(plural(model.requests, "request"))}`);
    io.log(`    ${p.dim(details.join(" · "))}`);
    io.log(`    ${p.accent("→")} ${p.link(shown, pathToFileURL(out).href)}`);
    if (!args.flags["no-open"]) {
      io.log(`    ${p.dim((await io.open(out)) ? "Opened in your browser." : "Couldn't open a browser; open the file above.")}`);
    }
    const flagged = secrets.filter((n) => n > 0).length;
    if (flagged > 0) {
      const total = secrets.reduce((sum, n) => sum + n, 0);
      io.log(
        `    ${p.yellow("!")} ${p.yellow(`${plural(total, "secret")} in ${plural(flagged, "cassette")}`)}` +
          `${p.dim(": see them with")} ${p.bold("npx tomiko scan")}`,
      );
    }
    return 0;
  },
};
