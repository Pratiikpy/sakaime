/**
 * Evidence assembly: checked assertions into the compiler's EvidenceItems, each tied to the facts it stands on.
 *
 * One item per stored record and evidence type, so the compiler can tell a regulator's summary from a registry entry from
 * a paper. Authority is by assertion type and never promoted: a record read as a study stays a study. A registry entry or a
 * paper is attributed to the product only through a CONFIRMED link; until then it is a candidate and is not assembled.
 */
import { toEvidenceItems, type CheckedAssertion, type ConversionNote } from "../extraction/index.ts";
import type { AssertionType, EvidenceAnchor, EvidenceAssertion, EvidenceItem } from "../schemas/index.ts";
import { hashOf } from "../util/canonical.ts";
import type { CaseSpec } from "./cases.ts";
import type { ExtractedRecord } from "./evidence.ts";
import { digestOf, mergeDigests, type EvidenceDigest } from "./requirements.ts";
import { alphaId } from "./util.ts";
import { REGULATOR_RECORD_NOTE } from "../compiler/index.ts";
import type { CaseWorld, WorldFact } from "./world.ts";

export interface AdmittedRecord {
  extracted: ExtractedRecord;
  linkId: string;
  aboutId: string;
}

export interface AssembleInput {
  spec: CaseSpec;
  clearance?: ExtractedRecord;
  summary?: ExtractedRecord;
  admitted: AdmittedRecord[];
  world: CaseWorld;
}

export interface AssembledEvidence {
  items: EvidenceItem[];
  /** The stored record each item was built from. */
  itemRecord: Map<string, string>;
  /** World Model fact ids per item, for the compiler's change-impact input. */
  factIds: Record<string, string[]>;
  facts: WorldFact[];
  assertions: EvidenceAssertion[];
  anchors: EvidenceAnchor[];
  notes: ConversionNote[];
  /** What the admitted study records and the authorization state say, reduced for the requirement checks. */
  digest: EvidenceDigest;
  /** Statements of what could not be extracted, for the case view. */
  notExtracted: string[];
}

const deviceSubject = (spec: CaseSpec): string => `device:fda:${spec.submission}`;

const rewrite = (kept: readonly CheckedAssertion[], subjectId: string, type?: AssertionType): CheckedAssertion[] =>
  kept.map((k) => ({ ...k, assertion: { ...k.assertion, subjectId, ...(type ? { assertionType: type } : {}) } }));

