import { CassetteNotFoundError, RequestMismatchError, TomikoError } from "./errors.js";
import { type Fault, type FaultName, FaultPlan, cutResponse, delay, errorResponse, networkError } from "./faults.js";
import {
  buildResponse,
  encodeBody,
  isEventStream,
  parseRequestBody,
  pickHeaders,
  recordStream,
  redactUrl,
} from "./http.js";
import { canonical, diff, formatDiff, similarity, stripPaths } from "./match.js";
import { readContent } from "./inspect.js";
import { costOf, defaultPricing, priceFor } from "./pricing.js";
import { buildReport, recordReport } from "./report.js";
import { cassettePath, loadCassette, saveCassette } from "./store.js";
import type {
  CassetteReport,
  Interaction,
  Mode,
  PricingTable,
  RecordedCall,
  RecordedRequest,
  TomikoOptions,
  ToolCall,
} from "./types.js";
import { detectProvider, extractUsage } from "./usage.js";

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

/** Response headers that describe the wire encoding, which no longer applies once the body is buffered. */
const WIRE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function liveHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of WIRE_HEADERS) copy.delete(name);
  return copy;
}

function modelOf(body: unknown): unknown {
  return body !== null && typeof body === "object" ? (body as { model?: unknown }).model : undefined;
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

interface ServedEntry {
  interaction: Interaction;
  replayed: boolean;
  fault?: FaultName;
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

export class Cassette {
  readonly fetch: typeof globalThis.fetch;

  private readonly used = new Set<Interaction>();
  private readonly replayed: Interaction[] = [];
  /** Every request handled in this run, in order, for assertions. */
  private readonly served: ServedEntry[] = [];
  private readonly faultPlan: FaultPlan;
  private readonly recorded: Interaction[] = [];
  /** Streams still being recorded; each is drained and finalized on close. */
  private readonly pending: (() => Promise<void>)[] = [];
  private readonly warnings: string[] = [];
  private readonly pricing: PricingTable;
  private readonly ignore: string[];
  private readonly fuzzy: number | false;
  private readonly baseFetch: typeof globalThis.fetch;
  private report: CassetteReport | undefined;
  /** Replay mode without a file only fails once a request needs it, so tests without LLM calls pass. */
  private missing = false;

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
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.faultPlan = new FaultPlan(options.faults ?? []);
    this.fetch = (input, init) => this.handle(input, init);
  }

  static async open(name: string, options: TomikoOptions = {}): Promise<Cassette> {
    const mode = resolveMode(options.mode);
    const file = cassettePath(options.dir ?? "__cassettes__", name);
    const existing = mode === "record" ? undefined : await loadCassette(file);
    const cassette = new Cassette(name, file, mode, existing?.interactions ?? [], options);
    cassette.missing = mode === "replay" && !existing;
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
    return this.served.map(({ interaction, replayed, fault }) => {
      const { request, response } = interaction;
      const { model: responseModel, usage } = extractUsage(response.body);
      const requestModel = modelOf(request.body);
      const model = responseModel ?? (typeof requestModel === "string" ? requestModel : undefined);
      const price = model && usage ? priceFor(model, this.pricing) : undefined;
      return {
        method: request.method,
        url: request.url,
        requestBody: request.body,
        status: response.status,
        replayed,
        fault,
        provider: detectProvider(request.url),
        model,
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

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.closed) throw new TomikoError(`Cassette "${this.name}" is already closed.`);
    const request = new Request(input, init);
    if (this.options.intercept && !this.options.intercept(request)) return this.baseFetch(request);

    const bodyText = request.body ? await request.clone().text() : undefined;
    const recordedRequest: RecordedRequest = {
      method: request.method,
      url: redactUrl(request.url),
      body: parseRequestBody(bodyText),
    };

    const faults = this.faultPlan.next(recordedRequest);
    const latency = faults.reduce((ms, f) => ms + (f.name === "latency" ? f.ms : 0), 0);
    if (latency > 0) await delay(latency, request.signal);
    const failure = faults.find((f) => f.name !== "latency" && f.name !== "cut_stream");
    if (failure) return this.fail(failure, request, recordedRequest);

    if (this.missing) throw new CassetteNotFoundError(this.file);
    const { response, entry } = await this.serve(request, recordedRequest);
    const cut = faults.find((f) => f.name === "cut_stream");
    if (cut?.name === "cut_stream") {
      entry.fault = "cut_stream";
      return cutResponse(response, cut.afterEvents);
    }
    if (latency > 0) entry.fault = "latency";
    return response;
  }

  private async serve(request: Request, recordedRequest: RecordedRequest): Promise<Served> {
    if (this.mode !== "record") {
      const found = this.lookup(recordedRequest);
      if (found.match) {
        if (found.warning) this.warnings.push(found.warning);
        this.replayed.push(found.match);
        const entry: ServedEntry = { interaction: found.match, replayed: true };
        this.served.push(entry);
        return { response: buildResponse(found.match.response, request.url), entry };
      }
      if (this.mode === "replay") {
        throw new RequestMismatchError(
          recordedRequest.method,
          recordedRequest.url,
          this.name,
          found.nearest ? this.describeDiff(found.nearest, recordedRequest) : null,
          found.score ?? null,
        );
      }
    }
    return this.record(request, recordedRequest);
  }

  /** Answers with a simulated failure. Nothing reaches the network and nothing is recorded. */
  private fail(f: Fault, request: Request, recordedRequest: RecordedRequest): Response {
    const interaction: Interaction = {
      request: recordedRequest,
      response: { status: 0, headers: {}, body: { type: "empty" } },
      meta: { recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    this.served.push({ interaction, replayed: false, fault: f.name });
    if (f.name === "network_error") throw networkError(f.message);
    if (f.name !== "rate_limit" && f.name !== "overloaded" && f.name !== "server_error") {
      throw new TomikoError(`Fault "${f.name}" cannot fail a request.`);
    }
    const { status, body } = errorResponse(f.name, detectProvider(request.url));
    interaction.response = {
      status,
      headers: {
        "content-type": "application/json",
        // SDKs wait this long before retrying; retry-after-ms is the precise one.
        "retry-after-ms": String(f.retryAfterMs),
        "retry-after": String(f.retryAfterMs / 1000),
      },
      body: { type: "json", value: body },
    };
    return buildResponse(interaction.response, request.url);
  }

  private matchable(body: unknown): unknown {
    return stripPaths(body, this.ignore);
  }

  private describeDiff(recorded: Interaction, live: RecordedRequest): string {
    return formatDiff(diff(this.matchable(recorded.request.body), this.matchable(live.body)));
  }

  /**
   * Identical requests are served in recording order.
   * Without an exact match, the most similar recording for the same endpoint is the candidate
   * for a fuzzy replay or for the mismatch error.
   */
  private lookup(req: RecordedRequest): Lookup {
    const key = canonical(this.matchable(req.body));
    const endpoint = this.interactions.filter((i) => i.request.method === req.method && i.request.url === req.url);
    const exact = endpoint.filter((i) => canonical(this.matchable(i.request.body)) === key);
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
      const s = similarity(this.matchable(candidate.request.body), this.matchable(req.body));
      if (s > score) {
        score = s;
        nearest = candidate;
      }
    }
    if (!nearest) return {};
    // A response from a different model is never an acceptable stand-in, however similar the prompt.
    const sameModel = modelOf(nearest.request.body) === modelOf(req.body);
    if (this.fuzzy !== false && score >= this.fuzzy && sameModel) {
      this.used.add(nearest);
      const warning =
        `Fuzzy match (${Math.round(score * 100)}% similar) in cassette "${this.name}" ` +
        `for ${req.method} ${req.url}:\n${this.describeDiff(nearest, req)}`;
      return { match: nearest, warning };
    }
    return { nearest, score };
  }

  private async record(request: Request, recordedRequest: RecordedRequest): Promise<Served> {
    const started = Date.now();
    const res = await this.baseFetch(request);
    const contentType = res.headers.get("content-type") ?? "";
    const interaction: Interaction = {
      request: recordedRequest,
      response: {
        status: res.status,
        statusText: res.statusText || undefined,
        headers: pickHeaders(res.headers),
        body: { type: "empty" },
      },
      meta: { recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    this.interactions.push(interaction);
    this.recorded.push(interaction);
    const entry: ServedEntry = { interaction, replayed: false };
    this.served.push(entry);
    this.used.add(interaction);
    const init = { status: res.status, statusText: res.statusText, headers: liveHeaders(res.headers) };

    if (isEventStream(contentType) && res.body) {
      const chunks: string[] = [];
      interaction.response.body = { type: "sse", chunks };
      const { stream, settle } = recordStream(res.body, chunks);
      this.pending.push(() =>
        settle().then(
          (endedAt) => this.finish(interaction, started, endedAt),
          (error: unknown) => this.discard(interaction, error),
        ),
      );
      return { response: withUrl(new Response(stream, init), request.url), entry };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    interaction.response.body = encodeBody(bytes, contentType);
    this.finish(interaction, started);
    const body = bytes.byteLength === 0 || [101, 204, 205, 304].includes(res.status) ? null : bytes;
    return { response: withUrl(new Response(body, init), request.url), entry };
  }

  private finish(interaction: Interaction, started: number, endedAt = Date.now()): void {
    const { model, usage } = extractUsage(interaction.response.body);
    const body = interaction.request.body as { model?: unknown } | undefined;
    const requestModel = typeof body?.model === "string" ? body.model : undefined;
    interaction.meta = {
      provider: detectProvider(interaction.request.url),
      model: model ?? requestModel,
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

  /** Waits for in-flight stream recordings, saves new recordings, and returns the run report. */
  async close(): Promise<CassetteReport> {
    if (this.report) return this.report;
    await Promise.all(this.pending.map((settle) => settle()));
    const saved = this.recorded.some((i) => this.interactions.includes(i));
    if (saved) {
      const redact = this.options.redact;
      const interactions = redact ? this.interactions.map((i) => redact(structuredClone(i))) : this.interactions;
      await saveCassette(this.file, { version: 1, interactions });
    }
    this.report = buildReport({
      name: this.name,
      file: this.file,
      mode: this.mode,
      replayed: this.replayed,
      recorded: this.recorded.filter((i) => this.interactions.includes(i)),
      warnings: this.warnings,
      saved,
      pricing: this.pricing,
    });
    recordReport(this.report);
    return this.report;
  }
}
