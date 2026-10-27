/**
 * Arm V: the Sakaime pipeline from documents to a finding.
 *
 *   FDA summary text ──► parseFdaSummary ──► verified assertions ──► toEvidenceItems ─┐
 *   candidate studies and publications ──► identity resolver (STUDY_EVALUATES) ───────┤──► normalise ──► compile
 *                                          (keeps the records that belong to the device)
 *
 * The adapter between the stages (vocabulary, which dimensions the claim needs, the hospital policy) is the only place a choice is
 * made on top of the product's modules. It is small, fixed, hashed (ADAPTER_HASH) and written down in `ADAPTER` below.
 */
import { compileDetailed, DEFAULT_PURPOSE_TAXONOMY, Hierarchy, type CompileOptions } from "../../src/compiler/index.ts";
import { parseFdaSummary } from "../../src/extraction/fda-summary.ts";
import { toEvidenceItems } from "../../src/extraction/to-evidence.ts";
import { documentFromText } from "../../src/extraction/document.ts";
import { ClaimSchema, EvidenceItemSchema, type Claim, type Dimension, type EvidenceItem, type Finding } from "../../src/schemas/index.ts";
import { hashOfJson, readJson } from "./core.ts";
import type { ArmOutput, EvalCase } from "./types.ts";
import type { Retrieval } from "./documents.ts";
import {
  EXTRACTED_PURPOSE,
  EXTRACTED_SETTING,
  PURPOSE_PRIORITY,
  VOCABULARY_HASH,
  mapClaimPurpose,
  mapClaimSettings,
} from "./vocabulary.ts";

/** The adapter's decisions, in words. A change here is a new adapter hash and, after the first held-out run, an erratum. */
export const ADAPTER = {
  version: "1",
  requiredDimensions:
    "The dimensions the claim states: product always, version, setting, purpose and timing when the claim names them, population when it states an age, conditions or exclusions, metric when it states a performance. A dimension the claim is silent on is not asserted (ANSWER-KEY.md, semantics 1).",
  dependencies:
    "Every claim declares an authorization record and a study as required: the question is always whether the authorization and the evidence the regulator reviewed (or the published study) cover the use. Without the declaration the compiler lets only the authorization support a dimension when the claim states no number.",
  stalenessWindowDays: 1095,
  stalenessWindowNote: "A hospital policy supplied to every arm, 3 years, an assumption and not a standard; a case may carry its own.",
  versionsFromSameDocument: true,
  versionsNote: "A study item in an FDA summary inherits the version strings written elsewhere in the same summary. The inference is recorded on the item.",
  purposeFromExtraction: "Extracted purpose terms are mapped to taxonomy nodes (vocabulary.ts); the broadest node wins, then a fixed priority.",
  sourceHealth: "All sources reported OK: the fault drills of FailureShift test the other states.",
  computedAt: "2026-10-27T00:00:00.000Z",
} as const;

const ADAPTER_DEPENDENCIES = { required: ["authorization", "study"], corroborating: [] } as const;

export const ADAPTER_HASH = hashOfJson({ ADAPTER, VOCABULARY_HASH, deps: ADAPTER_DEPENDENCIES });

export interface VConfig {
  /** `on`: only candidates the identity resolver links are read. `off`: every candidate a name search returns. */
  identity: "on" | "off";
  /** `compare`: claimed conditions are compared with extracted conditions (the extraction layer extracts none). `ignore`: diagnostic variant. */
  conditions: "compare" | "ignore";
  /** `extracted`: evidence from the extraction layer. `hand`: the Gate 0 key's hand-written items (leaks the key's encoding; M1). */
  evidence: "extracted" | "hand";
  /** `declared`: the claim names authorization and study as required. `default`: the compiler's own default (authorization, plus a study when the claim states a number). */
  dependencies?: "declared" | "default";
}

export const V_FULL: VConfig = { identity: "on", conditions: "compare", evidence: "extracted" };

