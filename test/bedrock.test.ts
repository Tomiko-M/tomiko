import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  ThrottlingException,
} from "@aws-sdk/client-bedrock-runtime";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { ChatBedrockConverse } from "@langchain/aws";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Sha256 } from "@aws-crypto/sha256-js";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { SignatureV4 } from "@smithy/signature-v4";
import { crc32, fromEvent, toEvents } from "../src/eventstream.js";
import { awsRequestHandler, cassette, diagnose, diffCassettes, fault, judge, SecretsFoundError, type CassetteFile } from "../src/index.js";
import { cassetteView } from "../src/view/model.js";
import {
  anthropicMessage,
  anthropicStream,
  awsEventStream,
  BEDROCK_CLAUDE,
  BEDROCK_NOVA,
  BEDROCK_URL,
  converseResponse,
  converseStream,
  fakeApi,
  invokeStream,
  json,
  keys,
  offline,
  tmpDir,
} from "./helpers.js";

const credentials = { accessKeyId: "AKIDTOMIKOTEST", secretAccessKey: "not-a-secret" };
const client = (region = "us-east-1") => new BedrockRuntimeClient({ region, credentials, requestHandler: awsRequestHandler, maxAttempts: 3 });

/** A fake Bedrock that answers each endpoint the way the real one does. */
function bedrock(options: { tool?: { name: string; input: unknown }; text?: string } = {}) {
  return fakeApi((_body, request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/converse")) return json(converseResponse({ text: options.text ?? "It is sunny in Lisbon.", tools: options.tool ? [options.tool] : [] }));
    if (path.endsWith("/converse-stream")) return awsEventStream(converseStream({ parts: ["It is ", "sunny ", "in Lisbon."], tool: options.tool }));
    if (path.endsWith("/invoke")) return json(anthropicMessage("Bonjour.", "claude-haiku-4-5-20251001"));
    if (path.endsWith("/invoke-with-response-stream")) return awsEventStream(invokeStream(anthropicStream(["Bon", "jour."], "claude-haiku-4-5-20251001")));
    return json({ message: "Unknown operation" }, 404);
  });
}

const weather = (text = "Weather in Lisbon?") => ({
  modelId: BEDROCK_CLAUDE,
  system: [{ text: "You report the weather." }],
  messages: [{ role: "user" as const, content: [{ text }] }],
  toolConfig: { tools: [{ toolSpec: { name: "get_weather", description: "Weather for a city", inputSchema: { json: { type: "object", properties: { city: { type: "string" } } } } } }] },
  inferenceConfig: { maxTokens: 512 },
});

async function streamed(c: BedrockRuntimeClient, input = weather()) {
  const { stream } = await c.send(new ConverseStreamCommand(input));
  let text = "";
  const tools: { name?: string; input: string }[] = [];
  let stopReason: string | undefined;
  let usage: unknown;
  for await (const event of stream!) {
    if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
    if (event.contentBlockStart?.start?.toolUse) tools.push({ name: event.contentBlockStart.start.toolUse.name, input: "" });
    if (event.contentBlockDelta?.delta?.toolUse) tools.at(-1)!.input += event.contentBlockDelta.delta.toolUse.input;
    if (event.messageStop) stopReason = event.messageStop.stopReason;
    if (event.metadata) usage = event.metadata.usage;
  }
  return { text, tools, stopReason, usage };
}

