/**
 * Each test here failed before its fix: bugs found reviewing secrets, diff and the viewer for 0.3.0.
 * Key-shaped values are built at run time, so no real-looking key sits in the source.
 */
import { describe, expect, it } from "vitest";
import { diffCassettes, type CassetteFile, type Interaction } from "../src/index.js";
import { diff } from "../src/match.js";
import { redactInteractions, scanInteractions, secretGuard, summarize, withoutSecrets } from "../src/secrets.js";
import { cassetteView } from "../src/view/model.js";
import { diffWords } from "../src/words.js";
import { ANTHROPIC_URL, anthropicMessage, keys, random } from "./helpers.js";

const meta = { recordedAt: "2026-10-14T12:00:00.000Z", durationMs: 40 };
const guard = (option: Parameters<typeof secretGuard>[0] = undefined, env: NodeJS.ProcessEnv = {}) => secretGuard(option, env)!;
const interaction = (body: unknown, answer: string): Interaction => ({
  request: { method: "POST", url: ANTHROPIC_URL, body },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { type: "json", value: anthropicMessage(answer) } },
  meta,
});
const found = (text: string, g = guard()) => scanInteractions([interaction(undefined, text)], g).map((f) => f.hit.kind);
const inRequest = (body: unknown, g = guard()) => scanInteractions([interaction(body, "ok")], g).map((f) => f.hit.kind);

describe("redacted recordings match on any machine", () => {
  it("names a password the same whether or not it is also in your environment", () => {
    const password = "Kx9vQ2mL7pRz4wTq";
    const prompt = { messages: [{ role: "user", content: `postgres://app:${password}@db.internal/app` }] };
    const recorded = redactInteractions([interaction(prompt, "ok")], guard("redact", { DB_PASSWORD: password })).interactions[0]!.request;
    const live = withoutSecrets({ method: "POST", url: ANTHROPIC_URL, body: prompt }, guard("redact", {}));
    expect(JSON.stringify(recorded.body)).toBe(JSON.stringify(live.body));
    expect(JSON.stringify(recorded.body)).toContain("[REDACTED:url-password]");
  });
});

describe("what a guard leaves alone", () => {
  it("leaves demo credentials and placeholders alone", () => {
    for (const text of [
      "postgresql://postgres:postgres@localhost:5432/mydb",
      "amqp://guest:guest@localhost:5672//",
      "mysql://root:root@localhost/app",
      "https://user:password123@example.com",
      "xoxb-your-bot-token",
      "glpat-your-personal-access-token",
      ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      "sk-" + "1234567890abcdef".repeat(2),
      '"password": "SecurePass123!"',
      "password = P@ssw0rd123",
    ]) {
      expect(found(text), text).toEqual([]);
    }
  });

  it("still finds real passwords", () => {
    expect(found("postgres://app:Kx9vQ2mL7pRz4wTq@db.internal/app")).toEqual(["Password in a URL"]);
    expect(found('"password": "Xq7Lm2Zp9Kd4"')).toEqual(['Value of "password"']);
  });
});

