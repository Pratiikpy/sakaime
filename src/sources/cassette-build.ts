/**
 * Build the public-evidence cassette from the feasibility probe's saved responses (the probe's complete output folder).
 *
 * The probe wrote one line per request to `_requests.jsonl` (URL, status, bytes, sha256) and saved most bodies
 * under the fixtures folder. A request is included only when its saved body still hashes to the logged value:
 * several requests in the log wrote to the same file name, so the file on disk matches only the last of them
 * and the others are recorded as skipped rather than guessed at. Nothing is rewritten or normalised.
 *
 * This is a development tool. The probe's complete output (about 4 MB with the request log) is a local folder and not
 * part of the repository; the output (data/cassettes) is what ships. The subset the tests read is tracked separately
 * in data/fixtures/feasibility.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../util/canonical.ts";
import { CassetteStore } from "./cassette.ts";
import type { HostAllowlist } from "./safe-fetch.ts";

interface LoggedRequest {
  url: string;
  date: string;
  status: number;
  bytes: number;
  sha256: string;
  file: string | null;
  ct: string | null;
}

export interface BuildOptions {
  fixturesDir: string;
  outDir: string;
  /** Bodies above this size are left out to keep the repository small (the EyeArt efetch is the one exception). */
  maxBodyBytes?: number;
  alwaysInclude?: string[];
  /** Only requests a source card may make (host and path prefix) go into the cassette. */
  allowlist: HostAllowlist;
}

export interface BuildReport {
  included: number;
  skipped: Array<{ url: string; reason: string }>;
  bytes: number;
}

export function buildFeasibilityCassette(options: BuildOptions): BuildReport {
  const maxBody = options.maxBodyBytes ?? 110 * 1024;
  const always = new Set(options.alwaysInclude ?? ["pubmed/ef_eyeart.xml", "fda/DEN180001_denovo_summary.pdf"]);

  const log = fs
    .readFileSync(path.join(options.fixturesDir, "_requests.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LoggedRequest);

  // Index every saved file by content hash so a logged response with no file name (the DEN180001 PDF) still
  // finds its bytes if they were saved under another name.
  const byHash = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else byHash.set(sha256Hex(new Uint8Array(fs.readFileSync(full))), path.relative(options.fixturesDir, full).replaceAll("\\", "/"));
    }
  };
  walk(options.fixturesDir);

  // Live recordings made later with the record tool are not in the probe's files; carry them over.
  const previous = fs.existsSync(path.join(options.outDir, "index.json")) ? CassetteStore.load(options.outDir) : undefined;

  const store = CassetteStore.create(
    options.outDir,
    "public-evidence-2026-10-27",
    "Real responses recorded on 2026-10-27 by the feasibility probe (read-only GET, no keys), plus later live recordings marked as such. Replayed offline; every body is verified against its hash on load.",
  );
  const report: BuildReport = { included: 0, skipped: [], bytes: 0 };

  for (const req of log) {
    const skip = (reason: string) => {
      store.skip(req.url, reason);
      report.skipped.push({ url: req.url, reason });
    };
    const parsed = new URL(req.url);
    const host = parsed.hostname;
    if (!options.allowlist.check(host, 443, parsed.pathname).ok) {
      skip("host or path is not covered by a source card");
      continue;
    }
    if (req.status < 100) {
      skip(`no HTTP response (status ${req.status}: the request timed out or failed)`);
      continue;
    }
    const rel = req.file && fs.existsSync(path.join(options.fixturesDir, req.file)) ? req.file : byHash.get(req.sha256);
    if (!rel) {
      store.skipUnsaved(host);
      report.skipped.push({ url: req.url, reason: "response body was not saved by the probe" });
      continue;
    }
    const bytes = new Uint8Array(fs.readFileSync(path.join(options.fixturesDir, rel)));
    if (sha256Hex(bytes) !== req.sha256 || bytes.length !== req.bytes) {
      skip(`saved file ${rel} no longer matches the logged hash (another request wrote to the same file)`);
      continue;
    }
    if (bytes.length > maxBody && !always.has(rel)) {
      skip(`body is ${bytes.length} bytes, over the ${maxBody}-byte repository budget`);
      continue;
    }
    const headers: Record<string, string> = {};
    if (req.ct) headers["content-type"] = req.ct;
    store.add({
      url: req.url,
      status: req.status,
      headers,
      body: bytes,
      recordedAt: `${req.date}T00:00:00.000Z`,
      precision: "day",
      // The ref names the probe's own file path, as recorded; it is provenance and is kept stable across rebuilds.
      origin: { kind: "feasibility-fixture", ref: `research/feasibility/fixtures/${rel}` },
    });
    report.included++;
    report.bytes += bytes.length;
  }
  for (const entry of previous?.entries() ?? []) {
    if (entry.origin.kind !== "live-recording") continue;
    const kept = previous!.find(entry.request.url)!;
    store.add({
      url: entry.request.url,
      status: entry.response.status,
      headers: entry.response.headers,
      body: kept.body,
      recordedAt: entry.recordedAt,
      precision: entry.recordedAtPrecision,
      origin: entry.origin,
    });
  }
  store.save();
  return report;
}