describe("Bedrock through the AWS SDK", () => {
  it("records Converse and replays it offline, with tools, usage and cost", async () => {
    const dir = tmpDir();
    const api = bedrock({ tool: { name: "get_weather", input: { city: "Lisbon" } } });
    const run = async (c: Awaited<Parameters<Parameters<typeof cassette>[1]>[0]>) => {
      const out = await client().send(new ConverseCommand(weather()));
      return { stop: out.stopReason, content: out.output?.message?.content, calls: c.calls.map((call) => ({ provider: call.provider, model: call.model, tools: call.toolCalls.map((t) => t.name), usage: call.usage, cost: call.cost })) };
    };
    const live = await cassette("converse", run, { dir, fetch: api });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe(`${BEDROCK_URL}/model/${encodeURIComponent(BEDROCK_CLAUDE)}/converse`);
    expect(live.calls).toEqual([
      {
        provider: "bedrock",
        model: BEDROCK_CLAUDE,
        tools: ["get_weather"],
        usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0 },
        // Haiku 4.5: $1 in, $5 out, cache reads at a tenth.
        cost: (300 * 1 + 40 * 5 + 1000 * 0.1) / 1e6,
      },
    ]);
    expect(await cassette("converse", run, { dir, mode: "replay", fetch: offline })).toEqual(live);
  });

  it("records ConverseStream as readable events and replays them frame by frame", async () => {
    const dir = tmpDir();
    const api = bedrock({ tool: { name: "get_weather", input: { city: "Lisbon" } } });
    const live = await cassette("stream", () => streamed(client()), { dir, fetch: api });
    expect(live).toEqual({
      text: "It is sunny in Lisbon.",
      tools: [{ name: "get_weather", input: '{"city":"Lisbon"}' }],
      stopReason: "tool_use",
      usage: { inputTokens: 250, outputTokens: 30, totalTokens: 280 },
    });

    const saved = JSON.parse(readFileSync(join(dir, "stream.json"), "utf8"));
    const body = saved.interactions[0].response.body;
    expect(body.type).toBe("eventstream");
    expect(body.events.slice(0, 2)).toEqual([
      { event: "messageStart", data: { role: "assistant" } },
      { event: "contentBlockDelta", data: { delta: { text: "It is " }, contentBlockIndex: 0 } },
    ]);
    expect(saved.interactions[0].meta).toMatchObject({ provider: "bedrock", model: BEDROCK_CLAUDE, usage: { inputTokens: 250, outputTokens: 30 } });

    expect(await cassette("stream", () => streamed(client()), { dir, mode: "replay", fetch: offline })).toEqual(live);
  });

  it("records InvokeModel and its stream, with Claude's own events decoded", async () => {
    const dir = tmpDir();
    const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [{ role: "user", content: "Say hello in French" }] });
    const run = async (c: Awaited<Parameters<Parameters<typeof cassette>[1]>[0]>) => {
      const whole = await client().send(new InvokeModelCommand({ modelId: BEDROCK_CLAUDE, body, contentType: "application/json" }));
      const answer = JSON.parse(new TextDecoder().decode(whole.body)).content[0].text;
      const { body: stream } = await client().send(new InvokeModelWithResponseStreamCommand({ modelId: BEDROCK_CLAUDE, body, contentType: "application/json" }));
      let text = "";
      for await (const event of stream!) {
        const data = JSON.parse(new TextDecoder().decode(event.chunk!.bytes));
        if (data.type === "content_block_delta") text += data.delta.text;
      }
      return { answer, text, calls: c.calls.map((call) => ({ text: call.text, model: call.model, usage: call.usage })) };
    };
    const live = await cassette("invoke", run, { dir, fetch: bedrock() });
    expect(live).toEqual({
      answer: "Bonjour.",
      text: "Bonjour.",
      calls: [
        { text: "Bonjour.", model: "claude-haiku-4-5-20251001", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { text: "Bonjour.", model: "claude-haiku-4-5-20251001", usage: { inputTokens: 120, outputTokens: 42, cacheReadTokens: 2000, cacheWriteTokens: 0 } },
      ],
    });
    const saved = JSON.parse(readFileSync(join(dir, "invoke.json"), "utf8"));
    // The chunk's base64 is stored as the event it holds, and Bedrock's padding is dropped.
    expect(saved.interactions[1].response.body.events[0]).toEqual({ event: "chunk", bytes: expect.objectContaining({ type: "message_start" }) });
    expect(await cassette("invoke", run, { dir, mode: "replay", fetch: offline })).toEqual(live);
  });

  it("replays a recording made in another region", async () => {
    const dir = tmpDir();
    const live = await cassette("region", () => client("us-east-1").send(new ConverseCommand(weather())).then((o) => o.stopReason), { dir, fetch: bedrock() });
    const replayed = await cassette("region", () => client("eu-west-1").send(new ConverseCommand(weather())).then((o) => o.stopReason), { dir, mode: "replay", fetch: offline });
    expect(replayed).toBe(live);
  });

  it("throws the SDK's own ThrottlingException, and its retries get through", async () => {
    const dir = tmpDir();
    await cassette("throttle", () => client().send(new ConverseCommand(weather())), { dir, fetch: bedrock() });
    const retried = await cassette(
      "throttle",
      async (c) => {
        const out = await client().send(new ConverseCommand(weather()));
        return { stop: out.stopReason, faults: c.calls.map((call) => call.fault ?? "ok") };
      },
      { dir, mode: "replay", fetch: offline, faults: [fault.rateLimit({ times: 2 })] },
    );
    expect(retried).toEqual({ stop: "end_turn", faults: ["rate_limit", "rate_limit", "ok"] });

    const error = await cassette("throttle", () => client().send(new ConverseCommand(weather())), {
      dir,
      mode: "replay",
      fetch: offline,
      faults: [fault.rateLimit({ times: Infinity })],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ThrottlingException);
    expect((error as Error).message).toContain("Too many requests");
  });

  it("cuts a stream between frames", async () => {
    const dir = tmpDir();
    await cassette("cut", () => streamed(client()), { dir, fetch: bedrock() });
    const seen: string[] = [];
    const error = await cassette(
      "cut",
      async () => {
        const { stream } = await client().send(new ConverseStreamCommand(weather()));
        for await (const event of stream!) seen.push(Object.keys(event).find((k) => k !== "$unknown")!);
      },
      { dir, mode: "replay", fetch: offline, faults: [fault.cutStream({ afterEvents: 3 })] },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(seen).toEqual(["messageStart", "contentBlockDelta", "contentBlockDelta"]);
  });
});

