import { pageRanges } from "./pagination.ts";
import {
  CHECKLIST,
  FIELD_PRIORITY,
  RawDefinitionSchema,
  RawFactSchema,
  normaliseValue,
  numberAppearsIn,
  quoteExists,
  type ChecklistKey,
  type FactField,
  type RelationKind,
} from "./facts.ts";

export interface Anchor {
  page: number;
  quote: string;
  /** The chain step whose chunk produced this anchor. */
  step: number;
  /** True when the model cited another page and code found the quote on this one. */
  anchorCorrected?: boolean;
}

export interface LedgerFact {
  id: string;
  field: FactField;
  value: string;
  number?: number;
  unit?: string;
  anchors: Anchor[];
  relations: { factId: string; kind: RelationKind }[];
}

export interface LedgerDefinition {
  term: string;
  meaning: string;
  page: number;
  quote: string;
}

export interface DropCounts {
  /** The item did not match the fact schema. */
  schemaInvalid: number;
  /** The quote is not on the cited page and not on any page of the chunk. */
  quoteNotFound: number;
  /** The quote is on several pages of the chunk and not on the cited one. */
  anchorAmbiguous: number;
  /**
   * A stated number does not appear in the quote. The number is discarded and the fact is kept: the quote is
   * verified, the number is not, and an unverified number is never carried forward.
   */
  numbersDiscarded: number;
  /** Placeholder items with no quote and no value: the model answering "nothing here" in item form. Not a lost fact. */
  emptyItems: number;
}

export const emptyDrops = (): DropCounts => ({ schemaInvalid: 0, quoteNotFound: 0, anchorAmbiguous: 0, numbersDiscarded: 0, emptyItems: 0 });

/** Facts lost, as distinct from numbers discarded from facts that were kept. */
export const factsDropped = (d: DropCounts): number => d.schemaInvalid + d.quoteNotFound + d.anchorAmbiguous;

export interface Coverage {
  allPages: number[];
  readPages: Set<number>;
  failedPages: Set<number>;
  /** Pages of a chunk whose reply was cut off. */
  partialPages: Set<number>;
  chunksDone: number;
  chunksTotal: number;
}

/**
 * The verified record of what the document states. Facts enter only after code has checked that the quote
 * exists on the page and that any stated number appears in the quote. The same ledger renders the compact
 * COMPLETED / REMAINING / DECISIONS / CONTEXT state that the next chunk sees, so the model's working view and
 * the final result come from one source and cannot drift apart.
 */
export class FactLedger {
  private readonly byKey = new Map<string, LedgerFact>();
  private readonly list: LedgerFact[] = [];
  private readonly defs: LedgerDefinition[] = [];
  readonly drops: DropCounts = emptyDrops();
  private seq = 0;

  constructor(private readonly pageText: ReadonlyMap<number, string>) {}

  get facts(): ReadonlyArray<LedgerFact> {
    return this.list;
  }
  get definitions(): ReadonlyArray<LedgerDefinition> {
    return this.defs;
  }

  /** Verify and record the items a model returned for one chunk. Returns the number of facts newly recorded or merged. */
  ingest(rawFacts: unknown[], rawDefs: unknown[], ctx: { step: number; shownPages: readonly number[] }): number {
    let accepted = 0;
    const pending: { id: string; relates?: { fact_id: string; kind: RelationKind } }[] = [];
    for (const item of rawFacts) {
      if (isEmptyItem(item)) {
        this.drops.emptyItems++;
        continue;
      }
      const parsed = RawFactSchema.safeParse(item);
      if (!parsed.success) {
        this.drops.schemaInvalid++;
        continue;
      }
      const f = parsed.data;
      const anchor = this.anchorFor(f.quote, f.page, ctx);
      if (anchor === "not-found") {
        this.drops.quoteNotFound++;
        continue;
      }
      if (anchor === "ambiguous") {
        this.drops.anchorAmbiguous++;
        continue;
      }
      let verifiedNumber = f.number;
      if (verifiedNumber !== undefined && !numberAppearsIn(f.quote, verifiedNumber)) {
        this.drops.numbersDiscarded++;
        verifiedNumber = undefined;
      }
      const key = `${f.field}|${normaliseValue(f.value)}`;
      let fact = this.byKey.get(key);
      if (!fact) {
        fact = { id: `F${++this.seq}`, field: f.field, value: f.value, number: verifiedNumber, unit: verifiedNumber === undefined ? undefined : f.unit, anchors: [], relations: [] };
        this.byKey.set(key, fact);
        this.list.push(fact);
      }
      if (fact.number === undefined && verifiedNumber !== undefined) fact.number = verifiedNumber;
      if (!fact.anchors.some((a) => a.page === anchor.page && normaliseValue(a.quote) === normaliseValue(f.quote))) {
        fact.anchors.push({ page: anchor.page, quote: f.quote, step: ctx.step, anchorCorrected: anchor.corrected || undefined });
      }
      if (f.relates_to) pending.push({ id: fact.id, relates: f.relates_to });
      accepted++;
    }
    for (const p of pending) {
      const fact = this.list.find((x) => x.id === p.id);
      const target = p.relates ? this.list.find((x) => x.id === p.relates?.fact_id) : undefined;
      if (fact && target && target.id !== fact.id && p.relates && !fact.relations.some((r) => r.factId === target.id && r.kind === p.relates?.kind)) {
        fact.relations.push({ factId: target.id, kind: p.relates.kind });
      }
    }
    for (const item of rawDefs) {
      const parsed = RawDefinitionSchema.safeParse(item);
      if (!parsed.success) continue;
      const d = parsed.data;
      const anchor = this.anchorFor(d.quote, d.page, ctx);
      if (anchor === "not-found" || anchor === "ambiguous") continue;
      if (!this.defs.some((x) => x.term.toLowerCase() === d.term.toLowerCase())) this.defs.push({ term: d.term, meaning: d.meaning, page: anchor.page, quote: d.quote });
    }
    return accepted;
  }

