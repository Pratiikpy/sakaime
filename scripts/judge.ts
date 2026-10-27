/**
 * npm run judge: re-checks the main claims of Sakaime offline, with no key and no network, in well under two minutes.
 *
 * It does four things and prints PASS or FAIL for each claim it checks:
 *   1. every committed dossier is verified: content hashes, signature, quotes in the stored records, number tracing, and the
 *      compiler is run again on the recorded inputs and must give the recorded label for every claim;
 *   2. one changed byte in a dossier must make verification fail and name the item;
 *   3. a fresh sample-mode investigation of every case (the compiler, identity scorer, extractors, verifiers and guard run for
 *      real on the recorded responses) must reproduce the committed recorded run: labels, relations, federation statements and
 *      record hashes;
 *   4. the source-off drills are replayed through the real code: a lost required source must never yield a supported label.
 *
 * Exit code 0 only if every line is PASS. A PASS means the recorded evidence reproduces; it is not a statement that any claim
 * about a product is clinically right.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyDossier } from "../src/dossier/index.ts";
import { canonicalJson } from "../src/util/canonical.ts";
import { lintWording } from "../src/agents/policy.ts";
import { loadConfig } from "../src/service/config.ts";
import { recomputeFn } from "../src/service/bundle.ts";
import { readRecordedRun, recordedCase } from "../src/service/sample-run.ts";
import { SakaimeService } from "../src/service/service.ts";

const started = Date.now();
let failures = 0;
const line = (ok: boolean, what: string, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

async function main(): Promise<void> {
  const cfg = loadConfig({ sample: true, env: { SAMPLE_MODE: "true" } });
  console.log("Sakaime judge: sample mode, no key, no network");
  console.log("");

  // ---- 1 and 2: the committed dossiers
  const dir = join(cfg.dirs.outputs, "dossiers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".dossier.json")).sort();
  line(files.length > 0, `committed dossiers found`, `${files.length} in output_examples/dossiers`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const bundle = JSON.parse(text) as { manifest: { dossierId: string; signing: { keyStatus: string } }; body: { claims: { id: string }[]; findings: { id: string; claimId: string; label: string; ruleVersion: string }[]; evidenceItems: never[]; compilerRuns: { findingId: string; evidenceItemIds: string[] }[] } };
    const result = await verifyDossier(bundle, { recompute: recomputeFn });
    const failed = result.checks.filter((c) => c.status === "FAIL").map((c) => c.id);
    line(result.ok, `${f}: hashes, signature and ${result.checks.filter((c) => c.status === "PASS").length} semantic checks`, result.ok ? `${bundle.manifest.signing.keyStatus} key: integrity only, not who signed` : `failed: ${failed.join(", ")}`);
    for (const finding of bundle.body.findings) {
      const claim = (bundle.body as unknown as { claims: { id: string }[] }).claims.find((c) => c.id === finding.claimId)!;
      const run = bundle.body.compilerRuns.find((r) => r.findingId === finding.id)!;
      const items = bundle.body.evidenceItems as unknown as { id: string }[];
      const evidence = run.evidenceItemIds.map((id) => items.find((i) => i.id === id)!);
      const again = await recomputeFn(claim as never, evidence as never, finding.ruleVersion);
      line(again.label === finding.label, `${finding.claimId}: compiler gives the recorded label`, `${finding.label}`);
    }
    // One changed byte must fail verification and name what moved.
    const tampered = JSON.parse(text) as typeof bundle;
    tampered.body.findings[0]!.label = tampered.body.findings[0]!.label === "INSUFFICIENT_EVIDENCE" ? "SUPPORTED_FOR_SCOPE" : "INSUFFICIENT_EVIDENCE";
    const t = await verifyDossier(tampered, { recompute: recomputeFn });
    line(!t.ok && t.failures.length > 0, `${f}: a changed label is detected`, t.failures[0] ? `${t.failures[0].item}: ${t.failures[0].reason.slice(0, 90)}` : "verification passed a tampered bundle");
  }

  // ---- 3: a fresh sample run reproduces the recorded run
  const svc = await SakaimeService.create({ sample: true, env: { SAMPLE_MODE: "true", SAKAIME_NO_ENV: "1" } });
  const recorded = readRecordedRun(cfg.dirs.sampleRun);
  line(recorded !== undefined, "recorded run found", "data/sample/run/labels.json");
  const runs = [];
  for (const c of svc.cases) {
    const run = await svc.investigate(c.spec.id);
    runs.push(run);
    line(run.status === "complete", `${c.spec.id}: sample investigation completes`, `${run.trace.events.length} trace lines, ${run.turns} compile turn(s)`);
    const now = recordedCase(run);
    const was = recorded?.cases.find((x) => x.caseId === c.spec.id);
    for (const claim of now.claims) {
      const w = was?.claims.find((x) => x.claimId === claim.claimId);
      line(w !== undefined && canonicalJson(w) === canonicalJson(claim), `${claim.claimId}: label and relations equal the recording`, claim.label);
    }
    line(was !== undefined && canonicalJson(was.federation) === canonicalJson(now.federation), `${c.spec.id}: the federation statements and result hashes equal the recording`, `${now.federation.length} Zetaris statements`);
    line(was !== undefined && canonicalJson(was.records) === canonicalJson(now.records), `${c.spec.id}: the stored records equal the recording`, `${now.records.length} records`);
    const wording = run.trace.events.flatMap((e) => lintWording(e.decision));
    line(wording.length === 0, `${c.spec.id}: no banned wording in the trace`);
  }

  // ---- 4: the drills, through the real code
  for (const c of svc.cases) {
    for (const d of [
      { drill: "source_off" as const, target: "authorization" },
      { drill: "source_off" as const, target: "study" },
      { drill: "source_empty" as const, target: "registry" },
      { drill: "zetaris_off" as const },
      { drill: "truncated_result" as const },
    ]) {
      const r = await svc.drill(c.spec.id, d);
      line(r.invariantHeld, `${c.spec.id}: ${d.drill}${"target" in d ? ` (${d.target})` : ""}: a lost required source never yields a supported label`, `${r.after.filter((f) => f.label.startsWith("SUPPORTED")).length} supported findings after`);
    }
  }
  svc.close();

  console.log("");
  console.log(`${failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`} in ${Math.round((Date.now() - started) / 100) / 10} s`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL  judge could not complete:", e instanceof Error ? e.message : e);
  process.exit(1);
});
