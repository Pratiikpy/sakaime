import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, METRIC_TABLE } from "../../src/compiler/taxonomy.ts";
import { parseRunDq } from "../../src/federation/dq.ts";
import type { FederationQueryOptionsEx } from "../../src/federation/result.ts";
import { prepareStatement } from "../../src/federation/sql.ts";
import {
  activateStatement,
  buildSemanticLayer,
  compileStatement,
  ensureUsl,
  manifestCsv,
  queryUsl,
  readCaseDefinitions,
  requireComplete,
  runCompletenessRule,
  runRule,
  type SemanticLayerSpec,
  type UslAdmin,
  type UslSqlPort,
} from "../../src/federation/usl.ts";
import { UslCassettePort, UslRecorder, verifyUslCassette, writeUslCassette } from "../../src/federation/usl-cassette.ts";
import { answerThroughUsl, compareAnswers, median, type Answer } from "../../src/federation/usl-measure.ts";
import { PortError, type FederationResult } from "../../src/ports/index.ts";
import { rawResultHash, type RawFederationPort, type RawFederationResult } from "../../src/federation/result.ts";

const spec = buildSemanticLayer({ settings: DEFAULT_SETTING_TAXONOMY, purposes: DEFAULT_PURPOSE_TAXONOMY, metrics: METRIC_TABLE });

function result(columns: string[], rows: unknown[][], over: Partial<FederationResult> = {}): FederationResult {
  return {
    columns: columns.map((name) => ({ name, type: "string" })),
    rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    total: rows.length,
    queryId: `q-${Math.random().toString(16).slice(2, 10)}`,
    servedFrom: "live",
    respHash: "0".repeat(64),
    elapsedMs: 1,
    ...over,
  };
}

// ---------------------------------------------------------------- a test double of the engine's USL commands

