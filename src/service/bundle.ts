/**
 * The dossier of one case: every claim, finding, quoted passage, stored record, query and model reply the findings stand on,
 * signed, with an offline verifier that recomputes the labels from the recorded inputs.
 *
 * The verifier re-runs the compiler on the claim and the evidence items the dossier lists. The compile options that matter
 * to a label are derivable from the claim alone (which dimensions it states) and the claim's declared dependencies, which the
 * dossier stores as compiled; a source that was lost simply has no evidence items, so the recompute reaches the same label
 * and the loss is recorded in the finding's `degraded` list.
 */
import { COMPILER_VERSION, compileDetailed } from "../compiler/index.ts";
import {
  buildDossier,
  createDemoSignerFromSeed,
  federationQueryFromResult,
  modelReplyFromResponse,
  resolveSigner,
  snapshotFromRecord,
  type DossierBundle,
  type DossierSigner,
  type DecisionEntry,
  type RecomputeFn,
} from "../dossier/index.ts";
import type { Claim, Dimension, EvidenceItem, Finding, Link, Source } from "../schemas/index.ts";
import type { InvestigationResult } from "../agents/investigation.ts";
import { sha256Hex } from "../util/canonical.ts";
import { baseCompileOptions } from "./bridge.ts";
import type { ServiceConfig } from "./config.ts";
import type { StoredRecord } from "./evidence.ts";
import { assertionTypesOf } from "./reader.ts";
import { chainOf, supersessionReason, type ArchivedChain } from "./history.ts";
import type { WorldFact } from "./world.ts";

/** Seed for the committed sample dossiers, so the same inputs give the same bytes. A demo key identifies no one. */
export const SAMPLE_KEY_SEED = createSeed("sakaime-sample-dossier-key-v1");

function createSeed(label: string): Uint8Array {
  return Uint8Array.from(Buffer.from(sha256Hex(label), "hex"));
}

export function dossierSigner(config: ServiceConfig): DossierSigner {
  return config.sample ? createDemoSignerFromSeed(SAMPLE_KEY_SEED) : resolveSigner({ env: config.env, allowDemo: true });
}

/** The dimensions a claim states, which is what the service passes the compiler as the required ones. */
export function requiredDimensionsOf(claim: Pick<Claim, "use">): Dimension[] {
  const dims: Dimension[] = ["product"];
  if (claim.use.versions?.length) dims.push("version");
  if (claim.use.population) dims.push("population");
  if (claim.use.settings?.length) dims.push("setting");
  if (claim.use.purpose) dims.push("purpose");
  if (claim.use.timing?.from) dims.push("timing");
  return dims;
}

/** The compiler as the verifier calls it: pure, under the rule version the finding names. */
export const recomputeFn: RecomputeFn = (claim, evidence, ruleVersion) => {
  const detail = compileDetailed(claim, evidence, { ...baseCompileOptions(), requiredDimensions: requiredDimensionsOf(claim), expectedRuleVersion: ruleVersion });
  return { label: detail.finding.label, mechanicalCoverage: detail.finding.mechanicalCoverage.map((m) => ({ dimension: m.dimension, relation: m.relation })) };
};

const SOURCE_KIND: Record<string, Source["kind"]> = { regulator: "regulator", registry: "registry", literature: "literature", vendor: "vendor", hospital: "hospital" };

