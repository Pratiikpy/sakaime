/**
 * Sense: score every registered intent against the request.
 *
 *   final = 0.40 lexical + 0.35 semantic + 0.20 contextual + 0.05 recency - riskPenalty
 *
 * lexical    weighted trigger phrases from the registry (negative weights suppress look-alikes), blended with
 *            overlap on features derived from the intent's examples
 * semantic   TF-IDF cosine between the request and the intent's examples (the nearest one, or all of them
 *            together, whichever is closer) and description. This is a lexical
 *            vector model, not an embedding model: it sees shared words, not shared meaning. It is named
 *            "semantic" because it is the term the specification gives that slot.
 * contextual the active case and the previous turn
 * recency    the intent was used earlier in this session
 *
 * Bands: High >= 0.80, Medium 0.55-0.79, Low 0.40-0.54, Reject < 0.40 (falls back to GENERAL).
 */
import { contentStems, stem, tokens } from "./text.ts";
import type { DecideContext, Intent, IntentCandidate } from "./types.ts";
import type { IntentRegistry } from "./registry.ts";

export const BANDS = { high: 0.8, medium: 0.55, low: 0.4 } as const;
export const WEIGHTS = { lexical: 0.4, semantic: 0.35, contextual: 0.2, recency: 0.05 } as const;

/** Trigger weight at which an intent's lexical score is 1. */
const TRIGGER_SATURATION = 0.9;
/** Cosine at which the semantic term is 1; a request rarely matches an intent's examples better than this. */
const COSINE_SATURATION = 0.28;
/** Cosine to the nearest single example at which the semantic term is 1. */
const NEAREST_SATURATION = 0.5;
const DERIVED_SATURATION = 1.5;

/**
 * Replace identifiers with a fixed token so that "a URL", "an FDA number" or "a case id" is one feature, and so
 * that a trigger written as ".{0,30}" is not defeated by a long link. Applied to requests and to examples alike.
 */
export function canon(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " urltoken ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " emailtoken ")
    .replace(/\bnct\d{8}\b/gi, " nctref ")
    .replace(/\bpmid[:\s]*\d{5,9}\b/gi, " pmidref ")
    .replace(/\b(?:k\d{6}|den\d{6}|p\d{6}(?:\/s\d{1,3})?)\b/gi, " fdaref ")
    .replace(/\bcase-[a-z0-9]+(?:-[a-z0-9]+)*\b/gi, " caseref ")
    .replace(/\blink-\d+\b/gi, " linkref ")
    .replace(/\bf-?\d{1,5}\b/gi, " findingref ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Compiled {
  intent: Intent;
  triggers: { re: RegExp; weight: number }[];
  /** idf-weighted vector of the intent's examples, description and id words. */
  vector: Map<string, number>;
  norm: number;
  bigrams: Set<string>;
  stems: Set<string>;
  /** One idf-weighted vector per example: a paraphrase is usually close to one example, not to their average. */
  exampleVectors: { v: Map<string, number>; norm: number }[];
}

function bigramsOf(stems: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < stems.length; i++) out.push(`${stems[i]} ${stems[i + 1]}`);
  return out;
}

function termsOf(text: string): string[] {
  const s = contentStems(canon(text));
  return [...s, ...bigramsOf(s)];
}

export class IntentScorer {
  private readonly compiled: Compiled[];
  private readonly idf = new Map<string, number>();

