#!/usr/bin/env -S npx tsx
// Sets up, records, measures and stress-tests the Sakaime semantic layer on the running Zetaris stack.
//
//   npx tsx infra/zetaris/scripts/usl.ts ensure         land the collection manifest, then compile, describe, activate, register and grant
//   npx tsx infra/zetaris/scripts/usl.ts record         record the layer reads (overview and every hospital case) into data/federation-cassettes
//   npx tsx infra/zetaris/scripts/usl.ts measure [n]    the same cross-silo question by hand, as one hand-written statement, and through the layer
//   npx tsx infra/zetaris/scripts/usl.ts drill          truncate a landed collection on purpose, show the rule catch it, restore it
//
// Credentials are read by name from the repository .env and infra/zetaris/sakaime.env and are never printed.
// `ensure` is idempotent and is also run at the end of seed.sh.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { ensureUsl, manifestCsv, MANIFEST_COLLECTIONS, runCompletenessRule, type ManifestEntry } from "../../../src/federation/usl.ts";
import { answerByHand, answerByOneStatement, answerThroughUsl, compareAnswers, median } from "../../../src/federation/usl-measure.ts";
import { loadCases } from "../../../src/service/cases.ts";
import { defaultDirs } from "../../../src/service/config.ts";
import { openUslAdmin, PasswordSessionPort, UslService, uslConnectionFromEnv, uslSpec } from "../../../src/service/usl.ts";
import { PortError } from "../../../src/ports/index.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
for (const file of [join(root, "infra", "zetaris", "sakaime.env"), join(root, ".env")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* a missing file leaves the process environment as it is */
  }
}

const env = process.env as Record<string, string | undefined>;
const conn = uslConnectionFromEnv(env);
const s3 = `http://127.0.0.1:${env["SAKAIME_S3_PORT"] ?? "19190"}`;
const siloDir = join(root, "data", "silos");
const say = (...parts: unknown[]): void => console.log(...parts);

// ---------------------------------------------------------------- the collection manifest

const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const rowsOf = (buf: Buffer): number => (parse(buf, { columns: true, skip_empty_lines: true, relax_quotes: true }) as unknown[]).length;

/** What each landing step recorded: the registry files from the normaliser's own manifest, the vendor files counted here. */
export function manifestEntries(): ManifestEntry[] {
  const landed = JSON.parse(readFileSync(join(siloDir, "registry", "MANIFEST.json"), "utf8")) as { outputs: { file: string; rows: number; sha256: string }[] };
  return MANIFEST_COLLECTIONS.map((c) => {
    if (c.database === "sk_registry") {
      const out = landed.outputs.find((o) => o.file === `${c.table}.csv`);
      if (!out) throw new Error(`registry/MANIFEST.json has no entry for ${c.table}`);
      const buf = readFileSync(join(siloDir, "registry", `${c.table}.csv`));
      if (sha(buf) !== out.sha256 || rowsOf(buf) !== out.rows) throw new Error(`${c.table}.csv no longer matches registry/MANIFEST.json; rebuild the registry files first`);
      return { database: c.database, table: c.table, sourceId: "registry-snapshots", expectedTotal: out.rows, truncated: false, landedSha256: out.sha256 };
    }
    const buf = readFileSync(join(siloDir, "vendor_packets", `${c.table}.csv`));
    return { database: c.database, table: c.table, sourceId: "vendor-packets", expectedTotal: rowsOf(buf), truncated: false, landedSha256: sha(buf) };
  });
}

