import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rawResultHash } from "../../src/federation/result.ts";
import { verifyUslCassette, writeUslCassette } from "../../src/federation/usl-cassette.ts";
import { PortError } from "../../src/ports/index.ts";
import { deterministicClock, defaultDirs } from "../../src/service/config.ts";
import { loadCases } from "../../src/service/cases.ts";
import { UslService, uslSpec } from "../../src/service/usl.ts";

const real = defaultDirs();
const config = (dir: string) => ({ sample: true, env: {}, dirs: { ...real, federationCassettes: dir }, clock: deterministicClock(), record: false });

/** A private copy of the committed recordings that a test may rewrite (with its hashes recomputed, so it stays a valid file). */
function copyOfRecordings(): string {
  const dir = mkdtempSync(join(tmpdir(), "usl-service-"));
  for (const f of readdirSync(real.federationCassettes).filter((n) => /^usl-.*\.json$/.test(n))) cpSync(join(real.federationCassettes, f), join(dir, f));
  return dir;
}

type Step = ReturnType<typeof verifyUslCassette>["steps"][number];

function rewrite(dir: string, edit: (step: Step) => void): void {
  const file = verifyUslCassette(join(dir, "usl-overview.json"));
  for (const step of file.steps) {
    edit(step);
    step.respHash = rawResultHash(step.columns, step.rawRows);
  }
  const { format: _f, stepsHash: _h, ...rest } = file;
  writeUslCassette(dir, rest);
}

describe("the semantic layer in sample mode", () => {
  const service = new UslService(config(real.federationCassettes));

  it("replays the recorded layer and says it is a recording", async () => {
    expect(service.mode).toBe("cassette");
    const s = await service.snapshot();
    expect(s.servedFrom).toBe("cassette");
    expect(s.readerIdentity).toBe("agent-reader");
    expect(s.recordedAt).toMatch(/^2026-10-27T/);
    expect(s.layer.path).toBe("lightning.metastore.sakaime.review_semantics");
    expect(s.tables.map((t) => t.name)).toEqual(uslSpec().tables.map((t) => t.name));
    expect(s.tables.every((t) => t.activated && (t.rows ?? 0) > 0)).toBe(true);
    expect(s.statements.every((x) => x.servedFrom === "cassette" && x.queryId.length > 0)).toBe(true);
  });

  it("reports every rule with its counts and query id, and the completeness gate passes on the recorded stack", async () => {
    const s = await service.snapshot();
    expect(s.dqRules.map((r) => r.rule)).toEqual(uslSpec().rules.map((r) => r.rule));
    const byRule = Object.fromEntries(s.dqRules.map((r) => [r.rule, r]));
    expect(byRule["collection_complete"]).toMatchObject({ verdict: "PASSED", failures: 0, rowsChecked: 7 });
    // 143 of the 157 registry records are search summaries without an eligibility block: a real failure, reported as one.
    expect(byRule["study_has_eligibility"]).toMatchObject({ verdict: "FAILED", failures: 143, rowsChecked: 157 });
    expect(byRule["claimed_age_plausible"]!.verdict).toBe("PASSED");
    expect(byRule["metric_proportion_bounds"]!.verdict).toBe("PASSED");
    for (const r of s.dqRules) expect(r.queryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.completeness).toMatchObject({ verdict: "PASSED", blocked: [], codeCheckAgrees: true });
    expect(s.completeness.complete).toContain("sk_registry.ctgov_studies");
  });

  it("returns the definitions a case needs: its setting and purpose with the broader terms above them, and its metric", async () => {
    const spec = loadCases(real.cases).find((c) => c.spec.id === "eyeart-k200667")!.spec;
    const s = await service.snapshot(UslService.requestFor(spec));
    expect(s.case).toMatchObject({ caseId: "CASE-2026-014", setting: "primary_care", purpose: "detection_aid", ageMinYears: 18 });
    expect(s.definitions.filter((d) => d.kind === "setting").map((d) => d.term)).toEqual(["any_care_setting", "outpatient_care", "primary_care"]);
    expect(s.definitions.filter((d) => d.kind === "purpose").map((d) => d.term)).toEqual(["diagnosis", "detection_aid"]);
    expect(s.definitions.find((d) => d.kind === "metric")).toMatchObject({ term: "sensitivity", unit: "proportion", valueMin: 0, valueMax: 1 });
    expect(s.unresolved).toEqual([]);
  });

  it("covers the case whose setting the hospital writes in its own words (an alias the bridge resolves)", async () => {
    const s = await service.snapshot(UslService.requestFor(loadCases(real.cases).find((c) => c.spec.id === "transpara-k221347")!.spec));
    expect(s.case!.setting).toBe("breast_screening_clinic");
    expect(s.definitions.filter((d) => d.kind === "setting").map((d) => d.term)).toEqual(["any_care_setting", "outpatient_care", "specialty_clinic"]);
    expect(s.unresolved).toEqual([]);
  });

  it("every hospital case has a recording; an unrecorded one is UNAVAILABLE with the reason, not an empty success", async () => {
    const products = loadCases(real.cases).map((c) => UslService.requestFor(c.spec));
    for (const id of ["CASE-2026-009", "CASE-2026-014", "CASE-2026-016", "CASE-2026-018", "CASE-2026-019", "CASE-2026-021", "CASE-2026-022"]) {
      const request = products.find((p) => p.caseId === id) ?? { caseId: id };
      expect((await service.snapshot(request)).case!.caseId).toBe(id);
    }
    await expect(service.snapshot({ caseId: "CASE-9999-999" })).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "CASSETTE_MISS" } });
  });

  it("never offers a vendor-confidential column", async () => {
    const s = await service.snapshot();
    expect(JSON.stringify(s)).not.toMatch(/confidential|unit_price|reference_site/);
  });
});

