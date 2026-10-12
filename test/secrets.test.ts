import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cassette, findSecrets, SecretsFoundError, type Interaction } from "../src/index.js";
import {
  isSecretName,
  maskSecrets,
  redactInteractions,
  scanInteractions,
  secretGuard,
  withoutSecrets,
} from "../src/secrets.js";
import { ANTHROPIC_URL, anthropicMessage, anthropicStream, fakeApi, json, keys, offline, random, sse, tmpDir } from "./helpers.js";

const meta = { recordedAt: "2026-10-10T12:00:00.000Z", durationMs: 40 };
const guard = (option: Parameters<typeof secretGuard>[0] = undefined, env: NodeJS.ProcessEnv = {}) => secretGuard(option, env)!;

function interaction(body: unknown, answer: string): Interaction {
  return {
    request: { method: "POST", url: ANTHROPIC_URL, body },
    response: { status: 200, headers: { "content-type": "application/json" }, body: { type: "json", value: anthropicMessage(answer) } },
    meta,
  };
}

const found = (text: string, g = guard()) => scanInteractions([interaction(undefined, text)], g).map((f) => f.hit.kind);

describe("finding secrets", () => {
  it("knows the formats of the APIs people call from tests", () => {
    expect(found(`key ${keys.anthropic}`)).toEqual(["Anthropic API key"]);
    expect(found(`key ${keys.openai}`)).toEqual(["OpenAI API key"]);
    expect(found(`key ${keys.google}`)).toEqual(["Google API key"]);
    expect(found(`token ${keys.github}`)).toEqual(["GitHub token"]);
    expect(found(`stripe ${keys.stripe}`)).toEqual(["Stripe secret key"]);
    expect(found(`slack ${keys.slack}`)).toEqual(["Slack token"]);
    expect(found(`aws ${keys.aws}`)).toEqual(["AWS access key ID"]);
    expect(found(`hf ${keys.huggingface}`)).toEqual(["Hugging Face token"]);
    expect(found(`groq ${keys.groq}`)).toEqual(["Groq API key"]);
    expect(found(`-----BEGIN RSA PRIVATE KEY-----\n${random(64)}\n${random(64, 1)}\n-----END RSA PRIVATE KEY-----`)).toEqual(["Private key"]);
  });

  it("leaves placeholders, documentation examples and API ids alone", () => {
    expect(found("use sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toEqual([]);
    expect(found(`the AWS docs use ${"AKIA" + "IOSFODNN7EXAMPLE"}`)).toEqual([]);
    expect(found("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----")).toEqual([]);
    expect(found("set ANTHROPIC_API_KEY=<your key> or OPENAI_API_KEY=${OPENAI_API_KEY}")).toEqual([]);
    expect(found("msg_01XFDUDYJgAACzvnptvVoYEL toolu_01A09q90qw90lq917835lq9 chatcmpl-B9MHDbslfCsHuT4N")).toEqual([]);
    expect(found("a task-ant-api03 mention, max_tokens: 1024, tokenizer: cl100k_base")).toEqual([]);
  });

  it("finds values assigned to secret-named fields, in JSON and in text", () => {
    const g = guard();
    const leaks = scanInteractions(
      [interaction({ messages: [{ role: "user", content: "hi" }], metadata: { api_key: "k3yV4lue99xyz" } }, "DB_PASSWORD=s3cretValue1 and {\"client_secret\":\"Abc123def456\"}")],
      g,
    ).map((f) => f.hit.kind);
    expect(leaks).toEqual(['Value of "api_key"', 'Value of "DB_PASSWORD"', 'Value of "client_secret"']);
  });

  it("doesn't mistake code and counters for secrets", () => {
    expect(found("password = self.password; apiKey: config.apiKey2; secret: /run/secrets/db")).toEqual([]);
    expect(found('{"max_tokens": 4096, "next_page_token": "token123", "author": "Ann123456"}')).toEqual([]);
  });

  it("finds passwords in URLs and bearer tokens", () => {
    expect(found("postgres://app:Pr0dPassw0rd@db.internal/app")).toEqual(["Password in a URL"]);
    expect(found("https://user:password@example.com")).toEqual([]);
    expect(found(`curl -H "Authorization: Bearer ${random(32, 2)}"`)).toEqual(["Bearer token"]);
  });

  it("finds the values of your own secret environment variables, whatever their format", () => {
    const env = { MISTRAL_API_KEY: random(32, 4), PWD: "/home/me/project-with-long-name", SHORT_TOKEN: "abc", ANTHROPIC_API_KEY: keys.anthropic };
    const g = guard(undefined, env);
    const hits = scanInteractions([interaction(undefined, `${env.MISTRAL_API_KEY} ${keys.anthropic} /home/me/project-with-long-name`)], g);
    expect(hits.map((f) => [f.hit.kind, f.hit.env])).toEqual([
      ["Value of $MISTRAL_API_KEY", "MISTRAL_API_KEY"],
      ["Anthropic API key", "ANTHROPIC_API_KEY"],
    ]);
    expect(scanInteractions([interaction(undefined, env.MISTRAL_API_KEY)], guard({ env: false }, env))).toEqual([]);
  });

  it("names secrets the way people write them", () => {
    for (const name of ["ANTHROPIC_API_KEY", "client_secret", "refreshToken", "db.password", "GITHUB_TOKEN", "x-api-key", "apiKey"]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ["max_tokens", "PWD", "tokenizer", "key", "next_page_token", "author", "SSH_AUTH_SOCK", "TOKENIZERS_PARALLELISM"]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it("can allow values and learn your own formats", () => {
    const text = `${keys.github} and acme_id=7;key=${random(20, 9)}`;
    expect(found(text, guard({ allow: [keys.github] }))).toEqual([]);
    expect(found(text, guard({ allow: [/^gh/], patterns: [{ name: "Acme key", pattern: /acme_id=\d+;key=(?<secret>\w+)/ }] }))).toEqual(["Acme key"]);
    expect(found(text, guard({ allow: [/^gh/], patterns: [/acme_id=\d+;key=\w+/] }))).toEqual(["Secret"]);
  });

  it("finds a key the model spelled out over several streamed events", () => {
    const parts = ["Your key: sk-", "ant-api03-", keys.anthropic.slice(14, 60), keys.anthropic.slice(60), " done"];
    const streamed: Interaction = {
      request: { method: "POST", url: ANTHROPIC_URL, body: {} },
      response: { status: 200, headers: {}, body: { type: "sse", chunks: [] } },
      meta,
    };
    const events = anthropicStream(parts);
    streamed.response.body = {
      type: "sse",
      chunks: [events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")].flatMap((text) => text.match(/[^]{1,50}/g)!),
    };
    const hits = scanInteractions([streamed], guard());
    expect(hits.map((f) => [f.hit.kind, f.part, f.path])).toEqual([["Anthropic API key", "response stream", "delta.text"]]);
  });

  it("scans a body served without a content type, and stays fast on large base64 data", () => {
    const text: Interaction = {
      request: { method: "POST", url: ANTHROPIC_URL, body: { image: Buffer.alloc(3_000_000, 7).toString("base64") + random(2000, 3) } },
      response: { status: 200, headers: {}, body: { type: "base64", value: Buffer.from(`token=${keys.github}`).toString("base64") } },
      meta,
    };
    const started = performance.now();
    const hits = scanInteractions([text], guard());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(hits.map((f) => f.hit.kind)).toEqual(["GitHub token"]);
  });

  it("reports each secret once with a preview that never reveals it", () => {
    const repeated = interaction({ system: `key ${keys.anthropic}`, messages: [] }, `I see ${keys.anthropic}`);
    const findings = findSecrets([repeated, repeated]);
    expect(findings).toEqual([
      {
        kind: "Anthropic API key",
        rule: "anthropic-api-key",
        preview: `sk-ant-api03-…${keys.anthropic.slice(-4)}`,
        request: 1,
        location: "request body › system",
        occurrences: 4,
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(keys.anthropic.slice(14, 30));
    expect(maskSecrets(`a ${keys.github} b`, guard())).toBe(`a ghp_…${keys.github.slice(-4)} b`);
  });
});

describe("redacting secrets", () => {
  it("replaces each secret with a placeholder in copies, everywhere it appears", () => {
    const original = interaction(
      { messages: [{ role: "user", content: [{ type: "tool_result", content: `OPENAI_API_KEY=${keys.openai}` }] }] },
      `Your token is ${keys.github}.`,
    );
    original.request.url = `https://example.com/hooks?key=${keys.google}`;
    const { interactions, found: hits } = redactInteractions([original], guard());
    const copy = interactions[0]!;
    expect(hits).toHaveLength(3);
    expect(copy.request.url).toBe("https://example.com/hooks?key=[REDACTED:google-api-key]");
    expect(JSON.stringify(copy.request.body)).toContain("OPENAI_API_KEY=[REDACTED:openai-api-key]");
    expect(JSON.stringify(copy.response.body)).toContain("Your token is [REDACTED:github-token].");
    expect(JSON.stringify(original)).toContain(keys.github); // the original is untouched
    expect(scanInteractions(interactions, guard())).toEqual([]);
  });

  it("rewrites only the stream events a secret touched, keeping every other chunk as it was", () => {
    const events = anthropicStream(["Key: ", keys.anthropic.slice(0, 30), keys.anthropic.slice(30), " — keep it safe."]);
    const raw = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
    const chunks = raw.match(/[^]{1,64}/g)!;
    const streamed: Interaction = {
      request: { method: "POST", url: ANTHROPIC_URL, body: {} },
      response: { status: 200, headers: {}, body: { type: "sse", chunks } },
      meta,
    };
    const { interactions } = redactInteractions([streamed], guard());
    const body = interactions[0]!.response.body as { chunks: string[] };
    const text = body.chunks.join("");
    expect(text).toContain('"text":"[REDACTED:anthropic-api-key]"');
    expect(text).not.toContain(keys.anthropic.slice(30));
    expect(text).toContain(' — keep it safe.');
    // Chunks before the first changed event are untouched.
    expect(body.chunks.slice(0, 3)).toEqual(chunks.slice(0, 3));
  });

  it("lets a redacted request match the live one", () => {
    const g = guard();
    const live = { method: "POST", url: ANTHROPIC_URL, body: { messages: [{ role: "user", content: `Use ${keys.stripe}` }] } };
    const saved = redactInteractions([{ request: live, response: { status: 200, headers: {}, body: { type: "empty" } }, meta }], g).interactions[0]!.request;
    expect(withoutSecrets(live, g)).toEqual(saved);
    expect(withoutSecrets(saved, g)).toBe(saved); // nothing to do: the same object back
  });
});

describe("the secrets option", () => {
  const leaky = () => fakeApi(() => json(anthropicMessage(`Sure! Your key is ${keys.anthropic}.`)));
  const send = (body: unknown = { model: "claude-opus-5-5", messages: [] }) =>
    fetch(ANTHROPIC_URL, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

  it("refuses to save a cassette with a secret, and says where it is without printing it", async () => {
    const dir = tmpDir();
    const error = await cassette("leak", () => send(), { dir, fetch: leaky() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsFoundError);
    const message = (error as Error).message;
    expect(message).toContain('Cassette "leak" was not saved: it contains 1 secret.');
    expect(message).toContain("● Anthropic API key");
    expect(message).toContain("#1 response body › content[0].text");
    expect(message).toContain('secrets: "redact"');
    expect(message).not.toContain(keys.anthropic.slice(14, 40));
    expect(existsSync(join(dir, "leak.json"))).toBe(false);
  });

  it("can redact before saving, and the redacted recording still replays", async () => {
    const dir = tmpDir();
    const body = { model: "claude-opus-5-5", messages: [{ role: "user", content: `Here is my key: ${keys.groq}` }] };
    const first = await cassette("redacted", () => send(body), { dir, fetch: leaky(), secrets: "redact" });
    expect(first.content[0].text).toContain(keys.anthropic); // the test itself sees the real response
    const saved = readFileSync(join(dir, "redacted.json"), "utf8");
    expect(saved).not.toContain(keys.anthropic);
    expect(saved).not.toContain(keys.groq);
    expect(saved).toContain("[REDACTED:anthropic-api-key]");
    expect(saved).toContain("Here is my key: [REDACTED:groq-api-key]");

    const replayed = await cassette("redacted", () => send(body), { dir, mode: "replay", fetch: offline, secrets: "redact" });
    expect(replayed.content[0].text).toBe("Sure! Your key is [REDACTED:anthropic-api-key].");
  });

  it("can save as is with a warning, or not look at all", async () => {
    const dir = tmpDir();
    await cassette("warned", () => send(), { dir, fetch: leaky(), secrets: "warn" });
    expect(readFileSync(join(dir, "warned.json"), "utf8")).toContain(keys.anthropic);
    await cassette("unguarded", () => send(), { dir, fetch: leaky(), secrets: false });
    expect(readFileSync(join(dir, "unguarded.json"), "utf8")).toContain(keys.anthropic);
    const { reports } = await import("../src/index.js");
    const [warned, unguarded] = reports();
    expect(warned!.warnings).toEqual([expect.stringMatching(/^Saved cassette "warned" with 1 secret in it: Anthropic API key \(#1 response body › content\[0\]\.text\)\.$/)]);
    expect(unguarded!.warnings).toEqual([]);
  });

  it("warns when a cassette it replays already holds a secret", async () => {
    const dir = tmpDir();
    const file = join(dir, "old.json");
    mkdirSync(dirname(file), { recursive: true });
    const recorded = interaction({ model: "claude-opus-5-5", messages: [] }, `token: ${keys.github}`);
    writeFileSync(file, JSON.stringify({ version: 1, interactions: [recorded] }));
    await cassette("old", () => send(), { dir, mode: "replay", fetch: offline });
    const { reports } = await import("../src/index.js");
    expect(reports()[0]!.warnings[0]).toMatch(/contains 1 secret: GitHub token .* Run `npx tomiko scan --fix` to replace it, and revoke it/);
  });

  it("never prints a secret from a live request in a mismatch error", async () => {
    const dir = tmpDir();
    await cassette("mismatch", () => send({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }), {
      dir,
      fetch: fakeApi(() => json(anthropicMessage("hello"))),
    });
    const error = await cassette(
      "mismatch",
      () => send({ model: "claude-opus-5-5", messages: [{ role: "user", content: `hi ${keys.openai}` }] }),
      { dir, mode: "replay", fetch: offline },
    ).catch((e: unknown) => e as Error);
    expect(error.message).toContain("[REDACTED:openai-api-key]");
    expect(error.message).not.toContain(keys.openai.slice(10, 40));
  });

  it("rejects an unknown action", async () => {
    await expect(cassette("x", () => 1, { dir: tmpDir(), secrets: "shred" as never })).rejects.toThrow(
      'Unknown secrets action "shred". Expected one of: fail, redact, warn.',
    );
  });

  it("guards streamed recordings too", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => sse(anthropicStream(["Your key ", keys.anthropic.slice(0, 20), keys.anthropic.slice(20)])));
    const error = await cassette("stream", () => send().catch(() => null), { dir, fetch: api }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as SecretsFoundError).findings.map((f) => f.location)).toEqual(["response stream › delta.text"]);
  });
});
