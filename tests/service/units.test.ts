import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { documentFromText, type CheckedAssertion } from "../../src/extraction/index.ts";
import { PortError, type Connector, type SourceCard } from "../../src/ports/index.ts";
import { Budget } from "../../src/service/budget.ts";
import { CaseSpecSchema, allClaims, loadCases } from "../../src/service/cases.ts";
import { DEFAULT_LIMITS, deterministicClock, loadConfig } from "../../src/service/config.ts";
import { criticalAssertions, readStudySettings } from "../../src/service/evidence.ts";
import { FaultInjectingConnector, FaultInjectingFederation, FaultInjectingModel, resolveTarget } from "../../src/service/faults.ts";
import { INJECTED_INSTRUCTION, applyDocumentMutation, applyRecordMutation, quarantineDocument } from "../../src/service/mutations.ts";
import { SourceReader, stepKey, type ReadStep } from "../../src/service/reader.ts";
import { assessCameraPrecedent, assessRequirement, requirementItems, type EvidenceDigest, type RequirementRow } from "../../src/service/requirements.ts";
import { CancelledError, alphaId, withTimeout } from "../../src/service/util.ts";
import { SERVICE_PURPOSES, SERVICE_SETTINGS } from "../../src/service/bridge.ts";
import { ChainFetcher } from "../../src/service/sources.ts";
import type { EvidenceRecord } from "../../src/schemas/index.ts";

const ROOT = loadConfig({ sample: true, env: { SAMPLE_MODE: "true" } }).dirs.cases;

describe("case files", () => {
  it("load, validate and keep the hospital reviewer's question first", () => {
    const cases = loadCases(ROOT);
    expect(cases.map((c) => c.spec.id)).toEqual(["eyeart-k200667", "lunit-k211733", "transpara-k221347"]);
    for (const c of cases) {
      expect(allClaims(c.spec)[0]!.id).toBe(c.spec.intended.id);
      expect(c.spec.constructedNotice).toMatch(/^CONSTRUCTED/);
    }
  });

  it("the claim sentences and intended uses agree with the constructed rows the silos hold", async () => {
    const { parse } = await import("csv-parse/sync");
    const { readFileSync } = await import("node:fs");
    const silo = (f: string) => parse(readFileSync(join(loadConfig({ sample: true }).dirs.silos, f)), { columns: true }) as Record<string, string>[];
    const claims = silo("vendor_packets/vendor_claims.csv");
    const hospital = silo("hospital/cases.csv");
    for (const { spec } of loadCases(ROOT)) {
      for (const c of spec.claims) {
        const row = claims.find((r) => r["claim_id"] === c.id)!;
        expect(row, c.id).toBeDefined();
        expect(c.text).toBe(row["claim_text"]);
        expect(c.use.versions).toEqual([row["claimed_version"]]);
        expect(c.use.population?.age?.min).toBe(Number(row["claimed_min_age_years"]));
        expect(c.use.settings!.join("|")).toBe(row["claimed_setting"]!.replace("inpatient", "inpatient_ward").replace("outpatient", "outpatient_care"));
        expect(c.use.purpose).toBe(row["claimed_purpose"]);
        expect(row["provenance"]).toBe("CONSTRUCTED");
      }
      const h = hospital.find((r) => r["case_id"] === spec.hospital.caseId)!;
      expect(spec.intended.use.population?.age?.min).toBe(Number(h["intended_min_age"]));
      expect(spec.intended.use.settings).toEqual([h["intended_setting"]]);
      expect(spec.intended.use.purpose).toBe(h["intended_purpose"]);
      expect(spec.intended.use.timing?.from).toBe(h["deployment_date"]);
    }
  });

  it("rejects junk files with a named reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "sakaime-cases-"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadCases(dir)).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "x" }));
    expect(() => loadCases(dir)).toThrow(/not a valid case/);
    expect(CaseSpecSchema.safeParse({}).success).toBe(false);
    const empty = mkdtempSync(join(tmpdir(), "sakaime-cases-"));
    expect(() => loadCases(empty)).toThrow(/no case files/);
  });
});