/** TEST DOUBLE. Models only the USL commands ensureUsl sends: enough state to show what a second run does. */
class FakeEngine implements UslSqlPort {
  readonly sent: string[] = [];
  uslId = 0;
  private nextId = 100;
  usl: { description?: string; tables: Map<string, { description?: string; columns: Map<string, string | undefined>; activate?: string; rules: Map<string, string> }> } | undefined;
  granted = false;

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<FederationResult> {
    const text = prepareStatement(statement).text;
    this.sent.push(text);
    if (options.statementPolicy !== "admin") throw new PortError("REFUSED", "the double only serves the admin policy");
    if (text.startsWith("CREATE NAMESPACE")) return result(["ok"], [["true"]]);
    if (text.startsWith("SHOW NAMESPACES OR TABLES IN lightning.metastore.sakaime.review_semantics")) {
      return result(["name", "type", "usl_id", "count", "activated"], [...(this.usl?.tables ?? [])].map(([n, t]) => [n, "table", null, "0", String(t.activate !== undefined)]));
    }
    if (text.startsWith("SHOW NAMESPACES OR TABLES IN")) return result(["name", "type", "usl_id"], this.usl ? [["review_semantics", "usl", String(this.uslId)]] : []);
    if (text.startsWith("COMPILE USL")) {
      const tables = new Map<string, { description?: string; columns: Map<string, string | undefined>; activate?: string; rules: Map<string, string> }>();
      let current: Map<string, string | undefined> | undefined;
      for (const line of text.split("\n").slice(1)) {
        const t = /^CREATE TABLE (\w+) \(/.exec(line);
        if (t) {
          current = new Map();
          tables.set(t[1]!, { columns: current, rules: new Map() });
        } else if (current && /^\s+\w+ /.test(line)) current.set(line.trim().split(" ")[0]!, undefined);
      }
      this.usl = { tables };
      this.uslId = this.nextId++;
      return result(["json"], [["{}"]]);
    }
    if (text.startsWith("REMOVE USL")) {
      this.usl = undefined;
      return result(["removed"], [["true"]]);
    }
    if (text.startsWith("LOAD USL")) {
      if (!this.usl) throw new PortError("INVALID", "not found");
      const model = {
        description: this.usl.description,
        tables: [...this.usl.tables].map(([name, t]) => ({
          name,
          description: t.description,
          activateQuery: t.activate,
          columnSpecs: [...t.columns].map(([n, d]) => ({ name: n, description: d })),
          dqAnnotations: [...t.rules].map(([n, e]) => ({ name: n, expression: e })),
        })),
      };
      return result(["json"], [[JSON.stringify(model)]]);
    }
    let m: RegExpExecArray | null;
    if ((m = /^UPDATE USL \S+\.review_semantics\.(\w+)\.(\w+) SET COLUMN DESCRIPTION (.+)$/.exec(text))) {
      this.usl!.tables.get(m[1]!)!.columns.set(m[2]!, m[3]!);
      return result(["updated"], [["true"]]);
    }
    if ((m = /^UPDATE USL \S+\.review_semantics\.(\w+) SET TABLE DESCRIPTION (.+)$/.exec(text))) {
      this.usl!.tables.get(m[1]!)!.description = m[2]!;
      return result(["updated"], [["true"]]);
    }
    if ((m = /^UPDATE USL \S+\.review_semantics SET DESCRIPTION (.+)$/.exec(text))) {
      this.usl!.description = m[1]!;
      return result(["updated"], [["true"]]);
    }
    if ((m = /^ACTIVATE USL TABLE \S+\.review_semantics\.(\w+) AS (.+)$/.exec(text))) {
      this.usl!.tables.get(m[1]!)!.activate = m[2]!;
      return result(["registered"], [["{}"]]);
    }
    if ((m = /^REGISTER DQ (\w+) TABLE \S+\.review_semantics\.(\w+) AS (.+)$/.exec(text))) {
      this.usl!.tables.get(m[2]!)!.rules.set(m[1]!, m[3]!);
      return result(["json"], [["{}"]]);
    }
    if ((m = /^UPDATE DQ (\w+) TABLE \S+\.review_semantics\.(\w+) SET NAME = \w+, EXPRESSION = (.+)$/.exec(text))) {
      this.usl!.tables.get(m[2]!)!.rules.set(m[1]!, m[3]!);
      return result(["json"], [["{}"]]);
    }
    if (text.startsWith("GRANT SELECT ON USL NAMESPACE")) {
      if (this.granted) throw new PortError("INVALID", "the privilege has already been granted");
      this.granted = true;
      return result(["ok"], [["true"]]);
    }
    throw new PortError("INVALID", `the double does not know: ${text.slice(0, 80)}`);
  }
}

function adminOver(engine: FakeEngine): UslAdmin & { assigned: { id: number; roles: readonly string[] }[] } {
  const assigned: { id: number; roles: readonly string[] }[] = [];
  return { port: engine, assigned, async assignUslToRoles(id, roles) { assigned.push({ id, roles }); } };
}

// ---------------------------------------------------------------- the specification

describe("the specification", () => {
  it("is deterministic and carries every silo through to a business name", () => {
    const again = buildSemanticLayer({ settings: DEFAULT_SETTING_TAXONOMY, purposes: DEFAULT_PURPOSE_TAXONOMY, metrics: METRIC_TABLE });
    expect(again.structureHash).toBe(spec.structureHash);
    expect(spec.tables.map((t) => t.name)).toEqual(["device_authorization", "device_version_record", "registered_study", "vendor_claim", "review_case", "hospital_requirement", "confirmed_evidence_link", "case_evidence_matrix", "collection_manifest", "term_definition"]);
    const names = spec.tables.flatMap((t) => t.columns.map((c) => c.name));
    for (const wanted of ["study_enrolled", "study_enrolled_age_min_years", "claimed_age_min_years", "intended_age_min_years", "authorized_on", "listed_version"]) expect(names).toContain(wanted);
  });

  it("puts a table before every table that references it, as the engine requires", () => {
    const seen = new Set<string>();
    for (const t of spec.tables) {
      for (const c of t.columns) if (c.references) expect(seen.has(c.references.table), `${t.name}.${c.name}`).toBe(true);
      seen.add(t.name);
    }
  });

  it("compiles in one request and every activation is one statement the port accepts", () => {
    const compile = prepareStatement(compileStatement(spec));
    expect(compile.multiDdl).toBe(true);
    expect(compile.text.match(/^CREATE TABLE /gm)).toHaveLength(spec.tables.length);
    for (const t of spec.tables) {
      const p = prepareStatement(activateStatement(spec, t));
      expect(p.words.slice(0, 3)).toEqual(["ACTIVATE", "USL", "TABLE"]);
      expect(t.activation).not.toMatch(/\bWHERE\b.*\bLIMIT\b/);
    }
  });

  it("leaves the commercial columns of the packet export out of the layer", () => {
    const all = JSON.stringify(spec.tables);
    expect(all).not.toMatch(/confidential/);
  });

  it("publishes the compiler's own words, and nothing for 'adult' but a warning that it has no number", () => {
    const row = (kind: string, term: string) => spec.terms.find((t) => t.kind === kind && t.term === term)!;
    expect(row("setting", "emergency_department").ancestry).toEqual(["any_care_setting", "hospital", "emergency_department"]);
    expect(row("setting", "er").canonical).toBe("emergency_department");
    expect(row("metric", "recall").canonical).toBe("sensitivity");
    expect(row("metric", "sensitivity")).toMatchObject({ unit: "proportion", valueMin: 0, valueMax: 1 });
    expect(row("metric", "ppv").prevalenceDependent).toBe(true);
    expect(row("population", "adult")).toMatchObject({ unit: "years", valueMin: null });
    expect(row("population", "adult").definition).toMatch(/not an age/);
  });

  it("states each rule once, including the completeness gate and a proportion bound", () => {
    expect(spec.rules.map((r) => r.rule)).toEqual(["collection_complete", "study_has_eligibility", "version_is_listed", "claimed_age_plausible", "claim_cites_authorization", "case_vocabulary_defined", "metric_proportion_bounds"]);
    expect(spec.rules[0]!.expression.sql).toBe("expected_total IS NOT NULL AND retrieved_total IS NOT NULL AND retrieved_total >= expected_total AND truncated = FALSE");
  });

  it("refuses a description the engine would take as something else", () => {
    expect(() => buildSemanticLayer({ settings: DEFAULT_SETTING_TAXONOMY, purposes: DEFAULT_PURPOSE_TAXONOMY, metrics: METRIC_TABLE }, [{ database: "a b", table: "x" }])).toThrow();
  });
});

// ---------------------------------------------------------------- ensureUsl

describe("ensureUsl", () => {
  it("builds the layer on a clean engine, then changes nothing on a second run", async () => {
    const engine = new FakeEngine();
    const admin = adminOver(engine);
    const first = await ensureUsl(admin, spec);
    expect(first.rebuilt).toBe(false);
    const steps = (s: string) => first.actions.filter((a) => a.step === s).length;
    expect(steps("compile")).toBe(1);
    expect(steps("activate")).toBe(spec.tables.length);
    expect(steps("register-rule")).toBe(spec.rules.length);
    expect(steps("describe-table")).toBe(spec.tables.length);
    expect(steps("describe-column")).toBe(spec.tables.reduce((n, t) => n + t.columns.length, 0));
    expect(engine.sent.filter((s) => s.startsWith("COMPILE USL"))).toHaveLength(1);

    const sentBefore = engine.sent.length;
    const second = await ensureUsl(admin, spec);
    expect(second.actions).toEqual([]);
    const writes = engine.sent.slice(sentBefore).filter((s) => /^(COMPILE|ACTIVATE|REGISTER|UPDATE|REMOVE)/.test(s));
    expect(writes).toEqual([]);
    // The REST assignment is repeated on every run and covers the default roles.
    expect(admin.assigned).toHaveLength(2);
    expect(admin.assigned[1]!.roles).toEqual(["agent_readonly", "case_reviewer_assigned", "case_reviewer_unassigned"]);
  });

  it("repairs exactly what drifted: one description, one activation, one rule", async () => {
    const engine = new FakeEngine();
    const admin = adminOver(engine);
    await ensureUsl(admin, spec);
    engine.usl!.tables.get("vendor_claim")!.columns.set("claim_id", "something else");
    engine.usl!.tables.get("registered_study")!.activate = "SELECT 1";
    engine.usl!.tables.get("registered_study")!.rules.set("study_has_eligibility", "true");
    engine.usl!.tables.get("review_case")!.rules.delete("case_vocabulary_defined");
    const r = await ensureUsl(admin, spec);
    expect(r.actions.map((a) => `${a.step} ${a.target.split(".").slice(-1)[0]}`).sort()).toEqual(
      ["activate registered_study", "describe-column claim_id", "register-rule case_vocabulary_defined on review_case", "update-rule study_has_eligibility on registered_study"].sort(),
    );
  });

  it("rebuilds when the structure changed, and assigns the new instance id to the roles", async () => {
    const engine = new FakeEngine();
    const admin = adminOver(engine);
    await ensureUsl(admin, spec);
    const oldId = engine.uslId;
    engine.usl!.description = "sakaime_structure_0000000000000000";
    const r = await ensureUsl(admin, spec);
    expect(r.rebuilt).toBe(true);
    expect(r.actions[0]!.step).toBe("rebuild");
    expect(engine.uslId).not.toBe(oldId);
    expect(admin.assigned.at(-1)!.id).toBe(engine.uslId);
  });

  it("does not fail when a grant was already made", async () => {
    const engine = new FakeEngine();
    engine.granted = true;
    await expect(ensureUsl(adminOver(engine), spec)).resolves.toBeDefined();
  });

  it("is DRIFTED, not success, when a table is still not activated afterwards", async () => {
    const engine = new FakeEngine();
    const admin = adminOver(engine);
    const real = engine.sql.bind(engine);
    engine.sql = async (s, o) => {
      if (s.startsWith("ACTIVATE USL TABLE") && s.includes(".case_evidence_matrix ")) return result(["registered"], [["{}"]]);
      return real(s, o);
    };
    await expect(ensureUsl(admin, spec)).rejects.toMatchObject({ failure: "DRIFTED" });
  });
});

// ---------------------------------------------------------------- reading

/** TEST DOUBLE: answers by pattern with the rows a test chooses. */
function reader(answers: { match: RegExp; answer: () => FederationResult | Error }[]): UslSqlPort & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async sql(statement: string) {
      const text = prepareStatement(statement).text;
      sent.push(text);
      const hit = answers.find((a) => a.match.test(text));
      if (!hit) throw new PortError("INVALID", `no answer for ${text.slice(0, 60)}`);
      const a = hit.answer();
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const DQ_HEADERS = ["name", "table", "type", "total_record", "valid_record", "invalid_record"];
const dqRow = (rule: string, table: string, total: number, invalid: number) => [rule, table, "Custom Data Quality", String(total), String(total - invalid), String(invalid)];

describe("RUN DQ output", () => {
  it("is read from the headers the live engine uses (singular) as well as the documented plural", () => {
    expect(parseRunDq(result(DQ_HEADERS, [dqRow("r", "t", 7, 2)]))).toEqual([{ rule: "r", total: 7, valid: 5, invalid: 2 }]);
  });
});

describe("a single rule", () => {
  const rule = spec.rules.find((r) => r.rule === "study_has_eligibility")!;
  it("FAILED is a result with counts, not an error", async () => {
    const r = reader([{ match: /^RUN DQ study_has_eligibility/, answer: () => result(DQ_HEADERS, [dqRow(rule.rule, rule.table, 157, 143)], { queryId: "q-77" }) }]);
    expect(await runRule(r, rule)).toMatchObject({ rule: "study_has_eligibility", table: "registered_study", rowsChecked: 157, failures: 143, verdict: "FAILED", queryId: "q-77" });
  });
  it("PASSED needs rows to judge; an empty table is UNVERIFIABLE, never passed", async () => {
    const some = reader([{ match: /RUN DQ/, answer: () => result(DQ_HEADERS, [dqRow(rule.rule, rule.table, 3, 0)]) }]);
    expect((await runRule(some, rule)).verdict).toBe("PASSED");
    const none = reader([{ match: /RUN DQ/, answer: () => result(DQ_HEADERS, [dqRow(rule.rule, rule.table, 0, 0)]) }]);
    expect((await runRule(none, rule)).verdict).toBe("UNVERIFIABLE");
  });
  it("arithmetic that does not add up is DRIFTED", async () => {
    const r = reader([{ match: /RUN DQ/, answer: () => result(DQ_HEADERS, [[rule.rule, rule.table, "x", "10", "3", "3"]]) }]);
    await expect(runRule(r, rule)).rejects.toMatchObject({ failure: "DRIFTED" });
  });
});

// ---------------------------------------------------------------- the completeness gate and its failure semantics

const MANIFEST_COLS = ["collection_id", "source_id", "expected_total", "retrieved_total", "truncated"];
function gateReader(manifest: (string | boolean | number | null)[][], dq: { total: number; invalid: number } | Error) {
  return reader([
    { match: /^RUN DQ collection_complete/, answer: () => (dq instanceof Error ? dq : result(DQ_HEADERS, [dqRow("collection_complete", "collection_manifest", dq.total, dq.invalid)], { queryId: "q-gate" })) },
    { match: /collection_manifest ORDER BY/, answer: () => result(MANIFEST_COLS, manifest) },
  ]);
}
const full: (string | boolean | number | null)[][] = [
  ["sk_registry.ctgov_studies", "registry", 157, 157, false],
  ["sk_registry.pubmed_articles", "registry", 110, 110, false],
];

describe("the completeness gate", () => {
  it("passes when every collection is whole, and lists them as free to feed evidence", async () => {
    const r = await runCompletenessRule(gateReader(full, { total: 2, invalid: 0 }), spec);
    expect(r).toMatchObject({ verdict: "PASSED", failures: 0, rowsChecked: 2, blocked: [], codeCheckAgrees: true, queryId: "q-gate" });
    expect(r.complete).toEqual(["sk_registry.ctgov_studies", "sk_registry.pubmed_articles"]);
    expect(() => requireComplete(r, ["sk_registry.ctgov_studies"])).not.toThrow();
  });

  it("a short collection fails the rule in both forms and is blocked", async () => {
    const short = [full[0]!, ["sk_registry.pubmed_articles", "registry", 110, 39, false]];
    const r = await runCompletenessRule(gateReader(short, { total: 2, invalid: 1 }), spec);
    expect(r).toMatchObject({ verdict: "FAILED", failures: 1, blocked: ["sk_registry.pubmed_articles"], codeCheckAgrees: true });
    expect(r.collections[1]).toMatchObject({ status: "TRUNCATED", reason: "39 of 110 records arrived" });
    const refused = (() => {
      try {
        requireComplete(r, ["sk_registry.pubmed_articles"]);
      } catch (e) {
        return e as PortError;
      }
    })();
    expect(refused).toMatchObject({ failure: "TRUNCATED" });
    expect(refused!.message).toMatch(/feed nothing downstream/);
  });

  it("a collection of unknown size, an uncountable one and a connector that stopped early are all blocked", async () => {
    const rows = [
      ["a", "s", null, 10, false],
      ["b", "s", 10, null, false],
      ["c", "s", 10, 10, true],
      ["d", "s", 10, 10, null],
      ["e", "s", 10, 12, false],
    ];
    const r = await runCompletenessRule(gateReader(rows, { total: 5, invalid: 4 }), spec);
    expect(r.blocked).toEqual(["a", "b", "c", "d"]);
    expect(r.complete).toEqual(["e"]);
    expect(Object.fromEntries(r.collections.map((c) => [c.collectionId, c.status]))).toEqual({ a: "UNVERIFIABLE", b: "UNVERIFIABLE", c: "TRUNCATED", d: "UNVERIFIABLE", e: "COMPLETE" });
  });

  it("an engine and a code check that disagree are DRIFTED, never one of them silently trusted", async () => {
    const short = [["x", "s", 10, 4, false]];
    await expect(runCompletenessRule(gateReader(short, { total: 1, invalid: 0 }), spec)).rejects.toMatchObject({ failure: "DRIFTED", detail: { reason: "RULE_DISAGREEMENT" } });
  });

  it("an engine that cannot be asked is UNAVAILABLE, not a failed rule and not a passed one", async () => {
    const down = new PortError("UNAVAILABLE", "Zetaris is not reachable: ECONNREFUSED", { reason: "CONNECTION_REFUSED" });
    await expect(runCompletenessRule(gateReader(full, down), spec)).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("a failed rule never throws UNAVAILABLE and an outage never returns a verdict", async () => {
    const failed = await runCompletenessRule(gateReader([["x", "s", 10, 4, false]], { total: 1, invalid: 1 }), spec);
    expect(failed.verdict).toBe("FAILED");
    const outcomes = await Promise.allSettled([runCompletenessRule(gateReader(full, new PortError("UNAVAILABLE", "down")), spec)]);
    expect(outcomes[0]!.status).toBe("rejected");
  });
});

describe("queryUsl and case definitions", () => {
  it("builds the statement from checked names and puts values through the value helpers", async () => {
    const r = reader([{ match: /./, answer: () => result(["case_id"], [["CASE-1"]]) }]);
    await queryUsl(r, spec, { table: "review_case", columns: ["case_id"], where: { case_id: "it's", intended_age_min_years: 18 }, orderBy: ["case_id"] });
    expect(r.sent[0]).toBe("SELECT case_id FROM lightning.metastore.sakaime.review_semantics.review_case WHERE case_id = ('it' || chr(39) || 's') AND intended_age_min_years = 18 ORDER BY case_id");
  });
  it("a name that is not in the specification is INVALID, not an empty answer", async () => {
    const r = reader([]);
    await expect(queryUsl(r, spec, { table: "no_such" })).rejects.toMatchObject({ failure: "INVALID" });
    await expect(queryUsl(r, spec, { table: "review_case", where: { nope: 1 } })).rejects.toMatchObject({ failure: "INVALID" });
    expect(r.sent).toEqual([]);
  });
  it("an unknown case is a typed not-found, and a word the layer does not define is reported", async () => {
    const none = reader([{ match: /FROM .*review_case WHERE case_id/, answer: () => result(["case_id"], []) }]);
    await expect(readCaseDefinitions(none, "CASE-NOPE")).rejects.toMatchObject({ failure: "INVALID", detail: { reason: "UNKNOWN_CASE" } });
    const known = reader([
      { match: /^SELECT case_id, product_name/, answer: () => result(["case_id", "product_name", "intended_setting", "intended_purpose", "intended_age_min_years"], [["C", "P", "mars_base", "detection_aid", "18"]]) },
      { match: /^SELECT d\.kind/, answer: () => result(["kind", "term", "canonical_term", "is_alias", "label", "broader_term", "ancestry", "depth", "definition", "unit", "value_min", "value_max", "prevalence_dependent", "origin"], [["purpose", "detection_aid", "detection_aid", false, "detection aid", "diagnosis", "diagnosis|detection_aid", 1, "d", null, null, null, null, "t@1"]]) },
    ]);
    const c = await readCaseDefinitions(known, "C", ["sensitivity"]);
    expect(c.unresolved).toEqual([
      { kind: "setting", term: "mars_base" },
      { kind: "metric", term: "sensitivity" },
    ]);
  });
});

// ---------------------------------------------------------------- recordings

function rawOf(statement: string, rows: (string | null)[][], columns: string[]): RawFederationResult {
  return { columns, rawRows: rows, total: rows.length, queryId: "q-raw", elapsedMs: 5, statement, identity: "default" };
}

describe("recordings of the layer", () => {
  const live: RawFederationPort = {
    mode: "live",
    async sqlRaw(statement: string) {
      return rawOf(prepareStatement(statement).text, [["1"]], ["one"]);
    },
    toResult: (raw) => result(raw.columns, raw.rawRows, { queryId: raw.queryId }),
    async sql(statement: string) {
      return result(["one"], [["1"]]);
    },
    async check() {
      return { health: "OK", detail: "", latencyMs: 0, checkedAt: new Date().toISOString() };
    },
  };

  it("round-trips, labels the replay as a cassette and refuses a statement it never recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usl-cassette-"));
    const rec = new UslRecorder(live, "agent-reader");
    await rec.sql("SELECT 1 AS one");
    const path = writeUslCassette(dir, { scope: "overview", recordedAt: "2026-10-27T10:00:00.000Z", readerIdentity: "agent-reader", layer: "lightning.metastore.sakaime.review_semantics", structureHash: "a".repeat(64), steps: rec.drain() });
    expect(verifyUslCassette(path).steps).toHaveLength(1);
    const port = new UslCassettePort(dir);
    const r = await port.sql("SELECT   1 AS one;");
    expect(r).toMatchObject({ servedFrom: "cassette", recordedAt: "2026-10-27T10:00:00.000Z", queryId: "q-raw" });
    await expect(port.sql("SELECT 2 AS two")).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "CASSETTE_MISS" } });
    await expect(port.sql("SELECT 1 AS one", { statementPolicy: "admin", identity: "someone-else" })).rejects.toMatchObject({ detail: { reason: "CASSETTE_MISS" } });
  });

  it("refuses an edited, truncated or renamed file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usl-cassette-"));
    const rec = new UslRecorder(live, "agent-reader");
    await rec.sql("SELECT 1 AS one");
    const path = writeUslCassette(dir, { scope: "overview", recordedAt: "2026-10-27T10:00:00.000Z", readerIdentity: "agent-reader", layer: "l", structureHash: "a".repeat(64), steps: rec.drain() });
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.replace('"1"', '"2"'));
    expect(() => verifyUslCassette(path)).toThrow(/integrity/);
    writeFileSync(path, good.slice(0, good.length - 40));
    expect(() => verifyUslCassette(path)).toThrow(/integrity/);
    writeFileSync(path, good.replace('"overview"', '"case:X"'));
    expect(() => verifyUslCassette(path)).toThrow(/integrity/);
    writeFileSync(path, good);
    expect(rawResultHash(["one"], [["1"]])).toBe(verifyUslCassette(path).steps[0]!.respHash);
  });

  it("an empty directory is not available, and says nothing is recorded", () => {
    expect(new UslCassettePort(mkdtempSync(join(tmpdir(), "usl-empty-"))).available).toBe(false);
  });
});