describe("what a guard finds", () => {
  it("finds a key right after an escaped line break, a tab or URL encoding", () => {
    expect(found(JSON.stringify({ path: ".env", content: `# keys\n${keys.github}` }))).toEqual(["GitHub token"]);
    expect(found(`a\\t${keys.github}`)).toEqual(["GitHub token"]);
    expect(found(`api_key%3D${keys.anthropic}`)).toEqual(["Anthropic API key"]);
    expect(inRequest({ content: JSON.stringify({ db: { password: "Kx9vQ2mL7pRz4wT" } }) })).toEqual(['Value of "password"']);
  });

  it("redacts a whole value, & ; , and # included", () => {
    const g = guard("redact");
    const redact = (text: string) => JSON.stringify(redactInteractions([interaction(undefined, text)], g).interactions[0]!.response.body);
    expect(redact("DB_PASSWORD=Xk9vQ2mL&7pRz(4wT")).toContain('"text":"DB_PASSWORD=[REDACTED:db-password]"');
    expect(redact("client_secret: Xk9vQ2mL7p,Rz4wTq")).not.toContain("Rz4wTq");
    expect(found("postgres://app:Kx9#vQ2mL7pRz4wT@db/app")).toEqual(["Password in a URL"]);
  });

  it("knows more formats and names", () => {
    const formats: [string, string][] = [
      ["tvly-dev-" + random(32, 1), "Tavily API key"],
      [`lsv2_pt_${"0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"}_${"9f8e7d6c5b"}`, "LangSmith API key"],
      [`pcsk_${random(60, 2)}`, "Pinecone API key"],
      [`ya29.${random(40, 3)}`, "Google OAuth token"],
      [`GOCSPX-${random(28, 4)}`, "Google OAuth client secret"],
      [`whsec_${random(32, 5)}`, "Stripe webhook secret"],
      [`fw_${random(30, 6)}`, "Fireworks API key"],
      [`https://discord.com/api/webhooks/804215367920156831/${random(68, 7)}`, "Discord webhook URL"],
      [`Authorization: Basic ${Buffer.from("deploy:Kx9vQ2mL7pRz4wTq").toString("base64")}`, "Basic auth credentials"],
    ];
    for (const [text, kind] of formats) expect(found(text), kind).toEqual([kind]);
    const env = { PGPASSWORD: "Kx9vQ2mL7pRz4wTq", ENCRYPTION_KEY: "Zr8nT4qW2mXv9LpK" };
    expect(found("connecting with Kx9vQ2mL7pRz4wTq and Zr8nT4qW2mXv9LpK", guard(undefined, env))).toEqual(["Value of $PGPASSWORD", "Value of $ENCRYPTION_KEY"]);
  });

  it("finds a secret used as a field name, and never prints it in the location", () => {
    const g = guard();
    const hits = scanInteractions([interaction({ metadata: { [keys.github]: { note: "x" } } }, "ok")], g);
    expect(hits.map((f) => f.hit.kind)).toEqual(["GitHub token"]);
    expect(summarize(hits)[0]!.location).not.toContain(keys.github);
    const redacted = redactInteractions([interaction({ metadata: { [keys.github]: { note: "x" } } }, "ok")], guard("redact"));
    expect(JSON.stringify(redacted.interactions[0]!.request.body)).not.toContain(keys.github);
  });

  it("scans a long run of JWT-like text in linear time", () => {
    const started = Date.now();
    found("eyJ-".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

const file = (...interactions: Interaction[]): CassetteFile => ({ version: 1, interactions });
const answer = (text: string, url = ANTHROPIC_URL, body: unknown = { model: "claude-opus-5-5", messages: [] }): Interaction => ({ ...interaction(body, text), request: { method: "POST", url, body } });

describe("diffs", () => {
  it("doesn't count trailing whitespace as a change", () => {
    expect(diffCassettes("x.json", file(answer("Hello world")), file(answer("Hello world\n"))).impact).toBe("none");
  });

  it("doesn't count ids minted per run as changes", () => {
    const get = (id: string) => answer("done", `https://api.openai.com/v1/responses/resp_${id}`, undefined);
    expect(diffCassettes("x.json", file(get("68a1f00b1c2d3e4f")), file(get("77ff00aa11bb22cc"))).impact).toBe("none");
    const doc = (id: string) => ({ model: "claude-opus-5-5", messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: `file_${id}` } }] }] });
    expect(diffCassettes("x.json", file(answer("ok", ANTHROPIC_URL, doc("011CNha8iCJcU1wXNR6q4V8w"))), file(answer("ok", ANTHROPIC_URL, doc("022DOib9jDKdV2xYOS7r5W9x")))).impact).toBe("none");
  });

  it("aligns long answers that differ in a few words", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i}`);
    const { similarity, pieces } = diffWords(words.join(" "), ["first", ...words.slice(1, -1), "last"].join(" "));
    expect(similarity).toBeGreaterThan(0.99);
    expect(pieces.filter((p) => p.op !== "=").length).toBe(4);
  });

  it("tells {} from [], a dotted key from a nested one, and true from false", () => {
    expect(diff({}, [])).toHaveLength(1);
    expect(diff({ "a.b": 1 }, { a: { b: 1 } })).not.toEqual([]);
    expect(diffCassettes("x.json", file(answer("true")), file(answer("false"))).impact).toBe("behavior");
  });
});

describe("the viewer", () => {
  it("shows an assistant prefill instead of taking it for the previous response", () => {
    const first = { model: "claude-opus-5-5", messages: [{ role: "user", content: "List colors as JSON" }] };
    const second = { ...first, messages: [...first.messages, { role: "assistant", content: '{"colors": [' }] };
    const view = cassetteView("x.json", file(answer('{"colors": ["red"]}', ANTHROPIC_URL, first), answer('"blue"]}', ANTHROPIC_URL, second)));
    expect(view.interactions[1]).toMatchObject({ repeatsPreviousResponse: false, messages: [{ role: "assistant", parts: [{ kind: "text", text: '{"colors": [' }] }] });
  });
});