describe("the vocabulary bridge", () => {
  it("is versioned into the rule version and places the words the readers produce", () => {
    expect(SERVICE_SETTINGS.version).toBe("1+bridge1");
    expect(SERVICE_PURPOSES.aliases["detection"]).toBe("detection_aid");
    expect(SERVICE_PURPOSES.aliases["triage_prioritisation"]).toBe("triage_notification");
    expect(SERVICE_SETTINGS.aliases["breast_screening_clinic"]).toBe("specialty_clinic");
    expect(SERVICE_PURPOSES.nodes["screening"]).toBeDefined(); // not merged into detection by the bridge
  });
});

describe("util", () => {
  it("withTimeout reports UNAVAILABLE and does not leave a timer", async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, "probe")).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { timeout: true } });
    await expect(withTimeout(Promise.resolve(3), 1000, "probe")).resolves.toBe(3);
  });
  it("alphaId has no digits, so the number tracer cannot mistake it for a figure", () => {
    for (const x of ["a", "b", { c: 1 }, "fda-summary:K200667"]) expect(alphaId(x)).toMatch(/^[a-z]{10}$/);
    expect(alphaId("a")).toBe(alphaId("a"));
    expect(alphaId("a")).not.toBe(alphaId("b"));
  });
  it("the deterministic clock advances by a millisecond and starts where it is told", () => {
    const c = deterministicClock("2026-10-27T12:00:00.000Z");
    expect(c.now().toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(c.now().toISOString()).toBe("2026-10-27T12:00:00.001Z");
  });
  it("refuses sample and record at once", () => {
    expect(() => loadConfig({ sample: true, record: true })).toThrow(/cannot both/);
  });
});

// ---------------------------------------------------------------- the reader

function connector(id: string, behaviours: (() => unknown)[]): Connector & { calls: number } {
  const card = { id, kind: "regulator", baseUrl: "https://x.test", auth: "none", identifierFields: [], supportedPredicates: [], license: "test", dataClass: "public" } as unknown as SourceCard;
  let n = 0;
  const c = {
    card,
    calls: 0,
    describe: () => card,
    check: async () => ({ health: "OK" as const, detail: "", latencyMs: 0, checkedAt: "" }),
    discover: async () => ({ sample: [], schemaHash: "" }),
    read: async () => {
      c.calls += 1;
      const b = behaviours[Math.min(n++, behaviours.length - 1)]!;
      const out = b();
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return c as unknown as Connector & { calls: number };
}

const okRead = (n = 1) => ({ health: "OK", records: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, sourceId: "t" }) as EvidenceRecord), servedFrom: "recorded", complete: true, returned: n, notes: [], contents: new Map() });
const emptyRead = () => ({ health: "EMPTY", records: [], servedFrom: "recorded", complete: true, returned: 0, total: 0, notes: ["none found in t for this request as of 2026-10-27; this does not show that none exist"], contents: new Map() });
const step: ReadStep = { id: "s", source: "t", query: { k_number: "K000001" }, why: "test", kind: "primary" };

function reader(c: Connector, opts: { limits?: Partial<typeof DEFAULT_LIMITS>; signal?: AbortSignal; cache?: Map<string, never> } = {}) {
  const limits = { ...DEFAULT_LIMITS, callTimeoutMs: 60, ...opts.limits };
  return new SourceReader({ connectors: new Map([[c.card.id, c]]), limits, clock: deterministicClock(), budget: new Budget(limits), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.cache ? { cache: opts.cache as never } : {}) });
}

