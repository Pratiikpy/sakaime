/**
 * Name-based evidence and the deterministic mapping proposer.
 *
 * The proposer is not the mapper of record: the model is. It exists for three reasons. It is the answer when the
 * model cannot be reached (the result says so), it is a second opinion that must agree before a renamed text
 * column is trusted, and it is the "no model" arm of the ablation. Everything it proposes goes through the same
 * semantic validator as a model proposal.
 */
import { ALL_KEY_FIELDS, CANONICAL_FIELDS, canonicalField, leafName, nameTokens, normalName, synonymTarget } from "./canonical.ts";
import { ID_FAMILIES, canonicalise } from "./identifiers.ts";
import { isNullToken, text, type Cell } from "./values.ts";
import type { ProbeTable } from "./tabular.ts";

/** "repair" is a mapping the validator derived from the evidence after rejecting the model's, and validated in turn. */
export type Proposer = "model" | "lexical" | "memory" | "repair";

export interface Proposal {
  sourceField: string;
  canonicalField: string;
  confidence: number;
  proposer: Proposer;
  rationale?: string;
}

/** Nouns that say a column holds a value without saying which. */
const GENERIC_NOUNS: ReadonlySet<string> = new Set(["name", "title", "label", "text", "value", "field", "col", "column", "desc", "description"]);

const WEAK_SINGLE_WORDS: ReadonlySet<string> = new Set(["device", "product", "class", "year", "status", "version", "company", "title", "name", "date", "id", "number", "type", "size", "count", "brand", "sponsor", "cohort", "participants", "enrolled", "release", "recall", "precision", "start", "started"]);

export type NameEvidence = "synonym" | "contains" | "description" | "none";

/**
 * Does the column's own name, or what the description says about it, point at this canonical field? This is the
 * corroboration a value-only check cannot give: 0.93 could be a sensitivity or a specificity.
 */
export function nameEvidence(canonicalId: string, sourceField: string, description: string): NameEvidence {
  const canon = canonicalField(canonicalId);
  if (!canon) return "none";
  if (synonymTarget(sourceField) === canonicalId) return "synonym";
  const src = nameTokens(sourceField).join(" ");
  const idTokens = nameTokens(canonicalId);
  // Every word of the canonical id appears in the path (reported_sensitivity_pct contains sensitivity).
  const srcSet = new Set(nameTokens(sourceField));
  if (idTokens.length > 0 && idTokens.every((t) => srcSet.has(t))) return "contains";
  for (const syn of canon.synonyms) {
    const n = normalName(syn);
    // A single common word inside a longer name is not evidence: device_class does not say device_name.
    if (!n.includes(" ") && WEAK_SINGLE_WORDS.has(n)) continue;
    if (n.length >= 3 && (" " + src + " ").includes(" " + n + " ") && synonymTarget(syn) === canonicalId) return "contains";
  }
  // Same words once the generic head noun is set aside: article_name for article_title, device_label for device_name.
  // The remaining words must be equal, so device_class is not evidence for device_name.
  const residual = (tokens: string[]): string => tokens.filter((t) => !GENERIC_NOUNS.has(t)).sort().join(" ");
  const want = residual(idTokens);
  if (want !== "" && residual(nameTokens(leafName(sourceField))) === want) return "contains";
  const leaf = nameTokens(leafName(sourceField));
  if (leaf.length > 0 && description) {
    const d = normalName(description);
    const mentions = d.includes(leaf.join(" "));
    if (mentions && canon.synonyms.concat(canonicalId).some((s) => d.includes(normalName(s)))) return "description";
  }
  return "none";
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = `  ${s} `;
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const g of x) if (y.has(g)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

/** Best canonical field for a column from its name alone, or from the shape of its values for identifiers. */
export function lexicalProposals(table: ProbeTable): Proposal[] {
  const out: Proposal[] = [];
  for (const column of table.columns) {
    const bySynonym = synonymTarget(column);
    if (bySynonym) {
      out.push({ sourceField: column, canonicalField: bySynonym, confidence: 0.95, proposer: "lexical", rationale: "the column name is a known name for this field" });
      continue;
    }
    const idHit = identifierByValues(table, column);
    if (idHit) {
      out.push({ sourceField: column, canonicalField: idHit, confidence: 0.85, proposer: "lexical", rationale: "every value has the shape of this identifier" });
      continue;
    }
    // Near-miss spelling of a canonical id or synonym (sensitvity, enrolment_count).
    const norm = normalName(leafName(column));
    let best: { id: string; score: number } | undefined;
    for (const c of CANONICAL_FIELDS) {
      for (const s of [c.id, ...c.synonyms]) {
        const n = normalName(s);
        if (n.length < 5 || Math.abs(n.length - norm.length) > 3) continue;
        const score = dice(norm, n);
        if (score >= 0.85 && (!best || score > best.score)) best = { id: c.id, score };
      }
    }
    if (best) out.push({ sourceField: column, canonicalField: best.id, confidence: 0.7, proposer: "lexical", rationale: "the column name is close to a known name for this field" });
  }
  // A canonical field is claimed once: the strongest claim wins and the others are left for the model or a reviewer.
  const strongest = new Map<string, Proposal>();
  for (const p of out) {
    const prior = strongest.get(p.canonicalField);
    if (!prior || p.confidence > prior.confidence) strongest.set(p.canonicalField, p);
  }
  return out.filter((p) => strongest.get(p.canonicalField) === p);
}

/** An identifier family that at least 90% of a column's present values belong to (after lexical clean-up). */
export function identifierByValues(table: ProbeTable, column: string): string | undefined {
  const values = table.rows.map((r) => r[column] as Cell).filter((v) => !isNullToken(v)).map(text);
  if (values.length < 3) return undefined;
  for (const family of ID_FAMILIES) {
    if (family.weak || !ALL_KEY_FIELDS.includes(family.id)) continue;
    const ok = values.filter((v) => canonicalise(family, v) !== null).length;
    if (ok / values.length >= 0.9) return family.id;
  }
  return undefined;
}