export interface VRun {
  finding: Finding | null;
  error?: string;
  items: EvidenceItem[];
  /** anchor id to the verbatim passage it points at. */
  anchors: Map<string, string>;
  usedRecords: string[];
  excludedRecords: string[];
  reasons: Record<string, string>;
}

const PURPOSE_TERMS = Object.keys(EXTRACTED_PURPOSE).sort((a, b) => b.length - a.length);
const purposeH = new Hierarchy(DEFAULT_PURPOSE_TAXONOMY);

/** to-evidence joins several purpose terms into one underscore string; this splits it back along the controlled list. */
export function splitPurposeTerms(joined: string): string[] {
  let rest = joined;
  const found: string[] = [];
  for (const term of PURPOSE_TERMS) {
    const token = term.replace(/\s+/g, "_");
    if (rest.includes(token)) {
      found.push(term);
      rest = rest.replace(token, "|");
    }
  }
  const leftover = rest.split("|").map((x) => x.replace(/^_+|_+$/g, "")).filter(Boolean);
  return [...found, ...leftover];
}

export function pickPurpose(terms: string[]): string | undefined {
  if (terms.length === 0) return undefined;
  const mapped = [...new Set(terms.map((t) => EXTRACTED_PURPOSE[t] ?? t))];
  const maximal = purposeH.maximal(mapped);
  if (maximal.length === 1) return maximal[0];
  for (const p of PURPOSE_PRIORITY) if (maximal.includes(p)) return p;
  return maximal[0];
}

export function normaliseExtracted(item: EvidenceItem): EvidenceItem {
  const scope = { ...item.scope };
  if (scope.settings) scope.settings = [...new Set(scope.settings.map((s) => EXTRACTED_SETTING[s] ?? s))];
  if (scope.purpose) {
    const purpose = pickPurpose(splitPurposeTerms(scope.purpose));
    if (purpose) scope.purpose = purpose;
  }
  return EvidenceItemSchema.parse({ ...item, scope });
}

function normaliseHand(item: EvidenceItem): EvidenceItem {
  const scope = { ...item.scope };
  if (scope.settings) scope.settings = mapClaimSettings(scope.settings) ?? scope.settings;
  if (scope.purpose) scope.purpose = mapClaimPurpose(scope.purpose) ?? scope.purpose;
  return EvidenceItemSchema.parse({ ...item, scope });
}

export function adaptClaim(c: EvalCase, cfg: VConfig): { claim: Claim; required: Dimension[] } {
  const use: Record<string, unknown> = { ...(c.claim.use as Record<string, unknown>) };
  const purpose = mapClaimPurpose(use["purpose"] as string | undefined);
  if (purpose !== undefined) use["purpose"] = purpose;
  const settings = mapClaimSettings(use["settings"] as string[] | undefined);
  if (settings !== undefined) use["settings"] = settings;
  if (cfg.conditions === "ignore" && use["population"]) {
    const { conditions: _dropped, ...rest } = use["population"] as Record<string, unknown>;
    if (Object.keys(rest).length === 0) delete use["population"];
    else use["population"] = rest;
  }
  const claim = ClaimSchema.parse({ ...c.claim, use, ...(cfg.dependencies === "default" ? {} : { dependencies: ADAPTER_DEPENDENCIES }) });
  const required: Dimension[] = ["product"];
  const u = claim.use;
  if (u.versions?.length) required.push("version");
  const p = u.population;
  if (p && (p.age || p.conditions?.length || p.exclusions?.length)) required.push("population");
  if (u.settings?.length) required.push("setting");
  if (u.purpose) required.push("purpose");
  if (u.timing?.from) required.push("timing");
  if (claim.performance) required.push("metric");
  return { claim, required };
}

let handCache: { byId: Map<string, EvidenceItem>; anchors: Map<string, string> } | undefined;

