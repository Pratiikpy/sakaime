/**
 * Dossier builder: validates the parts, derives the sections that are functions of the others (counterexamples,
 * receipt coverage, lineage), writes the manifest and signs it.
 *
 * The builder checks shape, not truth. It will sign a finding whose label the compiler would not reproduce;
 * catching that is the verifier's job (it re-runs the compiler), and keeping the two separate is what lets the
 * tests show the verifier catching a re-signed, internally consistent forgery.
 */
import type { Clock } from "../ports/index.ts";
import { canonicalJson, hashOf } from "../util/canonical.ts";
import type { Claim, EvidenceAnchor, EvidenceAssertion, EvidenceItem, Fact, Finding, Link, Source } from "../schemas/index.ts";
import { DecisionLog } from "./decisions.ts";
import { deriveLineage } from "./derive-lineage.ts";
import type { LineageEvent } from "./lineage.ts";
import { buildManifestSections, manifestMessage, rootOf } from "./manifest.ts";
import { computeReceiptCoverage } from "./receipts.ts";
import { BodySchema, DOSSIER_FORMAT, DOSSIER_VERSION, DossierBundleSchema, SIGNATURE_STATEMENT } from "./schema.ts";
import type {
  CompilerRun,
  Counterexample,
  DecisionEntry,
  DossierBody,
  DossierBundle,
  EgressDecision,
  EvidenceHistoryEntry,
  FederationQuery,
  Manifest,
  ModelReply,
  Requirement,
  RulesInfo,
  RunInfo,
  Snapshot,
} from "./schema.ts";
import type { DossierSigner } from "./signer.ts";

export interface DossierInput {
  run: RunInfo;
  /** versionsUsed defaults to the distinct rule versions of the findings. */
  rules: Omit<RulesInfo, "versionsUsed"> & { versionsUsed?: string[] };
  sources: Source[];
  claims: Claim[];
  findings: Finding[];
  /** One per finding: the evidence items the compiler read for it. */
  compilerRuns: CompilerRun[];
  requirements?: Requirement[];
  evidenceItems: EvidenceItem[];
  anchors: EvidenceAnchor[];
  assertions?: EvidenceAssertion[];
  links?: Link[];
  facts?: Fact[];
  snapshots: Snapshot[];
  federation?: FederationQuery[];
  models?: ModelReply[];
  egress?: EgressDecision[];
  evidenceHistory?: EvidenceHistoryEntry[];
  /** A decision log, or its stored entries. */
  decisions?: DecisionLog | DecisionEntry[];
  /** Events from a LineageEmitter used during the run. Derived from the contents when omitted. */
  lineage?: LineageEvent[];
}

export interface BuildOptions {
  signer: DossierSigner;
  clock: Clock;
  /** Defaults to a value derived from the manifest root, so identical content gives an identical id. */
  dossierId?: string;
}

export class DossierBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DossierBuildError";
  }
}

function counterexamplesOf(findings: readonly Finding[]): Counterexample[] {
  return findings
    .filter((f) => f.mismatches.length > 0)
    .map((f) => ({ findingId: f.id, claimId: f.claimId, dimensions: f.mismatches.map((m) => m.dimension), mismatches: f.mismatches }));
}

export function buildDossier(input: DossierInput, options: BuildOptions): DossierBundle {
  const createdAt = options.clock.now().toISOString();

  // A stored finding is the finding as computed. Review state lives in decisionHistory, so the cached field is reset.
  const findings = input.findings.map((f) => ({ ...f, reviewerState: "unreviewed" as const }));
  const decisions = input.decisions instanceof DecisionLog ? input.decisions.entries() : (input.decisions ?? []);
  const assertions = input.assertions ?? [];
  const models = input.models ?? [];
  const versionsUsed = input.rules.versionsUsed ?? [...new Set(findings.map((f) => f.ruleVersion))].sort();

  const partial = {
    run: input.run,
    rules: { ...input.rules, versionsUsed },
    sources: input.sources,
    claims: input.claims,
    findings,
    compilerRuns: input.compilerRuns,
    counterexamples: counterexamplesOf(findings),
    requirements: input.requirements ?? [],
    evidenceItems: input.evidenceItems,
    anchors: input.anchors,
    assertions,
    links: input.links ?? [],
    facts: input.facts ?? [],
    snapshots: input.snapshots,
    federation: input.federation ?? [],
    models,
    receiptCoverage: computeReceiptCoverage(
      models,
      assertions.filter((a) => a.extractionMethod === "model").map((a) => a.id),
    ),
    egress: input.egress ?? [],
    evidenceHistory: input.evidenceHistory ?? [],
    decisionHistory: decisions,
  };

  // Parse first so defaults are applied before anything is hashed, then derive lineage from the parsed contents.
  const parsedPartial = BodySchema.omit({ lineage: true }).safeParse(partial);
  if (!parsedPartial.success) {
    throw new DossierBuildError(`dossier input is malformed: ${parsedPartial.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`).join("; ")}`);
  }
  const lineage = input.lineage ?? deriveLineage(parsedPartial.data, createdAt);
  const parsedBody = BodySchema.safeParse({ ...parsedPartial.data, lineage });
  if (!parsedBody.success) {
    throw new DossierBuildError(`dossier input is malformed: ${parsedBody.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`).join("; ")}`);
  }
  const body: DossierBody = parsedBody.data;

  let sections;
  try {
    sections = buildManifestSections(body);
  } catch (error) {
    throw new DossierBuildError((error as Error).message);
  }
  assertUniqueIds(sections);
  const root = rootOf(sections);

  const manifest: Manifest = {
    format: DOSSIER_FORMAT,
    formatVersion: DOSSIER_VERSION,
    dossierId: options.dossierId ?? `dossier-${root.slice(0, 16)}`,
    createdAt,
    sections,
    root,
    signing: {
      algorithm: "Ed25519",
      keyId: options.signer.keyId,
      keyStatus: options.signer.keyStatus,
      publicKey: options.signer.publicKeyB64,
      statement: SIGNATURE_STATEMENT,
    },
  };

  const bundle = {
    format: DOSSIER_FORMAT,
    formatVersion: DOSSIER_VERSION,
    manifest,
    signature: { algorithm: "Ed25519" as const, value: options.signer.sign(manifestMessage(manifest)) },
    body,
  };
  return DossierBundleSchema.parse(bundle);
}

function assertUniqueIds(sections: ReturnType<typeof buildManifestSections>): void {
  for (const [name, entry] of Object.entries(sections)) {
    if (entry.kind !== "list") continue;
    const seen = new Set<string>();
    for (const item of entry.items) {
      if (seen.has(item.id)) throw new DossierBuildError(`section ${name} has two items with id ${item.id}`);
      seen.add(item.id);
    }
  }
}

/** Stable text form: keys sorted at every level, two-space indent, trailing newline. Same bundle, same bytes. */
export function serializeDossier(bundle: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(bundle)), null, 2)}\n`;
}

export function dossierContentHash(bundle: unknown): string {
  return hashOf(bundle);
}
