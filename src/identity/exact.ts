/**
 * Exact-identifier evidence, the first step in the order of evidence (docs/02-architecture.md s7).
 *
 * Each identifier supports one link type and no other:
 *   shared K/DEN/P number              -> SAME_SUBMISSION
 *   shared device identifier (UDI-DI)  -> SAME_MARKETED_VERSION
 *   shared submission AND equal version label -> SAME_MARKETED_VERSION
 *   NCT id cited by the product side, or the submission cited by the study -> STUDY_EVALUATES
 *   NCT id in the paper, or a result reference in the registry -> PUBLICATION_REPORTS
 *   an explicit supersession statement -> SUPERSEDES
 * Nothing here ever supports SAME_PRODUCT: a product line is a judgement, so it is scored and confirmed by a reviewer.
 */
import { PortError } from "../ports/index.ts";
import type { LinkType } from "../schemas/index.ts";
import { effectiveVersion } from "./compare.ts";
import { canonicalId, canonicalSet, classifyMentionContext, type CanonicalIdKind } from "./identifiers.ts";
import type { EntityKind, IdentityRecord, Mention } from "./types.ts";
import { compareVersions, isFullySpecified } from "./version.ts";

const STUDY_SIDE: readonly EntityKind[] = ["Study", "RegistryEntry", "Publication"];
const PRODUCT_SIDE: readonly EntityKind[] = ["AuthorizationSubmission", "MarketedDevice", "SoftwareRelease", "ProductFamily"];

const KINDS_FOR: Record<"SAME_SUBMISSION" | "SAME_PRODUCT" | "SAME_MARKETED_VERSION", readonly EntityKind[]> = {
  SAME_SUBMISSION: ["AuthorizationSubmission", "MarketedDevice", "SoftwareRelease", "RegistryEntry"],
  SAME_PRODUCT: ["ProductFamily", "MarketedDevice", "SoftwareRelease", "AuthorizationSubmission"],
  SAME_MARKETED_VERSION: ["MarketedDevice", "SoftwareRelease", "AuthorizationSubmission"],
};

export interface Oriented {
  from: IdentityRecord;
  to: IdentityRecord;
}

/**
 * Puts a pair in the direction the link type defines: a study points at the product it evaluates, a publication
 * at the study it reports, a newer record at the one it supersedes. Undirected types are ordered by record id so
 * the same pair always yields the same link. Throws INVALID when the kinds cannot carry the link type.
 */
export function orient(linkType: LinkType, a: IdentityRecord, b: IdentityRecord): Oriented {
  const bad = (why: string): never => {
    throw new PortError("INVALID", `${linkType} is not defined between ${a.kind} and ${b.kind}: ${why}`, { linkType, a: a.kind, b: b.kind });
  };
  if (a.id === b.id) return bad("a record cannot be linked to itself");
  switch (linkType) {
    case "SAME_SUBMISSION":
    case "SAME_PRODUCT":
    case "SAME_MARKETED_VERSION": {
      const allowed = KINDS_FOR[linkType];
      if (!allowed.includes(a.kind) || !allowed.includes(b.kind)) return bad(`allowed kinds are ${allowed.join(", ")}`);
      return a.id <= b.id ? { from: a, to: b } : { from: b, to: a };
    }
    case "STUDY_EVALUATES": {
      if (STUDY_SIDE.includes(a.kind) && PRODUCT_SIDE.includes(b.kind)) return { from: a, to: b };
      if (STUDY_SIDE.includes(b.kind) && PRODUCT_SIDE.includes(a.kind)) return { from: b, to: a };
      return bad("one side must be a study, registry entry or publication and the other a product-side record");
    }
    case "PUBLICATION_REPORTS": {
      const isStudy = (k: EntityKind) => k === "Study" || k === "RegistryEntry";
      if (a.kind === "Publication" && isStudy(b.kind)) return { from: a, to: b };
      if (b.kind === "Publication" && isStudy(a.kind)) return { from: b, to: a };
      return bad("one side must be a publication and the other a study or registry entry");
    }
    case "SUPERSEDES": {
      if (a.kind !== b.kind) return bad("both records must be of the same kind");
      if (a.supersedes.includes(b.id) && !b.supersedes.includes(a.id)) return { from: a, to: b };
      if (b.supersedes.includes(a.id) && !a.supersedes.includes(b.id)) return { from: b, to: a };
      return a.id <= b.id ? { from: a, to: b } : { from: b, to: a };
    }
  }
}

