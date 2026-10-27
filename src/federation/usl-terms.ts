/**
 * The shared vocabulary of the semantic layer: the business terms the compiler reasons with, written out as rows.
 *
 * The compiler places a setting or a purpose on a hierarchy and a metric on an alias table; those tables are code. The
 * semantic layer publishes the same tables as data so that a reviewer, a BI tool or a second agent that queries Zetaris reads
 * the words the compiler used, not its own guess of them. The rows are generated from the taxonomies handed in, never typed a
 * second time, so the layer cannot say one thing while the compiler does another. When a taxonomy changes, ensureUsl sees a
 * different activation query and re-activates the table.
 *
 * Definitions are structural statements (where a term sits, what evidence on it covers) or textbook definitions of a metric.
 * Nothing here is a clinical judgement. The word "adult" is deliberately given no number: scopes state an age range in years
 * or leave it unspecified, and unspecified is never read as everyone (src/schemas/scope.ts).
 */
import type { Taxonomy } from "../compiler/taxonomy.ts";

export type TermKind = "setting" | "purpose" | "metric" | "population";

export interface TermDefinition {
  kind: TermKind;
  /** The word as a source writes it. For an alias this is the alias, for a node its key. */
  term: string;
  /** The node or metric this word is read as. Equal to `term` for a node. */
  canonical: string;
  isAlias: boolean;
  label: string;
  /** The next broader node, for hierarchy kinds. */
  broader: string | null;
  /** Root-first path to the canonical node, the node included. Empty for metrics and population terms. */
  ancestry: string[];
  definition: string;
  /** "proportion" for rates bounded by 0 and 1; null when the term has no unit. */
  unit: string | null;
  valueMin: number | null;
  valueMax: number | null;
  prevalenceDependent: boolean | null;
  /** Where the row comes from, for example "sakaime-settings@1+bridge1". */
  source: string;
}

export interface MetricVocabulary {
  version: string;
  aliases: Readonly<Record<string, string>>;
  prevalenceDependent: readonly string[];
}

export interface TermSources {
  settings: Taxonomy;
  purposes: Taxonomy;
  metrics: MetricVocabulary;
}

const sourceOf = (t: Taxonomy): string => `${t.id}@${t.version}`;

function ancestryOf(t: Taxonomy, key: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = key;
  while (cur !== undefined && t.nodes[cur]) {
    out.unshift(cur);
    cur = t.nodes[cur]!.parent;
  }
  return out;
}

function descendantsOf(t: Taxonomy, key: string): string[] {
  const out: string[] = [];
  const walk = (parent: string): void => {
    for (const [k, node] of Object.entries(t.nodes)) {
      if (node.parent === parent) {
        out.push(k);
        walk(k);
      }
    }
  };
  walk(key);
  return out;
}

const labelOf = (t: Taxonomy, key: string): string => t.nodes[key]?.label ?? key.replace(/_/g, " ");
const listLabels = (t: Taxonomy, keys: readonly string[]): string => keys.map((k) => labelOf(t, k)).join(", ");

function nodeRows(t: Taxonomy, kind: "setting" | "purpose"): TermDefinition[] {
  const noun = kind === "setting" ? "settings" : "purposes";
  const rows: TermDefinition[] = [];
  for (const key of Object.keys(t.nodes).sort()) {
    const node = t.nodes[key]!;
    const path = ancestryOf(t, key);
    const above = path.slice(0, -1).reverse();
    const below = descendantsOf(t, key);
    const parts = [
      `${node.label}.`,
      above.length > 0 ? `Sits inside ${listLabels(t, above)}.` : "Broadest term in this hierarchy.",
      below.length > 0
        ? `Evidence established for it covers a claim for it and for the ${noun} inside it (${listLabels(t, below)}).`
        : "Evidence established for it covers a claim for it alone.",
      above.length > 0 ? `It does not cover a claim for ${above.length === 1 ? "the broader term" : "a broader term"} above it.` : "",
    ];
    rows.push({
      kind,
      term: key,
      canonical: key,
      isAlias: false,
      label: node.label,
      broader: node.parent ?? null,
      ancestry: path,
      definition: parts.filter(Boolean).join(" "),
      unit: null,
      valueMin: null,
      valueMax: null,
      prevalenceDependent: null,
      source: sourceOf(t),
    });
  }
  for (const alias of Object.keys(t.aliases).sort()) {
    const target = t.aliases[alias]!;
    if (!t.nodes[target]) continue;
    rows.push({
      kind,
      term: alias,
      canonical: target,
      isAlias: true,
      label: labelOf(t, target),
      broader: t.nodes[target]!.parent ?? null,
      ancestry: ancestryOf(t, target),
      definition: `A word sources use for ${labelOf(t, target)}. The taxonomy ${sourceOf(t)} reads it as ${target}.`,
      unit: null,
      valueMin: null,
      valueMax: null,
      prevalenceDependent: null,
      source: sourceOf(t),
    });
  }
  return rows;
}

