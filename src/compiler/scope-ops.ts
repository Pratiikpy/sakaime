import type { ExpertFlag, Population, Scope } from "../schemas/index.ts";
import { gapsOf, intersect, intersectLists, listContains, mergeIntervals, renderAge, renderAges, renderGap, type Interval } from "./intervals.ts";
import { Hierarchy } from "./taxonomy.ts";
import type { Explicit, Ops, Outcome } from "./types.ts";
import { diffSets, intersectSets, list, normText, normVersion, setOf, sortedUnique, subsetOf, unionSets, worst } from "./util.ts";

const ambiguous = (dimension: "population" | "purpose", why: string): ExpertFlag => ({
  ruleId: "SAK-NARROWER-AMBIGUOUS",
  dimension,
  reason: why,
});

/* ------------------------------------------------------------------ product */

export const productOps: Ops<Set<string>> = {
  dimension: "product",
  claim: (use) => (use.product ? new Set([use.product]) : undefined),
  item: (item) => (item.scope.product ? new Set([item.scope.product]) : undefined),
  union: unionSets,
  meet: intersectSets,
  relate(c, e) {
    if (subsetOf(c, e)) {
      return { relation: "CONTAINED", detail: `The evidence concerns the claimed product (${list(c)}).`, ruleIds: [], flags: [], explicit: [] };
    }
    return {
      relation: "DISJOINT",
      detail: `The claim is for ${list(c)}; the evidence concerns ${list(e)}.`,
      ruleIds: ["SAK-PRODUCT-MISMATCH"],
      flags: [],
      explicit: [],
    };
  },
  isEmpty: (v) => v.size === 0,
  render: (v) => list(v),
  toScope: () => ({}),
};

/* ------------------------------------------------------------------ version */

export const versionOps: Ops<Set<string>> = {
  dimension: "version",
  claim: (use) => setOf(use.versions, normVersion),
  item: (item) => setOf(item.scope.versions, normVersion),
  union: unionSets,
  meet: intersectSets,
  relate(c, e) {
    if (subsetOf(c, e)) {
      return {
        relation: "CONTAINED",
        detail: `The claimed version (${list(c)}) is among the versions the evidence covers (${list(e)}).`,
        ruleIds: [],
        flags: [],
        explicit: [],
      };
    }
    const shared = intersectSets(c, e);
    if (shared.size === 0) {
      return {
        relation: "DISJOINT",
        detail: `The claim is for version ${list(c)}; ${e.size ? `the evidence covers version ${list(e)}` : "the evidence covers no version in common"}. Nothing in the evidence speaks for the claimed version.`,
        ruleIds: ["R01-VER-DISJOINT"],
        flags: [],
        explicit: [],
      };
    }
    const missing = diffSets(c, e);
    return {
      relation: "PARTIAL",
      narrower: shared,
      gap: `version ${list(missing)}`,
      detail: `The evidence covers version ${list(shared)} of the claimed ${list(c)}; it says nothing about ${list(missing)}.`,
      ruleIds: ["R01-VER-DISJOINT"],
      flags: [],
      explicit: [],
    };
  },
  isEmpty: (v) => v.size === 0,
  render: (v) => list(v),
  toScope: (v) => ({ versions: sortedUnique(v) }),
};

/* --------------------------------------------------------------- population */

export interface PopV {
  age?: Interval[];
  conditions?: Set<string>;
  exclusions?: Set<string>;
}

function popOf(p: Population | undefined): PopV | undefined {
  if (!p) return undefined;
  const out: PopV = {};
  const a = p.age;
  if (a && (a.min !== undefined || a.max !== undefined)) out.age = [{ lo: a.min ?? 0, hi: a.max ?? Infinity }];
  const conditions = setOf(p.conditions, normText);
  if (conditions) out.conditions = conditions;
  const exclusions = setOf(p.exclusions, normText);
  if (exclusions) out.exclusions = exclusions;
  return out.age || out.conditions || out.exclusions ? out : undefined;
}

interface Part {
  relation: Outcome<PopV>["relation"];
  detail: string;
  gap?: string;
  rules: string[];
  explicit: Explicit[];
  apply?: (n: PopV) => void;
  ambiguousWhy?: string;
}