describe("Bedrock through Anthropic's Bedrock SDK and the AI SDK", () => {
  it("records Claude on Bedrock, streamed and not, and replays it", async () => {
    const dir = tmpDir();
    const run = async (c: Awaited<Parameters<Parameters<typeof cassette>[1]>[0]>) => {
      const anthropic = new AnthropicBedrock({ awsRegion: "us-east-1", awsAccessKey: credentials.accessKeyId, awsSecretKey: credentials.secretAccessKey });
      const whole = await anthropic.messages.create({ model: BEDROCK_CLAUDE, max_tokens: 100, messages: [{ role: "user", content: "Say hello in French" }] });
      const stream = anthropic.messages.stream({ model: BEDROCK_CLAUDE, max_tokens: 100, messages: [{ role: "user", content: "Say hello in French" }] });
      const final = await stream.finalMessage();
      return {
        whole: whole.content,
        streamed: final.content,
        stop: final.stop_reason,
        calls: c.calls.map((call) => ({ provider: call.provider, url: new URL(call.url).pathname, cost: call.cost })),
      };
    };
    const live = await cassette("anthropic", run, { dir, fetch: bedrock() });
    expect(live.streamed).toEqual([expect.objectContaining({ type: "text", text: "Bonjour." })]);
    expect(live.calls).toEqual([
      { provider: "bedrock", url: `/model/${BEDROCK_CLAUDE}/invoke`, cost: (1000 * 1 + 200 * 5) / 1e6 },
      { provider: "bedrock", url: `/model/${BEDROCK_CLAUDE}/invoke-with-response-stream`, cost: (120 * 1 + 42 * 5 + 2000 * 0.1) / 1e6 },
    ]);
    expect(await cassette("anthropic", run, { dir, mode: "replay", fetch: offline })).toEqual(live);
  });

  it("records an AI SDK tool loop and a stream through Converse", async () => {
    const dir = tmpDir();
    const api = fakeApi((body, request) => {
      const sent = JSON.stringify(body);
      if (request.url.endsWith("/converse-stream")) return awsEventStream(converseStream({ parts: ["Sunny ", "all day."] }));
      if (sent.includes("toolResult")) return json(converseResponse({ text: "It is 18°C and sunny in Lisbon." }));
      return json(converseResponse({ tools: [{ name: "get_weather", input: { city: "Lisbon" } }] }));
    });
    const run = async () => {
      const bedrockAi = createAmazonBedrock({ region: "us-east-1", accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey });
      const result = await generateText({
        model: bedrockAi(BEDROCK_NOVA),
        prompt: "Weather in Lisbon?",
        tools: { get_weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async () => ({ celsius: 18 }) }) },
        stopWhen: stepCountIs(3),
      });
      const stream = streamText({ model: bedrockAi(BEDROCK_NOVA), prompt: "And tomorrow?" });
      return { text: result.text, steps: result.steps.length, streamed: await stream.text };
    };
    const live = await cassette("ai-sdk", run, { dir, fetch: api });
    expect(live).toEqual({ text: "It is 18°C and sunny in Lisbon.", steps: 2, streamed: "Sunny all day." });
    expect(await cassette("ai-sdk", run, { dir, mode: "replay", fetch: offline })).toEqual(live);
  });
});

