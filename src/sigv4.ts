/**
 * AWS Signature Version 4, for the requests tomiko itself changes or makes on Bedrock: `tomiko
 * matrix` puts another model in a request's path, which the client's signature covers, and the
 * judge asks a Bedrock model. Credentials come from where the AWS SDK finds static ones: the
 * environment, then the shared credentials file.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const escape = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Headers that change on the way or that AWS never signs. */
const UNSIGNABLE = new Set(["authorization", "connection", "expect", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "x-amzn-trace-id"]);

export interface SignOptions {
  method: string;
  url: string;
  headers: Headers;
  body: string | Uint8Array | undefined;
  credentials: AwsCredentials;
  region: string;
  service: string;
  /** Header names to sign; by default every signable header present. */
  signedHeaders?: string[];
  now?: Date;
}

/**
 * Sets `authorization`, `x-amz-date` and, with a session token, `x-amz-security-token` on
 * `headers`. The `host` header is signed but left for fetch to send, from the URL.
 */
export function sign(options: SignOptions): void {
  const { headers, credentials } = options;
  const url = new URL(options.url);
  const amzDate = (options.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  headers.set("x-amz-date", amzDate);
  headers.delete("host");
  if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
  else headers.delete("x-amz-security-token");
  const payloadHash = sha256(options.body ?? "");
  if (headers.has("x-amz-content-sha256")) headers.set("x-amz-content-sha256", payloadHash);
  const value = (name: string) => (name === "host" ? url.host : headers.get(name));

  const names = (options.signedHeaders ?? [...headers.keys()])
    .map((n) => n.toLowerCase())
    .filter((n) => !UNSIGNABLE.has(n) && value(n) !== null);
  for (const required of ["host", "x-amz-date", ...(credentials.sessionToken ? ["x-amz-security-token"] : [])]) {
    if (!names.includes(required)) names.push(required);
  }
  const signed = [...new Set(names)].sort();

  // Each path segment is encoded once more, as the AWS SDK does for every service but S3.
  const path = url.pathname.split("/").map(escape).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [escape(k), escape(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalHeaders = signed.map((n) => `${n}:${(value(n) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const canonical = [options.method.toUpperCase(), path, query, canonicalHeaders, signed.join(";"), payloadHash].join("\n");

  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), options.region), options.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`);
}

/** What a SigV4 `authorization` header says about how it was signed. */
export function parseAuthorization(value: string | null): { accessKeyId: string; region: string; service: string; signedHeaders: string[] } | undefined {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+)/.exec(value ?? "");
  if (!match) return undefined;
  return { accessKeyId: match[1]!, region: match[2]!, service: match[3]!, signedHeaders: match[4]!.split(";") };
}

/** Profiles in the shared credentials file, `~/.aws/credentials` unless `AWS_SHARED_CREDENTIALS_FILE` says otherwise. */
function profiles(env: NodeJS.ProcessEnv): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  let text: string;
  try {
    text = readFileSync(env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials"), "utf8");
  } catch {
    return out;
  }
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    const section = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line);
    if (section) {
      current = {};
      out.set(section[1]!, current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1]!.toLowerCase()] = pair[2]!;
  }
  return out;
}

function fromProfile(p: Record<string, string> | undefined): AwsCredentials | undefined {
  if (!p?.aws_access_key_id || !p.aws_secret_access_key) return undefined;
  return { accessKeyId: p.aws_access_key_id, secretAccessKey: p.aws_secret_access_key, sessionToken: p.aws_session_token || undefined };
}

/**
 * Static AWS credentials: from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or the
 * `AWS_PROFILE` (or default) profile. With `accessKeyId`, only the credentials with that key, as
 * when re-signing a request someone else signed.
 */
export function findCredentials(env: NodeJS.ProcessEnv = process.env, accessKeyId?: string): AwsCredentials | undefined {
  const fromEnv: AwsCredentials | undefined =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined }
      : undefined;
  const all = profiles(env);
  if (accessKeyId === undefined) return fromEnv ?? fromProfile(all.get(env.AWS_PROFILE || "default"));
  if (fromEnv?.accessKeyId === accessKeyId) return fromEnv;
  for (const p of all.values()) {
    const found = fromProfile(p);
    if (found?.accessKeyId === accessKeyId) return found;
  }
  return undefined;
}

/** `AKIA…WXYZ`: enough to recognize an access key id, not to use it. */
export const maskKeyId = (id: string) => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…");