  constructor(registry: IntentRegistry) {
    const docs = registry.intents.map((i) => ({
      intent: i,
      terms: [...i.examples.flatMap(termsOf), ...termsOf(i.description).slice(0, 40), ...termsOf(i.id.replace(/[._]/g, " "))],
    }));
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + n / c));
    this.compiled = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      const vector = new Map<string, number>();
      let sq = 0;
      for (const [t, c] of tf) {
        const w = (1 + Math.log(c)) * (this.idf.get(t) ?? 0);
        vector.set(t, w);
        sq += w * w;
      }
      const exampleStems = d.intent.examples.flatMap((e) => contentStems(canon(e)));
      const exampleVectors = d.intent.examples.map((e) => {
        const etf = new Map<string, number>();
        for (const t of termsOf(e)) etf.set(t, (etf.get(t) ?? 0) + 1);
        const v = new Map<string, number>();
        let esq = 0;
        for (const [t, n] of etf) {
          const w = (1 + Math.log(n)) * (this.idf.get(t) ?? 0);
          v.set(t, w);
          esq += w * w;
        }
        return { v, norm: Math.sqrt(esq) || 1 };
      });
      return {
        intent: d.intent,
        triggers: (d.intent.triggers ?? []).map((t) => ({ re: new RegExp(t.phrase, "i"), weight: t.weight })),
        vector,
        norm: Math.sqrt(sq) || 1,
        bigrams: new Set(d.intent.examples.flatMap((e) => bigramsOf(contentStems(canon(e))))),
        stems: new Set(exampleStems),
        exampleVectors,
      };
    });
  }

  /** Score one stretch of text against every intent. */
  scoreText(raw: string, context: DecideContext | undefined, history: readonly string[]): IntentCandidate[] {
    const text = canon(raw);
    const q = termsOf(text);
    const qstems = new Set(contentStems(text));
    const qbigrams = new Set(bigramsOf(contentStems(text)));
    const tf = new Map<string, number>();
    for (const t of q) tf.set(t, (tf.get(t) ?? 0) + 1);
    const qv = new Map<string, number>();
    let qsq = 0;
    for (const [t, c] of tf) {
      const idf = this.idf.get(t);
      if (idf === undefined) continue;
      const w = (1 + Math.log(c)) * idf;
      qv.set(t, w);
      qsq += w * w;
    }
    const qnorm = Math.sqrt(qsq) || 1;

    const out: IntentCandidate[] = this.compiled.map((c) => {
      // lexical: explicit triggers, then derived overlap
      let tsum = 0;
      for (const t of c.triggers) if (t.re.test(text)) tsum += t.weight;
      const triggerPart = c.triggers.length ? clip01(tsum / TRIGGER_SATURATION) : 0;
      let derived = 0;
      for (const b of qbigrams) if (c.bigrams.has(b)) derived += 0.45;
      for (const s of qstems) if (c.stems.has(s)) derived += 0.12 * (this.idf.get(s) ?? 0.5);
      const derivedPart = clip01(derived / DERIVED_SATURATION);
      const lexical = c.triggers.length ? clip01(triggerPart + 0.3 * derivedPart * (tsum >= 0 ? 1 : 0)) : derivedPart;

      // semantic: tf-idf cosine
      let dot = 0;
      for (const [t, w] of qv) {
        const v = c.vector.get(t);
        if (v !== undefined) dot += w * v;
      }
      let nearest = 0;
      for (const ex of c.exampleVectors) {
        let edot = 0;
        for (const [t, w] of qv) {
          const v = ex.v.get(t);
          if (v !== undefined) edot += w * v;
        }
        nearest = Math.max(nearest, edot / (qnorm * ex.norm));
      }
      const semantic = clip01(Math.max(dot / (qnorm * c.norm) / COSINE_SATURATION, nearest / NEAREST_SATURATION));

      let ctx = 0;
      if (context?.caseId && c.intent.category === "case") ctx += 0.5;
      if (context?.previousIntent === c.intent.id) ctx += 0.5;
      else if (context?.previousIntent && c.intent.category !== "general" && c.intent.category !== "guarded" && this.compiled.find((x) => x.intent.id === context.previousIntent)?.intent.category === c.intent.category) ctx += 0.25;
      const contextual = clip01(ctx);
      const recency = history.includes(c.intent.id) ? 1 : 0;
      // A request that matches nothing lexically gets no credit from context alone.
      const gate = lexical > 0 || semantic > 0.15 ? 1 : 0;
      const score = clip01(gate * (WEIGHTS.lexical * lexical + WEIGHTS.semantic * semantic + WEIGHTS.contextual * contextual + WEIGHTS.recency * recency));
      return { intent: c.intent.id, score, lexical, semantic, contextual };
    });
    return out.sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent));
  }
}

const clip01 = (x: number): number => Math.max(0, Math.min(1, x));

export type Band = "high" | "medium" | "low" | "reject";
export function bandOf(score: number): Band {
  return score >= BANDS.high ? "high" : score >= BANDS.medium ? "medium" : score >= BANDS.low ? "low" : "reject";
}

// ---------------------------------------------------------------- clauses (multi-intent)

export interface Clause {
  text: string;
  start: number;
  end: number;
}

const CLAUSE_BREAK = /(?<=[.?!])\s+(?=[a-z0-9"'(])|\s*;\s*|\s+and\s+then\s+|,\s*then\s+|\s+then\s+|\s+and\s+also\s+|\s+as\s+well\s+as\s+|\s+plus\s+|,\s+and\s+|\s+and\s+(?=(?:also\s+)?(?:please\s+)?(?:show|list|export|explain|compare|add|confirm|review|check|build|generate|give|tell|find|draft|what|why|which|how|can|could|is|are|does|do)\b)/g;

/** Split a request into clauses where each side is long enough to be a request of its own. */
export function splitClauses(text: string): Clause[] {
  const cuts: { from: number; to: number }[] = [];
  for (const m of text.matchAll(CLAUSE_BREAK)) cuts.push({ from: m.index as number, to: (m.index as number) + m[0].length });
  if (cuts.length === 0) return [{ text, start: 0, end: text.length }];
  const parts: Clause[] = [];
  let at = 0;
  for (const c of cuts) {
    parts.push({ text: text.slice(at, c.from), start: at, end: c.from });
    at = c.to;
  }
  parts.push({ text: text.slice(at), start: at, end: text.length });
  // Merge pieces too short to stand alone into their neighbour.
  const merged: Clause[] = [];
  for (const p of parts) {
    const words = tokens(p.text).length;
    const prev = merged[merged.length - 1];
    if (words < 3 && prev) {
      prev.text = text.slice(prev.start, p.end);
      prev.end = p.end;
    } else if (words < 3 && !prev) merged.push({ ...p });
    else merged.push({ ...p });
  }
  if (merged.length > 1 && tokens((merged[0] as Clause).text).length < 3) {
    const [first, second, ...rest] = merged as [Clause, Clause, ...Clause[]];
    return [{ text: text.slice(first.start, second.end), start: first.start, end: second.end }, ...rest];
  }
  return merged.length ? merged : [{ text, start: 0, end: text.length }];
}

export { stem };
