import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  JOBS,
  LINEAGE_PRODUCER,
  LineageEmitter,
  LineageEventSchema,
  NS,
  anchorsFacet,
  customFacetSchemaUrl,
  deterministicRunId,
  findingAnchorIds,
  lineageEventId,
} from "../../src/dossier/index.ts";
import type { LineageEvent } from "../../src/dossier/index.ts";
import { baseBundle, fixedClock } from "./helpers.ts";

// ajv ships CommonJS; under NodeNext the default import is the module namespace, so unwrap it.
const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as new (options: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null } };
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: unknown) => void;

const events = (): LineageEvent[] => baseBundle().body.lineage;

describe("emitter", () => {
  it("emits one START and one terminal event per run, with the OpenLineage core fields", () => {
    const e = new LineageEmitter(fixedClock);
    const run = e.start({ name: "job.a" }, { runKey: "1", inputs: [{ namespace: "ns", name: "in" }] });
    const done = run.complete({ outputs: [{ namespace: "ns", name: "out" }] });
    const all = e.events();
    expect(all.map((x) => x.eventType)).toEqual(["START", "COMPLETE"]);
    for (const ev of all) {
      expect(ev).toMatchObject({ producer: LINEAGE_PRODUCER, schemaURL: "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent", job: { namespace: "sakaime", name: "job.a" } });
      expect(ev.run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(ev.inputs).toEqual([{ namespace: "ns", name: "in" }]);
    }
    expect(all[0]?.outputs).toEqual([]);
    expect(done.outputs).toEqual([{ namespace: "ns", name: "out" }]);
  });

  it("finishing a run twice, or reusing a run key, is an error rather than an ambiguous record", () => {
    const e = new LineageEmitter(fixedClock);
    const run = e.start({ name: "j" }, { runKey: "1" });
    run.complete();
    expect(() => run.complete()).toThrow(/already finished/);
    expect(() => e.start({ name: "j" }, { runKey: "1" })).toThrow(/already used/);
  });

  it("reports runs that were started and never finished", () => {
    const e = new LineageEmitter(fixedClock);
    const run = e.start({ name: "j" }, { runKey: "1" });
    expect(e.unfinished()).toEqual([run.runId]);
    run.fail("source unavailable");
    expect(e.unfinished()).toEqual([]);
  });

  it("a failed or aborted run carries the standard errorMessage facet and no outputs", () => {
    const e = new LineageEmitter(fixedClock);
    e.start({ name: "j" }, { runKey: "1" }).fail("source unavailable", { outputs: [{ namespace: "a", name: "ignored" }] });
    e.start({ name: "j" }, { runKey: "2" }).abort("guard refused");
    const [, failed, , aborted] = e.events();
    expect(failed).toMatchObject({ eventType: "FAIL", outputs: [], run: { facets: { errorMessage: { message: "source unavailable" } } } });
    expect(aborted).toMatchObject({ eventType: "ABORT", run: { facets: { errorMessage: { message: "guard refused" } } } });
  });

  it("links a child run to its parent with the standard parent facet", () => {
    const e = new LineageEmitter(fixedClock);
    const parent = e.start({ name: "investigation" }, { runKey: "root" });
    e.start({ name: "child" }, { runKey: "c", parent: { runId: parent.runId, jobNamespace: "sakaime", jobName: "investigation" } }).complete();
    const child = e.events().find((x) => x.job.name === "child");
    expect(child?.run.facets?.parent).toMatchObject({ run: { runId: parent.runId }, job: { namespace: "sakaime", name: "investigation" } });
  });

  it("run ids depend only on the job and the run key", () => {
    expect(deterministicRunId("a")).toBe(deterministicRunId("a"));
    expect(deterministicRunId("a")).not.toBe(deterministicRunId("b"));
    const a = new LineageEmitter(fixedClock);
    a.start({ name: "j" }, { runKey: "k" }).complete();
    const b = new LineageEmitter(fixedClock);
    b.start({ name: "j" }, { runKey: "k" }).complete();
    expect(a.events()).toEqual(b.events());
  });

  it("custom facets carry the project prefix and a versioned schema URN", () => {
    const f = anchorsFacet([{ id: "a1", recordId: "r1", textHash: "0".repeat(64) }]);
    expect(f).toMatchObject({ _producer: LINEAGE_PRODUCER, _schemaURL: customFacetSchemaUrl("AnchorsDatasetFacet"), anchors: [{ anchorId: "a1", recordId: "r1", textHash: "0".repeat(64) }] });
    for (const ev of events()) {
      for (const d of [...ev.inputs, ...ev.outputs]) for (const key of Object.keys(d.facets ?? {})) expect(["version", "schema", "sakaime_anchors", "sakaime_finding"]).toContain(key);
      for (const key of Object.keys(ev.job.facets ?? {})) expect(["sql", "sakaime_ruleVersion"]).toContain(key);
      for (const key of Object.keys(ev.run.facets ?? {})) expect(["sakaime_federation", "sakaime_receipt", "parent", "errorMessage"]).toContain(key);
    }
  });
});

describe("derived lineage for a dossier", () => {
  const all = events();

  it("has a START and a COMPLETE for each source record, query, model reply, evidence item and finding", () => {
    const body = baseBundle().body;
    const expected = body.snapshots.length + body.federation.length + body.models.length + body.evidenceItems.length + body.findings.length;
    expect(all.filter((e) => e.eventType === "START")).toHaveLength(expected);
    expect(all.filter((e) => e.eventType === "COMPLETE")).toHaveLength(expected);
    expect(new Set(all.map(lineageEventId)).size).toBe(all.length);
  });

  it("carries the anchors and the rule version on the event that produced each finding", () => {
    const body = baseBundle().body;
    for (const f of body.findings) {
      const ev = all.find((e) => e.eventType === "COMPLETE" && e.job.name === JOBS.compile && e.outputs.some((o) => o.name === f.id));
      expect(ev, f.id).toBeDefined();
      expect(ev?.job.facets?.sakaime_ruleVersion).toMatchObject({ ruleVersion: f.ruleVersion, registryVersion: "registry-1" });
      const out = ev?.outputs.find((o) => o.name === f.id);
      expect(out?.facets?.sakaime_finding).toMatchObject({ label: f.label, claimId: f.claimId });
      const ids = (out?.facets?.sakaime_anchors?.anchors as { anchorId: string; textHash: string }[]).map((a) => a.anchorId);
      expect(ids).toEqual(findingAnchorIds(f));
      for (const a of out?.facets?.sakaime_anchors?.anchors as { anchorId: string; textHash: string }[]) {
        expect(a.textHash).toBe(body.anchors.find((x) => x.id === a.anchorId)?.textHash);
      }
    }
  });

  it("lets a reader walk from a finding back to the record and the source it came from", () => {
    const completes = all.filter((e) => e.eventType === "COMPLETE");
    const producerOf = (ns: string, name: string) => completes.find((e) => e.outputs.some((o) => o.namespace === ns && o.name === name));
    const f1 = producerOf(NS.finding, "f1");
    const study = f1?.inputs.find((i) => i.namespace === NS.evidence && i.name === "e-study");
    expect(study).toBeDefined();
    const extract = producerOf(NS.evidence, "e-study");
    expect(extract?.job.name).toBe(JOBS.extractEvidence);
    expect(extract?.inputs.map((i) => i.name)).toEqual(["rec-study"]);
    const read = producerOf(NS.record, "rec-study");
    expect(read?.job.name).toBe(JOBS.sourceRead);
    expect(read?.inputs).toEqual([{ namespace: NS.source, name: "src-lit" }]);
    expect(read?.outputs[0]?.facets?.version).toMatchObject({ datasetVersion: baseBundle().body.snapshots.find((s) => s.id === "rec-study")?.contentHash });
  });

  it("records, for a model call, whether it was live or recorded and whether it was receipted", () => {
    const calls = all.filter((e) => e.eventType === "COMPLETE" && e.job.name.startsWith(JOBS.modelPrefix));
    const facets = calls.map((e) => e.run.facets?.sakaime_receipt);
    expect(facets).toEqual([
      expect.objectContaining({ label: "live", receipted: true, receiptId: "rcpt-1" }),
      expect.objectContaining({ label: "recorded", receipted: false }),
    ]);
    expect(facets[1]).not.toHaveProperty("receiptId");
  });

  it("records the SQL, the result schema, the served-from label and the result hash for a federation query", () => {
    const done = all.find((e) => e.eventType === "COMPLETE" && e.job.name === JOBS.federationQuery);
    expect(done?.job.facets?.sql).toMatchObject({ query: expect.stringContaining("SELECT study_id"), dialect: "zetaris" });
    expect(done?.run.facets?.sakaime_federation).toMatchObject({ queryId: "zq-1", label: "recorded", servedFrom: "cassette", total: 1 });
    expect(done?.outputs[0]?.facets?.schema).toMatchObject({ fields: [{ name: "study_id", type: "string" }, { name: "n", type: "string" }] });
  });

  it("every event parses against the event schema", () => {
    for (const e of all) expect(LineageEventSchema.safeParse(e).success).toBe(true);
  });
});

// The OpenLineage specification files are studied in research/ (not committed). Skip, and say so, when absent.
const specPath = resolve(import.meta.dirname, "../../research/OpenLineage/spec/OpenLineage.json");
describe("conformance with the OpenLineage 2-0-2 JSON Schema", () => {
  const present = existsSync(specPath);
  if (!present) console.log(`SKIPPED: ${specPath} not present; run-event conformance was not checked on this machine`);
  it.skipIf(!present)("validates every emitted event against the published RunEvent schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(specPath, "utf8"));
    const validate = ajv.compile({ ...schema, oneOf: undefined, $ref: "#/$defs/RunEvent" });
    for (const e of events()) {
      const ok = validate(e);
      expect(ok, JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    }
  });

  it.skipIf(!present)("rejects an event the specification would reject (not a UUID run id, missing producer)", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile({ ...JSON.parse(readFileSync(specPath, "utf8")), oneOf: undefined, $ref: "#/$defs/RunEvent" });
    const good = events()[0] as LineageEvent;
    expect(validate({ ...good, run: { runId: "not-a-uuid" } })).toBe(false);
    const { producer: _p, ...noProducer } = good;
    expect(validate(noProducer)).toBe(false);
  });
});