function sourceRows(run: InvestigationResult, usedIds: ReadonlySet<string>): Source[] {
  const wb = run.wb;
  const rows: Source[] = [];
  const healthOf = (id: string): Source["health"] => {
    const bad = wb.failures.find((f) => f.source === id && f.kind !== "candidate" && f.kind !== "discovery");
    if (bad) return bad.status === "EMPTY" ? "EMPTY" : (["UNAVAILABLE", "FORBIDDEN", "DRIFTED", "BLOCKED"].includes(bad.status) ? (bad.status as Source["health"]) : "UNAVAILABLE");
    const empty = wb.outcomes.find((o) => o.step.source === id && o.status === "EMPTY" && o.step.kind !== "candidate" && o.step.kind !== "discovery");
    return empty ? "EMPTY" : "OK";
  };
  const last = (id: string): string | undefined => {
    const ok = [...wb.outcomes].reverse().find((o) => o.step.source === id && o.status === "OK");
    return ok?.records[0]?.retrievedAt;
  };
  for (const [id, connector] of wb.env.connectors) {
    if (!usedIds.has(id)) continue;
    const card = connector.card;
    rows.push({
      id,
      kind: SOURCE_KIND[card.kind] ?? "other",
      access: "connector",
      descriptor: `${id}: ${assertionTypesOf(id).join(", ") || "reference"} records`,
      license: card.license,
      health: healthOf(id),
      ...(last(id) ? { lastSuccessAt: last(id)! } : {}),
      dataClass: card.dataClass,
    });
  }
  if (usedIds.has("fda-accessdata-pdf") && !rows.some((r) => r.id === "fda-accessdata-pdf")) {
    rows.push({
      id: "fda-accessdata-pdf",
      kind: "regulator",
      access: "file",
      descriptor: "FDA decision summary documents",
      license: "US government work; reuse terms NOT VERIFIED",
      health: wb.documentFailure ? "UNAVAILABLE" : "OK",
      ...(wb.summary ? { lastSuccessAt: wb.summary.stored.retrievedAt } : {}),
      dataClass: "public",
    });
  }
  if (usedIds.has("hospital-policy")) {
    rows.push({
      id: "hospital-policy",
      kind: "hospital",
      access: "zetaris",
      descriptor: "Hospital review database: requirements and precedents (constructed)",
      license: "constructed for this demonstration",
      health: wb.federation.status === "ok" ? "OK" : "UNAVAILABLE",
      ...(wb.federation.reads[0] ? { lastSuccessAt: wb.federation.reads[0].at } : {}),
      dataClass: "public",
    });
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function factsOf(world: WorldFact[]): { id: string; subject: string; predicate: string; object: string; validFrom?: string; recordedAt: string; sourceId: string; assertionType: WorldFact["assertionType"]; anchorId?: string; hash: string }[] {
  const seen = new Set<string>();
  const out = [];
  for (const f of world) {
    if (seen.has(f.factId)) continue;
    seen.add(f.factId);
    const object = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
    out.push({
      id: f.factId,
      subject: f.about,
      predicate: f.predicate,
      object: object === "" ? "(empty)" : object,
      ...(f.validFrom ? { validFrom: `${f.validFrom}T00:00:00.000Z` } : {}),
      recordedAt: f.recordedAt,
      sourceId: f.sourceId,
      assertionType: f.assertionType,
      ...(f.anchorId ? { anchorId: f.anchorId } : {}),
      hash: sha256Hex(JSON.stringify([f.about, f.predicate, f.value, f.recordId])),
    });
  }
  return out;
}

export interface BundleInput {
  run: InvestigationResult;
  config: ServiceConfig;
  signer: DossierSigner;
  decisions: DecisionEntry[];
  links: Link[];
  /** Findings that a re-run replaced after a reviewer decided on them. They are listed as superseded, with their evidence. */
  archive?: readonly ArchivedChain[];
}

export function buildCaseDossier(input: BundleInput): DossierBundle {
  const { run, config } = input;
  const wb = run.wb;
  const asm = wb.assembled;
  if (!asm) throw new Error("the investigation produced no assembled evidence to build a dossier from");

  // Findings, per claim in order: any finding a re-run replaced after a decision, the older finding a revision replaced, then the
  // current one. Each links to the one before it, so history is a chain and nothing is rewritten.
  const archive = input.archive ?? [];
  const findings: Finding[] = [];
  const compilerRuns: { findingId: string; evidenceItemIds: string[] }[] = [];
  for (const r of run.results) {
    const chain = [...archive.filter((c) => c.claimId === r.claim.id).flatMap((c) => c.members), ...chainOf(run, r.claim.id)];
    chain.forEach((m, i) => {
      const before = chain[i - 1];
      const f = before && m.finding.supersedes === undefined ? { ...m.finding, supersedes: before.finding.id, supersedesReason: supersessionReason(before.finding, m.finding) } : m.finding;
      findings.push(f);
      compilerRuns.push({ findingId: f.id, evidenceItemIds: m.evidenceItemIds });
    });
  }

  // What the older findings were computed from is kept beside what the current ones were computed from.
  const earlierRuns = [...new Set(archive.map((c) => c.run))].filter((r) => r !== run);
  const items = new Map<string, EvidenceItem>();
  const earlierAnchors = new Map<string, (typeof asm.anchors)[number]>();
  const earlierAssertions = new Map<string, (typeof asm.assertions)[number]>();
  const earlierRecords = new Map<string, StoredRecord>();
  const earlierFacts = new Map<string, WorldFact>();
  for (const old of earlierRuns) {
    const a = old.wb.assembled;
    if (!a) continue;
    for (const i of a.items) items.set(i.id, i);
    for (const r of old.results) for (const i of r.evidence) items.set(i.id, i);
    for (const x of a.anchors) earlierAnchors.set(x.id, x);
    for (const x of a.assertions) earlierAssertions.set(x.id, x);
    for (const e of old.wb.extracted.values()) earlierRecords.set(e.stored.id, e.stored);
    for (const f of old.wb.world.facts) earlierFacts.set(`${f.factId}|${f.assertionId}`, f);
  }
  for (const i of asm.items) items.set(i.id, i);
  for (const r of run.results) for (const i of r.evidence) items.set(i.id, i);

  const requirements = run.results.flatMap((r) =>
    r.evidence
      .filter((i) => i.assertionType === "requirement")
      .map((i) => ({ id: i.id, claimId: r.claim.id, description: (i.limitations[0] ?? i.id).slice(0, 400), evidenceItemId: i.id, anchorIds: [] as string[] })),
  );

  const records = new Map([...earlierRecords, ...[...wb.extracted.values()].map((e) => [e.stored.id, e.stored] as const)]);
  const snapshots = [...records.values()].map((s: StoredRecord) =>
    snapshotFromRecord({
      record: { id: s.id, sourceId: s.sourceId, retrievedAt: s.retrievedAt, ...(s.sourcePublishedAt ? { sourcePublishedAt: s.sourcePublishedAt } : {}), requestHash: s.requestHash, contentHash: s.contentHash, schemaVersion: s.schemaVersion, license: s.license },
      text: s.text,
      contentKind: s.contentKind,
    }),
  );

  const facts = factsOf([...earlierFacts.values(), ...wb.world.facts]);
  const used = new Set<string>([...snapshots.map((s) => s.sourceId), ...facts.map((f) => f.sourceId)]);
  if (wb.federation.status === "ok") used.add("hospital-policy");
  const sources = sourceRows(run, used);
  const sourceIds = new Set(sources.map((s) => s.id));
  for (const s of snapshots) if (!sourceIds.has(s.sourceId)) throw new Error(`snapshot ${s.id} names source ${s.sourceId}, which has no connector`);

  const federation = wb.federation.reads.map((r) =>
    federationQueryFromResult(r.result, { statement: r.statement, identity: r.identity, at: r.at, sourceIds: [...sourceIds].filter((id) => id === "hospital-policy"), keepResult: true }),
  );

  const modelReplies = (wb.env.model?.calls ?? [])
    .filter((c) => c.response)
    .map((c) => modelReplyFromResponse(c.response!, { id: `${run.runId}:${c.id}`, at: c.at, role: c.role, dataClass: c.dataClass }));

  const egress = [
    ...modelReplies.map((m) => ({
      id: `egress-${m.id}`,
      at: m.at,
      subjectKind: "model" as const,
      subjectId: m.id,
      dataClass: "public" as const,
      route: m.recorded ? ("none" as const) : ("remote" as const),
      decision: "allowed" as const,
      reason: "public-class content only: structured claim fields and regulator, registry and publication text. The vendor claim sentences never enter a prompt.",
    })),
    ...federation.map((q) => ({ id: `egress-${q.queryId}`, at: q.at, subjectKind: "federation" as const, subjectId: q.queryId, dataClass: "public" as const, route: "local" as const, decision: "allowed" as const, reason: "read-only statement run as the agent identity; confidential columns are denied or masked by policy and are not selected" })),
  ];

  const evidenceHistory = [
    ...snapshots.map((s) => ({ kind: "record_retrieved" as const, at: s.retrievedAt, refId: s.id, contentHash: s.contentHash })),
    ...facts.map((f) => ({ kind: "fact_recorded" as const, at: f.recordedAt, refId: f.id })),
    ...sources.map((s) => ({ kind: "source_health_observed" as const, at: s.lastSuccessAt ?? run.finishedAt, refId: s.id, health: s.health })),
  ].map((e, i) => ({ ...e, id: `eh-${i + 1}`, history: "evidence" as const, seq: i + 1 }));

  const ruleVersions = [...new Set(findings.map((f) => f.ruleVersion))].sort();
  return buildDossier(
    {
      run: { mode: config.sample ? "sample" : "live", note: `${run.spec.id}: claims constructed for this demonstration; regulator, registry and publication records are real and carry their retrieval dates` },
      rules: { registryVersion: COMPILER_VERSION, versionsUsed: ruleVersions },
      sources,
      claims: run.results.map((r) => r.compiled),
      findings,
      compilerRuns,
      requirements,
      evidenceItems: [...items.values()],
      anchors: [...new Map([...earlierAnchors, ...asm.anchors.map((a) => [a.id, a] as const)]).values()],
      assertions: [...new Map([...earlierAssertions, ...asm.assertions.map((a) => [a.id, a] as const)]).values()],
      links: input.links,
      facts,
      snapshots,
      federation,
      models: modelReplies,
      egress,
      evidenceHistory,
      decisions: input.decisions,
    },
    { signer: input.signer, clock: { now: () => new Date(run.finishedAt) }, dossierId: `dossier-${run.spec.id}-${sha256Hex(run.finishedAt + run.runId).slice(0, 10)}` },
  );
}
