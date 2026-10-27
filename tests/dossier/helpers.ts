/**
 * Test fixtures for the dossier module. Everything here is constructed for tests and says so in its text.
 * The compiler is a named test double: the real one lives in src/compiler and is injected by the caller.
 */
import {
  ClaimSchema,
  EvidenceAnchorSchema,
  EvidenceAssertionSchema,
  EvidenceItemSchema,
  FactSchema,
  FindingSchema,
  LinkSchema,
  SourceSchema,
} from "../../src/schemas/index.ts";
import type { Claim, Dimension, EvidenceItem, Label, Relation } from "../../src/schemas/index.ts";
import type { Clock } from "../../src/ports/index.ts";
import { hashOf, sha256Hex } from "../../src/util/canonical.ts";
import { buildManifestSections, manifestMessage, rootOf } from "../../src/dossier/manifest.ts";
import { DecisionLog, buildDossier, createDemoSignerFromSeed, snapshotFromRecord } from "../../src/dossier/index.ts";
import type { BuildOptions, DossierBundle, DossierInput, RecomputeFn, RecomputeResult } from "../../src/dossier/index.ts";

export const FIXED_TIME = "2026-10-27T12:00:00.000Z";
export const fixedClock: Clock = { now: () => new Date(FIXED_TIME) };
export const seedSigner = () => createDemoSignerFromSeed(new Uint8Array(32).fill(7));

const hex = (label: string): string => sha256Hex(`fixture|${label}`);

// ---------------------------------------------------------------- stored records

const AUTH_TEXT =
  "Clearance letter, constructed for tests. The device TRIAGE-1 software version 3.1 and 3.2 is indicated for triage notification in emergency department settings. Effective 2025-11-14.";
const STUDY_TEXT =
  "Evaluation report, constructed for tests. Adults aged 18 to 65 were enrolled at three emergency departments. Software version 3.1 was evaluated. Sensitivity 0.91 (95% CI 0.87 to 0.94) among 412 patients at the 0.5 operating threshold.";
const POLICY_TEXT = "Hospital policy HP-7, constructed for tests: an AI triage tool must report sensitivity of at least 0.9 for adults.";

function snap(id: string, sourceId: string, text: string, retrievedAt: string) {
  return snapshotFromRecord({
    record: { id, sourceId, retrievedAt, requestHash: hex(`req-${id}`), contentHash: sha256Hex(text), schemaVersion: "1", license: "constructed-for-tests" },
    text,
    contentKind: "text",
  });
}

export function snapshotFor(id: string, sourceId: string, text: string) {
  return snap(id, sourceId, text, "2026-10-20T08:00:00.000Z");
}

function anchor(id: string, recordId: string, text: string) {
  return EvidenceAnchorSchema.parse({ id, recordId, text, textHash: sha256Hex(text) });
}

// ---------------------------------------------------------------- compiler test double

/**
 * A deliberately small stand-in for the applicability compiler, defined only in tests. It reads the evidence the way
 * the dossier records it (authorization items for product, setting, purpose and timing; study items for version,
 * population and metric) and applies a simple three-valued rule. It is not the product's rule set.
 */