/** Definitions of the metrics the compiler names. Standard definitions; the alias pairs are the compiler's own table. */
const METRIC_DEFINITIONS: Readonly<Record<string, { label: string; text: string }>> = {
  sensitivity: {
    label: "sensitivity (true positive rate)",
    text: "Share of people who have the target condition that the product flags, as a proportion from 0 to 1, so 0.85 means 85 percent. Recall and true positive rate are the same quantity.",
  },
  specificity: {
    label: "specificity (true negative rate)",
    text: "Share of people without the target condition that the product leaves unflagged, as a proportion from 0 to 1. True negative rate is the same quantity.",
  },
  ppv: {
    label: "positive predictive value",
    text: "Share of flagged people who have the target condition, as a proportion from 0 to 1. It depends on how common the condition is in the people tested, so a value measured in one population does not carry to a population with another prevalence.",
  },
  npv: {
    label: "negative predictive value",
    text: "Share of unflagged people who do not have the target condition, as a proportion from 0 to 1. It depends on how common the condition is in the people tested, so a value measured in one population does not carry to a population with another prevalence.",
  },
  auc: {
    label: "area under the ROC curve",
    text: "Area under the receiver operating characteristic curve, from 0 to 1, where 0.5 is no better than chance. It summarises every threshold, so it does not state the operating point a product runs at.",
  },
};

function metricRows(m: MetricVocabulary): TermDefinition[] {
  const canonical = [...new Set(Object.values(m.aliases))].sort();
  const rows: TermDefinition[] = [];
  const source = `metric-table@${m.version}`;
  for (const key of canonical) {
    const known = METRIC_DEFINITIONS[key];
    if (!known) continue; // a metric the compiler aliases but this layer has no textbook definition for stays unpublished, not guessed
    rows.push({
      kind: "metric",
      term: key,
      canonical: key,
      isAlias: false,
      label: known.label,
      broader: null,
      ancestry: [],
      definition: known.text,
      unit: "proportion",
      valueMin: 0,
      valueMax: 1,
      prevalenceDependent: m.prevalenceDependent.includes(key),
      source,
    });
  }
  const published = new Set(rows.map((r) => r.term));
  for (const alias of Object.keys(m.aliases).sort()) {
    const target = m.aliases[alias]!;
    if (!published.has(target)) continue;
    rows.push({
      kind: "metric",
      term: alias,
      canonical: target,
      isAlias: true,
      label: METRIC_DEFINITIONS[target]!.label,
      broader: null,
      ancestry: [],
      definition: `A name sources use for ${target}. The compiler's metric table reads it as ${target}.`,
      unit: "proportion",
      valueMin: 0,
      valueMax: 1,
      prevalenceDependent: m.prevalenceDependent.includes(target),
      source,
    });
  }
  return rows;
}

const POPULATION_ROWS: readonly TermDefinition[] = [
  {
    kind: "population",
    term: "adult",
    canonical: "adult",
    isAlias: false,
    label: "adult",
    broader: null,
    ancestry: [],
    definition:
      "A word, not an age. Sources define it differently, so this layer holds no number for it. Compare the lower age bound each source states: study_enrolled_age_min_years for a study, claimed_age_min_years for a vendor claim, intended_age_min_years for a hospital case. A bound that is not stated is unknown and is never read as zero or as everyone.",
    unit: "years",
    valueMin: null,
    valueMax: null,
    prevalenceDependent: null,
    source: "scope-schema",
  },
];

/** Every row of the term table, in a stable order, so the same inputs always give the same activation query. */
export function buildTermRows(sources: TermSources): TermDefinition[] {
  return [...nodeRows(sources.settings, "setting"), ...nodeRows(sources.purposes, "purpose"), ...metricRows(sources.metrics), ...POPULATION_ROWS];
}

/** Every term (word and alias) of one kind, for a vocabulary rule that checks a column holds only defined words. */
export function wordsOf(rows: readonly TermDefinition[], kind: TermKind): string[] {
  return [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.term))].sort();
}
