/**
 * The Planner's rule plan and the checks on a model's suggestion for it.
 *
 * The rule plan is what any case needs: the regulator's record by submission number, the device records, the decision
 * summary, then (once the summary has been read) the studies it cites, and searches for further studies and papers by vendor,
 * product and condition. A model may suggest up to two more searches. A suggestion is kept only if it names a source the
 * plan may use, a vendor and product the case already names, and a condition that is a plain phrase; everything else is
 * dropped and counted. The model chooses among searches; it cannot add an action.
 */
import { buildSearchQueries, cleanTerm } from "../identity/index.ts";
import type { CaseSpec } from "../service/cases.ts";
import type { ReadStep } from "../service/reader.ts";

export const DISCOVERY_SOURCES = ["clinicaltrials-v2", "pubmed-eutils", "europepmc"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["subQuestions", "extraSearches"],
  properties: {
    subQuestions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
    extraSearches: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "vendor", "product", "reason"],
        properties: {
          source: { type: "string", enum: [...DISCOVERY_SOURCES] },
          vendor: { type: "string", maxLength: 80 },
          product: { type: "string", maxLength: 80 },
          condition: { type: "string", maxLength: 60 },
          reason: { type: "string", maxLength: 200 },
        },
      },
    },
  },
};

export interface PlanRefusal {
  reason: string;
  message: string;
}

/** The searches by vendor, product and condition, or the reason none can be built. */
export function discoveryQueries(spec: CaseSpec): { ok: true; query: Record<string, string> } | { ok: false; refusal: PlanRefusal } {
  const plan = buildSearchQueries({ vendor: spec.vendor.name, vendorAliases: spec.vendor.aliases, product: spec.product.name, ...(spec.product.condition ? { condition: spec.product.condition } : {}) });
  if (!plan.ok) return { ok: false, refusal: { reason: plan.reason, message: plan.message } };
  return { ok: true, query: { vendor: spec.vendor.name, product: spec.product.name, ...(spec.product.condition ? { condition: spec.product.condition } : {}) } };
}

/** The steps every case starts with. The decision summary is read separately, as a document. */
export function initialSteps(spec: CaseSpec): ReadStep[] {
  const steps: ReadStep[] = [
    { id: "regulator-record", source: "openfda-510k", query: { k_number: spec.submission }, why: `the regulator's record for ${spec.submission}: applicant, decision date, product code`, kind: "primary" },
    { id: "device-records", source: "openfda-udi", query: { submission_number: spec.submission }, why: `the marketed release labels filed under ${spec.submission}`, kind: "primary" },
  ];
  return steps;
}

export function discoverySteps(spec: CaseSpec): { steps: ReadStep[]; refusal?: PlanRefusal } {
  const q = discoveryQueries(spec);
  if (!q.ok) return { steps: [], refusal: q.refusal };
  return {
    steps: DISCOVERY_SOURCES.map((source) => ({
      id: `search-${source}`,
      source,
      query: q.query,
      why: `studies and papers that name ${spec.vendor.name} ${spec.product.name}${spec.product.condition ? ` and ${spec.product.condition}` : ""}`,
      kind: "discovery" as const,
    })),
  };
}

export function followupSteps(nct: string): ReadStep[] {
  return [
    { id: `study-${nct}`, source: "clinicaltrials-v2", query: { nct_id: nct }, why: `the registry record of ${nct}, which the regulator's summary cites`, kind: "followup" },
    { id: `papers-${nct}`, source: "pubmed-eutils", query: { nct_id: nct }, why: `papers that cite ${nct}`, kind: "followup" },
  ];
}

export const candidateStudyStep = (nct: string): ReadStep => ({ id: `candidate-${nct}`, source: "clinicaltrials-v2", query: { nct_id: nct }, why: `a registry study that may concern this product (${nct})`, kind: "candidate" });
export const paperStep = (pmid: string, kind: ReadStep["kind"]): ReadStep => ({ id: `paper-${pmid}`, source: "pubmed-eutils", query: { pmid }, why: kind === "followup" ? `a paper that cites a cited study (${pmid})` : `a paper that may concern this product (${pmid})`, kind });

export interface ModelSuggestion {
  subQuestions: string[];
  extra: ReadStep[];
  dropped: { reason: string; text: string }[];
}

/** Keeps only the suggestions that pass the checks. Anything else is dropped with its reason. */
export function vetSuggestion(raw: unknown, spec: CaseSpec, existing: readonly ReadStep[]): ModelSuggestion {
  const out: ModelSuggestion = { subQuestions: [], extra: [], dropped: [] };
  const obj = raw as { subQuestions?: unknown; extraSearches?: unknown } | null;
  if (!obj || typeof obj !== "object") return { ...out, dropped: [{ reason: "the reply was not a JSON object", text: "" }] };
  if (Array.isArray(obj.subQuestions)) out.subQuestions = obj.subQuestions.filter((q): q is string => typeof q === "string").map((q) => q.trim().slice(0, 200)).filter(Boolean).slice(0, 6);
  const vendors = [spec.vendor.name, ...spec.vendor.aliases].map((v) => cleanTerm(v).toLowerCase());
  const products = [spec.product.name].map((v) => cleanTerm(v).toLowerCase());
  const seen = new Set(existing.map((s) => `${s.source}|${JSON.stringify(s.query)}`));
  for (const e of (Array.isArray(obj.extraSearches) ? obj.extraSearches : []).slice(0, 2)) {
    const s = e as Record<string, unknown>;
    const text = JSON.stringify(s).slice(0, 160);
    const source = s["source"];
    if (typeof source !== "string" || !(DISCOVERY_SOURCES as readonly string[]).includes(source)) {
      out.dropped.push({ reason: "the source is not one the plan may search", text });
      continue;
    }
    const vendor = cleanTerm(typeof s["vendor"] === "string" ? s["vendor"] : "");
    const product = cleanTerm(typeof s["product"] === "string" ? s["product"] : "");
    if (!vendors.includes(vendor.toLowerCase()) || !products.includes(product.toLowerCase())) {
      out.dropped.push({ reason: "the vendor and product are not the ones this case names", text });
      continue;
    }
    const condition = cleanTerm(typeof s["condition"] === "string" ? s["condition"] : "");
    const query: Record<string, string> = { vendor, product, ...(condition ? { condition } : {}) };
    const key = `${source}|${JSON.stringify(query)}`;
    if (seen.has(key)) {
      out.dropped.push({ reason: "the search is already in the plan", text });
      continue;
    }
    seen.add(key);
    out.extra.push({ id: `suggested-${source}-${out.extra.length + 1}`, source, query, why: typeof s["reason"] === "string" ? s["reason"].slice(0, 200) : "suggested by the planner model", kind: "discovery" });
  }
  return out;
}
