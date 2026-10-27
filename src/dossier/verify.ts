/**
 * Offline dossier verifier (FR-12, F9).
 *
 * Reads only the bundle. No network, no keys beyond the public key in the manifest, no model. It:
 *   1. recomputes every content hash and compares it with the manifest (a changed byte is named by section and item);
 *   2. checks the Ed25519 signature over the manifest, and the signing key against a pinned set when one is given;
 *   3. checks the closed label set, quote existence (every anchor's text is verbatim in the stored record text),
 *      that every assertion's value and unit are visible in the quote it is anchored to, number tracing, supersession, the decision hash chain, source-served labels, receipt coverage, egress and lineage;
 *   4. re-runs the compiler on the recorded inputs through an injected function and fails if a label differs.
 *
 * What a pass means: the bundle is internally consistent, unchanged since signing, and its labels are reproducible by
 * the compiler that was supplied. It does not mean a finding is clinically correct.
 *
 * Who signed is a separate question and the answer depends on the key. A signature made with a demo key proves integrity
 * only: the demo key is published, so anyone can produce a bundle that passes every check here, including a rewritten
 * record text with matching hashes. Authorship needs a pinned key, supplied as `pinnedKeyIds`; without one the result
 * says "demo key" or "no pinned set" in `signer.trust` and the CLI, judge output and dossier screen repeat it.
 */
import type { ComputeReceipt } from "../ports/index.ts";
import type { Claim, Dimension, EvidenceItem, Finding, Label, Relation } from "../schemas/index.ts";
import { LABELS } from "../schemas/index.ts";
import { canonicalJson, hashOf, sha256Hex } from "../util/canonical.ts";
import { verifyDecisionChain } from "./decisions.ts";
import { JOBS, NS, findingAnchorIds, lineageEventId } from "./lineage.ts";
import { manifestMessage, rootOf } from "./manifest.ts";
import { computeReceiptCoverage } from "./receipts.ts";
import { BodySchema, DOSSIER_FORMAT, DOSSIER_VERSION, ManifestSchema, SECTIONS, SECTION_NAMES } from "./schema.ts";
import type { DossierBody, ModelReply } from "./schema.ts";
import { keyIdOfPublicKey, verifySignature } from "./signer.ts";
import { leafTexts, numbersInPassage, numbersInRendered, traces } from "./trace.ts";
import { assertionValueProblem } from "./value-trace.ts";

// ---------------------------------------------------------------- options and result

export interface RecomputeResult {
  label: Label;
  /** When present, the per-dimension relations are compared too. */
  mechanicalCoverage?: readonly { dimension: Dimension; relation: Relation }[];
}

/**
 * The applicability compiler, injected. The verifier never imports it: the caller passes the same pure function the
 * product used, so a verifier run on a judge's machine uses the code on that machine.
 */
export type RecomputeFn = (claim: Claim, evidence: EvidenceItem[], ruleVersion: string) => RecomputeResult | Promise<RecomputeResult>;

export interface ReceiptVerdict {
  valid: boolean;
  reason?: string;
}

export interface VerifyOptions {
  recompute: RecomputeFn;
  /** Key ids (sha256 of the raw public key, hex) the verifier trusts. When given, any other signer fails. */
  pinnedKeyIds?: readonly string[];
  /** Checks one receipt: signature, key id against the installed application, routed model, request and response hashes. */
  verifyReceipt?: (receipt: ComputeReceipt, reply: ModelReply) => ReceiptVerdict | boolean | Promise<ReceiptVerdict | boolean>;
  /** The federation port's definition of respHash, applied to a stored result. Without it, respHash is not recomputed. */
  federationResultHash?: (result: { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }) => string;
}

export type CheckStatus = "PASS" | "FAIL" | "SKIPPED";

export interface Check {
  id: string;
  section: string;
  status: CheckStatus;
  detail: string;
}

export interface Failure {
  /** The failing item as section/id[/field], or a bundle-level name such as `signature` or `manifest/root`. */
  item: string;
  reason: string;
  /** The check that found it. */
  check: string;
  /** Claims the failure affects. Empty means the whole dossier. */
  claimIds: string[];
}

export interface SignerInfo {
  keyId: string;
  keyStatus: "demo" | "pinned";
  /** true: in the pinned set. false: a pinned set was given and it is not in it. null: no pinned set was given. */
  pinned: boolean | null;
  /** One line a reader can quote. */
  trust: string;
}

export interface VerifyResult {
  ok: boolean;
  /** full: integrity plus semantic checks and a compiler re-run. integrity: hashes, signature and schema only. */
  mode: "full" | "integrity";
  dossierId?: string;
  formatVersion?: string;
  checks: Check[];
  failures: Failure[];
  signer?: SignerInfo;
  /** Skipped checks, so a pass cannot hide what was not run. */
  skipped: string[];
}

// ---------------------------------------------------------------- helpers over untyped input

type Json = Record<string, unknown>;
const ENVELOPE_KEYS = ["format", "formatVersion", "manifest", "signature", "body"];
const SIGNATURE_KEYS = ["algorithm", "value"];
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const arrOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

class Collector {
  readonly checks: Check[] = [];
  readonly failures: Failure[] = [];
  private attribute: (item: string) => string[] = () => [];

  setAttributor(fn: (item: string) => string[]): void {
    this.attribute = fn;
  }

  async run(id: string, section: string, passDetail: string, fn: (fail: (item: string, reason: string) => void) => void | string | Promise<void | string>): Promise<void> {
    let failed = 0;
    const fail = (item: string, reason: string): void => {
      failed += 1;
      this.failures.push({ item, reason, check: id, claimIds: this.attribute(item) });
    };
    let extra: void | string = undefined;
    try {
      extra = await fn(fail);
    } catch (error) {
      fail(section, `the check itself failed to run: ${(error as Error).message}`);
    }
    this.checks.push(
      failed === 0
        ? { id, section, status: "PASS", detail: typeof extra === "string" && extra !== "" ? extra : passDetail }
        : { id, section, status: "FAIL", detail: `${failed} problem${failed === 1 ? "" : "s"} found` },
    );
  }

  skip(id: string, section: string, detail: string): void {
    this.checks.push({ id, section, status: "SKIPPED", detail });
  }
}