export function compilerTestDouble(options: { coverage?: boolean } = {}): RecomputeFn {
  return (claim: Claim, evidence: EvidenceItem[], ruleVersion: string): RecomputeResult => {
    if (ruleVersion === "unknown-rules") throw new Error(`no rule set ${ruleVersion}`);
    const auth = evidence.filter((e) => e.assertionType === "authorization");
    const study = evidence.filter((e) => e.assertionType === "study");
    const rel: Record<Dimension, Relation> = {
      product: "UNKNOWN",
      version: "UNKNOWN",
      population: "UNKNOWN",
      setting: "UNKNOWN",
      purpose: "UNKNOWN",
      timing: "UNKNOWN",
      metric: "UNKNOWN",
    };
    const u = claim.use;
    const a = auth[0]?.scope;
    if (a?.product && u.product) rel.product = a.product === u.product ? "CONTAINED" : "DISJOINT";
    if (a?.settings && u.settings) rel.setting = u.settings.every((s) => a.settings?.includes(s)) ? "CONTAINED" : "DISJOINT";
    if (a?.purpose && u.purpose) rel.purpose = a.purpose === u.purpose ? "CONTAINED" : "DISJOINT";
    if (a?.timing?.from && u.timing?.from) rel.timing = a.timing.from <= u.timing.from ? "CONTAINED" : "DISJOINT";
    const withVersions = study.filter((s) => s.scope.versions);
    if (withVersions.length > 0 && u.versions?.[0]) rel.version = withVersions.some((s) => s.scope.versions?.includes(u.versions?.[0] as string)) ? "CONTAINED" : "DISJOINT";
    const age = study.find((s) => s.scope.population?.age)?.scope.population?.age;
    const want = u.population?.age;
    if (age && want && age.min !== undefined && age.max !== undefined && want.min !== undefined && want.max !== undefined) {
      rel.population = want.min >= age.min && want.max <= age.max ? "CONTAINED" : want.max < age.min || want.min > age.max ? "DISJOINT" : "PARTIAL";
    }
    const result = study.flatMap((s) => s.results).find((r) => r.metric === claim.performance?.metric);
    if (result && claim.performance) rel.metric = result.value >= claim.performance.atLeast ? "CONTAINED" : "DISJOINT";

    const values = Object.values(rel);
    let label: Label;
    if (values.includes("UNKNOWN")) label = "INSUFFICIENT_EVIDENCE";
    else if (values.every((v) => v === "CONTAINED")) label = "SUPPORTED_FOR_SCOPE";
    else if (rel.metric === "DISJOINT") label = "CONTRADICTED_BY_SPECIFIED_EVIDENCE";
    else if (values.includes("DISJOINT")) label = "REQUIRES_DOMAIN_REVIEW";
    else label = "SUPPORTED_ONLY_FOR_NARROWER_SCOPE";
    return options.coverage ? { label, mechanicalCoverage: (Object.keys(rel) as Dimension[]).map((dimension) => ({ dimension, relation: rel[dimension] })) } : { label };
  };
}

// ---------------------------------------------------------------- the base dossier

function dim(dimension: Dimension, relation: Relation, claimed?: string, established?: string, anchorIds: string[] = [], evidenceIds: string[] = []) {
  return { dimension, relation, ...(claimed !== undefined ? { claimed } : {}), ...(established !== undefined ? { established } : {}), anchorIds, evidenceIds };
}

