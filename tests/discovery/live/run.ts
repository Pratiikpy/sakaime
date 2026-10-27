/**
 * The live run: the onboarding pipeline against the real Zetaris stack, real public sources through the real SSRF-safe
 * fetcher, and the real model. Run it with
 *
 *   npx tsx tests/discovery/live/run.ts
 *
 * Credentials are read by name from the repository .env and infra/zetaris/sakaime.env and are never printed. The run
 * registers tables in the local Zetaris database `sk_onboarded`; remove them with `DROP LIGHTNING DATABASE sk_onboarded`
 * as the administrator. What was run, with query ids, is written to data/discovery-shift/live/.
 *
 * Two of the five sources are constructed (labelled so): they are served by a local fixture under a card for a test host,
 * because a constructed layout cannot be hosted by a real registry. Everything else in the path is the production path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDrift, MemoryLedger, MemoryReviewQueue, ObjectStoreLander, onboardSource, resolveReview, schemaFactId } from "../../../src/discovery/index.ts";
import { zetarisAuthFromEnv, openZetaris } from "../../../src/discovery/zetaris-auth.ts";
import { HMEM } from "../../../src/engines/hmem/index.ts";
import { SAKAIME_REGISTRY_PATH, Scout } from "../../../src/engines/scout/index.ts";
import { WorldModel } from "../../../src/engines/world-model/index.ts";
import { createModelStack, readEnvFile } from "../../../src/models/index.ts";
import { allowlistFromCards, loadSourceCards } from "../../../src/sources/cards.ts";
import type { Fetcher, FetchInit, FetchResult } from "../../../src/sources/fetcher.ts";
import { SafeFetcher, systemResolver } from "../../../src/sources/safe-fetch.ts";
import { SHIFT_DIR } from "../shift/suite.ts";
import { ServedFetcher } from "../helpers/doubles.ts";
import { ROOT, SECRET, TEST_HOST, clearances, csv, testCard, urlOf } from "../helpers/fixtures.ts";

const OUT = join(SHIFT_DIR, "live");
mkdirSync(OUT, { recursive: true });
const env = { ...process.env, ...readEnvFile(join(ROOT, "infra", "zetaris", "sakaime.env")), ...readEnvFile(join(ROOT, ".env")) } as Record<string, string>;

const say = (s: string): void => void process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  const auth = zetarisAuthFromEnv(env);
  if ("missing" in auth) {
    say(`The Zetaris stack is not configured; missing variables: ${auth.missing.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const port = await openZetaris(auth.config);
  const health = await port.check();
  say(`Zetaris probe: ${health.health} (${health.detail}) in ${health.latencyMs} ms`);
  if (health.health !== "OK") {
    process.exitCode = 3;
    return;
  }
  if (!process.argv.includes("--keep")) {
    // A clean start, so that the first registration of each source is a creation and the second run shows idempotency.
    try {
      await port.sql("DROP LIGHTNING DATABASE sk_onboarded", { identity: "admin", statementPolicy: "admin" });
      say("dropped the Lightning database sk_onboarded to start clean");
    } catch (e) {
      say(`sk_onboarded was not dropped (${(e as Error).message.slice(0, 120)}); registrations may report kept`);
    }
  }
  const stack = await createModelStack({ env, mode: "live" });
  await stack.beginRun();

  const cards = [...loadSourceCards(), testCard()];
  const allowlist = allowlistFromCards(cards);
  const real = new SafeFetcher({ allowlist });
  const fixture = new ServedFetcher(new Map());
  const router: Fetcher = {
    get servedFrom() {
      return real.servedFrom;
    },
    get: (url: string, init?: FetchInit): Promise<FetchResult> => (new URL(url).hostname === TEST_HOST ? fixture.get(url, init) : real.get(url, init)),
  };

  let now = Date.now();
  const clock = { now: () => new Date(now) };
  const scout = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"], secret: SECRET, clock: () => clock.now() });
  const trace: unknown[] = [];
  const deps = {
    // DNS is checked for every real host. The fixture host has no DNS; it is given a placeholder public address so the
    // check runs, and nothing is ever fetched from it.
    sources: { allowlist, cards, fetcher: router, resolver: (host: string) => (host === TEST_HOST ? Promise.resolve([{ address: "93.184.216.34", family: 4 as const }]) : systemResolver(host)) },
    federation: port,
    models: stack.port,
    hmem: new HMEM({ clock: () => now, actor: "live-run" }),
    worldModel: new WorldModel({ storage: "memory", namespace: "live-run", clock: () => clock.now() }),
    executor: scout.executor(),
    landing: new ObjectStoreLander({ endpoint: `http://127.0.0.1:${env["SAKAIME_S3_PORT"] ?? "19190"}` }),
    ledger: new MemoryLedger(),
    reviews: new MemoryReviewQueue(),
    clock,
    trace: (e: unknown) => trace.push(e),
  };
  const contract = async (url: string) => {
    const d = await scout.decide({ prompt: `Add this source: ${url}`, user: { id: "live-reviewer", role: "reviewer" }, surface: "chat" });
    if (!d.executionContract) throw new Error(`no contract for ${url}: ${d.decision}`);
    return d.executionContract;
  };
  const results: Record<string, unknown> = {};
  const show = (name: string, r: Awaited<ReturnType<typeof onboardSource>>): void => {
    say(`\n== ${name}: ${r.outcome}${r.reason ? ` (${r.reason.slice(0, 200)})` : ""}`);
    for (const s of r.stages) say(`   ${s.stage.padEnd(22)} ${s.status.padEnd(8)} ${s.summary.slice(0, 170)}`);
    for (const m of r.mapping) say(`   ${m.check.padEnd(12)} ${m.sourceField} -> ${m.canonicalField}${m.unit ? ` [${m.unit}]` : ""}`);
    results[name] = r;
  };

  // The run script stands in for a reviewer where a source is held: it keeps the column whose name is the canonical field,
  // accepts the findings that were shown, and says so in the note. A person would look at the same ticket.
  const asReviewer = async (name: string, r: Awaited<ReturnType<typeof onboardSource>>, url: string): Promise<Awaited<ReturnType<typeof onboardSource>>> => {
    if (r.outcome !== "held_for_review") return r;
    const ticket = deps.reviews.get(r.id)!;
    const columnChoices: Record<string, string> = {};
    for (const hold of ticket.holds) {
      if (!hold.signatures.some((s) => s.startsWith("duplicate-target#"))) continue;
      const same = ticket.holds.filter((x) => x.canonicalField === hold.canonicalField);
      columnChoices[hold.canonicalField] = (same.find((x) => x.sourceField.split(".").pop() === hold.canonicalField) ?? same[0]!).sourceField;
    }
    say(`   -> the run script stands in for a reviewer: keeps ${JSON.stringify(columnChoices)} and accepts the findings shown`);
    const done = await resolveReview(r.id, { reviewer: "run-script-as-reviewer", decision: "accept", note: "automated acceptance by the live run script, standing in for a reviewer", columnChoices, contract: await contract(url) }, deps);
    show(`${name} (after acceptance)`, done);
    return done;
  };

  // 1. A real openFDA endpoint, bounded to six clearances we hold.
  const fdaUrl = "https://api.fda.gov/device/510k.json?search=k_number:(K200667+OR+K211733+OR+K221347+OR+K253265+OR+DEN180001+OR+DEN170073)&limit=20";
  const fda = await onboardSource({ description: "openFDA 510(k) clearance records for six AI-enabled devices", url: fdaUrl, orgId: "live-org", actor: "live-reviewer", contract: await contract(fdaUrl), expectedJoinRate: 0.8 }, deps);
  show("openfda-510k", fda);
  // The real FDA source raises a real question (below); it is left for a person, not answered by this script.

  // 2. A real ClinicalTrials.gov endpoint, nested JSON.
  const ctUrl = "https://clinicaltrials.gov/api/v2/studies?query.intr=EyeArt&pageSize=15&fields=NCTId,BriefTitle,OverallStatus,EnrollmentCount,StartDate,MinimumAge";
  const ct = await onboardSource({ description: "ClinicalTrials.gov studies of the EyeArt device", url: ctUrl, orgId: "live-org", actor: "live-reviewer", contract: await contract(ctUrl) }, deps);
  show("clinicaltrials-eyeart", ct);

  // 3. A constructed unseen layout: held clearance records with every column renamed.
  const renamed = urlOf("partner-clearances.csv");
  fixture.set(renamed, csv(["fda_ref", "item_label", "firm_name", "procode", "cleared_on", "risk_class"], clearances().map((r) => [r[0]!, r[2]!, r[1]!, r[3]!, r[4]!, r[5]!])));
  const unseen = await onboardSource({ description: "Partner export of cleared AI-enabled devices (constructed layout)", url: renamed, orgId: "live-org", actor: "live-reviewer", contract: await contract(renamed), expectedJoinRate: 0.8 }, deps);
  show("constructed-renamed", unseen);

  // 4. A constructed unit shift: reported sensitivities on a 0 to 100 scale. Held, then accepted by the run script as the reviewer.
  const perfUrl = urlOf("partner-performance.csv");
  fixture.set(perfUrl, csv(["pubmed_id", "reported_sensitivity", "year"], [["34779843", 95.5, 2021], ["31304320", 87.2, 2018], ["33782551", 97.7, 2021], ["37450425", 81.4, 2023], ["36345378", 59.5, 2023], ["34117018", 54.9, 2021]]));
  const held = await onboardSource({ description: "Reported diagnostic performance from published studies (constructed unit shift)", url: perfUrl, orgId: "live-org", actor: "live-reviewer", contract: await contract(perfUrl), expectedJoinRate: 0.8 }, deps);
  show("constructed-percent (held)", held);
  await asReviewer("constructed-percent", held, perfUrl);

  // 5. Refusals. Scout declines to issue a contract for a malformed or internal address; the pipeline refuses on its own too.
  for (const [name, url] of [["refused-metadata", "https://169.254.169.254/latest/meta-data/"], ["refused-host", "https://example.org/data.csv"], ["refused-http", "http://api.fda.gov/device/510k.json?limit=1"]] as const) {
    const d = await scout.decide({ prompt: `Add this source: ${url}`, user: { id: "live-reviewer", role: "reviewer" }, surface: "chat" });
    say(`
Scout decision for ${url}: ${d.decision}`);
    show(name, await onboardSource({ description: "a pasted address", url, orgId: "live-org", actor: "live-reviewer", ...(d.executionContract ? { contract: d.executionContract } : {}) }, deps));
  }

  // 6. A cross-source query over two onboarded sources and two original silos, as the read-only identity:
  //    hospital submission (JDBC) -> clearance (onboarded) -> vendor claim (files) -> study (onboarded).
  const joins: Record<string, unknown> = {};
  const onboardedClearances = unseen.zetarisName;
  const study = ct.zetarisName;
  if (onboardedClearances && study) {
    const statement = `SELECT s.submission_id, s.product_name, a.applicant, a.decision_date, c.claim_id, n.nct_id, n.enrollment, n.overall_status FROM hospital.submissions s JOIN ${onboardedClearances} a ON UPPER(TRIM(s.regulator_submission_cited)) = a.submission_number JOIN sk_vendor.vendor_claims c ON UPPER(TRIM(c.cited_submission)) = a.submission_number JOIN ${study} n ON UPPER(TRIM(c.cited_nct_id)) = n.nct_id ORDER BY s.submission_id, c.claim_id`;
    const rows = await port.sql(statement, { limit: 100 });
    joins["hospital + onboarded clearances + vendor claims + onboarded studies"] = { statement, rows: rows.rows.length, queryId: rows.queryId, servedFrom: rows.servedFrom, sample: rows.rows.slice(0, 3) };
    say(`
cross-source query: ${rows.rows.length} rows (query ${rows.queryId}, ${rows.servedFrom})`);
  }

  // 7. Drift: the constructed source renames a column; the check raises DRIFTED and marks the dependent finding stale.
  if (unseen.outcome === "registered") {
    const fact = schemaFactId(deps, unseen.sourceId!);
    if (fact) await deps.worldModel.declareDependencies({ findingId: "live-finding-1", refs: [fact] });
    now += 3_600_000;
    fixture.set(renamed, csv(["fda_ref", "item_label", "company", "procode", "cleared_on", "risk_class"], clearances().map((r) => [r[0]!, r[2]!, r[1]!, r[3]!, r[4]!, r[5]!])));
    const same = await checkDrift(unseen.id, deps);
    say(`drift check after a renamed column: ${same.status}: ${same.detail}`);
    results["drift"] = same;
  }

  writeFileSync(join(OUT, "results.json"), `${JSON.stringify({ ranAt: new Date().toISOString(), zetaris: health, results, joins }, null, 1)}\n`);
  writeFileSync(join(OUT, "trace.jsonl"), `${trace.map((t) => JSON.stringify(t)).join("\n")}\n`);
  say(`\nwrote ${OUT}`);
}

await main();