/** Maps a failing item to the claims it affects, from the raw body (so it also works before the schema check passes). */
function makeAttributor(body: unknown): (item: string) => string[] {
  if (!isObj(body)) return () => [];
  const findingClaim = new Map<string, string>();
  for (const f of arrOf(body.findings)) if (isObj(f) && str(f.id) && str(f.claimId)) findingClaim.set(f.id as string, f.claimId as string);
  const itemClaims = new Map<string, Set<string>>();
  const anchorClaims = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, claim: string): void => {
    const s = m.get(key) ?? new Set<string>();
    s.add(claim);
    m.set(key, s);
  };
  for (const run of arrOf(body.compilerRuns)) {
    if (!isObj(run)) continue;
    const claim = findingClaim.get(str(run.findingId) ?? "");
    if (claim) for (const id of arrOf(run.evidenceItemIds)) if (typeof id === "string") add(itemClaims, id, claim);
  }
  for (const f of arrOf(body.findings)) {
    if (!isObj(f) || !str(f.claimId)) continue;
    for (const list of [arrOf(f.mechanicalCoverage), arrOf(f.mismatches)]) {
      for (const a of list) if (isObj(a)) for (const id of arrOf(a.anchorIds)) if (typeof id === "string") add(anchorClaims, id, f.claimId as string);
    }
  }
  const itemAnchorIds = new Map<string, string[]>();
  for (const it of arrOf(body.evidenceItems)) {
    if (!isObj(it) || !str(it.id)) continue;
    const ids = [...arrOf(it.anchorIds), ...arrOf(it.results).flatMap((r) => (isObj(r) ? [r.anchorId] : []))].filter((x): x is string => typeof x === "string");
    itemAnchorIds.set(it.id as string, ids);
    for (const claim of itemClaims.get(it.id as string) ?? []) for (const a of ids) add(anchorClaims, a, claim);
  }
  const recordClaims = new Map<string, Set<string>>();
  for (const a of arrOf(body.anchors)) {
    if (!isObj(a) || !str(a.id) || !str(a.recordId)) continue;
    for (const claim of anchorClaims.get(a.id as string) ?? []) add(recordClaims, a.recordId as string, claim);
  }
  const reqClaim = new Map<string, string>();
  for (const r of arrOf(body.requirements)) if (isObj(r) && str(r.id) && str(r.claimId)) reqClaim.set(r.id as string, r.claimId as string);
  const assertionAnchor = new Map<string, string>();
  for (const a of arrOf(body.assertions)) if (isObj(a) && str(a.id) && str(a.anchorId)) assertionAnchor.set(a.id as string, a.anchorId as string);
  const decClaim = new Map<string, string>();
  for (const d of arrOf(body.decisionHistory)) if (isObj(d) && str(d.id) && str(d.claimId)) decClaim.set(d.id as string, d.claimId as string);

  // A lineage event that outputs a finding belongs to that finding's claim.
  const lineageClaims = new Map<string, string[]>();
  for (const e of arrOf(body.lineage)) {
    if (!isObj(e) || !isObj(e.run) || !str(e.run.runId) || !str(e.eventType)) continue;
    const claims = arrOf(e.outputs).flatMap((o) => (isObj(o) && o.namespace === NS.finding ? [findingClaim.get(str(o.name) ?? "")] : [])).filter((c): c is string => c !== undefined);
    if (claims.length > 0) lineageClaims.set(`${e.run.runId}/${e.eventType}`, [...new Set(claims)].sort());
  }

  return (item: string): string[] => {
    if (item.startsWith("lineage/")) return lineageClaims.get(item.slice("lineage/".length)) ?? [];
    const [section, id] = item.split("/");
    if (!section || !id) return [];
    const one = (c: string | undefined): string[] => (c ? [c] : []);
    switch (section) {
      case "claims":
        return [id];
      case "findings":
      case "compilerRuns":
      case "counterexamples":
        return one(findingClaim.get(id));
      case "requirements":
        return one(reqClaim.get(id));
      case "decisionHistory":
        return one(decClaim.get(id));
      case "evidenceItems":
        return [...(itemClaims.get(id) ?? [])].sort();
      case "anchors":
        return [...(anchorClaims.get(id) ?? [])].sort();
      case "assertions":
        return [...(anchorClaims.get(assertionAnchor.get(id) ?? "") ?? [])].sort();
      case "snapshots":
        return [...(recordClaims.get(id) ?? [])].sort();
      default:
        return [];
    }
  };
}

function pathItem(raw: unknown, path: readonly (string | number)[]): string {
  const [section, index, ...rest] = path;
  if (section === undefined) return "body";
  if (index === undefined) return String(section);
  const spec = SECTIONS.find((s) => s.name === section);
  let id: string | number = index;
  if (spec?.kind === "list" && typeof index === "number" && isObj(raw)) {
    const item = arrOf(raw[String(section)])[index];
    id = spec.idOf?.(item) ?? index;
  }
  return [String(section), String(id), ...rest.map(String)].join("/");
}

// ---------------------------------------------------------------- size budget

/**
 * The most values (array elements and object entries, at any depth) a bundle may hold. A real dossier holds tens of
 * thousands (the largest committed one about 24,000) and the HTTP route caps a body at 12 MB, about 240,000 at the density of
 * real dossiers. The schema library collects one issue object for every failing element of an array with no cap, so a few
 * megabytes of `[1,1,1,...]` where records are expected would be turned into hundreds of megabytes of issues. Counting first
 * costs one pass and refuses that before any schema sees it.
 */
export const MAX_BUNDLE_VALUES = 500_000;

/** Counts values iteratively (no recursion, so depth cannot overflow the stack). Stops as soon as the limit is passed. */
function valuesBeyond(root: unknown, limit: number): number | undefined {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      count += v.length;
      for (const x of v) if (x !== null && typeof x === "object") stack.push(x);
    } else if (v !== null && typeof v === "object") {
      const values = Object.values(v as Record<string, unknown>);
      count += values.length;
      for (const x of values) if (x !== null && typeof x === "object") stack.push(x);
    }
    if (count > limit) return count;
  }
  return undefined;
}

// ---------------------------------------------------------------- main

/** Full verification: integrity, signature, semantic checks and a compiler re-run. */
export function verifyDossier(bundle: unknown, options: VerifyOptions): Promise<VerifyResult> {
  return verifyCore(bundle, options, true);
}

export interface IntegrityOptions {
  pinnedKeyIds?: readonly string[];
}

/**
 * Integrity only: hashes, signature and schema. It re-runs nothing, so it cannot say a label is reproducible;
 * the skipped checks are listed in the result. Used by the export guard when no compiler is at hand.
 */
export function verifyIntegrity(bundle: unknown, options: IntegrityOptions = {}): Promise<VerifyResult> {
  return verifyCore(bundle, options, false);
}

