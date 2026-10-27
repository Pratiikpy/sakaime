/**
 * Search-query builder. The feasibility probe measured what happens without it: a bare "ContaCT[tiab]" returns
 * 446,198 PubMed records (contact dermatitis, contact angle), an unquoted "Viz.ai OR ContaCT" returned 21,462
 * ClinicalTrials.gov studies, and "Caption" matched a pregnancy-messaging trial before the echo product.
 *
 * The builder therefore (1) quotes every term, (2) always includes the vendor, (3) requires a condition when
 * the product is a single word, and (4) refuses rather than guess when it cannot build a specific query. A
 * refusal carries a working example so the caller can fix the input. The syntax forms are the ones used in the
 * probe (fixtures/_requests.jsonl): PubMed `"term"[tiab]`, ClinicalTrials.gov v2 `query.term`, Europe PMC quoted phrases.
 */
import { aliasGroupOf, foldText, MANUFACTURER_ALIAS_GROUPS, normaliseManufacturer, stripMarks, tokenize } from "./normalize.ts";
import { canonicalNct, canonicalSubmissionId } from "./identifiers.ts";
import { PortError } from "../ports/index.ts";

export const QUERY_TARGETS = ["pubmed", "clinicaltrials", "europepmc"] as const;
export type QueryTarget = (typeof QUERY_TARGETS)[number];

export interface SearchSubject {
  vendor?: string;
  /** Other names the vendor has used; they are searched as alternatives to the vendor name. */
  vendorAliases?: string[];
  product: string;
  condition?: string;
}

export const REFUSAL_REASONS = ["EMPTY_PRODUCT", "MISSING_VENDOR", "BARE_AMBIGUOUS_NAME", "UNUSABLE_TERM"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface SearchQuery {
  target: QueryTarget;
  /** The query string to send. */
  text: string;
  /** For ClinicalTrials.gov v2 the parameter the text belongs in. */
  parameter?: string;
}

export type QueryPlan =
  | { ok: true; queries: SearchQuery[]; terms: { vendor: string[]; product: string; condition?: string }; warnings: string[] }
  | { ok: false; reason: RefusalReason; message: string; example: string };

const EXAMPLE = 'vendor "Aidoc", product "BriefCase", condition "intracranial hemorrhage"';
const MAX_TERM = 100;
const CORPORATE_TAIL = /[\s,]+(?:inc|incorporated|llc|ltd|limited|lp|corp|corporation|co|plc|gmbh|b\.?v\.?|s\.?r\.?l\.?)\.?$/i;

/** A term that is safe to place inside double quotes in any of the three syntaxes. */
export function cleanTerm(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  return stripMarks(raw)
    .replace(/[\u0000-\u001f\u007f"\\[\]()<>{}:^~*?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM)
    .trim();
}

function searchName(vendor: string): string {
  let out = cleanTerm(vendor);
  for (let i = 0; i < 3; i++) out = out.replace(CORPORATE_TAIL, "").trim();
  return out.replace(/[,.\s]+$/, "");
}

function productName(raw: string): string {
  return cleanTerm(raw).replace(/\s+v?\d+(?:\.\d+)+\S*$/i, "").trim();
}

function refuse(reason: RefusalReason, message: string): QueryPlan {
  return { ok: false, reason, message, example: EXAMPLE };
}

export function buildSearchQueries(subject: SearchSubject, targets: readonly QueryTarget[] = QUERY_TARGETS): QueryPlan {
  const product = productName(subject.product ?? "");
  if (product === "") return refuse("EMPTY_PRODUCT", "no product name was given");
  if (product.length < 2 || tokenize(foldText(product)).length === 0) {
    return refuse("UNUSABLE_TERM", `the product name "${product}" has no searchable characters`);
  }

  const vendors = new Set<string>();
  const primary = searchName(subject.vendor ?? "");
  if (primary !== "") vendors.add(primary);
  for (const alias of subject.vendorAliases ?? []) {
    const n = searchName(alias);
    if (n !== "") vendors.add(n);
  }
  if (primary !== "") {
    const group = MANUFACTURER_ALIAS_GROUPS.find((g) => g.id === aliasGroupOf(normaliseManufacturer(primary).key));
    for (const name of group?.names ?? []) {
      const n = searchName(name);
      if (n !== "" && n.length <= 40) vendors.add(n);
    }
  }
  if (vendors.size === 0) {
    return refuse("MISSING_VENDOR", `a product name alone is not searchable ("${product}" matches unrelated records); name the vendor`);
  }

  const condition = cleanTerm(subject.condition);
  const productTokens = tokenize(foldText(product));
  if (productTokens.length === 1 && condition === "") {
    return refuse(
      "BARE_AMBIGUOUS_NAME",
      `"${product}" is a single word and matches unrelated records on its own (a bare "ContaCT" matches 446,198 PubMed records); add the condition the product addresses`,
    );
  }

  const q = (s: string) => `"${s}"`;
  const vendorList = [...vendors];
  const build = (target: QueryTarget): SearchQuery => {
    const tag = target === "pubmed" ? "[tiab]" : "";
    const field = (s: string) => `${q(s)}${tag}`;
    const vendorClause = vendorList.length === 1 ? field(vendorList[0]!) : `(${vendorList.map(field).join(" OR ")})`;
    const parts = [vendorClause, field(product)];
    if (condition !== "") parts.push(field(condition));
    const text = parts.join(" AND ");
    return target === "clinicaltrials" ? { target, text, parameter: "query.term" } : { target, text };
  };

  const warnings: string[] = [];
  if (condition === "") warnings.push("no condition given: the query relies on vendor and product alone");
  return {
    ok: true,
    queries: targets.map(build),
    terms: { vendor: vendorList, product, ...(condition !== "" ? { condition } : {}) },
    warnings,
  };
}

/** Queries for known identifiers. Invalid identifiers throw INVALID: an unvalidated string must not reach a search API. */
export function buildIdentifierQueries(ids: { nct?: string; submission?: string }): SearchQuery[] {
  const out: SearchQuery[] = [];
  if (ids.nct !== undefined) {
    const nct = canonicalNct(ids.nct);
    if (!nct) throw new PortError("INVALID", `not an NCT identifier: ${String(ids.nct).slice(0, 40)}`);
    out.push({ target: "pubmed", text: `${nct}[si]` });
    out.push({ target: "europepmc", text: `"${nct}"` });
  }
  if (ids.submission !== undefined) {
    const sub = canonicalSubmissionId(ids.submission);
    if (!sub) throw new PortError("INVALID", `not an FDA submission number: ${String(ids.submission).slice(0, 40)}`);
    out.push({ target: "clinicaltrials", text: sub, parameter: "query.term" });
    out.push({ target: "europepmc", text: `"${sub}"` });
  }
  return out;
}