async function put(path: string, body: string | Uint8Array): Promise<void> {
  const res = await fetch(`${s3}/${path}`, { method: "PUT", body: body as BodyInit, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`PUT ${path} -> HTTP ${res.status}`);
}

const s3Options = 'isS3BucketPublic "true", s3Endpoint "http://object-store:9090", useS3PathStyleAccess "true"';

async function landManifest(admin: ReturnType<typeof openUslAdmin>): Promise<void> {
  await put("sakaime-registry/collection_manifest/collection_manifest.csv", manifestCsv(manifestEntries()));
  const have = await admin.port.sql("SELECT 1 AS one FROM sk_registry.collection_manifest LIMIT 1").then(() => true, () => false);
  if (!have) {
    await admin.port.sql(`CREATE LIGHTNING FILESTORE TABLE collection_manifest FROM sk_registry FORMAT CSV OPTIONS (path "s3a://sakaime-registry/collection_manifest/collection_manifest.csv", header "true", inferSchema "true", ${s3Options})`, { statementPolicy: "admin" });
    say("created  sk_registry.collection_manifest");
  } else say("kept     sk_registry.collection_manifest (file refreshed)");
}

// ---------------------------------------------------------------- commands

async function ensure(): Promise<void> {
  const admin = openUslAdmin(conn);
  await landManifest(admin);
  const report = await ensureUsl(admin, uslSpec());
  say(`USL ${report.path} (id ${report.uslId}): ${report.rebuilt ? "rebuilt" : "present"}, ${report.actions.length} change(s), ${report.kept} object(s) already correct, ${report.statements} statements, ${report.elapsedMs} ms`);
  const bySteps = new Map<string, number>();
  for (const a of report.actions) bySteps.set(a.step, (bySteps.get(a.step) ?? 0) + 1);
  for (const [step, n] of bySteps) say(`  ${step}: ${n}`);
}

async function record(): Promise<void> {
  const dirs = defaultDirs();
  const service = new UslService({ sample: false, env, dirs, clock: { now: () => new Date() }, record: true }, { ttlMs: 0 });
  if (service.mode !== "live") throw new Error(`cannot record: ${service.notes[0] ?? "Zetaris is not configured"}`);
  const cases = loadCases(dirs.cases).map((c) => UslService.requestFor(c.spec));
  // Every hospital case is recorded, so that a case the web app does not list still has its definitions replayable.
  const hospitalIds = ["CASE-2026-009", "CASE-2026-014", "CASE-2026-016", "CASE-2026-018", "CASE-2026-019", "CASE-2026-021", "CASE-2026-022"];
  const requests = hospitalIds.map((id) => cases.find((c) => c.caseId === id) ?? { caseId: id });
  const written = await service.record(requests);
  for (const f of written) say("recorded", f.replace(root, "").replace(/\\/g, "/"));
}

async function measure(rounds: number): Promise<void> {
  const reader = new PasswordSessionPort(conn.restUrl, conn.orgId, conn.reader!);
  const spec = uslSpec();
  const arms = [
    { name: "by hand: seven separate reads, joined in code", run: () => answerByHand(reader) },
    { name: "one hand-written federated statement", run: () => answerByOneStatement(reader, spec) },
    { name: "one read of the layer", run: () => answerThroughUsl(reader, spec) },
  ];
  // One untimed pass warms the engine's file caches; the timed rounds interleave the arms so drift hits all three alike.
  for (const arm of arms) await arm.run();
  const times = arms.map(() => [] as number[]);
  const last = arms.map(() => undefined as Awaited<ReturnType<(typeof arms)[number]["run"]>> | undefined);
  for (let i = 0; i < rounds; i++) {
    for (const [k, arm] of arms.entries()) {
      const began = performance.now();
      const answer = await arm.run();
      times[k]!.push(Math.round(performance.now() - began));
      last[k] = answer;
    }
  }
  say(`rounds: ${rounds} (after one untimed warm-up), reader identity, same machine, other clients may have been using the engine`);
  for (const [k, arm] of arms.entries()) {
    const a = last[k]!;
    const t = times[k]!;
    say(`${arm.name}\n  statements ${a.statements}  rows ${a.rows.length}  median ${median(t)} ms  min ${Math.min(...t)}  max ${Math.max(...t)}  all ${t.join(" ")}`);
  }
  const base = last[0]!;
  for (const k of [1, 2]) {
    const cmp = compareAnswers(base, last[k]!);
    say(`${arms[k]!.name} equals the by-hand answer: ${cmp.equal ? `yes, ${cmp.rows} rows identical cell by cell` : `NO: ${cmp.problems.slice(0, 5).join("; ")}`}`);
  }
  const src = readFileSync(join(root, "src", "federation", "usl-measure.ts"), "utf8");
  const lines = (name: string): number => {
    const m = new RegExp(`export async function ${name}[\\s\\S]*?\\n}\\n`).exec(src);
    return m ? m[0].split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).length : 0;
  };
  say(`consumer code, non-blank non-comment lines: by hand ${lines("answerByHand")} (plus the seven statement texts), through the layer ${lines("answerThroughUsl")}`);
}

async function drill(): Promise<void> {
  const reader = new PasswordSessionPort(conn.restUrl, conn.orgId, conn.reader!);
  const spec = uslSpec();
  const table = "pubmed_articles"; // a registry collection the Evidence Matrix does not read, so the drill cannot disturb another client
  const csv = readFileSync(join(siloDir, "registry", `${table}.csv`));
  const url = `sakaime-registry/${table}/${table}.csv`;
  const before = await runCompletenessRule(reader, spec);
  say(`before:   ${before.verdict}  ${before.failures} of ${before.rowsChecked} collections fail  blocked [${before.blocked.join(", ")}]  query ${before.queryId}`);
  const lines = csv.toString("utf8").split("\n");
  try {
    await put(url, lines.slice(0, 40).join("\n") + "\n");
    const during = await runCompletenessRule(reader, spec);
    const hit = during.collections.find((c) => c.collectionId === `sk_registry.${table}`)!;
    say(`truncated: ${during.verdict}  ${during.failures} of ${during.rowsChecked} fail  blocked [${during.blocked.join(", ")}]  query ${during.queryId}`);
    say(`          ${hit.collectionId}: expected ${hit.expectedTotal}, counted ${hit.retrievedTotal}, code check says ${hit.status}: ${hit.reason}`);
    say(`          the engine and the code check agree: ${during.codeCheckAgrees}`);
  } finally {
    await put(url, csv);
  }
  const after = await runCompletenessRule(reader, spec);
  say(`restored: ${after.verdict}  ${after.failures} of ${after.rowsChecked} fail  query ${after.queryId}`);
  if (after.verdict !== "PASSED") throw new Error("the collection was not restored");
}

const [command = "", arg] = process.argv.slice(2);
try {
  if (command === "ensure") await ensure();
  else if (command === "record") await record();
  else if (command === "measure") await measure(Number(arg ?? 9));
  else if (command === "drill") await drill();
  else {
    say("usage: usl.ts ensure | record | measure [rounds] | drill");
    process.exitCode = 2;
  }
} catch (e) {
  if (e instanceof PortError) console.error(`${e.failure}: ${e.message}`);
  else console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