async function verifyCore(bundle: unknown, options: Partial<VerifyOptions>, full: boolean): Promise<VerifyResult> {
  const c = new Collector();
  const result = (partial: Partial<VerifyResult> = {}): VerifyResult => ({
    ok: c.failures.length === 0,
    mode: full ? "full" : "integrity",
    checks: c.checks,
    failures: c.failures,
    skipped: c.checks.filter((k) => k.status === "SKIPPED").map((k) => `${k.id}: ${k.detail}`),
    ...partial,
  });

  // ---- size budget, before anything parses the bundle
  let withinBudget = true;
  await c.run("bundle.size", "bundle", `within the ${MAX_BUNDLE_VALUES}-value budget`, (fail) => {
    const over = valuesBeyond(bundle, MAX_BUNDLE_VALUES);
    if (over === undefined) return;
    withinBudget = false;
    fail("bundle", `holds more than ${MAX_BUNDLE_VALUES} values; it is refused unread rather than risk exhausting memory`);
  });
  if (!withinBudget) return result();

  // ---- bundle shell
  let shellOk = true;
  await c.run("bundle.format", "bundle", `format ${DOSSIER_FORMAT} ${DOSSIER_VERSION}`, (fail) => {
    if (!isObj(bundle)) {
      shellOk = false;
      return fail("bundle", "not an object");
    }
    if (bundle.format !== DOSSIER_FORMAT) {
      shellOk = false;
      fail("bundle/format", `expected ${DOSSIER_FORMAT}`);
    }
    if (bundle.formatVersion !== DOSSIER_VERSION) {
      shellOk = false;
      fail("bundle/formatVersion", `unsupported format version ${String((bundle as Json).formatVersion)}; this verifier reads ${DOSSIER_VERSION}`);
    }
    for (const key of ["manifest", "signature", "body"]) {
      if (!isObj((bundle as Json)[key])) {
        shellOk = false;
        fail(key, "missing or not an object");
      }
    }
    // The envelope outside the manifest is not itself signed, so it must carry nothing but the defined fields.
    for (const key of Object.keys(bundle)) if (!ENVELOPE_KEYS.includes(key)) fail(`bundle/${key}`, "field is outside the signed manifest and not part of the format");
    if (isObj(bundle.signature)) {
      for (const key of Object.keys(bundle.signature)) if (!SIGNATURE_KEYS.includes(key)) fail(`signature/${key}`, "field is outside the signed manifest and not part of the format");
    }
  });
  if (!shellOk || !isObj(bundle)) return result();

  const manifestRaw = bundle.manifest as Json;
  const signatureRaw = bundle.signature as Json;
  const bodyRaw = bundle.body as Json;
  c.setAttributor(makeAttributor(bodyRaw));

  // ---- manifest shape
  const manifestParsed = ManifestSchema.safeParse(manifestRaw);
  await c.run("manifest.shape", "manifest", "manifest is well formed", (fail) => {
    if (manifestParsed.success) return;
    for (const issue of manifestParsed.error.issues.slice(0, 8)) fail(["manifest", ...issue.path].join("/"), issue.message);
  });
  const manifest = manifestParsed.success ? manifestParsed.data : undefined;
  const signing = isObj(manifestRaw.signing) ? manifestRaw.signing : undefined;

  // ---- signature
  let signer: SignerInfo | undefined;
  await c.run("signature.valid", "signature", "Ed25519 signature matches the manifest", (fail) => {
    const publicKey = str(signing?.publicKey);
    const value = str(signatureRaw.value);
    if (signatureRaw.algorithm !== "Ed25519") fail("signature", "algorithm must be Ed25519");
    if (!publicKey || !value) return fail("signature", "signature or public key missing");
    // Base64 has spare bits in its last character; requiring the canonical form means no byte of the text can change unnoticed.
    if (Buffer.from(value, "base64").toString("base64") !== value) return fail("signature", "signature is not canonical base64");
    if (Buffer.from(publicKey, "base64").toString("base64") !== publicKey) return fail("manifest/signing/publicKey", "public key is not canonical base64");
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return fail("manifest/signing/publicKey", "not a 32-byte Ed25519 public key");
    if (keyIdOfPublicKey(raw) !== signing?.keyId) fail("manifest/signing/keyId", "key id is not the hash of the public key in the manifest");
    if (!verifySignature(manifestMessage(manifestRaw), value, publicKey)) {
      fail("signature", "signature does not match the manifest: the manifest or the signature was changed after signing");
    }
  });
  await c.run("signature.signer", "signature", "no pinned key set supplied; signer not attributed", (fail) => {
    const keyId = str(signing?.keyId);
    const keyStatus = signing?.keyStatus === "pinned" ? "pinned" : "demo";
    if (!keyId) return;
    const pins = options.pinnedKeyIds;
    const pinned = pins === undefined ? null : pins.includes(keyId);
    const trust =
      pinned === true
        ? `signed by a pinned key (${keyId.slice(0, 16)}); integrity and signer confirmed`
        : keyStatus === "demo"
          ? "demo key: shows the bundle is unchanged since signing, says nothing about who signed it"
          : "bundle claims a pinned key, but no pinned set was supplied to confirm it: integrity only";
    signer = { keyId, keyStatus, pinned, trust };
    if (pinned === false) fail("manifest/signing/keyId", "signing key is not in the pinned set");
    return pinned === true ? `signer is in the pinned set (${keyId.slice(0, 16)})` : undefined;
  });

  // ---- manifest root
  await c.run("manifest.root", "manifest", "root hash matches the section listing", (fail) => {
    if (!isObj(manifestRaw.sections)) return fail("manifest/sections", "missing");
    if (rootOf(manifestRaw.sections) !== manifestRaw.root) fail("manifest/root", "root hash does not match the section listing");
  });

  // ---- section and item hashes
  await c.run("manifest.items", "body", `${SECTIONS.length} sections match the manifest`, (fail) => {
    const listed = isObj(manifestRaw.sections) ? manifestRaw.sections : {};
    for (const spec of SECTIONS) {
      const raw = bodyRaw[spec.name];
      const entry = listed[spec.name];
      if (raw === undefined) fail(spec.name, "section is missing from the body");
      if (!isObj(entry)) {
        fail(`manifest/sections/${spec.name}`, "section is not listed in the manifest");
        continue;
      }
      if (raw === undefined) continue;
      if (spec.kind === "singleton") {
        if (entry.kind !== "singleton") fail(spec.name, "manifest lists this section as a list");
        else if (hashOf(raw) !== entry.sha256) fail(spec.name, "content changed since signing (hash mismatch)");
        continue;
      }
      if (!Array.isArray(raw)) {
        fail(spec.name, "section must be a list");
        continue;
      }
      if (entry.kind !== "list" || !Array.isArray(entry.items)) {
        fail(spec.name, "manifest lists this section as a single value");
        continue;
      }
      const listedHash = new Map<string, unknown>();
      const listedOrder: string[] = [];
      for (const it of entry.items) {
        if (isObj(it) && typeof it.id === "string") {
          listedHash.set(it.id, it.sha256);
          listedOrder.push(it.id);
        }
      }
      const seen = new Set<string>();
      const bodyOrder: string[] = [];
      raw.forEach((item, index) => {
        const id = spec.idOf?.(item);
        if (id === undefined) return fail(`${spec.name}[${index}]`, "item has no usable id");
        if (seen.has(id)) return fail(`${spec.name}/${id}`, "id appears more than once");
        seen.add(id);
        bodyOrder.push(id);
        const want = listedHash.get(id);
        if (want === undefined) fail(`${spec.name}/${id}`, "item is not listed in the manifest (added after signing)");
        else if (hashOf(item) !== want) fail(`${spec.name}/${id}`, "content changed since signing (hash mismatch)");
      });
      for (const id of listedOrder) if (!seen.has(id)) fail(`${spec.name}/${id}`, "item is listed in the manifest but missing from the body (removed after signing)");
      if (bodyOrder.length === listedOrder.length && bodyOrder.every((id) => listedHash.has(id)) && bodyOrder.some((id, i) => id !== listedOrder[i])) {
        fail(spec.name, "item order changed since signing");
      }
    }
    for (const key of Object.keys(bodyRaw)) if (!SECTION_NAMES.includes(key)) fail(`body/${key}`, "section is not part of the format and is not listed in the manifest");
    for (const key of Object.keys(isObj(manifestRaw.sections) ? manifestRaw.sections : {})) {
      if (!SECTION_NAMES.includes(key)) fail(`manifest/sections/${key}`, "manifest lists a section that is not part of the format");
    }
  });

  // ---- closed label set and review-state rule (on raw values, so a tampered label is named as such)
  await c.run("findings.label", "findings", "every label is one of the five", (fail) => {
    for (const f of arrOf(bodyRaw.findings)) {
      if (!isObj(f)) continue;
      const id = str(f.id) ?? "?";
      if (!(LABELS as readonly unknown[]).includes(f.label)) fail(`findings/${id}/label`, `"${String(f.label)}" is not one of the five labels`);
      if (f.reviewerState !== undefined && f.reviewerState !== "unreviewed") {
        fail(`findings/${id}/reviewerState`, "a stored finding is the finding as computed; review state belongs to decisionHistory");
      }
    }
  });

  // ---- schema
  const parsed = BodySchema.safeParse(bodyRaw);
  await c.run("body.schema", "body", "body matches the dossier schema", (fail) => {
    if (parsed.success) return;
    for (const issue of parsed.error.issues.slice(0, 12)) fail(pathItem(bodyRaw, issue.path as (string | number)[]), issue.message);
  });
  if (!parsed.success || !full) {
    const why = parsed.success ? "skipped: integrity-only verification" : "skipped: the body does not match the schema";
    for (const id of SEMANTIC_CHECK_IDS) c.skip(id, "body", why);
    return result(manifest ? { dossierId: manifest.dossierId, formatVersion: manifest.formatVersion, ...(signer ? { signer } : {}) } : signer ? { signer } : {});
  }
  const body = parsed.data;
  await semanticChecks(c, body, options as VerifyOptions);

  return result({ dossierId: str(manifestRaw.dossierId) ?? "", formatVersion: DOSSIER_VERSION, ...(signer ? { signer } : {}) });
}