export async function assembleEvidence(input: AssembleInput): Promise<AssembledEvidence> {
  const { spec, world } = input;
  const subject = deviceSubject(spec);
  const items: EvidenceItem[] = [];
  const itemRecord = new Map<string, string>();
  const factIds: Record<string, string[]> = {};
  const facts: WorldFact[] = [];
  const assertions = new Map<string, EvidenceAssertion>();
  const anchors = new Map<string, EvidenceAnchor>();
  const notes: ConversionNote[] = [];
  const notExtracted: string[] = [];
  const digests: EvidenceDigest[] = [];

  const add = async (
    ex: ExtractedRecord,
    kept: CheckedAssertion[],
    aboutOf: (k: CheckedAssertion) => string,
    versionsFromSameDocument: boolean,
    attribution?: { linkId: string },
    /** Anchors that establish which product the item is about: the printed identifier, or the passage that cites the study. */
    identity: readonly string[] = [],
  ): Promise<void> => {
    const absent = Object.entries(ex.fields).filter(([, v]) => v.status === "absent").map(([k]) => k);
    // A decision summary describes studies the regulator had reviewed by its decision date, so the summary's studies are dated by it (the same record that gives them their version).
    const converted = toEvidenceItems(kept, { absentFields: absent, versionsFromSameDocument, datesFromSameDocument: versionsFromSameDocument });
    notes.push(...converted.notes);
    for (const raw of converted.items) {
      // The reader's id is a hash of subject and type, so two records of one type would collide. Name the item for its record.
      const id = `ev-${ex.stored.kind}-${alphaId(ex.stored.id)}-${raw.assertionType}`;
      const anchorIds = [...new Set([...raw.anchorIds, ...identity])];
      // What the regulator's summary reports about the pivotal study (its analysed population, say) is marked, so the compiler can tell it
      // from a registry entry or a paper about the same study: the regulator record bounds the claim, the others only cover it.
      const fromRegulator = ex.stored.kind === "fda-summary" && raw.assertionType === "study";
      const marked = fromRegulator ? [...raw.limitations, `${REGULATOR_RECORD_NOTE} ${spec.submission}`] : raw.limitations;
      const item: EvidenceItem = attribution
        ? { ...raw, id, anchorIds, scope: { ...raw.scope, product: subject }, limitations: [...raw.limitations, `attributed to ${subject} through confirmed link ${attribution.linkId}`] }
        : { ...raw, id, anchorIds, limitations: marked };
      items.push(item);
      itemRecord.set(id, ex.stored.id);
      const used = kept.filter((k) => item.anchorIds.includes(k.anchor.id) && k.assertion.assertionType === item.assertionType);
      const ids: string[] = [];
      for (const k of used) {
        const wf = await world.assertFrom(ex.stored, k, aboutOf(k));
        ids.push(wf.factId);
        if (!facts.some((f) => f.factId === wf.factId && f.assertionId === wf.assertionId)) facts.push(wf);
      }
      factIds[id] = [...new Set(ids)].sort();
    }
    for (const k of kept) {
      assertions.set(k.assertion.id, k.assertion);
      anchors.set(k.anchor.id, k.anchor);
    }
    digests.push(digestOf(kept));
  };

  const anchorsOf = (ex: ExtractedRecord | undefined, predicate: string, value?: string): string[] =>
    (ex?.kept ?? []).filter((k) => k.assertion.predicate === predicate && k.assertion.supportVerified === "PASS" && (value === undefined || String(k.assertion.value) === value)).map((k) => k.anchor.id);
  if (input.clearance) {
    const kept = input.clearance.kept.filter((k) => k.assertion.subjectId === subject);
    await add(input.clearance, kept, () => subject, false, undefined, anchorsOf(input.clearance, "document.identifier", spec.submission));
  }
  if (input.summary) {
    const s = input.summary;
    await add(s, s.kept, () => subject, true, undefined, anchorsOf(s, "document.identifier"));
    for (const [field, v] of Object.entries(s.fields)) {
      if (v.status === "absent" && /^(result\.|study\.design|study\.site_count|population\.age_min|device\.version|indication\.setting_term)/.test(field)) {
        notExtracted.push(`FDA summary ${spec.submission}: ${field} was searched for and is not stated in the text that could be read`);
      }
    }
    notExtracted.push(...s.limits.map((l) => `FDA summary ${spec.submission}: ${l}`));
  }
  for (const a of input.admitted) {
    const study = rewrite(a.extracted.kept.filter((k) => k.assertion.supportVerified !== "FAIL"), subject, "study");
    // The product is attributed through the confirmed link, and the item says so.
    const own = a.extracted.study ? anchorsOf(a.extracted, "document.identifier") : anchorsOf(a.extracted, "document.cites_nct");
    await add(a.extracted, study, () => a.aboutId, false, { linkId: a.linkId }, [...anchorsOf(input.summary, "document.cites_nct"), ...own]);
    notExtracted.push(...a.extracted.limits.map((l) => `${a.extracted.stored.kind} ${a.extracted.stored.id.split(":").pop()}: ${l}`));
  }

  return {
    items,
    itemRecord,
    factIds,
    facts,
    assertions: [...assertions.values()],
    anchors: [...anchors.values()],
    notes,
    digest: mergeDigests(...digests),
    notExtracted: [...new Set(notExtracted)],
  };
}

/** Stable id for a derived object, used where the reader has none. */
export const derivedId = (prefix: string, payload: unknown): string => `${prefix}_${hashOf(payload).slice(0, 16)}`;