describe("SourceReader", () => {
  it("retries a transient failure once and then reports the answer", async () => {
    const c = connector("t", [() => new PortError("UNAVAILABLE", "boom"), () => okRead()]);
    const o = await reader(c).run(step);
    expect(o.status).toBe("OK");
    expect(o.attempts).toBe(2);
  });

  it("gives up after the capped retries and reports UNAVAILABLE, not EMPTY", async () => {
    const c = connector("t", [() => new PortError("UNAVAILABLE", "boom")]);
    const o = await reader(c).run(step);
    expect(o.status).toBe("UNAVAILABLE");
    expect(o.attempts).toBe(2);
    expect(o.records).toEqual([]);
  });

  it("does not retry what retrying cannot fix", async () => {
    for (const [failure, expected] of [["FORBIDDEN", "FORBIDDEN"], ["DRIFTED", "DRIFTED"], ["BLOCKED", "BLOCKED"], ["INVALID", "INVALID"]] as const) {
      const c = connector("t", [() => new PortError(failure, "no")]);
      const o = await reader(c).run({ ...step, query: { k_number: failure } });
      expect(o.status).toBe(expected);
      expect(c.calls).toBe(1);
    }
    const c = connector("t", [() => new PortError("UNAVAILABLE", "no recording", { noRecording: true })]);
    expect((await reader(c).run(step)).attempts).toBe(1);
  });

  it("keeps EMPTY apart from failure and carries the 'none found on date' wording", async () => {
    const o = await reader(connector("t", [emptyRead])).run(step);
    expect(o.status).toBe("EMPTY");
    expect(o.detail).toMatch(/none found/);
    expect(o.records).toEqual([]);
  });

  it("a step already run returns its stored outcome and sends nothing again (idempotency key)", async () => {
    const c = connector("t", [() => okRead()]);
    const r = reader(c);
    const a = await r.run(step);
    const b = await r.run(step);
    expect(c.calls).toBe(1);
    expect(b.cached).toBe(true);
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(stepKey(step)).toBe(a.idempotencyKey);
    expect(stepKey({ ...step, query: { k_number: "K000002" } })).not.toBe(a.idempotencyKey);
  });

  it("times out a call that never answers and reports it", async () => {
    const hang = connector("t", [() => new Promise(() => undefined) as never]);
    const o = await reader(hang, { limits: { callTimeoutMs: 15, maxRetries: 0 } }).run(step);
    expect(o.status).toBe("UNAVAILABLE");
    expect(o.detail).toMatch(/did not answer/);
  });

  it("a spent budget is a visible refusal, not a silent skip", async () => {
    const c = connector("t", [() => okRead()]);
    const r = reader(c, { limits: { maxSourceCalls: 1 } });
    await r.run(step);
    const o = await r.run({ ...step, query: { k_number: "K000002" } });
    expect(o.status).toBe("REFUSED");
    expect(o.detail).toMatch(/budget/);
  });

  it("an unregistered source is INVALID, and a cancelled run stops", async () => {
    const c = connector("t", [() => okRead()]);
    expect((await reader(c).run({ ...step, source: "unknown" })).status).toBe("INVALID");
    const ac = new AbortController();
    ac.abort();
    await expect(reader(c, { signal: ac.signal }).run(step)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("fault injection", () => {
  it("a switched-off connector fails the way a real one fails; an empty one returns the EMPTY shape", async () => {
    const inner = connector("t", [() => okRead()]);
    await expect(new FaultInjectingConnector(inner, "off").read({ query: {} })).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { retryable: false } });
    const empty = await new FaultInjectingConnector(inner, "empty").read({ query: {} });
    expect(empty.health).toBe("EMPTY");
    expect(empty.records).toEqual([]);
    expect(empty.notes[0]).toMatch(/does not show that none exist/);
    expect(inner.calls).toBe(0);
    expect((await new FaultInjectingConnector(inner, "off").check()).health).toBe("UNAVAILABLE");
  });

  it("the reader applies a fault to a named source only", async () => {
    const a = connector("a", [() => okRead()]);
    const b = connector("b", [() => okRead()]);
    const limits = { ...DEFAULT_LIMITS };
    const r = new SourceReader({ connectors: new Map([["a", a], ["b", b]]), limits, clock: deterministicClock(), budget: new Budget(limits), faults: { drill: "source_off", target: { sources: new Set(["a"]), label: "a" } } });
    expect((await r.run({ ...step, id: "1", source: "a" })).status).toBe("UNAVAILABLE");
    expect((await r.run({ ...step, id: "2", source: "b" })).status).toBe("OK");
  });

  it("federation: off throws UNAVAILABLE; a truncated answer is refused by the real completeness check", async () => {
    const inner = { mode: "live" as const, check: async () => ({ health: "OK" as const, detail: "", latencyMs: 0, checkedAt: "" }), sql: async () => ({ columns: [], rows: [{ a: 1 }, { a: 2 }], total: 2, queryId: "q", servedFrom: "live" as const, respHash: "h", elapsedMs: 1 }) };
    await expect(new FaultInjectingFederation(inner, "off").sql("SELECT 1")).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "ENGINE_STOPPED" } });
    await expect(new FaultInjectingFederation(inner, "truncated").sql("SELECT 1")).rejects.toMatchObject({ failure: "TRUNCATED" });
    await expect(new FaultInjectingFederation(undefined, "truncated").sql("SELECT 1")).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("model: off throws UNAVAILABLE with the role", async () => {
    await expect(new FaultInjectingModel().complete({ role: "critic" } as never)).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { role: "critic" } });
  });

  it("targets resolve from evidence types, source ids and families, and nothing else", () => {
    expect([...resolveTarget("study", []).sources].sort()).toEqual(["clinicaltrials-v2", "crossref", "europepmc", "fda-accessdata-pdf", "pubmed-eutils"]);
    expect([...resolveTarget("registry", []).sources]).toEqual(["clinicaltrials-v2"]);
    expect([...resolveTarget("openfda-510k", []).sources]).toEqual(["openfda-510k"]);
    expect([...resolveTarget(undefined, ["hospital-policy"]).sources]).toEqual(["hospital-policy"]);
    expect(() => resolveTarget("   x ", [])).toThrow(PortError);
  });
});

