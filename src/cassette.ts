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
import { chosenForRecording, logUsage, modelOverride, shadowed } from "./control.js";
import { type Misbehavior, MISBEHAVIORS, misbehave } from "./misbehave.js";
import { JUDGE_HEADER } from "./judge.js";
import { realFetch } from "./runtime.js";
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
  Mode,
  PricingTable,
  RecordedCall,
  RecordedRequest,
  RecordedResponse,
  TomikoOptions,
  ToolCall,
} from "./types.js";
import { detectProvider, extractUsage, requestModel } from "./usage.js";

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
  if (/^claude/i.test(model)) return "anthropic";
  if (/^(gpt|o\d|chatgpt)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return undefined;
}

/** The same request, asking `model`: in the body's `model` field, or in Gemini's path. */
async function withModel(request: Request, model: string): Promise<Request> {
  const provider = detectProvider(request.url, request.headers);
  const wanted = apiOf(model);
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

/** Faults that answer for the API, without reaching it. */
const FAILURES = new Set<FaultName>(["rate_limit", "overloaded", "server_error", "network_error"]);

/** Response headers that describe the wire encoding, which no longer applies once the body is buffered. */
const WIRE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

function liveHeaders(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of WIRE_HEADERS) copy.delete(name);
  return copy;
}

/** Timeouts, rate limits and server errors: worth retrying, not worth replaying. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

interface ServedEntry {
  interaction: Interaction;
  replayed: boolean;
  fault?: FaultName;
  /** What the caller got, when a fault rewrote the recorded answer. */
  response?: RecordedResponse;
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
  private readonly guard: Guard | undefined;
  private readonly keys = new WeakMap<RecordedRequest, MatchKey>();
  private report: CassetteReport | undefined;
  /** The interactions came from a file, which may predate the secrets guard. */
  private loaded = false;
  /** Interactions in the file when it was opened; later ones were recorded in this run. */
  private size = 0;
  /** Why a request found nothing to replay, for `tomiko record --stale`. */
  private failure: "missing" | "mismatched" | undefined;
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
    this.baseFetch = options.fetch ?? realFetch();
    this.guard = secretGuard(options.secrets);
    this.faultPlan = new FaultPlan(options.faults ?? []);
    this.fetch = (input, init) => this.handle(input, init);
  }

  static async open(name: string, options: TomikoOptions = {}): Promise<Cassette> {
    const own = cassettePath(options.dir ?? "__cassettes__", name);
    const file = shadowed(own);
    // `tomiko record` picks cassettes to re-record through the environment.
    const mode = chosenForRecording(own) ? "record" : resolveMode(options.mode);
    const existing = mode === "record" ? undefined : await loadCassette(file);
    const cassette = new Cassette(name, file, mode, existing?.interactions ?? [], options);
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
    return this.served.filter((entry) => !entry.interaction.meta.judge).map(({ interaction, replayed, fault, response: rewritten }) => {
      const { request } = interaction;
      // Assertions see what the caller saw.
      const response = rewritten ?? interaction.response;
      const { model: responseModel, usage } = extractUsage(response.body);
      const model = responseModel ?? requestModel(request);
      const price = model && usage ? priceFor(model, this.pricing) : undefined;
      return {
        method: request.method,
        url: request.url,
        requestBody: request.body,
        status: response.status,
        replayed,
        fault,
        provider: interaction.meta.provider ?? detectProvider(request.url),
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
    let request = new Request(input, init);
    // A judge's request is told apart by a header, which never reaches the API.
    const judging = request.headers.has(JUDGE_HEADER);
    if (judging) {
      const headers = new Headers(request.headers);
      headers.delete(JUDGE_HEADER);
      request = new Request(request, { headers });
    }
    if (!judging && this.options.intercept && !this.options.intercept(request)) return this.baseFetch(request);
    // `tomiko matrix` sends the code's requests to another model; the judge keeps its own.
    const model = judging ? undefined : modelOverride();
    if (model) request = await withModel(request, model);

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
    if (failure) return this.fail(failure, request, recordedRequest);
    const misbehavior = faults.find((f): f is Misbehavior => MISBEHAVIORS.has(f.name));

    if (this.missing) {
      this.failure = "missing";
      throw new CassetteNotFoundError(this.file);
    }
    const served = await this.serve(request, recordedRequest);
    const { entry } = served;
    if (judging) entry.interaction.meta.judge = true;
    let response = served.response;
    if (misbehavior) {
      // Reading the real answer to the end also finishes recording it, as it was.
      await response.arrayBuffer();
      entry.fault = misbehavior.name;
      entry.response = misbehave(misbehavior, entry.interaction.response, recordedRequest);
      response = buildResponse(entry.response, request.url);
    }
    const cut = faults.find((f) => f.name === "cut_stream");
    if (cut?.name === "cut_stream") {
      entry.fault = "cut_stream";
      return cutResponse(response, cut.afterEvents);
    }
    if (latency > 0) entry.fault ??= "latency";
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
    return this.record(request, recordedRequest);
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
    const { status, body } = errorResponse(f.name, interaction.meta.provider);
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

  /**
   * Secrets are replaced before matching, so a cassette saved with `secrets: "redact"` still
   * matches the live request, and no diff in an error message can print one.
   */
  private key(request: RecordedRequest): MatchKey {
    let key = this.keys.get(request);
    if (!key) {
      const clean = this.guard ? withoutSecrets(request, this.guard) : request;
      const body = stripPaths(clean.body, isGemini(clean.body) ? [...this.ignore, ...GEMINI_CALL_IDS] : this.ignore);
      key = { url: clean.url, body, canonical: canonical(body) };
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
  private lookup(req: RecordedRequest): Lookup {
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
    if (this.fuzzy !== false && score >= this.fuzzy && sameModel) {
      this.used.add(nearest);
      const warning =
        `Fuzzy match (${Math.round(score * 100)}% similar) in cassette "${this.name}" ` +
        `for ${req.method} ${live.url}:\n${this.describeDiff(nearest, req)}`;
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
      meta: { provider: detectProvider(request.url, request.headers), recordedAt: new Date().toISOString(), durationMs: 0 },
    };
    const entry: ServedEntry = { interaction, replayed: false };
    this.served.push(entry);
    const init = { status: res.status, statusText: res.statusText, headers: liveHeaders(res.headers) };

    const keep = !isTransient(res.status) || this.options.recordErrors === true;
    if (keep) {
      this.interactions.push(interaction);
      this.recorded.push(interaction);
      this.used.add(interaction);
    } else {
      this.warnings.push(
        `Not saved: ${res.status} from ${recordedRequest.method} ${recordedRequest.url} is a transient error, ` +
          `so it would replay forever. Set \`recordErrors: true\` to keep it, or simulate it with \`faults\`.`,
      );
      if (res.body && isEventStream(contentType)) return { response: withUrl(new Response(res.body, init), request.url), entry };
    }

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
    interaction.meta = {
      ...(interaction.meta.judge ? { judge: true } : {}),
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
    if (this.report) return this.report;
    await Promise.all(this.pending.map((settle) => settle()));
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
    logUsage({
      file: this.file,
      mode: this.mode,
      exists: this.loaded,
      size: this.size,
      used: this.interactions.flatMap((interaction, i) => (i < this.size && this.used.has(interaction) ? [i] : [])),
      recorded: this.report.recorded,
      mismatched: this.failure === "mismatched",
      missing: this.failure === "missing",
    });
    if (refused) throw refused;
    return this.report;
  }
}