const SEMANTIC_CHECK_IDS = [
  "refs.integrity",
  "claims.findings",
  "counterexamples.consistent",
  "snapshots.hash",
  "anchors.quote",
  "assertions.values",
  "findings.numbers",
  "evidence.numbers",
  "evidence.scope",
  "findings.supersession",
  "rules.versions",
  "findings.recompute",
  "decisions.chain",
  "history.evidence",
  "models.labels",
  "federation.results",
  "receipts.coverage",
  "receipts.verify",
  "egress.policy",
  "lineage.coherence",
];

// ---------------------------------------------------------------- semantic checks

async function semanticChecks(c: Collector, body: DossierBody, options: VerifyOptions): Promise<void> {
  const claims = new Map(body.claims.map((x) => [x.id, x]));
  const findings = new Map(body.findings.map((x) => [x.id, x]));
  const items = new Map(body.evidenceItems.map((x) => [x.id, x]));
  const anchors = new Map(body.anchors.map((x) => [x.id, x]));
  const snaps = new Map(body.snapshots.map((x) => [x.id, x]));
  const sources = new Map(body.sources.map((x) => [x.id, x]));
  const facts = new Map(body.facts.map((x) => [x.id, x]));
  const models = new Map(body.models.map((x) => [x.id, x]));
  const queries = new Map(body.federation.map((x) => [x.queryId, x]));
  const runs = new Map(body.compilerRuns.map((x) => [x.findingId, x]));

  // ---- references
  await c.run("refs.integrity", "body", "every reference resolves", (fail) => {
    const need = (ok: boolean, item: string, what: string): void => {
      if (!ok) fail(item, what);
    };
    for (const f of body.findings) {
      need(claims.has(f.claimId), `findings/${f.id}`, `claim ${f.claimId} is not in the dossier`);
      need(runs.has(f.id), `findings/${f.id}`, "no compilerRuns entry: the compiler input for this finding was not recorded");
      for (const a of f.mechanicalCoverage) {
        for (const id of a.anchorIds) need(anchors.has(id), `findings/${f.id}/mechanicalCoverage/${a.dimension}`, `anchor ${id} is not in the dossier`);
        for (const id of a.evidenceIds) need(items.has(id), `findings/${f.id}/mechanicalCoverage/${a.dimension}`, `evidence item ${id} is not in the dossier`);
      }
      for (const m of f.mismatches) for (const id of m.anchorIds) need(anchors.has(id), `findings/${f.id}/mismatches/${m.dimension}`, `anchor ${id} is not in the dossier`);
      for (const id of f.dependsOnFacts) need(facts.has(id), `findings/${f.id}`, `fact ${id} is not in the dossier`);
    }
    for (const r of body.compilerRuns) {
      need(findings.has(r.findingId), `compilerRuns/${r.findingId}`, "refers to a finding that is not in the dossier");
      for (const id of r.evidenceItemIds) need(items.has(id), `compilerRuns/${r.findingId}`, `evidence item ${id} is not in the dossier`);
    }
    for (const r of body.requirements) {
      need(claims.has(r.claimId), `requirements/${r.id}`, `claim ${r.claimId} is not in the dossier`);
      need(items.has(r.evidenceItemId), `requirements/${r.id}`, `evidence item ${r.evidenceItemId} is not in the dossier`);
      for (const id of r.anchorIds) need(anchors.has(id), `requirements/${r.id}`, `anchor ${id} is not in the dossier`);
    }
    for (const it of body.evidenceItems) {
      for (const id of it.anchorIds) need(anchors.has(id), `evidenceItems/${it.id}`, `anchor ${id} is not in the dossier`);
      for (const r of it.results) if (r.anchorId !== undefined) need(anchors.has(r.anchorId), `evidenceItems/${it.id}/results/${r.metric}`, `anchor ${r.anchorId} is not in the dossier`);
    }
    for (const a of body.anchors) need(snaps.has(a.recordId), `anchors/${a.id}`, `record ${a.recordId} has no stored snapshot`);
    for (const a of body.assertions) need(anchors.has(a.anchorId), `assertions/${a.id}`, `anchor ${a.anchorId} is not in the dossier`);
    for (const s of body.snapshots) need(sources.has(s.sourceId), `snapshots/${s.id}`, `source ${s.sourceId} is not in the dossier`);
    for (const f of body.facts) {
      need(sources.has(f.sourceId), `facts/${f.id}`, `source ${f.sourceId} is not in the dossier`);
      if (f.anchorId !== undefined) need(anchors.has(f.anchorId), `facts/${f.id}`, `anchor ${f.anchorId} is not in the dossier`);
    }
    for (const q of body.federation) for (const id of q.sourceIds) need(sources.has(id), `federation/${q.queryId}`, `source ${id} is not in the dossier`);
    for (const m of body.models) for (const id of m.inputRecordIds) need(snaps.has(id), `models/${m.id}`, `input record ${id} has no stored snapshot`);
    for (const d of body.decisionHistory) {
      const f = findings.get(d.findingId);
      need(f !== undefined, `decisionHistory/${d.id}`, `finding ${d.findingId} is not in the dossier`);
      if (f) need(f.claimId === d.claimId, `decisionHistory/${d.id}`, `decision names claim ${d.claimId}, the finding belongs to ${f.claimId}`);
    }
  });

  await c.run("claims.findings", "claims", "every claim has at least one finding", (fail) => {
    for (const claim of body.claims) if (!body.findings.some((f) => f.claimId === claim.id)) fail(`claims/${claim.id}`, "no finding was recorded for this claim");
  });

  await c.run("counterexamples.consistent", "counterexamples", "counterexamples match the findings' mismatches", (fail) => {
    const expected = new Map<string, string>();
    for (const f of body.findings) {
      if (f.mismatches.length > 0) expected.set(f.id, canonicalJson({ findingId: f.id, claimId: f.claimId, dimensions: f.mismatches.map((m) => m.dimension), mismatches: f.mismatches }));
    }
    const stored = new Map(body.counterexamples.map((x) => [x.findingId, canonicalJson(x)]));
    for (const [id, want] of expected) {
      if (!stored.has(id)) fail(`counterexamples/${id}`, "the finding has mismatches but no counterexample was recorded");
      else if (stored.get(id) !== want) fail(`counterexamples/${id}`, "does not match the mismatches of its finding");
    }
    for (const id of stored.keys()) if (!expected.has(id)) fail(`counterexamples/${id}`, "refers to a finding with no mismatches");
  });

  // ---- snapshots, quotes
  await c.run("snapshots.hash", "snapshots", `${body.snapshots.length} stored record texts match their hashes`, (fail) => {
    for (const s of body.snapshots) {
      const h = sha256Hex(s.text);
      if (h !== s.textHash) fail(`snapshots/${s.id}`, "stored text does not match its text hash");
      if (s.contentKind === "text" && h !== s.contentHash) fail(`snapshots/${s.id}`, "stored text does not match the record's content hash");
    }
  });

  await c.run("anchors.quote", "anchors", `${body.anchors.length} quotes exist verbatim in their stored records`, (fail) => {
    for (const a of body.anchors) {
      if (sha256Hex(a.text) !== a.textHash) fail(`anchors/${a.id}`, "quote does not match its text hash");
      const snap = snaps.get(a.recordId);
      if (snap && !snap.text.includes(a.text)) fail(`anchors/${a.id}`, `quote is not found verbatim in record ${a.recordId}`);
    }
  });

  // The quote check above shows the quote is in the record. This ties each assertion to its quote, so a value cannot be
  // rewritten (a product code, a sample size, a unit) while the quote, the hashes and the signature stay valid.
  await c.run("assertions.values", "assertions", `${body.assertions.length} assertion values and units are visible in their quotes`, (fail) => {
    for (const a of body.assertions) {
      const quote = anchors.get(a.anchorId)?.text;
      if (quote === undefined) continue; // reported by refs.integrity
      const problem = assertionValueProblem(a, quote);
      if (problem) fail(`assertions/${a.id}/${problem.field}`, `${a.predicate}: ${problem.reason}`);
    }
  });

  // ---- number tracing
  await c.run("findings.numbers", "findings", "every number in a finding traces to a cited anchor or to the claim", (fail) => {
    const anchorNumbers = (ids: Iterable<string>): number[] => [...ids].flatMap((id) => numbersInPassage(anchors.get(id)?.text ?? ""));
    const itemAnchors = (itemIds: readonly string[]): string[] =>
      itemIds.flatMap((id) => {
        const it = items.get(id);
        return it ? [...it.anchorIds, ...it.results.flatMap((r) => (r.anchorId ? [r.anchorId] : []))] : [];
      });
    for (const f of body.findings) {
      const claim = claims.get(f.claimId);
      const claimNumbers = claim ? numbersInPassage(`${claim.text ?? ""} ${leafTexts(claim.use).join(" ")} ${leafTexts(claim.performance).join(" ")}`) : [];
      const findingNumbers = anchorNumbers(findingAnchorIds(f));
      const test = (item: string, rendered: string | undefined, allowed: number[], label: string): void => {
        if (!rendered) return;
        for (const n of numbersInRendered(rendered)) {
          if (!traces(n.value, allowed)) fail(item, `number ${n.token} in ${label} "${rendered}" does not appear in any anchor it cites or in the claim`);
        }
      };
      for (const a of f.mechanicalCoverage) {
        const own = anchorNumbers([...a.anchorIds, ...itemAnchors(a.evidenceIds)]);
        const item = `findings/${f.id}/mechanicalCoverage/${a.dimension}`;
        test(item, a.established, own, "the established value");
        test(item, a.claimed, [...claimNumbers, ...own], "the claimed value");
      }
      for (const m of f.mismatches) {
        const own = anchorNumbers(m.anchorIds);
        const item = `findings/${f.id}/mismatches/${m.dimension}`;
        test(item, m.established, own, "the established value");
        test(item, m.claimed, [...claimNumbers, ...own], "the claimed value");
      }
      if (f.supportedScope) test(`findings/${f.id}/supportedScope`, leafTexts(f.supportedScope).join(" "), [...claimNumbers, ...findingNumbers], "the supported scope");
      for (const r of f.requiredEvidence) test(`findings/${f.id}/requiredEvidence/${r.dimension}`, r.request, [...claimNumbers, ...findingNumbers], "the evidence request");
    }
  });

  await c.run("evidence.numbers", "evidenceItems", "every reported result traces to its anchor", (fail) => {
    for (const it of body.evidenceItems) {
      for (const r of it.results) {
        const item = `evidenceItems/${it.id}/results/${r.metric}`;
        const ids = r.anchorId ? [r.anchorId] : it.anchorIds;
        if (ids.length === 0) {
          fail(item, "result has no anchor");
          continue;
        }
        const passage = ids.flatMap((id) => numbersInPassage(anchors.get(id)?.text ?? ""));
        const values: [string, number | undefined][] = [["value", r.value], ["ci lower", r.ci?.[0]], ["ci upper", r.ci?.[1]], ["n", r.n]];
        for (const [name, v] of values) if (v !== undefined && !traces(v, passage)) fail(item, `${name} ${v} does not appear in the anchor it cites`);
      }
    }
  });

  // The age limits an evidence item states are what the compiler compares a claim with. Each must be stated by a passage the
  // item cites, so a limit cannot be widened or narrowed while the item's results and anchors stay as they were.
  await c.run("evidence.scope", "evidenceItems", "every age limit of an evidence item is stated by an anchor it cites", (fail) => {
    for (const it of body.evidenceItems) {
      const age = it.scope.population?.age;
      if (!age) continue;
      const texts = it.anchorIds.map((id) => anchors.get(id)?.text).filter((x): x is string => x !== undefined);
      for (const [bound, value] of [["min", age.min], ["max", age.max]] as const) {
        if (value === undefined) continue;
        const predicate = bound === "min" ? "population.age_min" : "population.age_max";
        const stated = texts.some((text) => assertionValueProblem({ predicate, value, extractionMethod: "pattern" }, text) === undefined);
        if (!stated) fail(`evidenceItems/${it.id}/scope/population/age/${bound}`, texts.length === 0 ? `age ${bound} ${value} is stated but the item cites no anchor` : `age ${bound} ${value} is not stated in any anchor the item cites`);
      }
    }
  });

  // ---- supersession
  await c.run("findings.supersession", "findings", "supersession chains are linear and carry reasons", (fail) => {
    const index = new Map(body.findings.map((f, i) => [f.id, i]));
    const supersededBy = new Map<string, string>();
    for (const f of body.findings) {
      if (f.supersedes === undefined) {
        if (f.supersedesReason !== undefined) fail(`findings/${f.id}`, "has a supersession reason but supersedes nothing");
        continue;
      }
      const old = findings.get(f.supersedes);
      if (!old) {
        fail(`findings/${f.id}`, `supersedes ${f.supersedes}, which is not in the dossier`);
        continue;
      }
      if (f.supersedes === f.id) fail(`findings/${f.id}`, "supersedes itself");
      if (!f.supersedesReason || f.supersedesReason.trim() === "") fail(`findings/${f.id}`, "supersedes another finding without a reason");
      if (old.claimId !== f.claimId) fail(`findings/${f.id}`, "supersedes a finding of a different claim");
      if ((index.get(f.id) ?? 0) < (index.get(old.id) ?? 0)) fail(`findings/${f.id}`, "appears before the finding it supersedes; history is append-only");
      const prior = supersededBy.get(old.id);
      if (prior !== undefined) fail(`findings/${f.id}`, `${old.id} is already superseded by ${prior}; a finding is superseded once`);
      else supersededBy.set(old.id, f.id);
    }
    for (const f of body.findings) {
      const seen = new Set<string>([f.id]);
      let cur = f.supersedes;
      while (cur !== undefined) {
        if (seen.has(cur)) {
          fail(`findings/${f.id}`, "supersession cycle");
          break;
        }
        seen.add(cur);
        cur = findings.get(cur)?.supersedes;
      }
    }
  });

  // ---- rules
  await c.run("rules.versions", "rules", "every finding's rule version is recorded", (fail) => {
    const used = new Set(body.findings.map((f) => f.ruleVersion));
    const listed = new Set(body.rules.versionsUsed);
    for (const f of body.findings) if (!listed.has(f.ruleVersion)) fail(`findings/${f.id}/ruleVersion`, `rule version ${f.ruleVersion} is not in rules.versionsUsed`);
    for (const v of listed) if (!used.has(v)) fail("rules", `versionsUsed lists ${v}, which no finding was computed under`);
  });

  // ---- recompute
  await c.run("findings.recompute", "findings", `${body.findings.length} labels reproduced by the compiler on the recorded inputs`, async (fail) => {
    for (const f of body.findings) {
      const claim = claims.get(f.claimId);
      const run = runs.get(f.id);
      if (!claim || !run) continue; // reported by refs.integrity
      const evidence = run.evidenceItemIds.map((id) => items.get(id)).filter((x): x is EvidenceItem => x !== undefined);
      if (evidence.length !== run.evidenceItemIds.length) continue; // reported by refs.integrity
      let out: RecomputeResult;
      try {
        out = await options.recompute(structuredClone(claim), structuredClone(evidence), f.ruleVersion);
      } catch (error) {
        fail(`findings/${f.id}`, `the compiler could not re-run this finding under rule version ${f.ruleVersion}: ${(error as Error).message}`);
        continue;
      }
      if (out.label !== f.label) fail(`findings/${f.id}/label`, `recorded ${f.label}, but the compiler on the recorded inputs gives ${out.label}`);
      if (out.mechanicalCoverage) {
        const want = new Map(out.mechanicalCoverage.map((m) => [m.dimension, m.relation]));
        const have = new Map(f.mechanicalCoverage.map((m) => [m.dimension, m.relation]));
        for (const [dim, rel] of want) {
          if (have.get(dim) !== rel) fail(`findings/${f.id}/mechanicalCoverage/${dim}`, `recorded ${have.get(dim) ?? "nothing"}, but the compiler gives ${rel}`);
        }
        for (const dim of have.keys()) if (!want.has(dim)) fail(`findings/${f.id}/mechanicalCoverage/${dim}`, "the compiler produces no assessment for this dimension");
      }
    }
  });

  // ---- decision history and evidence history
  await c.run("decisions.chain", "decisionHistory", `${body.decisionHistory.length} decisions form an intact chain`, (fail) => {
    for (const p of verifyDecisionChain(body.decisionHistory)) fail(`decisionHistory/${p.item}`, p.reason);
  });

  await c.run("history.evidence", "evidenceHistory", `${body.evidenceHistory.length} evidence-history entries are consistent`, (fail) => {
    body.evidenceHistory.forEach((e, i) => {
      const item = `evidenceHistory/${e.id}`;
      if (e.seq !== i + 1) fail(item, `sequence is ${e.seq}, expected ${i + 1}`);
      if (e.kind === "record_retrieved") {
        const s = snaps.get(e.refId);
        if (!s) fail(item, `record ${e.refId} has no stored snapshot`);
        else if (e.contentHash !== undefined && e.contentHash !== s.contentHash) fail(item, "content hash differs from the stored snapshot");
        if (e.supersedes !== undefined && !snaps.has(e.supersedes)) fail(item, `supersedes record ${e.supersedes}, which is not stored; superseded records are kept`);
      } else if (e.kind === "fact_recorded" || e.kind === "fact_superseded") {
        const fact = facts.get(e.refId);
        if (!fact) fail(item, `fact ${e.refId} is not in the dossier`);
        else if (e.kind === "fact_superseded" && fact.supersededAt === undefined) fail(item, "records a supersession, but the fact carries no supersededAt");
        if (e.supersedes !== undefined && !facts.has(e.supersedes)) fail(item, `supersedes fact ${e.supersedes}, which is not kept; superseded facts are kept`);
      } else if (!sources.has(e.refId)) {
        fail(item, `source ${e.refId} is not in the dossier`);
      } else if (e.health === undefined) {
        fail(item, "a source-health entry must say which health was observed");
      }
    });
    for (const f of body.facts) if (f.supersededAt !== undefined && !body.evidenceHistory.some((e) => e.kind === "fact_superseded" && e.refId === f.id)) {
      fail(`facts/${f.id}`, "is marked superseded but the evidence history has no matching entry");
    }
  });

  // ---- served-from labels
  await c.run("models.labels", "models", `${body.models.length} model replies carry consistent live/recorded labels`, (fail) => {
    for (const m of body.models) {
      const item = `models/${m.id}`;
      if (m.provider === "recorded" && !m.recorded) fail(item, "provider is recorded but the reply is not marked recorded");
      if (m.recorded && m.label !== "recorded") fail(item, `reply is recorded but labelled ${m.label}`);
      if (!m.recorded && m.label === "recorded") fail(item, "reply is labelled recorded but is not marked recorded");
      // A replayed reply may carry the ORIGINAL signed receipt of the live call it replays, and then it is checked like any other
      // receipt. What it may not carry is a receipt that is not that: one with no signed envelope, or whose envelope signs a different
      // receipt or model than the one stored. This is a structural check; the signature and the pinned key are checked by the
      // supplied receipt verifier.
      if (m.provider === "nightshift" && !m.recorded && m.receipt === undefined) fail(item, "a live reply labelled nightshift carries no receipt: it is Nightshift's only if its signed receipt is attached");
      if (m.provider === "recorded" && m.receipt !== undefined) {
        const problem = originalReceiptProblem(m.receipt);
        if (problem) fail(item, `a recorded reply carries a receipt that is not the original signed one: ${problem}`);
      }
      if (m.receipt && m.receipt.routedModel !== m.routedModel) fail(item, `receipt routed model ${m.receipt.routedModel} differs from the reply's ${m.routedModel}`);
    }
  });

  await c.run("federation.results", "federation", `${body.federation.length} federation results are labelled and complete`, (fail) => {
    for (const q of body.federation) {
      const item = `federation/${q.queryId}`;
      const want = q.servedFrom === "cassette" ? "recorded" : q.servedFrom === "fallback" ? "fallback" : "live";
      if (q.label !== want) fail(item, `served from ${q.servedFrom} but labelled ${q.label}`);
      if (q.total > q.rowCount) fail(item, `truncated result: ${q.rowCount} of ${q.total} rows; a truncated result cannot back a finding`);
      if (q.result) {
        if (q.result.rows.length !== q.rowCount) fail(item, `stored result has ${q.result.rows.length} rows, record says ${q.rowCount}`);
        if (q.resultDigest === undefined || hashOf(q.result) !== q.resultDigest) fail(item, "stored result does not match its digest");
        if (options.federationResultHash && options.federationResultHash(q.result) !== q.respHash) fail(item, "stored result does not match the hash the federation port returned");
      } else if (q.resultDigest !== undefined) {
        fail(item, "has a result digest but no stored result");
      }
    }
  });

  // ---- receipts
  await c.run("receipts.coverage", "receiptCoverage", describeCoverage(body), (fail) => {
    const expected = computeReceiptCoverage(
      body.models,
      body.assertions.filter((a) => a.extractionMethod === "model").map((a) => a.id),
    );
    if (canonicalJson(expected) !== canonicalJson(body.receiptCoverage)) fail("receiptCoverage", "recorded coverage statistics do not match the model replies");
    for (const id of expected.unreceiptedFieldIds) {
      const covered = body.models.some((m) => m.derives.includes(id));
      if (!covered) fail(`assertions/${id}`, "model-derived field with no recorded model reply: neither a receipt nor an unreceipted label can be shown");
    }
  });

  if (options.verifyReceipt) {
    const verifyReceipt = options.verifyReceipt;
    await c.run("receipts.verify", "models", "every receipt passed the supplied receipt verifier", async (fail) => {
      for (const m of body.models) {
        if (!m.receipt) continue;
        const verdict = await verifyReceipt(structuredClone(m.receipt) as ComputeReceipt, m);
        const ok = typeof verdict === "boolean" ? verdict : verdict.valid;
        if (!ok) fail(`models/${m.id}`, `receipt ${m.receipt.receiptId} rejected${typeof verdict === "object" && verdict.reason ? `: ${verdict.reason}` : ""}`);
      }
    });
  } else {
    c.skip("receipts.verify", "models", "no receipt verifier supplied: receipt signatures, key ids and hashes were not checked");
  }

  // ---- egress
  await c.run("egress.policy", "egress", "no PHI present; vendor-confidential content left only with consent or a local lane", (fail) => {
    for (const s of body.sources) if (s.dataClass === "phi") fail(`sources/${s.id}`, "PHI must never be present in a dossier");
    for (const e of body.egress) {
      if (e.dataClass === "phi") fail(`egress/${e.id}`, "PHI must never be present in a dossier");
      if (e.decision === "consented" && !e.consentRef) fail(`egress/${e.id}`, "consent recorded without a consent reference");
      if (e.decision === "local_lane" && e.route === "remote") fail(`egress/${e.id}`, "local-lane decision with a remote route");
      const exists =
        e.subjectKind === "model" ? models.has(e.subjectId) : e.subjectKind === "federation" ? queries.has(e.subjectId) : e.subjectKind === "connector" ? sources.has(e.subjectId) : true;
      if (!exists) fail(`egress/${e.id}`, `refers to ${e.subjectKind} ${e.subjectId}, which is not in the dossier`);
    }
    for (const m of body.models) {
      const item = `models/${m.id}`;
      if (m.dataClass === "phi") fail(item, "PHI must never be present in a dossier");
      if (m.dataClass === "vendor-confidential" && m.provider !== "recorded") {
        const decisions = body.egress.filter((e) => e.subjectKind === "model" && e.subjectId === m.id);
        if (!decisions.some((e) => e.decision === "consented" || e.decision === "local_lane")) fail(item, "vendor-confidential content went to a model with no recorded consent or local-lane decision");
        if (decisions.some((e) => e.decision === "blocked")) fail(item, "a reply exists for a call the egress policy blocked");
      }
    }
  });

  // ---- lineage
  await c.run("lineage.coherence", "lineage", `${body.lineage.length} lineage events trace each finding to its anchors and rule version`, (fail) => {
    const starts = new Map<string, number>();
    const terminals = new Map<string, number>();
    body.lineage.forEach((e, i) => {
      const id = lineageEventId(e);
      if (e.eventType === "START") starts.set(e.run.runId, i);
      else if (e.eventType === "COMPLETE" || e.eventType === "FAIL" || e.eventType === "ABORT") {
        if (terminals.has(e.run.runId)) fail(`lineage/${id}`, "run has more than one terminal event");
        terminals.set(e.run.runId, i);
      }
    });
    for (const [runId, i] of starts) {
      const t = terminals.get(runId);
      if (t === undefined) fail(`lineage/${runId}/START`, "run started and never finished");
      else if (t < i) fail(`lineage/${runId}/${(body.lineage[t] as { eventType: string }).eventType}`, "terminal event precedes the start event");
    }
    for (const runId of terminals.keys()) if (!starts.has(runId)) fail(`lineage/${runId}`, "terminal event without a start event");

    const known: Record<string, ReadonlyMap<string, unknown>> = {
      [NS.record]: snaps,
      [NS.evidence]: items,
      [NS.finding]: findings,
      [NS.federation]: queries,
      [NS.source]: sources,
      [NS.claim]: claims,
    };
    for (const e of body.lineage) {
      for (const d of [...e.inputs, ...e.outputs]) {
        const map = known[d.namespace];
        if (map && !map.has(d.name)) fail(`lineage/${lineageEventId(e)}`, `dataset ${d.namespace}/${d.name} is not in the dossier`);
      }
    }

    for (const f of body.findings) {
      const event = body.lineage.find((e) => e.eventType === "COMPLETE" && e.job.name === JOBS.compile && e.outputs.some((o) => o.namespace === NS.finding && o.name === f.id));
      if (!event) {
        fail(`findings/${f.id}`, "no lineage event records how this finding was produced");
        continue;
      }
      const eid = `lineage/${lineageEventId(event)}`;
      const out = event.outputs.find((o) => o.namespace === NS.finding && o.name === f.id);
      const ruleFacet = event.job.facets?.sakaime_ruleVersion;
      if (!ruleFacet || ruleFacet.ruleVersion !== f.ruleVersion) fail(eid, `lineage rule version ${String(ruleFacet?.ruleVersion)} differs from the finding's ${f.ruleVersion}`);
      const lf = out?.facets?.sakaime_finding;
      if (!lf || lf.label !== f.label || lf.claimId !== f.claimId) fail(eid, "lineage output does not carry the finding's label and claim");
      const want = findingAnchorIds(f).map((id) => `${id}:${anchors.get(id)?.textHash ?? ""}`).sort();
      const got = (Array.isArray(out?.facets?.sakaime_anchors?.anchors) ? (out?.facets?.sakaime_anchors?.anchors as { anchorId?: string; textHash?: string }[]) : []).map((a) => `${a.anchorId}:${a.textHash}`).sort();
      if (canonicalJson(want) !== canonicalJson(got)) fail(eid, "lineage anchors differ from the anchors the finding cites");
    }
  });
}