describe("chain fetcher", () => {
  it("falls through a missing recording to the next, and passes every other failure on", async () => {
    const miss = { servedFrom: "recorded" as const, get: async () => { throw new PortError("UNAVAILABLE", "no recording", { noRecording: true }); } };
    const hit = { servedFrom: "recorded" as const, get: async (u: string) => ({ requestedUrl: u, finalUrl: u, status: 200, headers: {}, body: new Uint8Array(), truncated: false, redirects: [], servedFrom: "recorded" as const, elapsedMs: 0 }) };
    const bad = { servedFrom: "recorded" as const, get: async () => { throw new PortError("REFUSED", "not allowed"); } };
    expect((await new ChainFetcher([miss, hit]).get("https://a.test/x")).status).toBe(200);
    await expect(new ChainFetcher([bad, hit]).get("https://a.test/x")).rejects.toMatchObject({ failure: "REFUSED" });
    await expect(new ChainFetcher([miss, miss]).get("https://a.test/x")).rejects.toMatchObject({ detail: { noRecording: true } });
  });
});

// ---------------------------------------------------------------- the guard for documents, and mutations

describe("quarantine", () => {
  const doc = documentFromText("d", "Page one is ordinary.\fThe device is indicated for adults.\n" + INJECTED_INSTRUCTION + "\nThe study enrolled 100 patients.");
  it("cuts the instruction out of the page and reports what it cut", () => {
    const q = quarantineDocument(doc);
    expect(q.quarantined.length).toBeGreaterThan(0);
    expect(q.doc.text).not.toContain("NOTE TO THE REVIEWING SYSTEM");
    expect(q.doc.text).toContain("The study enrolled 100 patients.");
    expect(q.doc.text).toContain("Page one is ordinary.");
  });
  it("leaves an ordinary document untouched", () => {
    const clean = documentFromText("d", "The device is indicated for adults aged 22 and older.\fThe study enrolled 655 participants.");
    const q = quarantineDocument(clean);
    expect(q.quarantined).toEqual([]);
    expect(q.doc).toBe(clean);
  });
  it("applyDocumentMutation writes the instruction into one page only for the named submission", () => {
    const base = documentFromText("d", "one\ftwo\fthree");
    expect(applyDocumentMutation(base, "K1", undefined)).toBe(base);
    expect(applyDocumentMutation(base, "K2", { injection: { submission: "K1", page: 2, text: "X" } })).toBe(base);
    const mutated = applyDocumentMutation(base, "K1", { injection: { submission: "K1", page: 2, text: "INJECTED" } });
    expect(mutated.pages[1]!.text).toContain("INJECTED");
    expect(mutated.pages[0]!.text).not.toContain("INJECTED");
  });
  it("applyRecordMutation revises a registry record with a new hash and a later date, and nothing else", () => {
    const rec = { id: "r", sourceId: "clinicaltrials-v2", retrievedAt: "2026-10-27T00:00:00.000Z", requestHash: "a".repeat(64), contentHash: "b".repeat(64), schemaVersion: "1", license: "x", payload: { body: { protocolSection: { eligibilityModule: { minimumAge: "18 Years" } } } } } as unknown as EvidenceRecord;
    const stp: ReadStep = { id: "s", source: "clinicaltrials-v2", query: { nct_id: "NCT00000001" }, why: "", kind: "followup" };
    const m = { registryRevision: { nctId: "NCT00000001", minimumAge: "22 Years", revisedOn: "2026-10-28" } };
    const out = applyRecordMutation(rec, stp, m);
    expect(out.contentHash).not.toBe(rec.contentHash);
    expect(out.retrievedAt).toBe("2026-10-28T12:00:00.000Z");
    expect(JSON.stringify(out.payload)).toContain("22 Years");
    expect(JSON.stringify(rec.payload)).toContain("18 Years");
    expect(applyRecordMutation(rec, { ...stp, query: { nct_id: "NCT00000002" } }, m)).toBe(rec);
  });
});