// ---------------------------------------------------------------- the manifest and the measurement helpers

describe("manifestCsv", () => {
  it("writes an unknown total as an empty field, which the rule then refuses", () => {
    const csv = manifestCsv([
      { database: "sk_registry", table: "a", sourceId: "s", expectedTotal: 5, truncated: false, landedSha256: "ab" },
      { database: "sk_registry", table: "b", sourceId: "s,t", expectedTotal: null, truncated: true, landedSha256: "cd" },
    ]);
    expect(csv).toBe('database_name,table_name,source_id,expected_total,truncated,landed_sha256\nsk_registry,a,s,5,false,ab\nsk_registry,b,"s,t",,true,cd\n');
  });
});

describe("comparing answers", () => {
  const row = { case_id: "C", claim_id: "K1", product_name: "P", authorization_id: "K1", listed_versions: "1|2", claimed_version: "1", claimed_age_min_years: 22, intended_age_min_years: 18, confirmed_studies: 1, study_enrolled_age_min_years: 22, version_listed: "LISTED", claim_age_vs_study: "WITHIN_STUDY", case_age_vs_study: "NOT_COVERED_BY_STUDY" };
  const a: Answer = { statements: 7, rows: [row] };
  it("equal answers are equal; a changed cell, a missing row and an extra row are each found", () => {
    expect(compareAnswers(a, { statements: 1, rows: [{ ...row }] }).equal).toBe(true);
    expect(compareAnswers(a, { statements: 1, rows: [{ ...row, version_listed: "NOT_LISTED" }] }).problems[0]).toMatch(/version_listed/);
    expect(compareAnswers(a, { statements: 1, rows: [] }).problems).toEqual(["missing C|K1"]);
    expect(compareAnswers(a, { statements: 1, rows: [row, { ...row, claim_id: "K2" }] }).problems).toEqual(["unexpected C|K2"]);
  });
  it("median is the middle value, and the mean of the middle two for an even count", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow();
  });
  it("answerThroughUsl is one statement", async () => {
    const r = reader([{ match: /case_evidence_matrix ORDER BY matrix_key/, answer: () => result(Object.keys(row), [Object.values(row)]) }]);
    const out = await answerThroughUsl(r, spec);
    expect(out.statements).toBe(1);
    expect(out.rows).toEqual([row]);
  });
});