export function baseInput(): DossierInput {
  const claimUse = {
    product: "device:constructed:TRIAGE-1",
    versions: ["3.1"],
    population: { age: { min: 18, max: 70 } },
    settings: ["emergency_department"],
    purpose: "triage_notification",
    timing: { from: "2026-03-01" },
  };
  const perf = { metric: "sensitivity", atLeast: 0.9 };
  const claims = [
    ClaimSchema.parse({ id: "c1", text: "Triage notification for adults 18 to 70 on version 3.1", use: claimUse, performance: perf }),
    ClaimSchema.parse({ id: "c2", text: "Triage notification on version 4.0", use: { ...claimUse, versions: ["4.0"] }, performance: perf }),
  ];

  const sources = [
    SourceSchema.parse({ id: "src-reg", kind: "regulator", access: "connector", descriptor: "Constructed regulator register", license: "constructed-for-tests", health: "OK", dataClass: "public" }),
    SourceSchema.parse({ id: "src-lit", kind: "literature", access: "zetaris", descriptor: "Constructed study index", license: "constructed-for-tests", health: "OK", dataClass: "public" }),
    SourceSchema.parse({ id: "src-hosp", kind: "hospital", access: "file", descriptor: "Constructed hospital policy set", license: "constructed-for-tests", health: "OK", dataClass: "public" }),
  ];

  const snapshots = [
    snap("rec-auth", "src-reg", AUTH_TEXT, "2026-10-20T08:00:00.000Z"),
    snap("rec-study", "src-lit", STUDY_TEXT, "2026-10-20T08:05:00.000Z"),
    snap("rec-policy", "src-hosp", POLICY_TEXT, "2026-10-20T08:10:00.000Z"),
  ];

  const anchors = [
    anchor("a-auth", "rec-auth", "The device TRIAGE-1 software version 3.1 and 3.2 is indicated for triage notification in emergency department settings"),
    anchor("a-auth-date", "rec-auth", "Effective 2025-11-14"),
    anchor("a-study-pop", "rec-study", "Adults aged 18 to 65 were enrolled"),
    anchor("a-study-ver", "rec-study", "Software version 3.1 was evaluated"),
    anchor("a-study-sens", "rec-study", "Sensitivity 0.91 (95% CI 0.87 to 0.94) among 412 patients"),
    anchor("a-req", "rec-policy", "must report sensitivity of at least 0.9 for adults"),
  ];

  const evidenceItems = [
    EvidenceItemSchema.parse({
      id: "e-auth",
      assertionType: "authorization",
      scope: { product: "device:constructed:TRIAGE-1", versions: ["3.1", "3.2"], settings: ["emergency_department"], purpose: "triage_notification", timing: { from: "2025-11-14" } },
      anchorIds: ["a-auth", "a-auth-date"],
    }),
    EvidenceItemSchema.parse({
      id: "e-study",
      assertionType: "study",
      scope: { versions: ["3.1"], population: { age: { min: 18, max: 65 } }, settings: ["emergency_department"] },
      results: [{ metric: "sensitivity", value: 0.91, ci: [0.87, 0.94], n: 412, anchorId: "a-study-sens" }],
      adequate: true,
      anchorIds: ["a-study-pop", "a-study-ver", "a-study-sens"],
    }),
    EvidenceItemSchema.parse({ id: "e-req", assertionType: "requirement", scope: {}, satisfied: false, anchorIds: ["a-req"] }),
  ];

  const findings = [
    FindingSchema.parse({
      id: "f1",
      claimId: "c1",
      label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE",
      supportedScope: { population: { age: { min: 18, max: 65 } } },
      mechanicalCoverage: [
        dim("product", "CONTAINED", "device:constructed:TRIAGE-1", "device:constructed:TRIAGE-1", ["a-auth"], ["e-auth"]),
        dim("version", "CONTAINED", "3.1", "3.1", ["a-study-ver"], ["e-study"]),
        dim("population", "PARTIAL", "ages 18 to 70", "ages 18 to 65", ["a-study-pop"], ["e-study"]),
        dim("setting", "CONTAINED", "emergency_department", "emergency_department", ["a-auth"], ["e-auth"]),
        dim("purpose", "CONTAINED", "triage_notification", "triage_notification", ["a-auth"], ["e-auth"]),
        dim("timing", "CONTAINED", "2026-03-01", "2025-11-14", ["a-auth-date"], ["e-auth"]),
        dim("metric", "CONTAINED", "sensitivity at least 0.9", "sensitivity 0.91 (95% CI 0.87 to 0.94)", ["a-study-sens"], ["e-study"]),
      ],
      mismatches: [{ dimension: "population", relation: "PARTIAL", claimed: "ages 18 to 70", established: "ages 18 to 65", anchorIds: ["a-study-pop"] }],
      requiredEvidence: [{ dimension: "population", request: "Performance results for adults older than 65 up to the upper age of the intended use, on software version 3.1." }],
      ruleVersion: "rules-1",
      computedAt: "2026-10-27T10:00:00.000Z",
    }),
    FindingSchema.parse({
      id: "f2",
      claimId: "c2",
      label: "INSUFFICIENT_EVIDENCE",
      mechanicalCoverage: [
        dim("product", "CONTAINED", "device:constructed:TRIAGE-1", "device:constructed:TRIAGE-1", ["a-auth"], ["e-auth"]),
        dim("version", "UNKNOWN", "4.0"),
        dim("population", "UNKNOWN", "ages 18 to 70"),
        dim("setting", "CONTAINED", "emergency_department", "emergency_department", ["a-auth"], ["e-auth"]),
        dim("purpose", "CONTAINED", "triage_notification", "triage_notification", ["a-auth"], ["e-auth"]),
        dim("timing", "CONTAINED", "2026-03-01", "2025-11-14", ["a-auth-date"], ["e-auth"]),
        dim("metric", "UNKNOWN", "sensitivity at least 0.9"),
      ],
      mismatches: [{ dimension: "version", relation: "UNKNOWN", claimed: "4.0", anchorIds: [] }],
      requiredEvidence: [
        { dimension: "version", request: "A study report or regulator document that covers software version 4.0 of the product." },
        { dimension: "metric", request: "Sensitivity results for the intended use on that version." },
      ],
      ruleVersion: "rules-1",
      computedAt: "2026-10-27T10:00:01.000Z",
    }),
  ];

  const assertions = [
    EvidenceAssertionSchema.parse({ id: "asr-1", subjectId: "e-study", predicate: "reported_sensitivity", value: 0.91, appliesToVersion: "3.1", assertionType: "study", anchorId: "a-study-sens", extractionMethod: "model", quoteVerified: true, supportVerified: "PASS" }),
    EvidenceAssertionSchema.parse({ id: "asr-2", subjectId: "e-study", predicate: "enrolled_ages", value: "18 to 65", assertionType: "study", anchorId: "a-study-pop", extractionMethod: "model", quoteVerified: true, supportVerified: "UNCHECKED" }),
    EvidenceAssertionSchema.parse({ id: "asr-3", subjectId: "e-auth", predicate: "indicated_versions", value: ["3.1", "3.2"], assertionType: "authorization", anchorId: "a-auth", extractionMethod: "structured", quoteVerified: true, supportVerified: "PASS" }),
  ];

  const facts = [
    FactSchema.parse({ id: "fact-0", subject: "device:constructed:TRIAGE-1", predicate: "indicated_version", object: "3.1", recordedAt: "2026-10-20T08:00:00.000Z", supersededAt: "2026-10-20T08:30:00.000Z", sourceId: "src-reg", assertionType: "authorization", anchorId: "a-auth", hash: hex("fact-0") }),
    FactSchema.parse({ id: "fact-1", subject: "device:constructed:TRIAGE-1", predicate: "indicated_version", object: "3.1, 3.2", recordedAt: "2026-10-20T08:30:00.000Z", sourceId: "src-reg", assertionType: "authorization", anchorId: "a-auth", hash: hex("fact-1") }),
  ];

  const queryResult = { columns: [{ name: "study_id", type: "string" }, { name: "n", type: "string" }], rows: [{ study_id: "S-1", n: "412" }] };
  const models = [
    {
      id: "m1",
      at: "2026-10-20T08:06:00.000Z",
      role: "extractor",
      requestedModel: "constructed-model-small",
      routedModel: "constructed-model-small",
      provider: "nightshift" as const,
      recorded: false,
      label: "live" as const,
      dataClass: "public" as const,
      textHash: hex("m1-text"),
      usage: { promptTokens: 120, completionTokens: 40, measured: true },
      receipt: { receiptId: "rcpt-1", routedModel: "constructed-model-small", provider: "nightshift", raw: { constructed: true } },
      derives: ["asr-1"],
      inputRecordIds: ["rec-study"],
    },
    {
      id: "m2",
      at: "2026-10-20T08:07:00.000Z",
      role: "extractor",
      requestedModel: "constructed-model-small",
      routedModel: "constructed-model-small",
      provider: "recorded" as const,
      recorded: true,
      label: "recorded" as const,
      dataClass: "public" as const,
      textHash: hex("m2-text"),
      usage: { measured: false },
      derives: ["asr-2"],
      inputRecordIds: ["rec-study"],
    },
  ];

  const log = DecisionLog.create({ clock: fixedClock, findings });
  log.append({ idempotencyKey: "review-1-f1", claimId: "c1", findingId: "f1", action: "request_evidence", reviewer: "reviewer-a", requestedDimensions: ["population"], note: "Ask the vendor for the 66 to 70 age band." });
  log.append({ idempotencyKey: "review-1-f2", claimId: "c2", findingId: "f2", action: "escalate", reviewer: "reviewer-a", escalateTo: "clinical-lead" });

  return {
    run: { mode: "sample", note: "constructed fixture for tests" },
    rules: { registryVersion: "registry-1", registryHash: hex("registry-1") },
    sources,
    claims,
    findings,
    compilerRuns: [
      { findingId: "f1", evidenceItemIds: ["e-auth", "e-study", "e-req"] },
      { findingId: "f2", evidenceItemIds: ["e-auth", "e-req"] },
    ],
    requirements: [{ id: "req-1", claimId: "c1", description: "Hospital policy HP-7: sensitivity of at least 0.9", evidenceItemId: "e-req", anchorIds: ["a-req"] }],
    evidenceItems,
    anchors,
    assertions,
    links: [LinkSchema.parse({ id: "link-1", type: "STUDY_EVALUATES", from: "rec-study", to: "rec-auth", state: "CANDIDATE", basis: ["same product name"], flags: ["version differs"] })],
    facts,
    snapshots,
    federation: [
      {
        queryId: "zq-1",
        statement: "SELECT study_id, n FROM literature.studies WHERE product = 'TRIAGE-1'",
        identity: "reviewer-a",
        at: "2026-10-20T08:04:00.000Z",
        servedFrom: "cassette" as const,
        label: "recorded" as const,
        total: 1,
        rowCount: 1,
        columns: queryResult.columns,
        respHash: hex("resp-zq-1"),
        sourceIds: ["src-lit"],
        result: queryResult,
        resultDigest: hashOf(queryResult),
      },
    ],
    models,
    egress: [
      { id: "eg-1", at: "2026-10-20T08:06:00.000Z", subjectKind: "model" as const, subjectId: "m1", dataClass: "public" as const, route: "remote" as const, decision: "allowed" as const, reason: "public record text" },
    ],
    evidenceHistory: [
      { id: "eh-1", history: "evidence", seq: 1, at: "2026-10-20T08:00:00.000Z", kind: "record_retrieved", refId: "rec-auth", contentHash: snapshots[0]?.contentHash },
      { id: "eh-2", history: "evidence", seq: 2, at: "2026-10-20T08:05:00.000Z", kind: "record_retrieved", refId: "rec-study", contentHash: snapshots[1]?.contentHash },
      { id: "eh-3", history: "evidence", seq: 3, at: "2026-10-20T08:05:30.000Z", kind: "source_health_observed", refId: "src-reg", health: "OK" },
      { id: "eh-4", history: "evidence", seq: 4, at: "2026-10-20T08:00:00.000Z", kind: "fact_recorded", refId: "fact-0" },
      { id: "eh-5", history: "evidence", seq: 5, at: "2026-10-20T08:30:00.000Z", kind: "fact_recorded", refId: "fact-1", supersedes: "fact-0" },
      { id: "eh-6", history: "evidence", seq: 6, at: "2026-10-20T08:30:00.000Z", kind: "fact_superseded", refId: "fact-0" },
    ],
    decisions: log,
  };
}