// ---------------------------------------------------------------- reading where a study ran

describe("readStudySettings", () => {
  it("reads the setting of a study from the sentence that describes its sites, and not from a sentence about intended use", async () => {
    const doc = documentFromText("r", "The device is indicated for use in primary care and eye care settings.\fThe 655 participants were enrolled in the study at 11 US study sites that included primary care centers and general ophthalmology centers.");
    const kept = await readStudySettings(doc, "device:fda:K1");
    const values = kept.map((k) => k.assertion.value);
    expect(values).toEqual(expect.arrayContaining(["primary care", "ophthalmology"]));
    expect(kept.every((k) => k.assertion.assertionType === "study" && k.assertion.quoteVerified)).toBe(true);
    expect(kept.every((k) => k.anchor.text.includes("enrolled"))).toBe(true);
  });
  it("finds nothing in text that names no setting", async () => {
    expect(await readStudySettings(documentFromText("r", "Enrolment was at 11 sites."), "x")).toEqual([]);
  });
  it("criticalAssertions picks the version and the bounds first, only usable ones, and at most the cap", () => {
    const mk = (predicate: string, value: string | number, support = "PASS"): CheckedAssertion => ({ assertion: { id: predicate + value, subjectId: "s", predicate, value, assertionType: "study", anchorId: "a", extractionMethod: "pattern", quoteVerified: true, supportVerified: support as never }, anchor: {} as never, quote: {} as never, support: {} as never, detail: {} });
    const structured = mk("population.age_min", 18);
    structured.assertion = { ...structured.assertion, extractionMethod: "structured" } as never;
    expect(criticalAssertions([structured], 5)).toEqual([]);
    const picked = criticalAssertions([mk("result.sensitivity", 0.9), mk("population.age_min", 18), mk("device.version", "2.1.0"), mk("device.version", "9.9", "FAIL"), mk("study.design", "prospective")], 2);
    expect(picked.map((p) => p.assertion.predicate)).toEqual(["device.version", "population.age_min"]);
  });
});

// ---------------------------------------------------------------- the hospital's requirements