  private anchorFor(quote: string, page: number, ctx: { shownPages: readonly number[] }): { page: number; corrected: boolean } | "not-found" | "ambiguous" {
    const cited = this.pageText.get(page);
    if (cited !== undefined && quoteExists(cited, quote)) return { page, corrected: false };
    const hits = ctx.shownPages.filter((n) => {
      const t = this.pageText.get(n);
      return t !== undefined && quoteExists(t, quote);
    });
    if (hits.length === 1) return { page: hits[0] as number, corrected: true };
    return hits.length === 0 ? "not-found" : "ambiguous";
  }

  /** Which checklist groups have no verified fact yet. */
  missing(): ChecklistKey[] {
    return CHECKLIST.filter((g) => !this.list.some((f) => (g.fields as readonly FactField[]).includes(f.field))).map((g) => g.key);
  }

  private ordered(): LedgerFact[] {
    const rank = (f: FactField): number => FIELD_PRIORITY.indexOf(f);
    return [...this.list].sort((a, b) => rank(a.field) - rank(b.field) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  /**
   * The state for the next chunk, never above budgetTokens. When it must shrink it shortens values first,
   * then leaves out the lowest-priority facts and says how many; limitations and exclusions are the last to go.
   * Everything left out is still in the ledger and in the final result.
   */
  render(budgetTokens: number, cov: Coverage, opts: { values?: boolean } = {}): { text: string; warnings: string[] } {
    const values = opts.values !== false;
    const budgetChars = budgetTokens * 4;
    const ordered = this.ordered();
    const build = (facts: LedgerFact[], valueMax: number, omitted: LedgerFact[]): string => {
      const unread = cov.allPages.filter((p) => !cov.readPages.has(p) && !cov.failedPages.has(p));
      const completed = `pages ${pageRanges(cov.readPages)} read (chunk ${cov.chunksDone} of ${cov.chunksTotal})` + (cov.failedPages.size ? `; pages ${pageRanges(cov.failedPages)} could not be read` : "") +
        (cov.partialPages.size ? `; pages ${pageRanges(cov.partialPages)} only partly read (reply cut off)` : "");
      const missing = this.missing();
      const remaining = `pages ${pageRanges(unread)} unread; checklist not yet found: ${missing.length ? missing.join(", ") : "none"}`;
      const lines = facts.map((f) => {
        const pages = [...new Set(f.anchors.map((a) => a.page))].join(",");
        // Without values the model sees which facts are on record and where, but has nothing to restate.
        return values ? `${f.id} ${f.field} p.${pages}: ${clip(f.value, valueMax)}` : `${f.id} ${f.field} p.${pages}`;
      });
      if (omitted.length) lines.push(`(+${omitted.length} lower-priority facts omitted from this view: ${omitted.map((f) => f.id).join(",")})`);
      const defs = this.defs.map((d) => `"${d.term}" = ${clip(d.meaning, Math.min(valueMax, 100))} (p.${d.page})`);
      const rels = facts.flatMap((f) => f.relations.map((r) => `${f.id} ${r.kind} ${r.factId}`));
      const context = [...defs, ...rels].join("; ") || "none";
      return `COMPLETED: ${completed}\nREMAINING: ${remaining}\nDECISIONS (recorded already, not part of the document, do not report them again): ${lines.length ? "\n" + lines.join("\n") : "none yet"}\nCONTEXT: ${context}`;
    };

    for (const valueMax of [160, 100, 60, 40]) {
      const text = build(ordered, valueMax, []);
      if (text.length <= budgetChars) return { text, warnings: valueMax < 160 ? ["carryover-values-shortened"] : [] };
    }
    for (let keep = ordered.length - 1; keep >= 0; keep--) {
      const text = build(ordered.slice(0, keep), 40, ordered.slice(keep));
      if (text.length <= budgetChars) return { text, warnings: ["carryover-values-shortened", "carryover-facts-omitted"] };
    }
    const bare = build([], 40, ordered);
    return { text: bare.slice(0, budgetChars), warnings: ["carryover-values-shortened", "carryover-facts-omitted", "carryover-header-truncated"] };
  }
}

function isEmptyItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  return blank(o.quote) && blank(o.value);
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 3))}...`);
