/**
 * The case's World Model: the facts the evidence items stand on, kept with where they came from and when, so that a change
 * to one source marks the findings that used it as stale and leaves every other finding alone.
 *
 * One store per case, in memory, fed from the extracted records. Facts are about the thing they describe: the device for
 * regulator facts, the registry study for registry facts, the publication for paper facts. A finding declares the fact ids
 * it used; a later fact that changes the winning value of a slot, or a retraction, marks exactly those findings stale.
 */
import type { CheckedAssertion } from "../extraction/index.ts";
import type { Clock } from "../ports/index.ts";
import { WorldModel, type FactRecord } from "../engines/world-model/index.ts";
import type { AssertionType } from "../schemas/index.ts";
import type { StoredRecord } from "./evidence.ts";

export interface WorldFact {
  factId: string;
  assertionId: string;
  about: string;
  predicate: string;
  value: unknown;
  recordId: string;
  sourceId: string;
  assertionType: AssertionType;
  /** Absent for a fact that is a policy row rather than a quoted passage. */
  anchorId?: string;
  /** What the store needs to write the same fact again, so a scratch copy gets the same ids. */
  provenance?: { kind: string; url: string; at: string; checksum?: string; confidence: number };
  validFrom?: string;
  recordedAt: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PREDICATES = /(^|\.)(decision_date|letter_date|start_date|completion_date|date_received|primary_completion_date)$/;

export class CaseWorld {
  readonly wm: WorldModel;
  /** Every fact written for this case, in order. */
  readonly facts: WorldFact[] = [];

  constructor(
    readonly namespace: string,
    private readonly clock: Clock,
  ) {
    this.wm = new WorldModel({ namespace, storage: "memory", clock: () => this.clock.now() });
  }

  close(): void {
    this.wm.close();
  }

  /** Writes one assertion as a fact. Writing the same assertion again returns the same fact. */
  async assertFrom(stored: StoredRecord, k: CheckedAssertion, about: string): Promise<WorldFact> {
    const a = k.assertion;
    const value = a.value;
    const isDate = DATE_PREDICATES.test(a.predicate) && typeof value === "string" && DATE.test(value);
    const fact: FactRecord = await this.wm.assertFact({
      about,
      predicate: a.predicate,
      value,
      confidence: a.extractionMethod === "structured" ? 0.95 : 0.8,
      ...(isDate ? { validFrom: value as string } : {}),
      source: { kind: stored.sourceId, url: stored.url, at: stored.retrievedAt, by: "sakaime-pipeline", checksum: stored.contentHash },
    });
    const wf: WorldFact = {
      factId: fact.id,
      assertionId: a.id,
      about,
      predicate: a.predicate,
      value,
      recordId: stored.id,
      sourceId: stored.sourceId,
      assertionType: a.assertionType,
      anchorId: a.anchorId,
      ...(isDate ? { validFrom: value as string } : {}),
      recordedAt: stored.retrievedAt,
      provenance: { kind: stored.sourceId, url: stored.url, at: stored.retrievedAt, checksum: stored.contentHash, confidence: a.extractionMethod === "structured" ? 0.95 : 0.8 },
    };
    if (!this.facts.some((f) => f.factId === wf.factId && f.assertionId === wf.assertionId)) this.facts.push(wf);
    return wf;
  }

  /** A row of the hospital's policy as a fact, so a change to the policy marks the findings that relied on it stale. */
  async assertPolicy(key: string, predicate: string, value: string, queryId: string, at: string): Promise<WorldFact> {
    const about = `policy:${key}`;
    const fact = await this.wm.assertFact({
      about,
      predicate,
      value,
      confidence: 0.9,
      source: { kind: "hospital-policy", url: `zetaris:${queryId}`, at, by: "sakaime-pipeline" },
    });
    const wf: WorldFact = { factId: fact.id, assertionId: `policy:${key}`, about, predicate, value, recordId: `zetaris:${queryId}`, sourceId: "hospital-policy", assertionType: "requirement", recordedAt: at, provenance: { kind: "hospital-policy", url: `zetaris:${queryId}`, at, confidence: 0.9 } };
    if (!this.facts.some((f) => f.factId === wf.factId)) this.facts.push(wf);
    return wf;
  }

  /** A finding says which facts it used. Declaring again replaces the set and clears the stale flag. */
  async declare(findingId: string, factIds: readonly string[]): Promise<void> {
    await this.wm.declareDependencies({ findingId, refs: [...new Set(factIds)], by: "sakaime-pipeline" });
  }

  /** Writes facts from another world into this one with the same provenance, so they get the same ids. */
  async restore(facts: readonly WorldFact[]): Promise<void> {
    for (const f of facts) {
      if (!f.provenance) continue;
      const fact = await this.wm.assertFact({
        about: f.about,
        predicate: f.predicate,
        value: f.value,
        confidence: f.provenance.confidence,
        ...(f.validFrom ? { validFrom: f.validFrom } : {}),
        source: { kind: f.provenance.kind, url: f.provenance.url, at: f.provenance.at, by: "sakaime-pipeline", ...(f.provenance.checksum ? { checksum: f.provenance.checksum } : {}) },
      });
      if (fact.id !== f.factId) throw new Error(`restored fact ${f.predicate} got a different id; the scratch copy would not match the original`);
      if (!this.facts.some((x) => x.factId === f.factId && x.assertionId === f.assertionId)) this.facts.push(f);
    }
  }

  stale(): string[] {
    return this.wm.staleFindings();
  }
}