export function buildOptions(overrides: Partial<BuildOptions> = {}): BuildOptions {
  return { signer: seedSigner(), clock: fixedClock, ...overrides };
}

export function baseBundle(mutate?: (input: DossierInput) => void): DossierBundle {
  const input = baseInput();
  mutate?.(input);
  return buildDossier(input, buildOptions());
}

export const verifyOptions = { recompute: compilerTestDouble() };

/** Deep clone through JSON, as a file read would produce. Typed any so tests can edit it freely. */
export function viaJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------- forging (an attacker who holds the signing key)

/**
 * Edits the body of a built bundle, then rebuilds the manifest and signs it again with `signer`, the way someone
 * holding the key could. Hashes and signature are then all valid, so only the semantic checks can catch the edit.
 */
export function forge(mutate: (body: any) => void, signer = seedSigner(), source: DossierBundle = baseBundle()): any {
  const b: any = viaJson(source);
  mutate(b.body);
  const sections = buildManifestSections(b.body);
  b.manifest.sections = sections;
  b.manifest.root = rootOf(sections);
  b.manifest.signing.keyId = signer.keyId;
  b.manifest.signing.publicKey = signer.publicKeyB64;
  b.manifest.signing.keyStatus = signer.keyStatus;
  b.signature.value = signer.sign(manifestMessage(b.manifest));
  return b;
}

export function failedItems(result: { failures: { item: string }[] }): string[] {
  return result.failures.map((f) => f.item);
}