const digest = (d: Partial<EvidenceDigest> = {}): EvidenceDigest => ({ designs: [], siteCounts: [], ageMins: [], versions: [], settings: [], equipment: [], ...d });
const row = (dimension: string, required_value: string, purpose = "detection_aid"): RequirementRow => ({ requirement_id: "REQ-T", applies_to_purpose: purpose, dimension, comparator: "equals", required_value, rationale: "why", policy_ref: "P", policy_version: "v1" });
const claim = (use: object, equipment?: string) => ({ id: "c", text: "t", use, ...(equipment ? { equipment } : {}) }) as never;

describe("requirement assessment", () => {
  it("validation type: prospective and multi-site is met, retrospective or one site is not, silence is not decided", () => {
    const r = row("validation_type", "prospective_multicentre");
    expect(assessRequirement(r, claim({}), digest({ designs: ["prospective"], siteCounts: [11] })).satisfied).toBe(true);
    expect(assessRequirement(r, claim({}), digest({ designs: ["retrospective"], siteCounts: [11] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({}), digest({ designs: ["prospective"], siteCounts: [1] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({}), digest()).satisfied).toBeUndefined();
    expect(assessRequirement(r, claim({}), digest({ designs: ["prospective"] })).satisfied).toBeUndefined();
  });
  it("minimum age: the evidence must reach down to the age the use needs", () => {
    const r = row("population_min_age", "18");
    expect(assessRequirement(r, claim({ population: { age: { min: 22 } } }), digest({ ageMins: [18] })).satisfied).toBe(true);
    expect(assessRequirement(r, claim({ population: { age: { min: 0 } } }), digest({ ageMins: [18] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({}), digest()).satisfied).toBeUndefined();
  });
  it("version-specific evidence: the claimed release must be named by a study", () => {
    const r = row("version_specific_evidence", "true");
    expect(assessRequirement(r, claim({ versions: ["2.1.0"] }), digest({ versions: ["2.1.0"] })).satisfied).toBe(true);
    expect(assessRequirement(r, claim({ versions: ["3.0"] }), digest({ versions: ["2.1.0"] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({ versions: ["3.0"] }), digest()).satisfied).toBeUndefined();
  });
  it("setting match uses the setting hierarchy", () => {
    const r = row("setting_match", "deployment_setting");
    expect(assessRequirement(r, claim({ settings: ["primary_care"] }), digest({ settings: ["primary care"] })).satisfied).toBe(true);
    expect(assessRequirement(r, claim({ settings: ["emergency_department"] }), digest({ settings: ["primary care"] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({ settings: ["primary_care"] }), digest({ settings: ["hospital"] })).satisfied).toBe(false);
    expect(assessRequirement(r, claim({ settings: ["emergency_department"] }), digest({ settings: ["hospital"] })).satisfied).toBe(true);
    expect(assessRequirement(r, claim({ settings: ["moon_base"] }), digest({ settings: ["hospital"] })).satisfied).toBeUndefined();
  });
  it("camera precedent: equipment the authorization does not list is not met", () => {
    const listed = digest({ equipment: ["Canon CR-2 AF", "Canon CR-2 Plus AF"] });
    expect(assessCameraPrecedent(claim({}, "Canon CR-2 Plus AF"), listed).satisfied).toBe(true);
    expect(assessCameraPrecedent(claim({}, "any_fundus_camera"), listed).satisfied).toBe(false);
    expect(assessCameraPrecedent(claim({}, "Canon CR-2 Plus AF"), digest()).satisfied).toBeUndefined();
    expect(assessCameraPrecedent(claim({}), listed).satisfied).toBeUndefined();
  });
  it("what cannot be decided is listed as unassessed, never counted as met", () => {
    const rows = [row("subgroup_reporting", "age|sex"), row("validation_type", "prospective_multicentre"), { ...row("update_control_statement", "true"), requirement_id: "REQ-U" }];
    const out = requirementItems(rows, [], claim({ purpose: "detection_aid" }), digest({ designs: ["prospective"], siteCounts: [3] }));
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.satisfied).toBe(true);
    expect(out.unassessed.map((u) => u.dimension).sort()).toEqual(["subgroup_reporting", "update_control_statement"]);
    expect(requirementItems(rows, [], claim({ purpose: "diagnosis" }), digest()).items).toEqual([]);
  });
});