/** Link types a pair of kinds can carry. Used to enumerate what to ask about a blocked pair. */
export function applicableLinkTypes(a: IdentityRecord, b: IdentityRecord): LinkType[] {
  const types: LinkType[] = ["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION", "STUDY_EVALUATES", "PUBLICATION_REPORTS", "SUPERSEDES"];
  return types.filter((t) => {
    try {
      orient(t, a, b);
      return true;
    } catch {
      return false;
    }
  });
}

export type ExactVerdict =
  | { kind: "NONE"; notes: string[] }
  | { kind: "CONFIRMED"; basis: string[]; flags: string[]; notes: string[] }
  | { kind: "CANDIDATE"; basis: string[]; flags: string[]; notes: string[] }
  | { kind: "AMBIGUOUS"; basis: string[]; flags: string[]; notes: string[] }
  | { kind: "REJECTED"; basis: string[]; flags: string[]; notes: string[] };

const none = (notes: string[] = []): ExactVerdict => ({ kind: "NONE", notes });

function own(record: IdentityRecord, kind: CanonicalIdKind): string[] {
  return canonicalSet(kind, record.ids[kind]);
}

function mentionsOf(record: IdentityRecord, type: Mention["type"]): { value: string; mention: Mention }[] {
  const out: { value: string; mention: Mention }[] = [];
  for (const m of record.mentions) {
    if (m.type !== type) continue;
    const value = canonicalId(type, m.value);
    if (value) out.push({ value, mention: m });
  }
  return out;
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

const RANK: Record<ExactVerdict["kind"], number> = { NONE: 0, REJECTED: 1, AMBIGUOUS: 2, CANDIDATE: 3, CONFIRMED: 4 };

export function exactEvidence(linkType: LinkType, from: IdentityRecord, to: IdentityRecord): ExactVerdict {
  switch (linkType) {
    case "SAME_SUBMISSION":
      return sameSubmission(from, to);
    case "SAME_MARKETED_VERSION":
      return sameMarketedVersion(from, to);
    case "SAME_PRODUCT":
      return none(["no identifier confirms a product line; it is scored and confirmed by a reviewer"]);
    case "STUDY_EVALUATES":
      return studyEvaluates(from, to);
    case "PUBLICATION_REPORTS":
      return publicationReports(from, to);
    case "SUPERSEDES":
      return supersedes(from, to);
  }
}

function sameSubmission(a: IdentityRecord, b: IdentityRecord): ExactVerdict {
  const sa = own(a, "submission");
  const sb = own(b, "submission");
  if (sa.length === 0 || sb.length === 0) return none(["no submission number on one side"]);
  const shared = intersect(sa, sb);
  const flags = sa.length > 1 || sb.length > 1 ? ["record-tied-to-multiple-submissions"] : [];
  if (shared.length > 0) {
    return {
      kind: "CONFIRMED",
      basis: [`shared submission number ${shared.join(", ")}`],
      flags: [...flags, "shared submission number establishes the same authorization only, not the same release or product line"],
      notes: [],
    };
  }
  return {
    kind: "REJECTED",
    basis: [`distinct submission numbers (${sa.join(", ")} versus ${sb.join(", ")})`],
    flags,
    notes: [],
  };
}

function sameMarketedVersion(a: IdentityRecord, b: IdentityRecord): ExactVerdict {
  const va = effectiveVersion(a);
  const vb = effectiveVersion(b);
  const cmp = compareVersions(va, vb);
  const udiA = own(a, "udiDi");
  const udiB = own(b, "udiDi");
  const sharedUdi = intersect(udiA, udiB);
  if (sharedUdi.length > 0) {
    if (cmp.relation === "DIFFERENT") {
      return {
        kind: "AMBIGUOUS",
        basis: [`shared device identifier ${sharedUdi[0]}`],
        flags: [`identifier-version-conflict: ${cmp.reason}`],
        notes: [],
      };
    }
    return { kind: "CONFIRMED", basis: [`shared device identifier ${sharedUdi[0]}`], flags: [], notes: [] };
  }
  const shared = intersect(own(a, "submission"), own(b, "submission"));
  if (shared.length > 0 && cmp.relation === "EXACT") {
    return { kind: "CONFIRMED", basis: [`shared submission ${shared[0]}`, `same version label (${cmp.reason})`], flags: [], notes: [] };
  }
  // Two fully specified release labels that disagree name two releases, whether or not they share a submission.
  if (cmp.relation !== "UNKNOWN" && cmp.relation !== "EXACT" && isFullySpecified(va) && isFullySpecified(vb)) {
    return {
      kind: "REJECTED",
      basis: [`the version labels differ (${va} versus ${vb}: ${cmp.reason})${shared.length > 0 ? `; both are tied to ${shared[0]}` : ""}`],
      flags: shared.length > 0 ? ["multiple releases under one submission number"] : [],
      notes: [],
    };
  }
  if (shared.length === 0) return none(["no shared device identifier or submission number"]);
  return none([`shared submission ${shared[0]}, but the version relation is ${cmp.relation} (${cmp.reason})`]);
}

function studyEvaluates(study: IdentityRecord, product: IdentityRecord): ExactVerdict {
  const verdicts: ExactVerdict[] = [];
  const notes: string[] = [];
  const studyNct = own(study, "nct");

  // The product side cites the study: a regulator summary naming the registry id.
  for (const { value, mention } of mentionsOf(product, "nct")) {
    if (!studyNct.includes(value)) continue;
    if (mention.channel === "field") {
      verdicts.push({ kind: "CONFIRMED", basis: [`${product.id} cites ${value} in a structured field`], flags: [], notes: [] });
      continue;
    }
    const reading = classifyMentionContext(mention.context, "evaluation");
    const basis = [`${product.id} cites ${value} in its text`];
    if (reading.verdict === "ESTABLISHED") {
      verdicts.push({ kind: "CONFIRMED", basis: [...basis, `passage reads as a study of the device (${reading.cues.join(", ")})`], flags: [], notes: [] });
    } else if (reading.verdict === "CONTRADICTED") {
      verdicts.push({
        kind: "AMBIGUOUS",
        basis: [...basis, `passage reads as a data source, not a test of the device (${reading.cues.join(", ")})`],
        flags: ["identifier-cited-as-data-origin"],
        notes: [],
      });
    } else {
      verdicts.push({
        kind: "CANDIDATE",
        basis: [...basis, "the passage does not establish what the cited study did"],
        flags: ["identifier-role-unestablished"],
        notes: [],
      });
    }
  }

  // The study cites the product's submission in a structured field (an intervention name, a reference).
  const productSubs = own(product, "submission");
  for (const { value, mention } of mentionsOf(study, "submission")) {
    if (!productSubs.includes(value)) continue;
    if (mention.channel === "field") {
      verdicts.push({ kind: "CONFIRMED", basis: [`${study.id} names ${value} in a structured field`], flags: [], notes: [] });
    } else {
      notes.push(`${study.id} mentions ${value} in free text; submission numbers in prose are not trusted (accession-number noise)`);
    }
  }
  return strongest(verdicts, notes);
}

function publicationReports(publication: IdentityRecord, study: IdentityRecord): ExactVerdict {
  const verdicts: ExactVerdict[] = [];
  const notes: string[] = [];
  const studyNct = own(study, "nct");

  for (const { value, mention } of mentionsOf(publication, "nct")) {
    if (!studyNct.includes(value)) continue;
    if (mention.channel === "field") {
      verdicts.push({ kind: "CONFIRMED", basis: [`${publication.id} lists ${value} as a databank accession`], flags: [], notes: [] });
      continue;
    }
    const reading = classifyMentionContext(mention.context, "report");
    const basis = [`${publication.id} cites ${value} in its text`];
    if (reading.verdict === "ESTABLISHED") {
      verdicts.push({ kind: "CONFIRMED", basis: [...basis, `passage reads as the paper's own registration or study (${reading.cues.join(", ")})`], flags: [], notes: [] });
    } else if (reading.verdict === "CONTRADICTED") {
      verdicts.push({ kind: "AMBIGUOUS", basis: [...basis, `passage reads as a citation of earlier work (${reading.cues.join(", ")})`], flags: ["identifier-cited-as-background"], notes: [] });
    } else {
      verdicts.push({ kind: "CANDIDATE", basis: [...basis, "the passage does not establish whether the paper reports that study"], flags: ["identifier-role-unestablished"], notes: [] });
    }
  }

  const pubPmids = own(publication, "pmid");
  const pubDois = own(publication, "doi");
  for (const type of ["pmid", "doi"] as const) {
    const owned = type === "pmid" ? pubPmids : pubDois;
    for (const { value, mention } of mentionsOf(study, type)) {
      if (!owned.includes(value)) continue;
      if (mention.channel !== "field") {
        notes.push(`${study.id} mentions ${type} ${value} in free text only`);
        continue;
      }
      if (mention.role === "background") {
        verdicts.push({ kind: "REJECTED", basis: [`${study.id} lists ${type} ${value} as a background reference, not a result`], flags: ["registry-classes-reference-as-background"], notes: [] });
      } else if (mention.role === "report") {
        verdicts.push({ kind: "CONFIRMED", basis: [`${study.id} lists ${type} ${value} as a result reference`], flags: [], notes: [] });
      } else {
        verdicts.push({ kind: "CANDIDATE", basis: [`${study.id} lists ${type} ${value} with no stated role`], flags: ["identifier-role-unestablished"], notes: [] });
      }
    }
  }
  return strongest(verdicts, notes);
}

function supersedes(newer: IdentityRecord, older: IdentityRecord): ExactVerdict {
  const forward = newer.supersedes.includes(older.id);
  const backward = older.supersedes.includes(newer.id);
  if (!forward && !backward) return none(["neither record declares supersession"]);
  if (forward && backward) {
    return { kind: "AMBIGUOUS", basis: ["both records declare they supersede the other"], flags: ["supersession-cycle"], notes: [] };
  }
  const flags: string[] = [];
  if (newer.date && older.date && newer.date < older.date) {
    return {
      kind: "AMBIGUOUS",
      basis: [`${newer.id} declares it supersedes ${older.id}`],
      flags: [`date-order-contradicts-supersession (${newer.date} is earlier than ${older.date})`],
      notes: [],
    };
  }
  return { kind: "CONFIRMED", basis: [`${newer.id} declares it supersedes ${older.id}`], flags, notes: [] };
}

/**
 * Several identifiers can bear on one link. The most favourable verdict wins, but contradicting structured
 * evidence is never hidden: a confirmation beside a rejection becomes AMBIGUOUS with both reasons.
 */
function strongest(verdicts: ExactVerdict[], notes: string[]): ExactVerdict {
  if (verdicts.length === 0) return none(notes);
  const rejected = verdicts.filter((v) => v.kind === "REJECTED");
  const positive = verdicts.filter((v) => v.kind === "CONFIRMED" || v.kind === "CANDIDATE");
  if (rejected.length > 0 && positive.length > 0) {
    return {
      kind: "AMBIGUOUS",
      basis: verdicts.flatMap((v) => (v.kind === "NONE" ? [] : v.basis)),
      flags: ["identifier-evidence-conflicts", ...verdicts.flatMap((v) => (v.kind === "NONE" ? [] : v.flags))],
      notes,
    };
  }
  const best = [...verdicts].sort((x, y) => RANK[y.kind] - RANK[x.kind])[0]!;
  if (best.kind === "NONE") return none(notes);
  const same = verdicts.filter((v) => v.kind === best.kind);
  return {
    kind: best.kind,
    basis: [...new Set(same.flatMap((v) => (v.kind === "NONE" ? [] : v.basis)))],
    flags: [...new Set(same.flatMap((v) => (v.kind === "NONE" ? [] : v.flags)))],
    notes: [...notes, ...best.notes],
  } as ExactVerdict;
}
