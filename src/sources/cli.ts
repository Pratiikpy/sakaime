/**
 * Development tool for the source layer. Not used at run time.
 *
 *   tsx src/sources/cli.ts build-feasibility
 *       Rebuild data/cassettes/public-evidence-2026-10-27 and the pinned FDA AI-list snapshot from the
 *       feasibility probe's saved responses (research/feasibility/fixtures, a local folder).
 *
 *   tsx src/sources/cli.ts record <cassette-dir> [--manual] [--overwrite] <url> [<url> ...]
 *       Fetch each URL once through the safe fetcher (allowlist from the source cards) and add the response
 *       to the cassette. --manual records a redirect instead of following it. Each URL is one polite request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyYaml } from "yaml";
import { sha256Hex } from "../util/canonical.ts";
import { allowlistFromCards, loadSourceCards } from "./cards.ts";
import { buildFeasibilityCassette } from "./cassette-build.ts";
import { CassetteStore, RecordingFetcher } from "./cassette.ts";
import { SafeFetcher } from "./safe-fetch.ts";
import type { SnapshotManifest } from "./snapshot.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES = path.join(repoRoot, "research", "feasibility", "fixtures");
const CASSETTE = path.join(repoRoot, "data", "cassettes", "public-evidence-2026-10-27");
const SNAPSHOTS = path.join(repoRoot, "data", "sources", "snapshots");

const AI_LIST_URL = "https://www.fda.gov/media/178541/download?attachment";
const BROWSER_CAPTURE_SHA256 = "315672a00715b7c076b6ca79807cce028e2e7f21f79bab73e6bc841671c112af";

function buildSnapshot(): void {
  // The byte-exact copy fetched by the safe fetcher on 2026-10-27 (recorded in the cassette) is pinned. The
  // probe's browser capture (sha256 BROWSER_CAPTURE_SHA256) differs from it only by a windows-1252 decoding step
  // applied during the capture: decoding the capture as UTF-8 and encoding the text as windows-1252 reproduces the
  // live bytes exactly (checked once, 2026-10-27).
  const live = CassetteStore.load(CASSETTE).find(AI_LIST_URL);
  if (!live || live.entry.response.status !== 200) throw new Error("record the FDA AI list into the cassette first (see the record command)");
  const bytes = live.body;
  const rows = parseCsv(Buffer.from(bytes), { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  const manifest: SnapshotManifest = {
    id: "fda-ai-enabled-devices",
    file: "fda-ai-enabled-devices.csv",
    sha256: sha256Hex(bytes),
    bytes: bytes.length,
    sourceUrl: AI_LIST_URL,
    capturedOn: live.entry.recordedAt.slice(0, 10),
    capturedBy: "the safe fetcher in src/sources (Node HTTPS GET, one request, redirects not followed)",
    sourceLastModified: new Date(live.entry.response.headers["last-modified"]!).toISOString(),
    contentCurrentAsOf: "2026-09-04",
    rows: rows.length,
    columns: Object.keys(rows[0] ?? {}),
    notes: [
      "The bytes are pinned exactly as served, CRLF line endings included.",
      `The feasibility probe's browser capture (sha256 ${BROWSER_CAPTURE_SHA256}, 141,730 bytes) carries 69 lines with a stray A-circumflex before a registered or trademark sign. That was introduced by the capture, not by FDA: decoding the capture as UTF-8 and encoding it as windows-1252 reproduces these bytes exactly. Row content is otherwise identical.`,
      "The FDA list page was reported as blocked for scripted access on 2026-10-27 (redirect to an abuse-detection page for curl and urllib). This request, made from Node later the same day, was served. Whether that is stable is NOT VERIFIED, so the snapshot is still treated as a stale pinned copy.",
      "FDA states the list is not a comprehensive resource.",
    ],
  };
  fs.mkdirSync(SNAPSHOTS, { recursive: true });
  fs.writeFileSync(path.join(SNAPSHOTS, manifest.file), bytes);
  fs.writeFileSync(path.join(SNAPSHOTS, "fda-ai-enabled-devices.yaml"), stringifyYaml(manifest));
  console.log(`snapshot: ${rows.length} rows, ${bytes.length} bytes, sha256 ${manifest.sha256}`);
}

async function record(args: string[]): Promise<void> {
  const manual = args.includes("--manual");
  const overwrite = args.includes("--overwrite");
  const [dir, ...rest] = args.filter((a) => !a.startsWith("--"));
  if (!dir || rest.length === 0) throw new Error("usage: record <cassette-dir> [--manual] [--overwrite] <url> ...");
  const store = fs.existsSync(path.join(dir, "index.json")) ? CassetteStore.load(dir) : CassetteStore.create(dir, path.basename(dir), "Recorded responses.");
  const fetcher = new RecordingFetcher(new SafeFetcher({ allowlist: allowlistFromCards(loadSourceCards()) }), store, { overwrite, ref: "src/sources/cli.ts record" });
  for (const url of rest) {
    // Save after every response: a refusal or outage on one URL must not discard the others already fetched.
    try {
      const res = await fetcher.get(url, manual ? { redirect: "manual" } : {});
      console.log(`${res.status} ${res.body.length} bytes sha256 ${sha256Hex(res.body)} ${url}`);
      store.save();
    } catch (err) {
      console.log(`FAILED ${(err as Error).message} :: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "build-feasibility") {
  const report = buildFeasibilityCassette({ fixturesDir: FIXTURES, outDir: CASSETTE, allowlist: allowlistFromCards(loadSourceCards()) });
  console.log(`cassette: ${report.included} responses, ${report.bytes} bytes, ${report.skipped.length} skipped`);
  buildSnapshot();
} else if (command === "record") {
  await record(args);
} else {
  console.error("commands: build-feasibility | record <cassette-dir> [--manual] [--overwrite] <url> ...");
  process.exitCode = 2;
}
