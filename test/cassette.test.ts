import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CassetteNotFoundError,
  NestedCassetteError,
  RequestMismatchError,
  cassette,
  configure,
  openCassette,
  reports,
} from "../src/index.js";
import { ANTHROPIC_URL, anthropicMessage, fakeApi, json, offline, tmpDir } from "./helpers.js";

const post = (body: unknown, url = ANTHROPIC_URL) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-SECRET" },
    body: JSON.stringify(body),
  });

const ask = (prompt: string, extra: object = {}) => ({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  system: "You are a helpful booking assistant for a small restaurant in Lisbon.",
  messages: [{ role: "user", content: prompt }],
  ...extra,
});

describe("record and replay", () => {
  it("records on the first run and replays without the network afterwards", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json(anthropicMessage("Booked for 19:00.")));

    const first = await cassette("booking", async () => (await post(ask("Table for two"))).json(), { dir, fetch: api });
    expect(api.calls).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ recorded: 1, replayed: 0, saved: true });

    const second = await cassette("booking", async () => (await post(ask("Table for two"))).json(), {
      dir,
      fetch: offline,
    });
    expect(second).toEqual(first);
    expect(api.calls).toHaveLength(1);
    expect(reports()[1]).toMatchObject({ recorded: 0, replayed: 1, saved: false });
  });

  it("never writes request headers or response cookies to disk", async () => {
    const dir = tmpDir();
    await cassette("secrets", () => post(ask("hi")), { dir, fetch: fakeApi(() => json(anthropicMessage("ok"))) });
    const file = readFileSync(join(dir, "secrets.json"), "utf8");
    expect(file).not.toContain("sk-ant-SECRET");
    expect(file).not.toContain("set-cookie");
    expect(JSON.parse(file).interactions[0].response.headers).toEqual({ "content-type": "application/json" });
  });

  it("redacts secret query parameters but still matches on replay", async () => {
    const dir = tmpDir();
    const url = "https://generativelanguage.googleapis.com/v1/models/x:generate?key=AIzaSECRET&alt=json";
    await cassette("query", () => post({ q: 1 }, url), { dir, fetch: fakeApi(() => json({ ok: true })) });
    expect(readFileSync(join(dir, "query.json"), "utf8")).not.toContain("AIzaSECRET");

    const res = await cassette("query", () => post({ q: 1 }, url), { dir, mode: "replay", fetch: offline });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("ignores object key order when matching", async () => {
    const dir = tmpDir();
    await cassette("order", () => post({ a: 1, b: { c: 2, d: 3 } }), { dir, fetch: fakeApi(() => json({ n: 1 })) });
    const res = await cassette("order", () => post({ b: { d: 3, c: 2 }, a: 1 }), { dir, mode: "replay", fetch: offline });
    expect(await res.json()).toEqual({ n: 1 });
  });

  it("serves identical requests in recorded order, then repeats the last one", async () => {
    const dir = tmpDir();
    const api = fakeApi((_body, _req, call) => json({ call }));
    await cassette(
      "repeat",
      async () => {
        await post({ same: true });
        await post({ same: true });
      },
      { dir, fetch: api },
    );

    const seen = await cassette(
      "repeat",
      async () => [
        await (await post({ same: true })).json(),
        await (await post({ same: true })).json(),
        await (await post({ same: true })).json(),
      ],
      { dir, mode: "replay", fetch: offline },
    );
    expect(seen).toEqual([{ call: 1 }, { call: 2 }, { call: 2 }]);
  });

  it("appends new requests in auto mode and keeps the old ones", async () => {
    const dir = tmpDir();
    const api = fakeApi((body) => json({ echo: body.messages[0].content }));
    await cassette("grow", () => post(ask("one")), { dir, fetch: api });
    await cassette(
      "grow",
      async () => {
        await post(ask("one"));
        await post(ask("two"));
      },
      { dir, fetch: api },
    );
    expect(api.calls).toHaveLength(2);
    const saved = JSON.parse(readFileSync(join(dir, "grow.json"), "utf8"));
    expect(saved.interactions.map((i: any) => i.response.body.value.echo)).toEqual(["one", "two"]);
  });

  it("re-records everything in record mode", async () => {
    const dir = tmpDir();
    await cassette("fresh", () => post(ask("old")), { dir, fetch: fakeApi(() => json({ v: "old" })) });
    await cassette("fresh", () => post(ask("new")), { dir, mode: "record", fetch: fakeApi(() => json({ v: "new" })) });
    const saved = JSON.parse(readFileSync(join(dir, "fresh.json"), "utf8"));
    expect(saved.interactions).toHaveLength(1);
    expect(saved.interactions[0].response.body.value).toEqual({ v: "new" });
  });

  it("handles responses without a body", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => new Response(null, { status: 204 }));
    const status = await cassette("empty", async () => (await post({ x: 1 })).status, { dir, fetch: api });
    const replayed = await cassette("empty", async () => (await post({ x: 1 })).status, { dir, mode: "replay", fetch: offline });
    expect([status, replayed]).toEqual([204, 204]);
  });

  it("replays recorded error responses faithfully", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json({ type: "error", error: { type: "overloaded_error" } }, 529));
    await cassette("errors", () => post(ask("hi")), { dir, fetch: api, recordErrors: true });
    const res = await cassette("errors", () => post(ask("hi")), { dir, mode: "replay", fetch: offline });
    expect(res.status).toBe(529);
    expect(await res.json()).toMatchObject({ error: { type: "overloaded_error" } });
  });
});