describe("a misbehaving model on Bedrock", () => {
  it("rewrites Converse answers, whole and streamed", async () => {
    const dir = tmpDir();
    await cassette("misbehave", async () => {
      await client().send(new ConverseCommand(weather()));
      await streamed(client());
    }, { dir, fetch: bedrock({ tool: { name: "get_weather", input: { city: "Lisbon" } } }) });

    const replay = (faults: ReturnType<typeof fault.refusal>[]) =>
      cassette("misbehave", async () => {
        const whole = await client().send(new ConverseCommand(weather()));
        return { whole: { stop: whole.stopReason, content: whole.output?.message?.content }, streamed: await streamed(client()) };
      }, { dir, mode: "replay", fetch: offline, faults });

    const hallucinated = await replay([fault.hallucinatedTool({ times: 2 })]);
    expect(hallucinated.whole).toEqual({ stop: "tool_use", content: [{ toolUse: { toolUseId: "tooluse_tomiko_1", name: "get_weather_v2", input: { city: "Lisbon" } } }] });
    expect(hallucinated.streamed).toMatchObject({ text: "", tools: [{ name: "get_weather_v2", input: '{"city":"Lisbon"}' }], stopReason: "tool_use" });

    const broken = await replay([fault.brokenArguments({ on: 2 })]);
    expect(broken.streamed.tools).toEqual([{ name: "get_weather", input: '{"city":"' }]);

    const cut = await replay([fault.maxTokens({ times: 2 })]);
    expect(cut.whole.stop).toBe("max_tokens");
    expect(cut.streamed).toMatchObject({ text: "It is sunny", stopReason: "max_tokens" });

    const refused = await replay([fault.refusal({ times: 2 })]);
    expect(refused.whole).toEqual({ stop: "content_filtered", content: [{ text: "I'm sorry, but I can't help with that." }] });
    expect(refused.streamed.stopReason).toBe("content_filtered");
  });

  it("rewrites Claude's own events inside an InvokeModel stream", async () => {
    const dir = tmpDir();
    const run = () => {
      const anthropic = new AnthropicBedrock({ awsRegion: "us-east-1", awsAccessKey: credentials.accessKeyId, awsSecretKey: credentials.secretAccessKey });
      return anthropic.messages.stream({ model: BEDROCK_CLAUDE, max_tokens: 100, messages: [{ role: "user", content: "Say hello in French" }] }).finalMessage();
    };
    await cassette("claude-stream", run, { dir, fetch: bedrock() });
    const refused = await cassette("claude-stream", run, { dir, mode: "replay", fetch: offline, faults: [fault.refusal()] });
    expect(refused.stop_reason).toBe("refusal");
    expect(refused.content).toEqual([expect.objectContaining({ type: "text", text: "I'm sorry, but I can't help with that." })]);
  });
});

describe("secrets in Bedrock streams", () => {
  it("finds a key the model spelled out over several events, and redacts it so replays still work", async () => {
    const key = keys.anthropic;
    const api = fakeApi(() => awsEventStream(converseStream({ parts: ["Your key is ", key.slice(0, 20), key.slice(20), "."] })));
    const dir = tmpDir();
    const error = await cassette("leak", () => streamed(client()), { dir, fetch: api }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as Error).message).toContain("Anthropic API key");

    const live = await cassette("leak", () => streamed(client()), { dir, fetch: api, secrets: "redact" });
    expect(live.text).toBe(`Your key is ${key}.`);
    const saved = readFileSync(join(dir, "leak.json"), "utf8");
    expect(saved).not.toContain(key.slice(20));
    const replayed = await cassette("leak", () => streamed(client()), { dir, mode: "replay", fetch: offline, secrets: "redact" });
    expect(replayed.text).toBe("Your key is [REDACTED:anthropic-api-key].");
  });
});