function hand(): NonNullable<typeof handCache> {
  if (handCache) return handCache;
  const raw = readJson<{ items: (Record<string, unknown> & { id: string; anchors?: { id: string; text?: string; quote?: string }[] })[] }>(
    new URL("../gate0/evidence-sets.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  );
  const byId = new Map<string, EvidenceItem>();
  const anchors = new Map<string, string>();
  for (const it of raw.items) {
    const { anchors: a, ...rest } = it;
    const ids = (a ?? []).map((x) => x.id);
    (a ?? []).forEach((x) => anchors.set(x.id, x.quote ?? x.text ?? ""));
    byId.set(it.id, EvidenceItemSchema.parse({ ...rest, anchorIds: ids }));
  }
  handCache = { byId, anchors };
  return handCache;
}

export async function runV(c: EvalCase, retrieval: Retrieval, cfg: VConfig, handSetIds: string[] = []): Promise<VRun> {
  const anchors = new Map<string, string>();
  const usedRecords: string[] = [];
  const excludedRecords: string[] = [];
  let items: EvidenceItem[] = [];
  try {
    if (cfg.evidence === "hand") {
      const h = hand();
      for (const id of handSetIds) {
        const it = h.byId.get(id);
        if (!it) throw new Error(`no hand-written evidence item ${id}`);
        items.push(normaliseHand(it));
      }
      for (const [k, v] of h.anchors) anchors.set(k, v);
      usedRecords.push(...handSetIds);
    } else {
      const fda = await parseFdaSummary(documentFromText(retrieval.fda.id, retrieval.fda.text));
      for (const k of fda.extraction.kept) anchors.set(k.anchor.id, k.anchor.text);
      const absentFields = Object.entries(fda.fields)
        .filter(([, v]) => v.status === "absent")
        .map(([k]) => k);
      items.push(...toEvidenceItems(fda.extraction.kept, { absentFields, versionsFromSameDocument: ADAPTER.versionsFromSameDocument }).items);
      usedRecords.push(retrieval.fda.id);
      for (const cand of retrieval.candidates) {
        const link = cfg.identity === "off" || cand.verdict === "LINK";
        if (!link) {
          excludedRecords.push(cand.recordId);
          continue;
        }
        for (const k of cand.kept) anchors.set(k.anchor.id, k.anchor.text);
        const conv = toEvidenceItems(cand.kept, { versionsFromSameDocument: ADAPTER.versionsFromSameDocument }).items;
        // The identity layer (or, with it off, the name search) is what attaches the record to the product.
        for (const it of conv) items.push(EvidenceItemSchema.parse({ ...it, scope: { ...it.scope, product: retrieval.product } }));
        usedRecords.push(cand.recordId);
      }
      items = items.map(normaliseExtracted);
    }
    const { claim, required } = adaptClaim(c, cfg);
    const options: CompileOptions = {
      requiredDimensions: required,
      policy: { stalenessWindowDays: c.policy?.stalenessWindowDays ?? ADAPTER.stalenessWindowDays },
      traceId: c.id,
      computedAt: ADAPTER.computedAt,
    };
    const detail = compileDetailed(claim, items, options);
    const reasons: Record<string, string> = {};
    for (const r of detail.reasons) reasons[r.dimension] = `${r.relation}: ${r.text}`;
    return { finding: detail.finding, items, anchors, usedRecords, excludedRecords, reasons };
  } catch (err) {
    return { finding: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), items, anchors, usedRecords, excludedRecords, reasons: {} };
  }
}

export function toArmOutput(run: VRun): ArmOutput {
  if (!run.finding) return { label: null, status: "unavailable", mismatches: [], detail: run.error ?? "no finding" };
  const f = run.finding;
  return {
    label: f.label,
    status: "ok",
    mismatches: f.mismatches.map((m) => ({
      dimension: m.dimension,
      ...(m.claimed ? { claimed: m.claimed } : {}),
      ...(m.established ? { established: m.established } : {}),
      anchored: m.anchorIds.length > 0 && m.anchorIds.every((a) => run.anchors.has(a)),
    })),
    citations: f.mismatches.flatMap((m) => m.anchorIds),
  };
}
