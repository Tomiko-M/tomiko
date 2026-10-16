import { CassetteNotFoundError, RequestMismatchError, TomikoError } from "./errors.js";
import { type Fault, type FaultName, FaultPlan, type RequestFault, cutResponse, delay, errorResponse, networkError } from "./faults.js";
import {
  abortable,
  buildResponse,
  encodeBody,
  isEventStream,
  parseRequestBody,
  pickHeaders,
  recordStream,
  redactUrl,
  textSink,
} from "./http.js";
import { eventSink, isAwsEventStream } from "./eventstream.js";
import { type Injection, type InjectionFault, plant, type PlantState } from "./injection.js";
import { type McpExchange, type McpRecorder, type McpServer, slug } from "./mcp.js";
import { isMcpHttp, maybeSseStream, mcpOverHttp, openSse, peekEvent } from "./mcp-http.js";
import { canonical, diff, formatDiff, similarity, stripPaths } from "./match.js";
import { readContent } from "./inspect.js";
import { costOf, defaultPricing, priceFor } from "./pricing.js";
import { buildReport, recordReport } from "./report.js";
import { chosenForRecording, logUsage, modelOverride, shadowed } from "./control.js";
import { type Misbehavior, MISBEHAVIORS, misbehave } from "./misbehave.js";
import { JUDGE_HEADER } from "./judge.js";
import { bypassing, realFetch, runtime } from "./runtime.js";
import {
  type Found,
  type Guard,
  publicFindings,
  redactInteractions,
  scanInteractions,
  SecretsFoundError,
  secretGuard,
  withoutSecrets,
} from "./secrets.js";
import { cassettePath, loadCassette, saveCassette } from "./store.js";
import type {
  CassetteReport,
  Interaction,
  McpCall,
  Mode,
  PricingTable,
  RecordedCall,
  RecordedRequest,
  RecordedResponse,
  StreamEvent,
  TomikoOptions,
  ToolCall,
} from "./types.js";
import { parseAuthorization, findCredentials, maskKeyId, sign } from "./sigv4.js";
import { BEDROCK_PATH, bedrockFamily, detectProvider, extractUsage, isBedrockModel, matchUrl, requestModel } from "./usage.js";

const MODES: readonly Mode[] = ["auto", "replay", "record"];