/** Checks a request's SigV4 signature with the AWS SDK's own signer. */
async function validSignature(request: Request, secretAccessKey: string): Promise<boolean> {
  const auth = request.headers.get("authorization") ?? "";
  const [, accessKeyId, region, service, signed] = /Credential=([^/]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+)/.exec(auth) ?? [];
  if (!accessKeyId) return false;
  const url = new URL(request.url);
  const headers: Record<string, string> = { host: url.host };
  for (const name of signed!.split(";")) if (name !== "host") headers[name] = request.headers.get(name) ?? "";
  const body = await request.clone().text();
  if (signed!.split(";").includes("content-length")) headers["content-length"] = String(Buffer.byteLength(body));
  const signer = new SignatureV4({ credentials: { accessKeyId, secretAccessKey, sessionToken: request.headers.get("x-amz-security-token") ?? undefined }, region: region!, service: service!, sha256: Sha256, applyChecksum: false });
  const date = request.headers.get("x-amz-date")!;
  const signingDate = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  const expected = await signer.sign({ method: request.method, protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: {}, headers, body }, { signingDate });
  return expected.headers.authorization === auth;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("another model on Bedrock, for tomiko matrix", () => {
  it("puts the model in the path and signs the request again", async () => {
    const signatures: boolean[] = [];
    const api = fakeApi(async (_body, request) => {
      signatures.push(await validSignature(request, credentials.secretAccessKey));
      return json(converseResponse({ text: "Sunny." }));
    });
    await withEnv({ TOMIKO_MODEL: BEDROCK_NOVA, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey }, () =>
      cassette("matrix", () => client().send(new ConverseCommand(weather())), { dir: tmpDir(), fetch: api }),
    );
    expect(api.calls.map((c) => new URL(c.url).pathname)).toEqual([`/model/${encodeURIComponent(BEDROCK_NOVA)}/converse`]);
    expect(signatures).toEqual([true]);
  });

  it("finds the signing key in the shared credentials file, or says where to put it", async () => {
    const home = tmpDir();
    const file = join(home, "credentials");
    writeFileSync(file, `[default]\naws_access_key_id = AKIDOTHER\naws_secret_access_key = other\n\n[work]\naws_access_key_id = ${credentials.accessKeyId}\naws_secret_access_key = ${credentials.secretAccessKey}\n`);
    const signatures: boolean[] = [];
    const api = fakeApi(async (_body, request) => {
      signatures.push(await validSignature(request, credentials.secretAccessKey));
      return json(converseResponse({ text: "Sunny." }));
    });
    const send = () => cassette("matrix", () => client().send(new ConverseCommand(weather())), { dir: tmpDir(), fetch: api });
    await withEnv({ TOMIKO_MODEL: BEDROCK_NOVA, AWS_SHARED_CREDENTIALS_FILE: file, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, send);
    expect(signatures).toEqual([true]);

    const error = await withEnv({ TOMIKO_MODEL: BEDROCK_NOVA, AWS_SHARED_CREDENTIALS_FILE: join(home, "none"), AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, send).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `To send this request to ${BEDROCK_NOVA}, tomiko signs it again, and the AWS credentials it was signed with (access key AKID…TEST) ` +
        "are not in AWS_ACCESS_KEY_ID or ~/.aws/credentials. Set them there, or use a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK.",
    );
  });

  it("leaves a Bedrock API key's request as it is, and refuses what can't work", async () => {
    const api = fakeApi(() => json(converseResponse({ text: "Sunny." })));
    const bedrockAi = createAmazonBedrock({ region: "us-east-1", apiKey: "bedrock-api-key-test" });
    const ask = () => cassette("bearer", () => generateText({ model: bedrockAi(BEDROCK_CLAUDE), prompt: "Hi" }), { dir: tmpDir(), fetch: api });
    await withEnv({ TOMIKO_MODEL: BEDROCK_NOVA }, ask);
    expect(new URL(api.calls[0]!.url).pathname).toBe(`/model/${encodeURIComponent(BEDROCK_NOVA)}/converse`);

    await expect(withEnv({ TOMIKO_MODEL: "gpt-5.4-mini" }, ask)).rejects.toThrow(
      "TOMIKO_MODEL=gpt-5.4-mini is not a Bedrock model id: this request goes to Amazon Bedrock, which names models like us.anthropic.claude-haiku-4-5-20251001-v1:0 or amazon.nova-lite-v1:0.",
    );
    const invoke = withEnv({ TOMIKO_MODEL: BEDROCK_NOVA, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey }, () =>
      cassette("invoke", () => client().send(new InvokeModelCommand({ modelId: BEDROCK_CLAUDE, body: "{}", contentType: "application/json" })), { dir: tmpDir(), fetch: bedrock() }),
    );
    await expect(invoke).rejects.toThrow(`InvokeModel bodies are in each model family's own format, and this one is for ${BEDROCK_CLAUDE}. Use Bedrock's Converse API`);
  });
});

describe("a judge on Bedrock", () => {
  it("asks through Converse, signed, and replays the verdict offline", async () => {
    const signatures: boolean[] = [];
    const api = fakeApi(async (body, request) => {
      signatures.push(await validSignature(request, credentials.secretAccessKey));
      expect(request.headers.has("x-tomiko-judge")).toBe(false);
      expect(body.system[0].text).toContain("You grade the output");
      return json(converseResponse({ text: '{"pass": true, "reason": "It apologizes and offers a refund."}' }));
    });
    const dir = tmpDir();
    const run = () => judge("Sorry! Here is a full refund.", "apologizes and offers a refund", { model: BEDROCK_NOVA });
    const verdict = await withEnv({ AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_REGION: "us-west-2", AWS_BEARER_TOKEN_BEDROCK: undefined }, () =>
      cassette("judge", run, { dir, fetch: api }),
    );
    expect(verdict).toEqual({ pass: true, reason: "It apologizes and offers a refund.", model: BEDROCK_NOVA });
    expect(api.calls[0]!.url).toBe(`https://bedrock-runtime.us-west-2.amazonaws.com/model/${encodeURIComponent(BEDROCK_NOVA)}/converse`);
    expect(signatures).toEqual([true]);
    // No credentials, another region: the recorded verdict still answers.
    const replayed = await withEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_REGION: "eu-west-1", AWS_SHARED_CREDENTIALS_FILE: join(dir, "none") }, () =>
      cassette("judge", run, { dir, mode: "replay", fetch: offline }),
    );
    expect(replayed).toEqual(verdict);
  });
});

