import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaimSchema } from "../../src/schemas/index.ts";
import { PortError, type ModelPort, type ModelRequest, type ModelResponse } from "../../src/ports/index.ts";
import { ageLowerBounds, b1, b2, runChecks } from "../../evals/lib/baselines.ts";
import { CachedModel, parseAnswer, runB4, searchPassages, toOutput } from "../../evals/lib/model-arms.ts";
import { ADAPTER_HASH, adaptClaim, pickPurpose, splitPurposeTerms, V_FULL } from "../../evals/lib/pipeline.ts";
import { mapClaimPurpose, mapClaimSettings, VOCABULARY_HASH } from "../../evals/lib/vocabulary.ts";
import type { Doc } from "../../evals/lib/documents.ts";
import type { EvalCase } from "../../evals/lib/types.ts";

const mkCase = (use: Record<string, unknown>, extra: Partial<EvalCase> = {}): EvalCase => ({
  id: "T-1",
  cluster: "t",
  product: "device:fda:K000001",
  kind: "mismatch",
  partition: "development",
  text: "t",
  claim: ClaimSchema.parse({ id: "T-1", use }),
  key: { expectedLabel: "INSUFFICIENT_EVIDENCE", acceptableLabels: [], keyConfidence: "clear", mismatches: [] },
  ...extra,
});
const doc = (id: string, text: string, kind: Doc["kind"] = "fda-summary"): Doc => ({ id, kind, label: id, text, origin: "test" });

