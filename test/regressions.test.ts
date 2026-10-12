import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cassette, reports } from "../src/index.js";
import { ANTHROPIC_URL, fakeApi, json, offline, tmpDir } from "./helpers.js";

const post = (body: BodyInit, url = ANTHROPIC_URL) => globalThis.fetch(url, { method: "POST", body });

describe("transient errors", () => {
  it("are passed through but not saved, so a retry's success is what replays", async () => {
    const dir = tmpDir();
    const api = fakeApi((_body, _req, call) =>
      call === 1 ? json({ type: "error", error: { type: "overloaded_error" } }, 529) : json({ ok: true }),
    );
    // A client that retries once, as the SDKs do.
    const send = async () => {
      const first = await post('{"q":1}');
      return first.status === 529 ? post('{"q":1}') : first;
    };
    const live = await cassette("transient", async () => (await send()).status, { dir, fetch: api });
    expect(live).toBe(200);
    expect(reports()[0]!.warnings.join()).toContain("529");

    const replayed = await cassette("transient", async () => (await post('{"q":1}')).status, { dir, mode: "replay", fetch: offline });
    expect(replayed).toBe(200);
    const saved = JSON.parse(readFileSync(join(dir, "transient.json"), "utf8"));
    expect(saved.interactions.map((i: any) => i.response.status)).toEqual([200]);
  });

  it("are saved with recordErrors", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => json({ error: "slow down" }, 429));
    await cassette("kept", () => post("{}"), { dir, fetch: api, recordErrors: true });
    const res = await cassette("kept", () => post("{}"), { dir, mode: "replay", fetch: offline });
    expect(res.status).toBe(429);
  });

  it("do not include deterministic client errors", async () => {
    const dir = tmpDir();
    await cassette("bad-request", () => post("{}"), { dir, fetch: fakeApi(() => json({ error: "invalid" }, 400)) });
    const res = await cassette("bad-request", () => post("{}"), { dir, mode: "replay", fetch: offline });
    expect(res.status).toBe(400);
  });
});

describe("bodies", () => {
  it("keeps binary responses without a content type byte for byte", async () => {
    const dir = tmpDir();
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]);
    const api = fakeApi(() => new Response(bytes));
    const read = async () => new Uint8Array(await (await post("{}")).arrayBuffer());
    expect(await cassette("binary", read, { dir, fetch: api })).toEqual(bytes);
    expect(await cassette("binary", read, { dir, mode: "replay", fetch: offline })).toEqual(bytes);
  });

  it("matches multipart uploads despite their random boundaries", async () => {
    const dir = tmpDir();
    const upload = () => {
      const form = new FormData();
      form.append("model", "whisper-1");
      form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "clip.mp3");
      return post(form, "https://api.openai.com/v1/audio/transcriptions");
    };
    // The fake answers directly: fakeApi parses bodies as JSON, and this one is multipart.
    await cassette("multipart", upload, { dir, fetch: async () => json({ text: "hello" }) });
    const res = await cassette("multipart", upload, { dir, mode: "replay", fetch: offline });
    expect(await res.json()).toEqual({ text: "hello" });
  });
});