describe("reading Bedrock cassettes", () => {
  it("shows Converse requests in the viewer, the doctor and diffs like any other", async () => {
    const dir = tmpDir();
    await cassette("read", () => streamed(client()), { dir, fetch: bedrock({ tool: { name: "get_weather", input: { city: "Lisbon" } } }) });
    const file = JSON.parse(readFileSync(join(dir, "read.json"), "utf8")) as CassetteFile;

    const [view] = cassetteView("read.json", file).interactions;
    expect(view).toMatchObject({
      provider: "bedrock",
      model: BEDROCK_CLAUDE,
      system: "You report the weather.",
      tools: [{ name: "get_weather", description: "Weather for a city" }],
      messages: [{ role: "user", parts: [{ kind: "text", text: "Weather in Lisbon?" }] }],
      response: { text: "It is sunny in Lisbon.", toolCalls: [{ name: "get_weather", input: { city: "Lisbon" } }], stopReason: "tool_use", streamed: true },
    });

    const after = structuredClone(file);
    const delta = after.interactions[0]!.response.body as { events: { event?: string; data?: { delta?: { toolUse?: { input: string } } } }[] };
    for (const e of delta.events) if (e.data?.delta?.toolUse) e.data.delta.toolUse.input = e.data.delta.toolUse.input.replace("Lisbon", "Porto").replace("Lis", "Por");
    const changed = diffCassettes("read.json", file, after);
    expect(changed.impact).toBe("behavior");
    expect(changed.requests[0]!.response?.tools?.inputs).toEqual([{ name: "get_weather", occurrence: 0, changes: [expect.objectContaining({ path: "city" })] }]);

    const twice = { version: 1 as const, interactions: [file.interactions[0]!, file.interactions[0]!] };
    expect(diagnose([{ path: "read.json", data: twice }]).findings.map((f) => f.kind)).toContain("duplicate-request");
  });
});