function agePart(c: Interval[] | undefined, e: Interval[] | undefined): Part | undefined {
  if (!c && !e) return undefined;
  if (!c) return { relation: "UNKNOWN", detail: "The claim states no age range, so age coverage cannot be judged.", rules: ["SAK-CLAIM-UNSPECIFIED"], explicit: [] };
  if (!e) return { relation: "UNKNOWN", detail: "The evidence states no age range.", rules: ["R11-POP-UNDESCRIBED"], explicit: [] };
  const claimed = c[0]!;
  if (listContains(e, claimed)) {
    return { relation: "CONTAINED", detail: `The evidence covers ${renderAges(e)}; the claim (${renderAge(claimed)}) lies inside it.`, rules: [], explicit: [] };
  }
  const pieces = mergeIntervals(e.map((p) => intersect(p, claimed)).filter((x): x is Interval => x !== undefined));
  if (pieces.length === 0) {
    return {
      relation: "DISJOINT",
      detail: `The claim is for ${renderAge(claimed)}; the evidence covers ${renderAges(e)}, which does not overlap it.`,
      rules: ["R09-POP-DISJOINT"],
      explicit: [{ ruleId: "R10-POP-LABEL-EXCLUDED", text: `the record covers ${renderAges(e)}; the claimed ${renderAge(claimed)} lies outside it` }],
    };
  }
  const gap = gapsOf(claimed, e).map(renderGap).join(" and ");
  const part: Part = {
    relation: "PARTIAL",
    gap,
    detail: `The evidence covers ${renderAges(e)}; the claim also asks for ${gap}.`,
    rules: ["R08-POP-SUBSET"],
    explicit: [{ ruleId: "R10-POP-LABEL-EXCLUDED", text: `the record covers ${renderAges(e)}; the claim extends to ${gap}` }],
  };
  if (pieces.length === 1) part.apply = (n) => void (n.age = pieces);
  else part.ambiguousWhy = `The evidence covers the claimed ages in ${pieces.length} separate pieces (${renderAges(pieces)}), so no single narrower age range can be stated.`;
  return part;
}

function conditionsPart(c: Set<string> | undefined, e: Set<string> | undefined, excl: Set<string>): Part | undefined {
  if (!c && !e) return undefined;
  if (!c) return { relation: "UNKNOWN", detail: "The claim names no conditions, so coverage of the target condition cannot be judged.", rules: ["SAK-CLAIM-UNSPECIFIED"], explicit: [] };
  if (!e) return { relation: "UNKNOWN", detail: "The evidence names no target condition.", rules: ["R11-POP-UNDESCRIBED"], explicit: [] };
  const excluded = intersectSets(c, excl);
  const covered = new Set([...c].filter((x) => e.has(x) && !excl.has(x)));
  const uncovered = diffSets(c, covered);
  const explicit: Explicit[] = excluded.size
    ? [{ ruleId: "R10-POP-LABEL-EXCLUDED", text: `the record excludes ${list(excluded)}, which the claim includes` }]
    : [];
  if (uncovered.size === 0) {
    return { relation: "CONTAINED", detail: `The evidence covers ${list(e)}; the claim (${list(c)}) lies inside it.`, rules: [], explicit: [] };
  }
  if (covered.size === 0) {
    return {
      relation: "DISJOINT",
      detail: `The claim is for ${list(c)}; the evidence covers ${list(e)}${excluded.size ? ` and excludes ${list(excluded)}` : ""}.`,
      rules: ["R09-POP-DISJOINT"],
      explicit,
    };
  }
  return {
    relation: "PARTIAL",
    gap: list(uncovered),
    detail: `The evidence covers ${list(covered)} of the claimed ${list(c)}; it does not cover ${list(uncovered)}.`,
    rules: ["R08-POP-SUBSET"],
    explicit,
    apply: (n) => void (n.conditions = covered),
  };
}

function exclusionsPart(c: PopV, e: PopV): Part | undefined {
  if (!e.exclusions || e.exclusions.size === 0) return undefined;
  const unhandled = diffSets(diffSets(e.exclusions, c.exclusions ?? new Set()), c.conditions ?? new Set());
  if (unhandled.size === 0) {
    return { relation: "CONTAINED", detail: "Every group the evidence excluded is also excluded or not claimed.", rules: [], explicit: [] };
  }
  return {
    relation: "PARTIAL",
    gap: `${list(unhandled)} (excluded from the evidence, not excluded by the claim)`,
    detail: `The evidence excluded ${list(unhandled)}; the claim does not exclude ${unhandled.size === 1 ? "that group" : "those groups"}.`,
    rules: ["R08-POP-SUBSET"],
    explicit: [],
    apply: (n) => void (n.exclusions = unionSets(n.exclusions ?? new Set(), unhandled)),
  };
}

function renderPop(v: PopV): string {
  const parts: string[] = [];
  if (v.age) parts.push(renderAges(v.age));
  if (v.conditions) parts.push(`conditions: ${list(v.conditions)}`);
  if (v.exclusions) parts.push(`excluding: ${list(v.exclusions)}`);
  return parts.join("; ");
}