describe("mismatches", () => {
  it("fails in replay mode with a readable diff of what changed", async () => {
    const dir = tmpDir();
    await cassette("diff", () => post(ask("Table for two at 7pm")), { dir, fetch: fakeApi(() => json({})) });

    const changed = ask("Table for two at 7pm", {
      system: "You are a helpful reservation assistant for a small restaurant in Lisbon.",
      temperature: 0.2,
    });
    const error = await cassette("diff", () => post(changed), { dir, mode: "replay", fetch: offline }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestMismatchError);
    expect(error.message).toContain('~ system: "You are a helpful [-booking-]{+reservation+} assistant for a small');
    expect(error.message).toContain("+ temperature: 0.2");
  });

  it("explains when nothing was recorded for the endpoint", async () => {
    const dir = tmpDir();
    await cassette("other", () => post({ a: 1 }), { dir, fetch: fakeApi(() => json({})) });
    const error = await cassette("other", () => post({ a: 1 }, "https://api.openai.com/v1/responses"), {
      dir,
      mode: "replay",
      fetch: offline,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestMismatchError);
    expect(error.message).toContain("Nothing was recorded for this endpoint");
  });

  it("replays a near match with a warning when fuzzy matching is on", async () => {
    const dir = tmpDir();
    await cassette("fuzzy", () => post(ask("Table for two at 7pm")), { dir, fetch: fakeApi(() => json({ ok: 1 })) });

    const tweaked = ask("Table for two at 7pm", {
      system: "You are a helpful reservation assistant for a small restaurant in Lisbon.",
    });
    const res = await cassette("fuzzy", () => post(tweaked), { dir, mode: "replay", fuzzy: 0.9, fetch: offline });
    expect(await res.json()).toEqual({ ok: 1 });
    const report = reports()[1]!;
    expect(report.replayed).toBe(1);
    expect(report.warnings[0]).toMatch(/Fuzzy match \(\d+% similar\)/);
    expect(report.warnings[0]).toContain("[-booking-]{+reservation+}");
  });

  it("does not fuzzy-match a different model", async () => {
    const dir = tmpDir();
    await cassette("model", () => post(ask("hi")), { dir, fetch: fakeApi(() => json({})) });
    const error = await cassette("model", () => post(ask("hi", { model: "claude-haiku-5-5" })), {
      dir,
      mode: "replay",
      fuzzy: 0.5,
      fetch: offline,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(RequestMismatchError);
  });

  it("ignores configured body paths", async () => {
    const dir = tmpDir();
    configure({ dir, ignore: ["metadata.user_id", "messages.*.cache_control"] });
    await cassette("ignore", () => post(ask("hi", { metadata: { user_id: "u-1" } })), {
      fetch: fakeApi(() => json({ ok: true })),
    });
    const live = ask("hi", { metadata: { user_id: "u-2" } });
    (live.messages[0] as any).cache_control = { type: "ephemeral" };
    const res = await cassette("ignore", () => post(live), { mode: "replay", fetch: offline });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("modes and lifecycle", () => {
  it("fails on the first request when a cassette is missing in replay mode", async () => {
    const dir = tmpDir();
    await expect(cassette("missing", () => post({ x: 1 }), { dir, mode: "replay" })).rejects.toBeInstanceOf(
      CassetteNotFoundError,
    );
    // A test that never sends a request has nothing to replay, so it passes.
    await expect(cassette("missing", () => "no calls", { dir, mode: "replay" })).resolves.toBe("no calls");
  });

  it("defaults to replay on CI, and TOMIKO_MODE overrides everything", async () => {
    const dir = tmpDir();
    process.env.CI = "true";
    const onCI = await openCassette("ci", { dir });
    expect(onCI.mode).toBe("replay");
    await expect(onCI.fetch(ANTHROPIC_URL, { method: "POST" })).rejects.toBeInstanceOf(CassetteNotFoundError);
    await onCI.close();

    process.env.TOMIKO_MODE = "record";
    const c = await openCassette("ci", { dir, mode: "replay" });
    expect(c.mode).toBe("record");
    await c.close();
  });

  it("passes non-intercepted requests straight through", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json({ local: true }));
    await cassette("intercept", () => post({ x: 1 }, "http://localhost:3000/health"), {
      dir,
      fetch: api,
      intercept: (req) => new URL(req.url).hostname !== "localhost",
    });
    expect(api.calls).toHaveLength(1);
    expect(existsSync(join(dir, "intercept.json"))).toBe(false);
  });

  it("restores globalThis.fetch even when the test throws", async () => {
    const original = globalThis.fetch;
    await expect(cassette("boom", () => Promise.reject(new Error("boom")), { dir: tmpDir() })).rejects.toThrow("boom");
    expect(globalThis.fetch).toBe(original);
  });

  it("refuses to nest cassettes", async () => {
    const dir = tmpDir();
    await expect(cassette("outer", () => cassette("inner", () => {}, { dir }), { dir })).rejects.toBeInstanceOf(
      NestedCassetteError,
    );
  });

  it("keeps cassette names inside the cassette directory", async () => {
    const dir = tmpDir();
    const c = await openCassette("../../etc/agent flow", { dir });
    expect(c.file).toBe(join(dir, "etc", "agent-flow.json"));
    await c.close();
  });

  it("keeps letters from any script in cassette names", async () => {
    const dir = tmpDir();
    const c = await openCassette("агент > бронирует столик: 2 места?", { dir });
    expect(c.file).toBe(join(dir, "агент-бронирует-столик-2-места.json"));
    await c.close();
  });

  it("applies the redact hook before saving", async () => {
    const dir = tmpDir();
    await cassette("pii", () => post(ask("My phone is +351 912 345 678")), {
      dir,
      fetch: fakeApi(() => json({ ok: true })),
      redact: (i) => {
        i.response.headers = {};
        return i;
      },
    });
    const saved = JSON.parse(readFileSync(join(dir, "pii.json"), "utf8"));
    expect(saved.interactions[0].response.headers).toEqual({});
  });

  it("rejects cassette files from an unknown format version", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "old.json"), JSON.stringify({ version: 99, interactions: [] }));
    await expect(openCassette("old", { dir })).rejects.toThrow("Unsupported cassette format");
  });
});