describe("AWS event streams", () => {
  it("decodes frames the AWS SDK encodes, and encodes frames it decodes", async () => {
    const response = awsEventStream([
      { event: "messageStart", data: { role: "assistant", p: "abc" } },
      { exception: "throttlingException", data: { message: "Slow down" } },
    ]);
    const events = toEvents(new Uint8Array(await response.arrayBuffer()));
    expect(events).toEqual([
      { event: "messageStart", data: { role: "assistant" } },
      { exception: "throttlingException", data: { message: "Slow down" } },
    ]);
    const codec = new EventStreamCodec((s: Uint8Array) => Buffer.from(s).toString("utf8"), (s: string) => new Uint8Array(Buffer.from(s, "utf8")));
    const decoded = events!.map((e) => codec.decode(fromEvent(e)));
    expect(decoded.map((m) => [m.headers[":message-type"]!.value, m.headers[":event-type"]?.value ?? m.headers[":exception-type"]?.value, Buffer.from(m.body).toString()])).toEqual([
      ["event", "messageStart", '{"role":"assistant"}'],
      ["exception", "throttlingException", '{"message":"Slow down"}'],
    ]);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    // Not frames: left to be stored as bytes.
    expect(toEvents(new TextEncoder().encode("not an event stream at all"))).toBeUndefined();
  });

  it("stores a stream that turns out not to be frames as the bytes it was", async () => {
    const dir = tmpDir();
    const api = fakeApi(() => new Response("garbage that is not framed", { headers: { "content-type": "application/vnd.amazon.eventstream" } }));
    await cassette("garbage", () => fetch(`${BEDROCK_URL}/model/x.y/converse-stream`, { method: "POST", body: "{}" }).then((r) => r.text()), { dir, fetch: api });
    const saved = JSON.parse(readFileSync(join(dir, "garbage.json"), "utf8"));
    expect(saved.interactions[0].response.body).toEqual({ type: "base64", value: Buffer.from("garbage that is not framed").toString("base64") });
  });
});

describe("comparing Bedrock recordings", () => {
  it("pairs requests to another model by their endpoint, the model aside", () => {
    const at = (model: string, text: string): CassetteFile => ({
      version: 1,
      interactions: [
        {
          request: { method: "POST", url: `${BEDROCK_URL}/model/${encodeURIComponent(model)}/converse`, body: { messages: [{ role: "user", content: [{ text: "Hi" }] }] } },
          response: { status: 200, headers: {}, body: { type: "json", value: converseResponse({ text }) } },
          meta: { recordedAt: "", durationMs: 1 },
        },
      ],
    });
    const changed = diffCassettes("x.json", at(BEDROCK_CLAUDE, "Hello there."), at(BEDROCK_NOVA, "Hello there!"));
    expect(changed.impact).toBe("wording");
    expect(changed.requests[0]!.request?.model).toEqual({ before: BEDROCK_CLAUDE, after: BEDROCK_NOVA });
  });
});

describe("LangChain on Bedrock", () => {
  it("records ChatBedrockConverse through a client with tomiko's handler", async () => {
    const dir = tmpDir();
    const run = async () => {
      const model = new ChatBedrockConverse({ model: BEDROCK_NOVA, region: "us-east-1", credentials, client: client() });
      const answer = await model.invoke("Weather in Lisbon?");
      return answer.content;
    };
    const live = await cassette("langchain", run, { dir, fetch: bedrock({ text: "Sunny in Lisbon." }) });
    expect(live).toBe("Sunny in Lisbon.");
    expect(await cassette("langchain", run, { dir, mode: "replay", fetch: offline })).toBe(live);
  });
});