describe("failure semantics: a failed rule is a result, an unreachable engine is not", () => {
  it("a collection cut short fails the completeness rule, is blocked, and the snapshot is still served", async () => {
    const dir = copyOfRecordings();
    rewrite(dir, (step) => {
      if (/collection_manifest ORDER BY/.test(step.statement)) {
        const i = step.columns.indexOf("retrieved_total");
        step.rawRows.find((r) => r[0] === "sk_registry.pubmed_articles")![i] = "39";
      }
      if (/^RUN DQ collection_complete/.test(step.statement)) step.rawRows = [["collection_complete", "collection_manifest", "Custom Data Quality", "7", "6", "1"]];
    });
    const s = await new UslService(config(dir)).snapshot();
    expect(s.completeness.verdict).toBe("FAILED");
    expect(s.completeness.blocked).toEqual(["sk_registry.pubmed_articles"]);
    expect(s.completeness.collections.find((c) => c.collectionId === "sk_registry.pubmed_articles")).toMatchObject({ status: "TRUNCATED", expectedTotal: 110, retrievedTotal: 39 });
    expect(s.dqRules.find((r) => r.rule === "collection_complete")).toMatchObject({ verdict: "FAILED", failures: 1, rowsChecked: 7 });
    expect(s.completeness.complete).not.toContain("sk_registry.pubmed_articles");
  });

  it("an engine that reports no failure for a manifest that is plainly short is DRIFTED, not trusted", async () => {
    const dir = copyOfRecordings();
    rewrite(dir, (step) => {
      if (/collection_manifest ORDER BY/.test(step.statement)) step.rawRows.find((r) => r[0] === "sk_registry.pubmed_articles")![step.columns.indexOf("retrieved_total")] = "39";
    });
    await expect(new UslService(config(dir)).snapshot()).rejects.toMatchObject({ failure: "DRIFTED", detail: { reason: "RULE_DISAGREEMENT" } });
  });

  it("an engine that cannot be asked is UNAVAILABLE and carries no verdict", async () => {
    const down = new UslService(config(real.federationCassettes), {
      port: {
        async sql() {
          throw new PortError("UNAVAILABLE", "Zetaris is not reachable: ECONNREFUSED", { reason: "CONNECTION_REFUSED" });
        },
      },
    });
    const e = await down.snapshot().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PortError);
    expect(e).toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("a layer that was never set up is UNAVAILABLE with the reason, not a raw engine message", async () => {
    const notThere = new UslService(config(real.federationCassettes), {
      port: {
        async sql() {
          throw new PortError("INVALID", "lightning.metastore.sakaime.review_semantics is not defined");
        },
      },
    });
    await expect(notThere.snapshot()).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "LAYER_NOT_PROVISIONED" } });
  });

  it("with nothing recorded and no engine configured it says so and never answers empty", async () => {
    const empty = mkdtempSync(join(tmpdir(), "usl-none-"));
    const off = new UslService(config(empty));
    expect(off.mode).toBe("off");
    await expect(off.snapshot()).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "USL_OFF" } });
    const live = new UslService({ ...config(empty), sample: false });
    expect(live.mode).toBe("off");
    await expect(live.snapshot()).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("an identity without the USL assignment gets FORBIDDEN, which is not an outage", async () => {
    const forbidden = new UslService(config(real.federationCassettes), {
      port: {
        async sql() {
          throw new PortError("FORBIDDEN", "User does not have access to USL");
        },
      },
    });
    await expect(forbidden.snapshot()).rejects.toMatchObject({ failure: "FORBIDDEN" });
  });
});

describe("the committed recordings", () => {
  it("are intact, name their layer and were read as the read-only identity", () => {
    const names = readdirSync(real.federationCassettes).filter((n) => /^usl-.*\.json$/.test(n));
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of names) {
      const f = verifyUslCassette(join(real.federationCassettes, n));
      expect(f.readerIdentity).toBe("agent-reader");
      expect(f.layer).toBe("lightning.metastore.sakaime.review_semantics");
      expect(f.structureHash).toBe(uslSpec().structureHash);
    }
  });
});
