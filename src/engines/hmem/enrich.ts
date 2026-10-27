import { DEFAULTS, type MemoryType } from "./types.ts";
import { tokenize } from "./lexical.ts";

/**
 * Enrichment: domain, namespace and entities, derived from the record's own text and tags. It is
 * keyword-table based and deliberately simple; the tables are data so a product can supply its own
 * vocabulary. The default tables cover the software-assistant vocabulary the specification uses and
 * the regulatory and clinical vocabulary Sakaime needs.
 */

export interface Vocabulary {
  /** domain name -> keywords that vote for it */
  domains: Record<string, readonly string[]>;
  /** terms that are entities even when lower case */
  entityTerms: readonly string[];
}

const TECH = ["react", "python", "typescript", "javascript", "rust", "sqlite", "postgres", "node", "docker", "graphql", "redis", "llm", "embedding"];

export const DEFAULT_VOCABULARY: Vocabulary = {
  domains: {
    tech: ["code", "bug", "api", "database", "deploy", "framework", "library", "server", ...TECH],
    work: ["meeting", "deadline", "client", "project", "sprint", "review", "report"],
    personal: ["family", "hobby", "prefer", "like", "dislike", "morning", "evening"],
    regulatory: ["fda", "clearance", "cleared", "510k", "predicate", "authorization", "indications", "intended", "labeling", "recall", "decision", "summary"],
    clinical: ["study", "trial", "sensitivity", "specificity", "cohort", "patients", "validation", "prospective", "retrospective", "auc", "subgroup", "triage", "reader"],
  },
  entityTerms: TECH,
};

/** Identifier shapes that registries use; keeping them as entities makes records that cite the same K-number overlap. */
const ID_SHAPES = /\b(?:K\d{6}|DEN\d{6}|P\d{6}|NCT\d{8}|PMID:?\s?\d{5,9})\b/gi;

/** Registry identifiers (K, DEN, P, NCT, PMID numbers) found in the text, lower-cased and de-duplicated. */
export function identifiersIn(text: string): string[] {
  return [...new Set([...text.matchAll(ID_SHAPES)].map((m) => m[0].toLowerCase().replace(/\s+/g, "")))].sort();
}

/**
 * Whether two texts name the same registry identifiers. Two texts with no identifiers agree;
 * a text with identifiers never agrees with one that has different ones, or none. Word overlap
 * between two questions about different products is high ("is X the same product as submission
 * Y"), so a retrieval score alone cannot tell them apart; the identifiers can.
 */
export function identifiersAgree(a: string, b: string): boolean {
  const ia = identifiersIn(a);
  const ib = identifiersIn(b);
  return ia.length === ib.length && ia.every((x, i) => x === ib[i]);
}

export function classifyDomain(vocab: Vocabulary, content: string, tags: readonly string[], type: MemoryType): string {
  for (const t of tags) {
    if (t.startsWith("project:")) return t.slice("project:".length);
    if (t.startsWith("tech:")) return "tech";
  }
  const tokens = new Set(tokenize(content));
  let leader = "general";
  let topScore = 0;
  for (const [domain, words] of Object.entries(vocab.domains)) {
    let score = words.reduce((s, w) => s + (tokens.has(w) ? 1 : 0), 0);
    if (domain === "personal" && (type === "personal" || type === "preference")) score += 1;
    if (score > topScore) {
      leader = domain;
      topScore = score;
    }
  }
  return leader;
}

export function namespaceFor(domain: string, type: MemoryType): string {
  const bucket = type === "preference" || type === "personal" ? "profile" : type === "factual" ? "facts" : "notes";
  return `${domain}/${bucket}`;
}

export function extractEntities(vocab: Vocabulary, content: string): string[] {
  const found = new Set<string>();
  const terms = new Set(vocab.entityTerms);
  for (const t of tokenize(content)) if (terms.has(t)) found.add(t);
  for (const m of content.matchAll(ID_SHAPES)) found.add(m[0].toLowerCase().replace(/\s+/g, ""));
  for (const m of content.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
    const norm = m[1]!.toLowerCase();
    if (!["the", "this", "that", "with", "always", "never"].includes(norm)) found.add(norm);
  }
  return [...found].slice(0, DEFAULTS.entityCap);
}

/** Correction language: a new record that reads like a replacement of a similar older one. */
export const CORRECTION = /\b(actually|instead|no longer|not anymore|changed to|correction|supersedes?|replaces?)\b/i;
