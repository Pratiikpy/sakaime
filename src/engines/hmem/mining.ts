import type { MemoryStore } from "./store.ts";
import type { MemoryLayer, MemoryRecord, MemoryType, MiningEventType, Scope, SourceTier } from "./types.ts";

const EVENT_TYPE: Record<MiningEventType, MemoryType> = {
  chat_message: "general",
  user_correction: "preference",
  file_save: "factual",
  file_open: "general",
  file_edit: "factual",
  model_response: "factual",
  plan_completion: "factual",
};

const SIGNAL = /\b(prefer|always|never|decided|chose|choose|use|because|instead|must|should|important|remember|requires?|validated|cleared|authorized)\b/i;

export interface MineOptions extends Scope {
  layer?: MemoryLayer;
  sourceTier?: SourceTier;
  kind?: string;
}

/**
 * Acquisition: turn text into candidate records. With no model the default path is a sentence
 * filter on signal words, so capture continues when a model is unavailable; with `minerFn` the model
 * proposes strict JSON that is parsed defensively. Either way, every candidate is written through
 * `MemoryStore.add`, so it carries a source and a ledger entry like any other record. Mined records
 * that came from a model start at the model tier unless the caller says otherwise, because a model
 * extraction is a proposal, not an observation.
 */
export class Mining {
  constructor(private store: MemoryStore, private minerFn?: (prompt: string) => Promise<string>) {}

  async mineInteraction(event: MiningEventType, text: string, opts: MineOptions = {}): Promise<MemoryRecord[]> {
    const candidates = this.minerFn ? await this.withModel(event, text) : this.modelFree(text);
    return candidates.map((content) =>
      this.store.add({
        content,
        type: EVENT_TYPE[event],
        layer: opts.layer ?? (this.minerFn ? "working" : "short_term"),
        tags: [`event:${event}`],
        source: `interaction:${event}`,
        ...this.tier(opts),
        provenance: { origin: event, learnedAt: this.store.clock(), label: `mined from ${event}` },
        ...scopeOf(opts),
        ...(opts.kind ? { kind: opts.kind } : {}),
      }),
    );
  }

  async mineDocument(fileName: string, text: string, opts: MineOptions = {}): Promise<MemoryRecord[]> {
    const window = text.slice(0, 8000);
    const candidates = this.minerFn ? await this.withModel("file_save", window) : this.modelFree(window);
    return candidates.map((content) =>
      this.store.add({
        content,
        type: "factual",
        layer: opts.layer ?? "working",
        tags: ["document", `file:${fileName}`],
        source: `document:${fileName}`,
        ...this.tier(opts),
        ...scopeOf(opts),
        ...(opts.kind ? { kind: opts.kind } : {}),
      }),
    );
  }

  private tier(opts: MineOptions): { sourceTier?: SourceTier } {
    const tier = opts.sourceTier ?? (this.minerFn ? "model" : undefined);
    return tier ? { sourceTier: tier } : {};
  }

  modelFree(text: string): string[] {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20 && s.length <= 300 && SIGNAL.test(s))
      .slice(0, 10);
  }

  private async withModel(event: MiningEventType, text: string): Promise<string[]> {
    const raw = await this.minerFn!(`Extract durable memories from this ${event} as a strict JSON array of strings:\n\n${text}`);
    return parseStrictJsonArray(raw);
  }
}

function scopeOf(o: Scope): Scope {
  return {
    ...(o.organizationId ? { organizationId: o.organizationId } : {}),
    ...(o.caseId ? { caseId: o.caseId } : {}),
    ...(o.chatId ? { chatId: o.chatId } : {}),
    ...(o.missionId ? { missionId: o.missionId } : {}),
    ...(o.goalRunId ? { goalRunId: o.goalRunId } : {}),
  };
}

/** Strips markdown fences and surrounding prose, keeps strings of at least six characters (the specification's minimum). */
export function parseStrictJsonArray(raw: string): string[] {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length >= 6);
  } catch {
    return [];
  }
}