describe("vocabulary and adapter", () => {
  it("maps the key's own purpose and setting strings and passes unknown terms through untouched", () => {
    expect(mapClaimPurpose("dr_screening_detection")).toBe("detection_aid");
    expect(mapClaimPurpose("autonomous_reading")).toBe("autonomous_reading");
    expect(mapClaimSettings(["primary_care", "endoscopy_unit"])).toEqual(["primary_care", "endoscopy_unit"]);
    expect(mapClaimPurpose(undefined)).toBeUndefined();
  });

  it("the extractor's joined purpose string is split back along the controlled list and the broadest node wins", () => {
    expect(splitPurposeTerms("triage_notification_detection")).toEqual(expect.arrayContaining(["triage", "notification", "detection"]));
    expect(pickPurpose(["triage", "detection"])).toBe("detection_aid");
    expect(pickPurpose(["triage"])).toBe("triage_notification");
    expect(pickPurpose(["screening", "detection"])).toBe("detection_aid");
    expect(pickPurpose([])).toBeUndefined();
  });

  it("requires exactly the dimensions the claim states", () => {
    const a = adaptClaim(mkCase({ product: "device:fda:K1", versions: ["1.0"], settings: ["hospital"], purpose: "triage_notification", population: { age: { min: 18 } }, timing: { from: "2026-01-01" } }), V_FULL);
    expect(a.required.sort()).toEqual(["population", "product", "purpose", "setting", "timing", "version"]);
    const b = adaptClaim(mkCase({ product: "device:fda:K1", purpose: "detection_aid" }), V_FULL);
    expect(b.required.sort()).toEqual(["product", "purpose"]);
  });

  it("claims without a number still declare authorization and study as required", () => {
    expect(adaptClaim(mkCase({ product: "device:fda:K1" }), V_FULL).claim.dependencies?.required).toEqual(["authorization", "study"]);
    expect(adaptClaim(mkCase({ product: "device:fda:K1" }), { ...V_FULL, dependencies: "default" }).claim.dependencies).toBeUndefined();
  });

  it("the conditions switch drops conditions and keeps age", () => {
    const a = adaptClaim(mkCase({ product: "device:fda:K1", population: { age: { min: 18 }, conditions: ["x"] } }), { ...V_FULL, conditions: "ignore" });
    expect(a.claim.use.population).toEqual({ age: { min: 18 } });
  });

  it("the adapter and vocabulary are hashed", () => {
    expect(ADAPTER_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(VOCABULARY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("B1 and B2 keyword baselines", () => {
  const fda = doc("fda:K1", "Device X version 2.1.0 is indicated for adults aged 22 years and older in primary care for the detection of disease. K000001");
  const pub = doc("pub:1", "A study of Device X in women aged 40 and older in eye care clinics.", "publication");

  it("reads age lower bounds", () => {
    expect(ageLowerBounds("aged 22 years and older").sort()).toContain(22);
    expect(ageLowerBounds("patients ≥ 18 years")).toContain(18);
    expect(ageLowerBounds("older than 22")).toContain(22);
    expect(ageLowerBounds("no numbers")).toEqual([]);
  });

  it("supports a claim whose every stated field has a keyword hit", () => {
    const c = mkCase({ product: "device:fda:K000001", versions: ["2.1.0"], population: { age: { min: 22 } }, settings: ["primary_care"], purpose: "detection_aid" });
    expect(b1(c, [fda, pub]).label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("says insufficient and names the field when a version string is missing, with no anchor to point at", () => {
    const c = mkCase({ product: "device:fda:K000001", versions: ["3.0.0"] });
    const o = b1(c, [fda]);
    expect(o.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(o.mismatches[0]).toMatchObject({ dimension: "version", anchored: false });
  });

  it("cannot read a negation: a purpose the text rules out is still found by keyword (the point of the baseline)", () => {
    const text = doc("fda:K1", "K000001 is not intended for monitoring response to therapy.");
    expect(b1(mkCase({ product: "device:fda:K000001", purpose: "monitoring" }), [text]).label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("B2 needs one record to satisfy every field; B1 may combine records", () => {
    const c = mkCase({ product: "device:fda:K000001", population: { age: { min: 22 } }, settings: ["eye_care"] });
    expect(b1(c, [fda, pub]).label).toBe("SUPPORTED_FOR_SCOPE");
    expect(b2(c, [fda, pub]).label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("checks a stated threshold against a figure near the metric name", () => {
    const text = doc("fda:K1", "K000001 sensitivity was 87.8% in the pivotal study");
    const ok = mkCase({ product: "device:fda:K000001" }, {});
    ok.claim = ClaimSchema.parse({ id: "T", use: { product: "device:fda:K000001" }, performance: { metric: "sensitivity", atLeast: 0.85 } });
    expect(runChecks(ok, text.text, true).find((k) => k.dimension === "metric")?.pass).toBe(true);
    ok.claim = ClaimSchema.parse({ id: "T", use: { product: "device:fda:K000001" }, performance: { metric: "sensitivity", atLeast: 0.95 } });
    expect(runChecks(ok, text.text, true).find((k) => k.dimension === "metric")?.pass).toBe(false);
  });
});

describe("model answers", () => {
  const docs = [doc("fda:K1", "The device is indicated for adults aged 22 and older. It was tested at ten sites.")];

  it("parses a good answer and rejects labels outside the five", () => {
    const good = parseAnswer('{"label":"SUPPORTED_FOR_SCOPE","mismatches":[]}');
    expect(good.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(parseAnswer('{"label":"SAFE","mismatches":[]}').label).toBeNull();
    expect(parseAnswer("I think it is fine").label).toBeNull();
    expect(parseAnswer('{"label":"cleared"}').problem).toMatch(/not one of the five/);
  });

  it("accepts an answer wrapped in reasoning or a fence", () => {
    expect(parseAnswer('<think>hmm</think>{"label":"INSUFFICIENT_EVIDENCE","mismatches":[]}').label).toBe("INSUFFICIENT_EVIDENCE");
    expect(parseAnswer('```json\n{"label":"INSUFFICIENT_EVIDENCE","mismatches":[]}\n```').label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("a quote counts as an anchor only if it exists in a record the arm was given", () => {
    const p = parseAnswer(JSON.stringify({ label: "CONTRADICTED_BY_SPECIFIED_EVIDENCE", mismatches: [{ dimension: "population", claimed: "age 12", established: "22 and older", quote: "indicated for adults aged 22 and older" }, { dimension: "setting", claimed: "x", established: "y", quote: "a sentence nobody wrote anywhere" }] }));
    const o = toOutput(p, docs);
    expect(o.mismatches.map((m) => m.anchored)).toEqual([true, false]);
  });

  it("a very short quote is not an anchor", () => {
    const p = parseAnswer(JSON.stringify({ label: "INSUFFICIENT_EVIDENCE", mismatches: [{ dimension: "version", claimed: "a", established: "b", quote: "the" }] }));
    expect(toOutput(p, docs).mismatches[0]?.anchored).toBe(false);
  });

  it("search returns passages with record and page, and says so when nothing matches", () => {
    const idx = [{ doc: docs[0] as Doc, pages: ["alpha beta gamma", "the pivotal study enrolled adults aged 22"] }];
    expect(searchPassages(idx, "pivotal adults")).toContain("[fda:K1 page 2]");
    expect(searchPassages(idx, "zzzz")).toMatch(/no passage/);
    expect(searchPassages(idx, "a")).toMatch(/no searchable words/);
  });
});

class ScriptedPort implements ModelPort {
  calls = 0;
  constructor(private readonly replies: (string | Error)[]) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const r = this.replies[Math.min(this.calls, this.replies.length - 1)] as string | Error;
    this.calls++;
    if (r instanceof Error) throw r;
    return { text: r, requestedModel: "double", routedModel: "double", provider: "recorded", usage: { measured: false }, recorded: false };
  }
}

describe("B4 tool loop with a scripted model (a test double, not a measurement)", () => {
  const docs = [doc("fda:K1", "page one\fadults aged 22 and older are indicated\fpage three")];
  const c = mkCase({ product: "device:fda:K1" });
  const dir = mkdtempSync(join(tmpdir(), "sakaime-b4-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const model = (port: ModelPort) => new CachedModel(`test-b4-${Math.random().toString(36).slice(2)}`, port, "live", dir);

  it("search, read, then answer", async () => {
    const port = new ScriptedPort(['{"action":"search","query":"adults"}', '{"action":"read","record":"fda:K1","page":2}', '{"action":"answer","label":"SUPPORTED_FOR_SCOPE","mismatches":[]}']);
    const o = await runB4(model(port), c, docs, 1);
    expect(o.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(o.steps).toBe(2);
  });

  it("a reply that is not an action is answered with a hint and the loop continues, then forced to answer at the budget", async () => {
    const port = new ScriptedPort(['{"action":"dance"}']);
    const o = await runB4(model(port), c, docs, 1);
    expect(o.label).toBeNull();
    expect(o.status).toBe("none");
    expect(port.calls).toBeGreaterThan(8);
  });

  it("a transport failure ends the case as unavailable, never as an answer", async () => {
    const o = await runB4(model(new ScriptedPort([new PortError("FORBIDDEN", "no")])), c, docs, 1);
    expect(o.status).toBe("unavailable");
    expect(o.label).toBeNull();
  });
});