function popToScope(v: PopV): Partial<Scope> {
  const p: Population = {};
  if (v.age && v.age.length === 1) {
    const { lo, hi } = v.age[0]!;
    // A bound of 0 is kept: an age range with no bounds reads as unspecified, but "from age 0" is a stated claim.
    const age: { min: number; max?: number } = { min: lo };
    if (Number.isFinite(hi)) age.max = hi;
    p.age = age;
  }
  if (v.conditions) p.conditions = sortedUnique(v.conditions);
  if (v.exclusions) p.exclusions = sortedUnique(v.exclusions);
  return { population: p };
}

export const populationOps: Ops<PopV> = {
  dimension: "population",
  claim: (use) => popOf(use.population),
  item: (item) => popOf(item.scope.population),
  union(a, b) {
    const out: PopV = {};
    const age = a.age && b.age ? mergeIntervals([...a.age, ...b.age]) : (a.age ?? b.age);
    if (age) out.age = age;
    const conditions = a.conditions && b.conditions ? unionSets(a.conditions, b.conditions) : (a.conditions ?? b.conditions);
    if (conditions) out.conditions = conditions;
    // Several records: a group counts as excluded if any record excluded it. This can only lose coverage, never invent it.
    const exclusions = a.exclusions && b.exclusions ? unionSets(a.exclusions, b.exclusions) : (a.exclusions ?? b.exclusions);
    if (exclusions) out.exclusions = exclusions;
    return out;
  },
  meet(a, b) {
    const out: PopV = {};
    const age = a.age && b.age ? intersectLists(a.age, b.age) : (a.age ?? b.age);
    if (age) out.age = age;
    const conditions = a.conditions && b.conditions ? intersectSets(a.conditions, b.conditions) : (a.conditions ?? b.conditions);
    if (conditions) out.conditions = conditions;
    const exclusions = a.exclusions && b.exclusions ? unionSets(a.exclusions, b.exclusions) : (a.exclusions ?? b.exclusions);
    if (exclusions) out.exclusions = exclusions;
    return out;
  },
  relate(c, e) {
    const parts = [agePart(c.age, e.age), conditionsPart(c.conditions, e.conditions, e.exclusions ?? new Set()), exclusionsPart(c, e)].filter(
      (p): p is Part => p !== undefined,
    );
    if (parts.length === 0) {
      return { relation: "UNKNOWN", detail: "Neither the claim nor the evidence states a population.", ruleIds: ["R11-POP-UNDESCRIBED"], flags: [], explicit: [] };
    }
    const relation = worst(parts.map((p) => p.relation));
    const ruleIds = sortedUnique(parts.filter((p) => p.relation !== "CONTAINED").flatMap((p) => p.rules));
    const explicit = parts.flatMap((p) => p.explicit);
    const gap = parts.filter((p) => p.gap).map((p) => p.gap!).join("; ");
    const detail = parts.map((p) => p.detail).join(" ");
    const out: Outcome<PopV> = { relation, detail, ruleIds, flags: [], explicit };
    if (gap) out.gap = gap;
    if (relation === "PARTIAL") {
      const ambiguousPart = parts.find((p) => p.ambiguousWhy);
      if (ambiguousPart) {
        out.flags.push(ambiguous("population", ambiguousPart.ambiguousWhy!));
      } else {
        const n: PopV = {};
        if (c.age) n.age = c.age;
        if (c.conditions) n.conditions = c.conditions;
        if (c.exclusions) n.exclusions = c.exclusions;
        for (const p of parts) if (p.relation === "PARTIAL") p.apply?.(n);
        out.narrower = n;
      }
    }
    return out;
  },
  isEmpty: (v) => v.age?.length === 0 || v.conditions?.size === 0,
  render: renderPop,
  toScope: popToScope,
};

/* ------------------------------------------------- settings and purposes */

interface HierarchyKind {
  dimension: "setting" | "purpose";
  noun: string;
  unplacedRule: "SAK-UNPLACED-SETTING" | "SAK-UNPLACED-PURPOSE";
  partialRule: string;
  disjointRule: string;
  /** Whether a PARTIAL result can be stated as several nodes. */
  multi: boolean;
}

