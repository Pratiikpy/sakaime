/**
 * The hospital's own requirements, held against the extracted evidence.
 *
 * Requirement rows come from the hospital review database through Zetaris. A row becomes a "requirement" evidence item with
 * a `satisfied` verdict only when code can decide it from what was extracted. The verdict is true, false, or not given: a
 * requirement the extracted evidence cannot decide (a subgroup report, an update-control statement, a time-to-notification
 * figure) produces no item and is listed as unassessed, so it is visible and never counted as met.
 *
 * An unmet requirement is a flag for the committee, not a rejection: the compiler turns it into REQUIRES_DOMAIN_REVIEW.
 */
import { Hierarchy } from "../compiler/index.ts";
import type { CheckedAssertion } from "../extraction/index.ts";
import { EvidenceItemSchema, type EvidenceItem } from "../schemas/index.ts";
import { SERVICE_SETTINGS } from "./bridge.ts";
import type { CaseClaim } from "./cases.ts";

export interface RequirementRow {
  requirement_id: string;
  applies_to_purpose: string;
  dimension: string;
  comparator: string;
  required_value: string;
  rationale: string;
  policy_ref: string;
  policy_version: string;
}

export interface PrecedentRow {
  precedent_id: string;
  topic: string;
  statement: string;
}

/** What the admitted study records and the authorization state, reduced to the facts a requirement can be tested on. */
export interface EvidenceDigest {
  designs: string[];
  siteCounts: number[];
  ageMins: number[];
  versions: string[];
  settings: string[];
  equipment: string[];
}

export function digestOf(kept: readonly CheckedAssertion[]): EvidenceDigest {
  const ok = kept.filter((k) => k.assertion.quoteVerified && k.assertion.supportVerified === "PASS");
  const vals = (p: string) => ok.filter((k) => k.assertion.predicate === p).map((k) => k.assertion.value);
  return {
    designs: vals("study.design").map(String),
    siteCounts: vals("study.site_count").map(Number).filter(Number.isFinite),
    ageMins: vals("population.age_min").map(Number).filter(Number.isFinite),
    versions: vals("device.version").map(String),
    settings: vals("indication.setting_term").map(String),
    equipment: vals("indication.compatible_equipment").flatMap((v) => (Array.isArray(v) ? v.map(String) : [String(v)])),
  };
}

export function mergeDigests(...ds: EvidenceDigest[]): EvidenceDigest {
  return {
    designs: ds.flatMap((d) => d.designs),
    siteCounts: ds.flatMap((d) => d.siteCounts),
    ageMins: ds.flatMap((d) => d.ageMins),
    versions: ds.flatMap((d) => d.versions),
    settings: ds.flatMap((d) => d.settings),
    equipment: ds.flatMap((d) => d.equipment),
  };
}

