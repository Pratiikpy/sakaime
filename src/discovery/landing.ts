/**
 * Landing of normalised snapshots in the object store Zetaris reads from.
 *
 * The endpoint is operator configuration (the S3-compatible store of the Zetaris stack), never user input, and it
 * is the one network address in this module that is not run through the SSRF-safe fetcher: it is a loopback store
 * in the local stack. Bucket and key are validated so a snapshot name cannot escape its prefix. After the write the
 * object is read back and its hash compared, so "landed" means the bytes are there, not that the PUT returned 200.
 */
import { PortError } from "../ports/index.ts";
import { sha256Hex } from "../util/canonical.ts";

export interface LandedObject {
  /** The path Zetaris reads, as `s3a://bucket/key`. */
  uri: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotLander {
  /** Idempotent: landing the same bytes at the same key again changes nothing. Throws PortError on any failure. */
  put(bucket: string, key: string, bytes: Uint8Array): Promise<LandedObject>;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{2,62}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;

export interface ObjectStoreLanderOptions {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ObjectStoreLander implements SnapshotLander {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ObjectStoreLanderOptions) {
    let url: URL;
    try {
      url = new URL(options.endpoint);
    } catch {
      throw new PortError("INVALID", "the object store endpoint is not a URL", { reason: "BAD_CONFIG" });
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      throw new PortError("INVALID", "the object store endpoint must be http or https without credentials", { reason: "BAD_CONFIG" });
    }
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async call(method: string, path: string, body?: Uint8Array): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.endpoint}/${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body ? { body: Buffer.from(body) } : {}),
      });
    } catch (e) {
      throw new PortError("UNAVAILABLE", `the object store did not answer ${method} ${path.split("/")[0]}: ${(e as Error).message}`, { retryable: true });
    }
  }

  async put(bucket: string, key: string, bytes: Uint8Array): Promise<LandedObject> {
    if (!BUCKET_RE.test(bucket) || !KEY_RE.test(key) || key.includes("..") || key.includes("//")) {
      throw new PortError("INVALID", "the bucket or object key is not a plain name", { reason: "BAD_NAME" });
    }
    // Creating a bucket that exists answers 409; that is the idempotent case.
    const made = await this.call("PUT", bucket);
    if (!made.ok && made.status !== 409) throw new PortError("UNAVAILABLE", `creating bucket ${bucket} returned HTTP ${made.status}`, { retryable: true });
    const stored = await this.call("PUT", `${bucket}/${key}`, bytes);
    if (!stored.ok) throw new PortError("UNAVAILABLE", `landing ${key} returned HTTP ${stored.status}`, { retryable: true });
    const back = await this.call("GET", `${bucket}/${key}`);
    if (!back.ok) throw new PortError("UNAVAILABLE", `reading ${key} back returned HTTP ${back.status}`, { retryable: true });
    const read = new Uint8Array(await back.arrayBuffer());
    const expected = sha256Hex(bytes);
    if (sha256Hex(read) !== expected) throw new PortError("INVALID", `the object read back from the store differs from what was written (${key})`, { reason: "READBACK" });
    return { uri: `s3a://${bucket}/${key}`, sha256: expected, bytes: bytes.length };
  }
}