function hierarchyOps(h: Hierarchy, kind: HierarchyKind, read: (s: Scope) => string[] | undefined, toScope: (keys: string[]) => Partial<Scope>): Ops<Set<string>> {
  const resolve = (raw: string[] | undefined): Set<string> | undefined => {
    if (!raw || raw.length === 0) return undefined;
    return new Set(raw.map((x) => h.resolve(x).key));
  };
  const maximal = (keys: Iterable<string>): Set<string> => new Set(h.maximal(keys));
  const covers = (broad: string, narrow: string): boolean => broad === narrow || h.covers(broad, narrow);

  return {
    dimension: kind.dimension,
    claim: (use) => resolve(read(use)),
    item: (item) => resolve(read(item.scope)),
    union: (a, b) => maximal([...a, ...b]),
    meet(a, b) {
      const out: string[] = [];
      for (const x of a) for (const y of b) {
        if (covers(x, y)) out.push(y);
        else if (covers(y, x)) out.push(x);
      }
      return maximal(out);
    },
    relate(c, e) {
      const covered: string[] = [];
      const partial: string[] = [];
      const uncovered: string[] = [];
      const gapParts: string[] = [];
      for (const k of [...c].sort()) {
        if ([...e].some((x) => covers(x, k))) {
          covered.push(k);
          continue;
        }
        const inside = [...e].filter((x) => x !== k && h.has(k) && h.has(x) && h.covers(k, x));
        partial.push(...inside);
        uncovered.push(k);
        gapParts.push(inside.length > 0 ? `${h.label(k)} outside ${h.render(inside)}` : h.label(k));
      }
      const fullyCovered = uncovered.length === 0;
      const unplaced = sortedUnique([...c, ...e].filter((k) => !h.has(k)));
      const claimedText = h.render(c);
      const establishedText = h.render(e);

      if (fullyCovered) {
        return {
          relation: "CONTAINED",
          detail: `The claimed ${kind.noun} (${claimedText}) lies inside what the evidence establishes (${establishedText}).`,
          ruleIds: [],
          flags: [],
          explicit: [],
        };
      }
      if (unplaced.length > 0) {
        return {
          relation: "UNKNOWN",
          pending: true,
          term: unplaced.join('", "'),
          detail: `The ${kind.noun} term${unplaced.length > 1 ? "s" : ""} "${unplaced.join('", "')}" cannot be placed in the ${kind.noun} taxonomy, so no containment is decided. A reviewer must place ${unplaced.length > 1 ? "them" : "it"}.`,
          ruleIds: [],
          flags: [
            {
              ruleId: kind.unplacedRule,
              dimension: kind.dimension,
              reason: `"${unplaced.join('", "')}" is not in the ${kind.noun} taxonomy (${h.taxonomy.id} version ${h.taxonomy.version}); the compiler does not guess a containment.`,
            },
          ],
          explicit: [],
        };
      }
      if (covered.length === 0 && partial.length === 0) {
        return {
          relation: "DISJOINT",
          detail: `The claim is for ${claimedText}; the evidence concerns ${establishedText}, which does not contain it.`,
          ruleIds: [kind.disjointRule],
          flags: [],
          explicit: [],
        };
      }
      const narrower = maximal([...covered, ...partial]);
      const gapText = gapParts.join("; ");
      const out: Outcome<Set<string>> = {
        relation: "PARTIAL",
        gap: gapText,
        detail: `The evidence covers ${h.render(narrower)}; the claim also asks for ${gapText}, which the evidence does not establish.`,
        ruleIds: [kind.partialRule],
        flags: [],
        explicit: [],
      };
      if (!kind.multi && narrower.size > 1) {
        out.flags.push(ambiguous("purpose", `The evidence covers ${narrower.size} separate purposes inside the claimed one (${h.render(narrower)}), so no single narrower purpose can be stated.`));
      } else {
        out.narrower = narrower;
      }
      return out;
    },
    isEmpty: (v) => v.size === 0,
    render: (v) => h.render(v),
    toScope: (v) => toScope(h.maximal(v)),
  };
}

export function settingOps(h: Hierarchy): Ops<Set<string>> {
  return hierarchyOps(
    h,
    { dimension: "setting", noun: "care setting", unplacedRule: "SAK-UNPLACED-SETTING", partialRule: "R15-SETTING-NOT-STUDIED", disjointRule: "R15-SETTING-NOT-STUDIED", multi: true },
    (s) => s.settings,
    (keys) => ({ settings: keys }),
  );
}

export function purposeOps(h: Hierarchy): Ops<Set<string>> {
  return hierarchyOps(
    h,
    { dimension: "purpose", noun: "purpose", unplacedRule: "SAK-UNPLACED-PURPOSE", partialRule: "R25-PURPOSE-ESCALATION", disjointRule: "SAK-PURPOSE-DISJOINT", multi: false },
    (s) => (s.purpose ? [s.purpose] : undefined),
    (keys) => (keys.length === 1 ? { purpose: keys[0]! } : {}),
  );
}