export interface Assessment {
  /** Undefined: the extracted evidence cannot decide this requirement. */
  satisfied?: boolean;
  reason: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const settingHierarchy = new Hierarchy(SERVICE_SETTINGS);

export function assessRequirement(row: RequirementRow, claim: CaseClaim, d: EvidenceDigest): Assessment {
  switch (row.dimension) {
    case "validation_type": {
      if (row.required_value !== "prospective_multicentre") return { reason: `validation type "${row.required_value}" is not one the checker understands` };
      const prospective = d.designs.some((x) => /prospective/i.test(x) && !/retrospective/i.test(x));
      const retrospectiveOnly = d.designs.length > 0 && !prospective;
      const multi = d.siteCounts.some((n) => n >= 2);
      const single = d.siteCounts.length > 0 && !multi;
      if (prospective && multi) return { satisfied: true, reason: `a prospective design and ${Math.max(...d.siteCounts)} sites are stated in the evidence` };
      if (retrospectiveOnly) return { satisfied: false, reason: `the evidence states a ${[...new Set(d.designs)].join(", ")} design and no prospective study` };
      if (single) return { satisfied: false, reason: "the evidence states a single study site" };
      return { reason: "the extracted evidence does not state both the design and the number of sites" };
    }
    case "population_min_age": {
      if (d.ageMins.length === 0) return { reason: "no study in the extracted evidence states a minimum participant age" };
      const target = claim.use.population?.age?.min ?? Number(row.required_value);
      const youngest = Math.min(...d.ageMins);
      return youngest <= target
        ? { satisfied: true, reason: `the evidence includes participants from age ${youngest}, down to the age ${target} the use needs` }
        : { satisfied: false, reason: `the evidence starts at age ${youngest}; the use needs it down to age ${target}` };
    }
    case "version_specific_evidence": {
      const wanted = claim.use.versions ?? [];
      if (wanted.length === 0) return { reason: "the claim names no software version" };
      if (d.versions.length === 0) return { reason: "no study in the extracted evidence names a software version" };
      const has = wanted.every((v) => d.versions.some((x) => norm(x) === norm(v)));
      return has
        ? { satisfied: true, reason: `the evidence names version ${wanted.join(", ")}` }
        : { satisfied: false, reason: `the evidence names version ${[...new Set(d.versions)].join(", ")}, not ${wanted.join(", ")}` };
    }
    case "setting_match": {
      const wanted = claim.use.settings ?? [];
      if (wanted.length === 0) return { reason: "the claim names no care setting" };
      if (d.settings.length === 0) return { reason: "the extracted evidence states no care setting" };
      const placed = d.settings.map((s) => settingHierarchy.resolve(s)).filter((r) => r.placed).map((r) => r.key);
      if (placed.length === 0) return { reason: "the care settings the evidence states could not be placed on the setting hierarchy" };
      const claimed = wanted.map((s) => settingHierarchy.resolve(s));
      if (claimed.some((c) => !c.placed)) return { reason: "a claimed care setting could not be placed on the setting hierarchy" };
      const uncovered = claimed.filter((c) => !placed.some((p) => settingHierarchy.covers(p, c.key)));
      return uncovered.length === 0
        ? { satisfied: true, reason: `the evidence covers ${wanted.join(", ")}` }
        : { satisfied: false, reason: `the evidence does not cover ${uncovered.map((u) => u.key).join(", ")}` };
    }
    default:
      return { reason: `requirement dimension "${row.dimension}" cannot be decided from extracted evidence` };
  }
}

/** The camera precedent: equipment the authorization does not list needs a local bridging study. */
export function assessCameraPrecedent(claim: CaseClaim, d: EvidenceDigest): Assessment {
  if (!claim.equipment) return { reason: "the claim names no equipment" };
  if (d.equipment.length === 0) return { reason: "the authorization record read states no compatible equipment" };
  const claimed = norm(claim.equipment);
  const listed = d.equipment.map(norm).some((e) => e.includes(claimed) || claimed.includes(e));
  return listed
    ? { satisfied: true, reason: `${claim.equipment} is among the equipment the authorization lists` }
    : { satisfied: false, reason: `${claim.equipment} is not among the equipment the authorization lists (${[...new Set(d.equipment)].join("; ")})` };
}

export interface RequirementOutcome {
  items: EvidenceItem[];
  /** Requirement rows the extracted evidence could not decide. They are not counted as met. */
  unassessed: { id: string; dimension: string; statement: string; why: string }[];
  /** Plain statement of each assessed row, for the case view. */
  assessed: { id: string; satisfied: boolean | undefined; reason: string }[];
}

export function requirementItems(rows: readonly RequirementRow[], precedents: readonly PrecedentRow[], claim: CaseClaim, digest: EvidenceDigest): RequirementOutcome {
  const items: EvidenceItem[] = [];
  const unassessed: RequirementOutcome["unassessed"] = [];
  const assessed: RequirementOutcome["assessed"] = [];
  const applicable = rows.filter((r) => r.applies_to_purpose === (claim.use.purpose ?? ""));
  for (const row of applicable) {
    const a = assessRequirement(row, claim, digest);
    if (a.satisfied === undefined) {
      unassessed.push({ id: row.requirement_id, dimension: row.dimension, statement: row.rationale, why: a.reason });
      assessed.push({ id: row.requirement_id, satisfied: undefined, reason: a.reason });
      continue;
    }
    assessed.push({ id: row.requirement_id, satisfied: a.satisfied, reason: a.reason });
    items.push(
      EvidenceItemSchema.parse({
        id: `req:${claim.id}:${row.requirement_id}`,
        assertionType: "requirement",
        scope: {},
        satisfied: a.satisfied,
        limitations: [`${row.policy_ref} ${row.policy_version} ${row.requirement_id}: ${row.rationale}`, a.reason],
        anchorIds: [],
      }),
    );
  }
  const camera = precedents.find((p) => p.topic === "camera_model");
  if (camera && claim.equipment) {
    const a = assessCameraPrecedent(claim, digest);
    if (a.satisfied === undefined) {
      unassessed.push({ id: camera.precedent_id, dimension: "camera_model", statement: camera.statement, why: a.reason });
    } else {
      assessed.push({ id: camera.precedent_id, satisfied: a.satisfied, reason: a.reason });
      items.push(
        EvidenceItemSchema.parse({
          id: `req:${claim.id}:${camera.precedent_id}`,
          assertionType: "requirement",
          scope: {},
          satisfied: a.satisfied,
          limitations: [`${camera.precedent_id}: ${camera.statement}`, a.reason],
          anchorIds: [],
        }),
      );
    }
  }
  return { items, unassessed, assessed };
}