function isCI(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/** `TOMIKO_MODE` wins so a whole suite can be re-recorded without code changes. */
export function resolveMode(option?: Mode): Mode {
  const env = process.env.TOMIKO_MODE?.trim().toLowerCase();
  const mode = (env || option || (isCI() ? "replay" : "auto")) as Mode;
  if (!MODES.includes(mode)) {
    throw new TomikoError(`Unknown mode "${mode}". Expected one of: ${MODES.join(", ")}.`);
  }
  return mode;
}

/** The API a model belongs to, by its name, when it is one tomiko knows. */
function apiOf(model: string): string | undefined {
  if (isBedrockModel(model)) return "bedrock";
  if (/^claude/i.test(model)) return "anthropic";
  if (/^(gpt|o\d|chatgpt)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return undefined;
}

/** The same request, asking `model`: in the body's `model` field, or in Gemini's and Bedrock's path. */
async function withModel(request: Request, model: string): Promise<Request> {
  const provider = detectProvider(request.url, request.headers);
  const wanted = apiOf(model);
  if (provider === "bedrock") return withBedrockModel(request, model);
  if (wanted && provider && ["anthropic", "openai", "google"].includes(provider) && wanted !== provider) {
    throw new TomikoError(`TOMIKO_MODEL=${model} is a model of another API: this request goes to the ${provider} API.`);
  }
  const url = request.url.replace(/(\/models\/)[^/:?#]+(:)/, `$1${encodeURIComponent(model)}$2`);
  let body: string | undefined = request.body ? await request.clone().text() : undefined;
  try {
    const parsed: unknown = body ? JSON.parse(body) : undefined;
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { model?: unknown }).model === "string") {
      body = JSON.stringify({ ...(parsed as object), model });
    }
  } catch {
    // Not JSON: sent as it was.
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(url, { method: request.method, headers, body, signal: request.signal });
}

/**
 * A Bedrock request for another model, which goes in the path. A request signed with SigV4 is
 * signed again, since the signature covers the path.
 */
async function withBedrockModel(request: Request, model: string): Promise<Request> {
  if (!isBedrockModel(model)) {
    throw new TomikoError(
      `TOMIKO_MODEL=${model} is not a Bedrock model id: this request goes to Amazon Bedrock, which names models ` +
        `like us.anthropic.claude-haiku-4-5-20251001-v1:0 or amazon.nova-lite-v1:0.`,
    );
  }
  const url = new URL(request.url);
  const match = BEDROCK_PATH.exec(url.pathname);
  if (!match) return request;
  const [, current, kind] = match;
  // InvokeModel bodies are each model family's own; only Converse speaks for all of them.
  if (kind!.startsWith("invoke") && bedrockFamily(decodeURIComponent(current!)) !== bedrockFamily(model)) {
    throw new TomikoError(
      `TOMIKO_MODEL=${model} can't answer this request: InvokeModel bodies are in each model family's own format, ` +
        `and this one is for ${decodeURIComponent(current!)}. Use Bedrock's Converse API to compare models of different families.`,
    );
  }
  url.pathname = url.pathname.replace(BEDROCK_PATH, `/model/${encodeURIComponent(model)}/${kind}`);
  const body = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : undefined;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const missing = signAgain(request.method, url.toString(), headers, body);
  if (missing) throw new TomikoError(unsignable(`To send this request to ${model}`, missing));
  return new Request(url, { method: request.method, headers, body, signal: request.signal });
}

/**
 * Signs a request signed with SigV4 again, after a change to its URL or body, which the signature
 * covers. Returns the access key id it was signed with when its credentials are nowhere to be found.
 */
function signAgain(method: string, url: string, headers: Headers, body: string | Uint8Array | undefined): string | undefined {
  const signature = parseAuthorization(headers.get("authorization"));
  if (!signature) return undefined;
  const credentials = findCredentials(process.env, signature.accessKeyId);
  if (!credentials) return signature.accessKeyId;
  sign({ method, url, headers, body, credentials, region: signature.region, service: signature.service, signedHeaders: signature.signedHeaders });
  return undefined;
}

const unsignable = (doing: string, accessKeyId: string) =>
  `${doing}, tomiko signs it again, and the AWS credentials it was signed with ` +
  `(access key ${maskKeyId(accessKeyId)}) are not in AWS_ACCESS_KEY_ID or ~/.aws/credentials. ` +
  `Set them there, or use a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK.`;

/** Faults that answer for the API, without reaching it. */
const FAILURES = new Set<FaultName>(["rate_limit", "overloaded", "server_error", "network_error"]);

/** Response headers that describe the wire encoding, which no longer applies once the body is buffered. */
const WIRE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function liveHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of WIRE_HEADERS) copy.delete(name);
  return copy;
}

/**
 * Why an answer is not saved: timeouts, rate limits and server errors are worth retrying, not
 * replaying, and a missing or wrong key would keep failing after it is fixed.
 */
function unsavedReason(status: number): string | undefined {
  if (status === 408 || status === 429 || status >= 500) return "a transient error";
  if (status === 401 || status === 403) return "an authentication error";
  return undefined;
}

/** `promise`, or the abort of `signal`, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Responses recorded as they stream: SSE, and Bedrock's AWS event streams. */
const streaming = (contentType: string) => isEventStream(contentType) || isAwsEventStream(contentType);

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

interface ServedEntry {
  interaction: Interaction;
  replayed: boolean;
  fault?: FaultName;
  /** Prompt injections the request carried to the model. */
  injections?: Injection[];
  /** What the caller got, when a fault rewrote the recorded answer. */
  response?: RecordedResponse;
}

/** A request to an MCP server in this run. */
interface McpServed {
  interaction: Interaction;
  replayed: boolean;
  /** The server's id in the cassette: the host of the `mcp://` URL. */
  server: string;
}

interface Served {
  response: Response;
  entry: ServedEntry;
}

interface Lookup {
  match?: Interaction;
  warning?: string;
  nearest?: Interaction;
  score?: number;
}

/** A request as matching sees it: secrets replaced by placeholders and ignored paths removed. */
interface MatchKey {
  url: string;
  body: unknown;
  canonical: string;
}

/**
 * Gemini returns function calls without ids, so clients make them up, differently on every run,
 * and send them back with the results. They are left out of matching.
 */
const GEMINI_CALL_IDS = ["contents.*.parts.*.functionCall.id", "contents.*.parts.*.functionResponse.id"];
const isGemini = (body: unknown) => body !== null && typeof body === "object" && Array.isArray((body as { contents?: unknown }).contents);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `Anthropic API key (#1 request body › messages[0].content)`, for one-line warnings. */
function listFindings(found: Found[]): string {
  const findings = publicFindings(found);
  const shown = findings.slice(0, 3).map((f) => `${f.kind} (#${f.request} ${f.location})`);
  if (findings.length > 3) shown.push(`${findings.length - 3} more`);
  return shown.join(", ");
}

export class Cassette implements McpRecorder {
  readonly fetch: typeof globalThis.fetch;

  private readonly used = new Set<Interaction>();
  private readonly replayed: Interaction[] = [];
  /** Every request handled in this run, in order, for assertions. */
  private readonly served: ServedEntry[] = [];
  /** Requests to MCP servers handled in this run, in order. */
  private readonly mcpServed: McpServed[] = [];
  /** MCP requests sent to a server and not answered yet; one still waiting at close is not saved. */
  private readonly mcpWaiting = new Set<McpServed>();
  private readonly faultPlan: FaultPlan;
  private readonly injections: InjectionFault[];
  /** Injections that reached the model at least once, to warn about those that never did. */
  private readonly planted = new Set<InjectionFault>();
  /** Where each injection went: it stays in that result on every turn after. */
  private readonly plantState: PlantState = { sites: new Map(), known: (id) => this.toolNames().get(id) };
  /** Requests that changed after they were signed, and couldn't be signed again: the access key id. */
  private readonly unsigned = new WeakMap<Request, string>();
  private readonly recorded: Interaction[] = [];
  /** Streams still being recorded; each is drained and finalized on close. */
  private readonly pending: (() => Promise<void>)[] = [];
  private readonly warnings: string[] = [];
  private readonly pricing: PricingTable;
  private readonly ignore: string[];
  private readonly fuzzy: number | false;
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly guard: Guard | undefined;
  private readonly keys = new WeakMap<RecordedRequest, MatchKey>();
  private report: CassetteReport | undefined;
  private closing: Promise<CassetteReport> | undefined;
  /** The interactions came from a file, which may predate the secrets guard. */
  private loaded = false;
  /** Interactions in the file when it was opened; later ones were recorded in this run. */
  private size = 0;
  /** Why a request found nothing to replay, for `tomiko record --stale`. */
  private failure: "missing" | "mismatched" | undefined;
  /** Replay mode without a file only fails once a request needs it, so tests without LLM calls pass. */
  private missing = false;
  /** The cassette's own file; `file` differs when a trial run keeps it elsewhere. */
  private source: string | undefined;

  private constructor(
    readonly name: string,
    readonly file: string,
    readonly mode: Mode,
    private readonly interactions: Interaction[],
    private readonly options: TomikoOptions,
  ) {
    this.pricing = { ...defaultPricing, ...options.pricing };
    this.ignore = options.ignore ?? [];
    this.fuzzy = options.fuzzy ?? false;
    if (this.fuzzy !== false && !(this.fuzzy > 0 && this.fuzzy <= 1)) {
      throw new TomikoError(`\`fuzzy\` must be a number in (0, 1] or false, got ${this.fuzzy}`);
    }
    this.baseFetch = options.fetch ?? realFetch();
    this.guard = secretGuard(options.secrets);
    const faults = options.faults ?? [];
    this.injections = faults.filter((f): f is InjectionFault => f.name === "prompt_injection");
    this.faultPlan = new FaultPlan(faults.filter((f): f is RequestFault => f.name !== "prompt_injection"));
    this.fetch = (input, init) => this.handle(input, init);
  }

  static async open(name: string, options: TomikoOptions = {}): Promise<Cassette> {
    const own = cassettePath(options.dir ?? "__cassettes__", name);
    // Names keep only letters, digits and a few signs, so two tests can end up in one file, and
    // each would overwrite the other's recordings.
    const files = (runtime.files ??= new Map());
    const other = files.get(own);
    if (other !== undefined && other !== name) {
      throw new TomikoError(
        `Cassettes "${other}" and "${name}" would share the file ${own}, and overwrite each other's recordings. ` +
          `Give them names that differ in letters or digits, not only in signs such as + * ? or spaces.`,
      );
    }
    files.set(own, name);
    const file = shadowed(own);
    // `tomiko record` picks cassettes to re-record through the environment.
    const mode = chosenForRecording(own) ? "record" : resolveMode(options.mode);
    const existing = mode === "record" ? undefined : await loadCassette(file);
    const cassette = new Cassette(name, file, mode, existing?.interactions ?? [], options);
    cassette.source = own;
    cassette.missing = mode === "replay" && !existing;
    cassette.loaded = existing !== undefined;
    cassette.size = existing?.interactions.length ?? 0;
    return cassette;
  }

  get closed(): boolean {
    return this.report !== undefined;
  }

  /**
   * Requests served so far in this run, in order. Read live from the responses, so a stream that
   * is still being recorded contributes everything the caller has read from it.
   */
  get calls(): RecordedCall[] {
    // The judge's requests are not what the code under test did.
    return this.served.filter((entry) => !entry.interaction.meta.judge).map(({ interaction, replayed, fault, injections, response: rewritten }) => {
      const { request } = interaction;
      // Assertions see what the caller saw.
      const response = rewritten ?? interaction.response;
      const { model: responseModel, usage } = extractUsage(response.body, response.headers);
      const model = responseModel ?? requestModel(request);
      const price = model && usage ? priceFor(model, this.pricing) : undefined;
      const position = this.interactions.indexOf(interaction) + 1;
      return {
        ...(position > 0 ? { position } : {}),
        method: request.method,
        url: request.url,
        requestBody: request.body,
        status: response.status,
        replayed,
        fault,
        ...(injections ? { injections } : {}),
        provider: interaction.meta.provider ?? detectProvider(request.url),
        model,
        requestedModel: requestModel(request),
        usage,
        cost: usage && price ? costOf(usage, price) : null,
        ...readContent(response.body),
      };
    });
  }

  /** Every tool call the model made in this run, in order. */
  get toolCalls(): ToolCall[] {
    return this.calls.flatMap((call) => call.toolCalls);
  }

  /** Requests to MCP servers in this run, in order: what the agent asked and what the server answered. */
  get mcpCalls(): McpCall[] {
    return this.mcpServed.map(({ interaction, replayed, server }) => {
      const method = interaction.request.url.slice(`mcp://${server}/`.length);
      const params = interaction.request.body as Record<string, unknown> | undefined;
      const outcome = (interaction.response.body.type === "json" ? interaction.response.body.value : {}) as McpExchange;
      const tool = method === "tools/call" && typeof params?.name === "string" ? { name: params.name, input: params.arguments ?? {} } : undefined;
      return {
        server,
        method,
        ...(params ? { params } : {}),
        ...(tool ? { tool } : {}),
        ...("result" in outcome ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : outcome.http ? { error: { code: outcome.http.status, message: `HTTP ${outcome.http.status}` } } : {}),
        replayed,
      };
    });
  }

  get recordsMcp(): boolean {
    return this.options.mcp !== false && !this.closed;
  }

  /**
   * @internal An MCP request: its recorded outcome, or the one `send` gets from the server,
   * recorded. `send` calls `answering` once the answer is on its way to the client, as a stream:
   * the cassette then waits for the rest of it before it closes.
   */
  async mcpExchange(server: McpServer, method: string, params: unknown, send: (answering: () => void) => Promise<McpExchange>): Promise<{ exchange: McpExchange; replayed: boolean }> {
    const request: RecordedRequest = { method: "MCP", url: `mcp://${server.id}/${method}`, ...(params === undefined ? {} : { body: params }) };
    if (this.missing) {
      this.failure = "missing";
      throw new CassetteNotFoundError(this.file);
    }
    if (this.mode !== "record") {
      const found = this.lookup(request);
      if (found.match) {
        if (found.warning) this.warnings.push(found.warning);
        this.mcpServed.push({ interaction: found.match, replayed: true, server: server.id });
        const body = found.match.response.body;
        return { exchange: (body.type === "json" ? body.value : {}) as McpExchange, replayed: true };
      }
      if (this.mode === "replay") {
        this.failure ??= "mismatched";
        throw new RequestMismatchError(
          request.method,
          request.url,
          this.name,
          found.nearest ? this.describeDiff(found.nearest, request) : null,
          found.score ?? null,
        );
      }
    }
    // The slot is taken now, so concurrent requests are saved in the order they were sent.
    const started = Date.now();
    const interaction: Interaction = {
      request,
      response: { status: 200, headers: {}, body: { type: "empty" } },
      meta: { provider: "mcp", recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    const entry: McpServed = { interaction, replayed: false, server: server.id };
    this.mcpServed.push(entry);
    this.interactions.push(interaction);
    this.recorded.push(interaction);
    this.used.add(interaction);
    this.mcpWaiting.add(entry);
    let recorded!: () => void;
    const settled = new Promise<void>((resolve) => (recorded = resolve));
    let answering = false;
    const onAnswer = () => {
      if (answering) return;
      answering = true;
      this.pending.push(() => settled);
    };
    try {
      let exchange: McpExchange;
      try {
        exchange = await send(onAnswer);
      } catch (error) {
        // A request that failed or was cancelled has no answer to replay.
        if (this.mcpWaiting.delete(entry)) {
          this.dropMcp(entry);
          const reason = error instanceof Error ? error.message : String(error);
          this.warnings.push(`MCP server "${server.id}" never answered ${method} (${reason}), so it was not saved.`);
        }
        throw error;
      }
      // The cassette closed while the server was still working, and left the request out.
      if (!this.mcpWaiting.delete(entry)) return { exchange, replayed: false };
      interaction.response.body = { type: "json", value: exchange };
      // The server's name is known once it has answered `initialize`.
      const name = method === "initialize" ? (exchange.result as { serverInfo?: { name?: unknown } } | undefined)?.serverInfo?.name : server.name;
      interaction.meta = {
        provider: "mcp",
        ...(typeof name === "string" && name ? { server: name } : {}),
        ...(server.transport ? { transport: server.transport } : {}),
        recordedAt: interaction.meta.recordedAt,
        durationMs: Date.now() - started,
      };
      return { exchange, replayed: false };
    } finally {
      recorded();
    }
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // tomiko's own requests to an MCP server it records.
    if (bypassing()) return realFetch()(input, init);
    if (this.closed) throw new TomikoError(`Cassette "${this.name}" is already closed.`);
    let request = new Request(input, init);
    // As fetch does: an aborted signal fails the request, and an abort later fails reading the body.
    if (request.signal.aborted) throw request.signal.reason;
    return abortable(await this.respond(request), request.signal);
  }

  private async respond(request: Request): Promise<Response> {
    // A judge's request is told apart by a header, which never reaches the API.
    const judging = request.headers.has(JUDGE_HEADER);
    if (judging) {
      const headers = new Headers(request.headers);
      headers.delete(JUDGE_HEADER);
      request = new Request(request, { headers });
    }
    if (!judging && this.options.intercept && !this.options.intercept(request)) return this.baseFetch(request);
    // An MCP server over HTTP, reached by a client tomiko doesn't meet at its transport. With
    // `mcp: false`, it is asked as if tomiko weren't there.
    let sent: Response | undefined;
    if (!judging && maybeSseStream(request)) {
      const stream = await this.sseStream(request);
      if (stream instanceof Response) return stream;
      sent = stream?.sent;
    } else if (!judging) {
      const text = request.body ? await request.clone().text() : undefined;
      if (isMcpHttp(request, text)) return mcpOverHttp(this.recordsMcp ? this : undefined, request, text, this.baseFetch);
    }
    // `tomiko matrix` sends the code's requests to another model; the judge keeps its own.
    const model = judging ? undefined : modelOverride();
    if (model) request = await withModel(request, model);
    let injections: Injection[] | undefined;
    let plantedFaults: InjectionFault[] = [];
    if (!judging && this.injections.length > 0) ({ request, injections, faults: plantedFaults } = await this.inject(request));

    const bodyText = request.body ? await request.clone().text() : undefined;
    const recordedRequest: RecordedRequest = {
      method: request.method,
      url: redactUrl(request.url),
      body: parseRequestBody(bodyText, request.headers.get("content-type")),
    };

    // Faults are for the code under test; the judge always gets a straight answer.
    const faults = judging ? [] : this.faultPlan.next(recordedRequest);
    const latency = faults.reduce((ms, f) => ms + (f.name === "latency" ? f.ms : 0), 0);
    if (latency > 0) await delay(latency, request.signal);
    const failure = faults.find((f) => FAILURES.has(f.name));
    // A simulated failure answers for the API: the model never sees the request, nor its attack.
    if (failure) {
      await sent?.body?.cancel();
      return this.fail(failure, request, recordedRequest);
    }
    const misbehavior = faults.find((f): f is Misbehavior => MISBEHAVIORS.has(f.name));

    if (this.missing) {
      this.failure = "missing";
      throw new CassetteNotFoundError(this.file);
    }
    const served = await this.serve(request, recordedRequest, injections, sent);
    const { entry } = served;
    if (judging) entry.interaction.meta.judge = true;
    // What the model saw is what the answer was given to: a replay's own record of it.
    const seen = entry.replayed ? entry.interaction.meta.injections : injections;
    if (seen) entry.injections = seen;
    if (injections && !entry.replayed) entry.interaction.meta.injections = injections;
    if (seen) for (const fault of plantedFaults) this.planted.add(fault);
    let response = served.response;
    if (misbehavior) {
      // Reading the real answer to the end also finishes recording it, as it was.
      await response.arrayBuffer();
      entry.fault = misbehavior.name;
      // What the caller did next answered a rewritten answer: `tomiko doctor` takes that into account.
      if (!entry.replayed) entry.interaction.meta.fault = misbehavior.name;
      entry.response = misbehave(misbehavior, entry.interaction.response, recordedRequest);
      response = buildResponse(entry.response, request.url);
    }
    const cut = faults.find((f) => f.name === "cut_stream");
    if (cut?.name === "cut_stream") {
      entry.fault = "cut_stream";
      return cutResponse(response, cut.afterEvents);
    }
    if (latency > 0) entry.fault ??= "latency";
    if (seen) entry.fault ??= "prompt_injection";
    return response;
  }

  /**
   * A stream asked for outside any MCP session: the older HTTP+SSE transport's, a Streamable HTTP
   * client's before its session, or not MCP's at all. The cassette's handshake with the server says
   * which; without one, the server does, by naming first where to post for the older transport.
   * Returns the answer, or one not MCP's, sent, to record.
   */
  private async sseStream(request: Request): Promise<Response | { sent: Response } | undefined> {
    // Only MCP's clients send its protocol's version; for the rest, a stream recorded as it was replays as it was.
    const mcp = request.headers.has("mcp-protocol-version");
    const url = this.key({ method: "GET", url: redactUrl(request.url) }).url;
    if (!mcp && this.interactions.some((i) => i.request.method === "GET" && this.key(i.request).url === url)) return undefined;
    if (mcp && !this.recordsMcp) return this.baseFetch(request);
    if (this.recordsMcp) {
      const host = slug(new URL(request.url).hostname);
      const handshake = this.interactions.find((i) => i.request.method === "MCP" && (i.request.url === `mcp://${host}/initialize` || i.request.url === `mcp://${host}/server/discover`));
      if (handshake?.meta.transport === "sse") return openSse(request, this.baseFetch);
      // A Streamable HTTP server, whose session the client hasn't got yet: no stream for it, as a replay can't say whose it would be.
      if (mcp && (handshake || this.mode === "replay")) return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (this.mode === "replay") return undefined;
    // A stream to record is sent without the caller's signal, as any request being recorded is.
    const { event, response } = await peekEvent(await this.baseFetch(mcp ? request : new Request(request, { signal: null })));
    if (event === "endpoint") return this.recordsMcp ? openSse(request, this.baseFetch, response) : response;
    return mcp ? response : { sent: response };
  }

  /** The request with each prompt injection planted in the tool result it goes into, if it carries one. */
  private async inject(request: Request): Promise<{ request: Request; injections?: Injection[]; faults: InjectionFault[] }> {
    if (!request.body) return { request, faults: [] };
    let body: unknown;
    try {
      body = JSON.parse(await request.clone().text());
    } catch {
      return { request, faults: [] };
    }
    const result = plant(body, request.url, this.injections, this.plantState);
    if (!result) return { request, faults: [] };
    const text = JSON.stringify(result.body);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    // A Bedrock request signed with SigV4 is signed again; a replay doesn't need it, so missing
    // credentials only fail a request that goes to the network.
    const missing = signAgain(request.method, request.url, headers, text);
    const injected = new Request(request.url, { method: request.method, headers, body: text, signal: request.signal });
    if (missing) this.unsigned.set(injected, missing);
    return { request: injected, injections: result.planted.map((p) => p.injection), faults: result.planted.map((p) => p.fault) };
  }

  /** Tools the model called in the answers served so far, by call id. */
  private toolNames(): Map<string, string> {
    return new Map(this.served.flatMap(({ interaction, response }) => readContent((response ?? interaction.response).body).toolCalls.flatMap((t) => (t.id ? [[t.id, t.name] as const] : []))));
  }

  private async serve(request: Request, recordedRequest: RecordedRequest, injections?: Injection[], sent?: Response): Promise<Served> {
    if (this.mode !== "record") {
      const found = this.lookup(recordedRequest, injections);
      if (found.match) {
        await sent?.body?.cancel();
        if (found.warning) this.warnings.push(found.warning);
        this.replayed.push(found.match);
        const entry: ServedEntry = { interaction: found.match, replayed: true };
        this.served.push(entry);
        return { response: buildResponse(found.match.response, request.url), entry };
      }
      if (this.mode === "replay") {
        this.failure ??= "mismatched";
        throw new RequestMismatchError(
          recordedRequest.method,
          this.key(recordedRequest).url,
          this.name,
          found.nearest ? this.describeDiff(found.nearest, recordedRequest) : null,
          found.score ?? null,
        );
      }
    }
    return this.record(request, recordedRequest, sent);
  }

  /** Answers with a simulated failure. Nothing reaches the network and nothing is recorded. */
  private fail(f: Fault, request: Request, recordedRequest: RecordedRequest): Response {
    const interaction: Interaction = {
      request: recordedRequest,
      response: { status: 0, headers: {}, body: { type: "empty" } },
      meta: { provider: detectProvider(request.url, request.headers), recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    this.served.push({ interaction, replayed: false, fault: f.name });
    if (f.name === "network_error") throw networkError(f.message);
    if (f.name !== "rate_limit" && f.name !== "overloaded" && f.name !== "server_error") {
      throw new TomikoError(`Fault "${f.name}" cannot fail a request.`);
    }
    const { status, body, headers } = errorResponse(f.name, interaction.meta.provider);
    interaction.response = {
      status,
      headers: {
        "content-type": "application/json",
        // SDKs wait this long before retrying; retry-after-ms is the precise one.
        "retry-after-ms": String(f.retryAfterMs),
        "retry-after": String(f.retryAfterMs / 1000),
        ...headers,
      },
      body: { type: "json", value: body },
    };
    return buildResponse(interaction.response, request.url);
  }

  /**
   * Secrets are replaced before matching, so a cassette saved with `secrets: "redact"` still
   * matches the live request, and no diff in an error message can print one.
   */
  private key(request: RecordedRequest): MatchKey {
    let key = this.keys.get(request);
    if (!key) {
      const clean = this.guard ? withoutSecrets(request, this.guard) : request;
      const body = stripPaths(clean.body, isGemini(clean.body) ? [...this.ignore, ...GEMINI_CALL_IDS] : this.ignore);
      key = { url: matchUrl(clean.url), body, canonical: canonical(body) };
      this.keys.set(request, key);
    }
    return key;
  }

  private describeDiff(recorded: Interaction, live: RecordedRequest): string {
    return formatDiff(diff(this.key(recorded.request).body, this.key(live).body));
  }

  /**
   * Identical requests are served in recording order.
   * Without an exact match, the most similar recording for the same endpoint is the candidate
   * for a fuzzy replay or for the mismatch error.
   */
  private lookup(req: RecordedRequest, injections?: Injection[]): Lookup {
    const live = this.key(req);
    const endpoint = this.interactions.filter((i) => i.request.method === req.method && this.key(i.request).url === live.url);
    const exact = endpoint.filter((i) => this.key(i.request).canonical === live.canonical);
    if (exact.length > 0) {
      const next = exact.find((i) => !this.used.has(i));
      if (next) {
        this.used.add(next);
        return { match: next };
      }
      // Recordings exhausted: auto mode records a new one, replay mode repeats the last.
      return this.mode === "replay" ? { match: exact[exact.length - 1] } : {};
    }

    const unused = endpoint.filter((i) => !this.used.has(i));
    let nearest: Interaction | undefined;
    let score = -1;
    for (const candidate of unused.length > 0 ? unused : endpoint) {
      const s = similarity(this.key(candidate.request).body, live.body);
      if (s > score) {
        score = s;
        nearest = candidate;
      }
    }
    if (!nearest) return {};
    // A response from a different model is never an acceptable stand-in, however similar the prompt.
    const sameModel = requestModel(nearest.request) === requestModel(req);
    // Nor is an answer to a request without the attack this one carries, or with another.
    const attacks = (list: Injection[] | undefined) => (list ?? []).map((i) => i.canary).sort().join();
    const sameAttacks = attacks(nearest.meta.injections) === attacks(injections);
    if (this.fuzzy !== false && score >= this.fuzzy && sameModel && sameAttacks) {
      this.used.add(nearest);
      const warning =
        `Fuzzy match (${Math.round(score * 100)}% similar) in cassette "${this.name}" ` +
        `for ${req.method} ${live.url}:\n${this.describeDiff(nearest, req)}`;
      return { match: nearest, warning };
    }
    return { nearest, score };
  }

  private async record(request: Request, recordedRequest: RecordedRequest, early?: Response): Promise<Served> {
    const missing = this.unsigned.get(request);
    if (missing) throw new TomikoError(unsignable("To plant a prompt injection in this Bedrock request", missing));
    const started = Date.now();
    // The entry and the cassette slot are taken before the answer comes, so concurrent requests
    // are listed and saved in the order they were sent, as a replay serves them.
    const interaction: Interaction = {
      request: recordedRequest,
      response: { status: 0, headers: {}, body: { type: "empty" } },
      meta: { provider: detectProvider(request.url, request.headers), recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    const entry: ServedEntry = { interaction, replayed: false };
    this.served.push(entry);
    this.interactions.push(interaction);
    this.recorded.push(interaction);
    this.used.add(interaction);

    // Sent without the caller's signal: an SDK that leaves a stream early aborts its request, and
    // the answer is still recorded whole. The caller's abort only ends what the caller reads.
    const sent = early ? Promise.resolve(early) : this.baseFetch(new Request(request, { signal: null }));
    let res: Response;
    try {
      res = await untilAborted(sent, request.signal);
    } catch (error) {
      if (request.signal.aborted) {
        // The caller gave up before the answer came; it is recorded when it does.
        this.pending.push(() =>
          sent.then(
            (late) => this.capture(interaction, late, started, request.url, request.signal).then((r) => void r.body?.cancel()),
            (failure: unknown) => this.discard(interaction, failure),
          ),
        );
      } else {
        this.served.splice(this.served.indexOf(entry), 1);
        this.forget(interaction);
      }
      throw error;
    }
    return { response: await this.capture(interaction, res, started, request.url, request.signal), entry };
  }

  /** Takes an MCP request out of what will be saved, and out of `mcpCalls`. */
  private dropMcp(entry: McpServed): void {
    const at = this.mcpServed.indexOf(entry);
    if (at !== -1) this.mcpServed.splice(at, 1);
    this.forget(entry.interaction);
  }

  /** Takes `interaction` out of what will be saved. */
  private forget(interaction: Interaction): void {
    for (const list of [this.interactions, this.recorded]) {
      const at = list.indexOf(interaction);
      if (at !== -1) list.splice(at, 1);
    }
  }

  /** Records `res` into `interaction`, and returns the response the caller reads. */
  private async capture(interaction: Interaction, res: Response, started: number, url: string, signal: AbortSignal | null): Promise<Response> {
    const contentType = res.headers.get("content-type") ?? "";
    interaction.response = {
      status: res.status,
      statusText: res.statusText || undefined,
      headers: pickHeaders(res.headers),
      body: { type: "empty" },
    };
    const init = { status: res.status, statusText: res.statusText, headers: liveHeaders(res.headers) };

    const unsaved = this.options.recordErrors === true ? undefined : unsavedReason(res.status);
    if (unsaved) {
      this.forget(interaction);
      this.warnings.push(
        `Not saved: ${res.status} from ${interaction.request.method} ${interaction.request.url} is ${unsaved}, ` +
          `so it would replay forever. Set \`recordErrors: true\` to keep it, or simulate it with \`faults\`.`,
      );
      if (res.body && streaming(contentType)) return withUrl(new Response(res.body, init), url);
    }

    if (streaming(contentType) && res.body) {
      let sink;
      if (isEventStream(contentType)) {
        const chunks: string[] = [];
        interaction.response.body = { type: "sse", chunks };
        sink = textSink(chunks);
      } else {
        // Bedrock's binary frames are decoded as they arrive, so assertions see the stream so far.
        const events: StreamEvent[] = [];
        interaction.response.body = { type: "eventstream", events };
        // A stream that turns out not to be valid frames is kept as the bytes it was.
        sink = eventSink(events, (bytes) => (interaction.response.body = encodeBody(bytes, contentType)));
      }
      const { stream, settle } = recordStream(res.body, sink, signal);
      this.pending.push(() =>
        settle().then(
          (endedAt) => this.finish(interaction, started, endedAt),
          (error: unknown) => this.discard(interaction, error),
        ),
      );
      return withUrl(new Response(stream, init), url);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    interaction.response.body = encodeBody(bytes, contentType);
    this.finish(interaction, started);
    const body = bytes.byteLength === 0 || [101, 204, 205, 304].includes(res.status) ? null : bytes;
    return withUrl(new Response(body, init), url);
  }

  private finish(interaction: Interaction, started: number, endedAt = Date.now()): void {
    const { model, usage } = extractUsage(interaction.response.body, interaction.response.headers);
    interaction.meta = {
      ...(interaction.meta.judge ? { judge: true } : {}),
      ...(interaction.meta.fault ? { fault: interaction.meta.fault } : {}),
      ...(interaction.meta.injections ? { injections: interaction.meta.injections } : {}),
      provider: interaction.meta.provider,
      model: model ?? requestModel(interaction.request),
      usage,
      recordedAt: interaction.meta.recordedAt,
      durationMs: endedAt - started,
    };
  }

  /** A stream that failed mid-recording would replay truncated, so it is not saved. */
  private discard(interaction: Interaction, error: unknown): void {
    const at = this.interactions.indexOf(interaction);
    if (at !== -1) this.interactions.splice(at, 1);
    const reason = error instanceof Error ? error.message : String(error);
    this.warnings.push(
      `Stream for ${interaction.request.method} ${interaction.request.url} failed while recording ` +
        `(${reason}); it was not saved.`,
    );
  }

  /**
   * Waits for in-flight stream recordings, saves new recordings, and returns the run report.
   * Throws `SecretsFoundError`, saving nothing, when the cassette would contain a secret.
   */
  async close(): Promise<CassetteReport> {
    // Concurrent calls share one close; the second would otherwise save the file again.
    this.closing ??= this.save();
    return this.closing;
  }

  private async save(): Promise<CassetteReport> {
    // Settling can start more of it (an answer that came after its caller gave up).
    while (this.pending.length > 0) await Promise.all(this.pending.splice(0).map((settle) => settle()));
    // Saved without its answer, it would replay as an empty success.
    for (const entry of this.mcpWaiting) {
      this.dropMcp(entry);
      const method = entry.interaction.request.url.slice(`mcp://${entry.server}/`.length);
      this.warnings.push(
        `MCP server "${entry.server}" had not answered ${method} when cassette "${this.name}" closed, so it was not saved. ` +
          `Await the call before the test ends.`,
      );
    }
    this.mcpWaiting.clear();
    for (const injection of this.injections.filter((f) => !this.planted.has(f))) {
      const result = injection.result === 1 ? "result" : `result #${injection.result}`;
      this.warnings.push(
        `fault.promptInjection() never reached the model in cassette "${this.name}": no request carried ` +
          `${injection.into ? `a ${result} of ${injection.into}` : `a tool ${result}`}.`,
      );
    }
    let saved = this.recorded.some((i) => this.interactions.includes(i));
    let refused: SecretsFoundError | undefined;
    if (saved) {
      const redact = this.options.redact;
      let interactions = redact ? this.interactions.map((i) => redact(structuredClone(i))) : this.interactions;
      const guarded = this.guard ? redactInteractions(interactions, this.guard) : undefined;
      if (guarded && guarded.found.length > 0) {
        const count = plural(publicFindings(guarded.found).length, "secret");
        if (this.guard!.action === "fail") {
          refused = new SecretsFoundError(this.name, this.file, publicFindings(guarded.found));
          this.warnings.push(`Not saved: cassette "${this.name}" contains ${count}: ${listFindings(guarded.found)}.`);
          saved = false;
        } else if (this.guard!.action === "redact") {
          interactions = guarded.interactions;
          this.warnings.push(`Redacted ${count} in cassette "${this.name}": ${listFindings(guarded.found)}.`);
        } else {
          this.warnings.push(`Saved cassette "${this.name}" with ${count} in it: ${listFindings(guarded.found)}.`);
        }
      }
      if (saved) await saveCassette(this.file, { version: 1, interactions });
    } else if (this.guard && this.loaded) {
      // Nothing to save, but a cassette recorded before the guard (or with it off) may hold secrets.
      const found = scanInteractions(this.interactions, this.guard);
      const count = publicFindings(found).length;
      if (count > 0) {
        const them = count === 1 ? "it" : "them";
        this.warnings.push(
          `Cassette "${this.name}" contains ${plural(count, "secret")}: ${listFindings(found)}. ` +
            `Run \`npx tomiko scan --fix\` to replace ${them}, and revoke ${them} if the file was ever committed.`,
        );
      }
    }
    const recorded = this.recorded.filter((i) => this.interactions.includes(i));
    this.report = buildReport({
      name: this.name,
      file: this.file,
      mode: this.mode,
      replayed: this.replayed,
      recorded: recorded.filter((i) => i.meta.provider !== "mcp"),
      mcp: { replayed: this.mcpServed.filter((e) => e.replayed).length, recorded: recorded.filter((i) => i.meta.provider === "mcp").length },
      warnings: this.warnings,
      saved,
      pricing: this.pricing,
    });
    recordReport(this.report);
    logUsage({
      file: this.file,
      ...(this.source !== undefined && this.source !== this.file ? { source: this.source } : {}),
      mode: this.mode,
      exists: this.loaded,
      size: this.size,
      used: this.interactions.flatMap((interaction, i) => (i < this.size && this.used.has(interaction) ? [i] : [])),
      // MCP requests count too: `tomiko record` lists the cassettes it re-recorded by this.
      recorded: recorded.length,
      mismatched: this.failure === "mismatched",
      missing: this.failure === "missing",
    });
    if (refused) throw refused;
    return this.report;
  }
}