function describeCoverage(body: DossierBody): string {
  const cov = body.receiptCoverage;
  const pct = cov.coverage === null ? "no model-derived fields" : `${Math.round(cov.coverage * 100)}% of model-derived fields receipted`;
  return `receipt coverage recomputed: ${pct} (${cov.fields.receipted} of ${cov.fields.total}); ${cov.replies.recorded} recorded, ${cov.replies.live} live replies`;
}

/**
 * Whether a receipt stored with a replayed reply is structurally the signed receipt of a live call: it holds the signed envelope,
 * and what the envelope signs is the receipt id and the model the stored receipt names. Returns the problem, or undefined.
 */
function originalReceiptProblem(receipt: ComputeReceipt): string | undefined {
  const raw = receipt.raw as Record<string, unknown> | null | undefined;
  const envelope = raw && typeof raw === "object" ? (raw["envelope"] as Record<string, unknown> | undefined) : undefined;
  if (!envelope || typeof envelope !== "object") return "it holds no signed envelope";
  if (typeof envelope["sig_b64"] !== "string" || typeof envelope["pubkey_b64"] !== "string") return "its envelope has no signature or public key";
  const body = envelope["body"] as Record<string, unknown> | undefined;
  const signed = body && typeof body === "object" ? (body["receipt"] as Record<string, unknown> | undefined) : undefined;
  if (!signed || typeof signed !== "object") return "its envelope signs no receipt";
  if (signed["receipt_id"] !== receipt.receiptId) return "the envelope signs a different receipt id";
  const route = signed["winning_route"] as Record<string, unknown> | undefined;
  if (!route || route["model"] !== receipt.routedModel) return "the envelope signs a different model";
  return undefined;
}
