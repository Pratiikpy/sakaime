import fc from "fast-check";
import { DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, Hierarchy } from "../../src/compiler/index.ts";
import type { Scope } from "../../src/schemas/index.ts";

export const settingsH = new Hierarchy(DEFAULT_SETTING_TAXONOMY);
export const purposesH = new Hierarchy(DEFAULT_PURPOSE_TAXONOMY);
const keys = (h: Hierarchy) => Object.keys(h.taxonomy.nodes);

export const descendantsOrSelf = (h: Hierarchy, k: string) => keys(h).filter((x) => h.covers(k, x));
export const ancestorsOrSelf = (h: Hierarchy, k: string) => h.ancestorsOrSelf(k);

export const VERSIONS = ["1.0", "1.1", "2.0", "2.1"] as const;
export const CONDITIONS = ["diabetes mellitus", "hypertension", "asthma"] as const;
export const EXCLUSIONS = ["pregnancy", "prior surgery"] as const;
const ALL_SETTINGS = keys(settingsH);
const ALL_PURPOSES = keys(purposesH);

const nonEmptySubset = <T>(xs: readonly T[]) => fc.subarray([...xs], { minLength: 1 });

export const PRODUCT = "device:fda:K1";

/** A fully stated scope. */
export const arbScope: fc.Arbitrary<Scope> = fc
  .record({
    versions: nonEmptySubset(VERSIONS),
    min: fc.integer({ min: 0, max: 60 }),
    span: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
    conditions: nonEmptySubset(CONDITIONS),
    exclusions: fc.option(fc.subarray([...EXCLUSIONS]), { nil: undefined }),
    settings: nonEmptySubset(ALL_SETTINGS),
    purpose: fc.constantFrom(...ALL_PURPOSES),
  })
  .map((r) => {
    const exclusions = r.exclusions && r.exclusions.length > 0 ? r.exclusions : undefined;
    const age = r.span === undefined ? { min: r.min } : { min: r.min, max: r.min + r.span };
    return {
      product: PRODUCT,
      versions: r.versions,
      population: { age, conditions: r.conditions, ...(exclusions ? { exclusions } : {}) },
      settings: r.settings,
      purpose: r.purpose,
    };
  });

export interface Choices {
  keep: boolean[];
  ageShift: number;
  ageClose: number;
  condKeep: boolean[];
  addExcl: boolean[];
  pick: number[];
}

export const arbChoices: fc.Arbitrary<Choices> = fc.record({
  keep: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  ageShift: fc.integer({ min: 0, max: 15 }),
  ageClose: fc.integer({ min: 0, max: 15 }),
  condKeep: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  addExcl: fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }),
  pick: fc.array(fc.nat(100), { minLength: 12, maxLength: 12 }),
});

function subset<T>(xs: readonly T[], keep: readonly boolean[]): T[] {
  const out = xs.filter((_, i) => keep[i % keep.length]);
  return out.length > 0 ? out : [xs[0] as T];
}

/** A scope inside `s` on every dimension: fewer versions, a narrower age range, fewer conditions, more exclusions, finer settings, a finer purpose. */
export function shrink(s: Scope, c: Choices): Scope {
  const pop = s.population!;
  const base = pop.age?.min ?? 0;
  const lo = pop.age?.max !== undefined ? Math.min(pop.age.max, base + c.ageShift) : base + c.ageShift;
  const hi = pop.age?.max !== undefined ? Math.max(lo, pop.age.max - c.ageClose) : lo + 5 + c.ageClose;
  const exclusions = [...new Set([...(pop.exclusions ?? []), ...EXCLUSIONS.filter((_, i) => c.addExcl[i])])];
  const settings = [...new Set((s.settings ?? []).map((k, i) => { const d = descendantsOrSelf(settingsH, k); return d[c.pick[i % c.pick.length]! % d.length]!; }))];
  const dp = descendantsOrSelf(purposesH, s.purpose!);
  return {
    ...s,
    versions: subset(s.versions ?? [], c.keep),
    population: { age: { min: lo, max: hi }, conditions: subset(pop.conditions ?? [], c.condKeep), ...(exclusions.length ? { exclusions } : {}) },
    settings,
    purpose: dp[c.pick[11]! % dp.length]!,
  };
}

/** A scope around `s` on every dimension: more versions, wider ages, more conditions, fewer exclusions, coarser settings and purpose. */
export function grow(s: Scope, c: Choices): Scope {
  const pop = s.population!;
  const lo = Math.max(0, (pop.age?.min ?? 0) - c.ageShift);
  const hi = pop.age?.max !== undefined ? pop.age.max + c.ageClose : undefined;
  const exclusions = (pop.exclusions ?? []).filter((_, i) => !c.addExcl[i]);
  const settings = [...new Set((s.settings ?? []).map((k, i) => { const a = ancestorsOrSelf(settingsH, k); return a[c.pick[i % c.pick.length]! % a.length]!; }))];
  const ap = ancestorsOrSelf(purposesH, s.purpose!);
  return {
    ...s,
    versions: [...new Set([...(s.versions ?? []), ...VERSIONS.filter((_, i) => c.keep[i])])],
    population: {
      age: hi === undefined ? { min: lo } : { min: lo, max: hi },
      conditions: [...new Set([...(pop.conditions ?? []), ...CONDITIONS.filter((_, i) => c.condKeep[i])])],
      ...(exclusions.length ? { exclusions } : {}),
    },
    settings,
    purpose: ap[c.pick[11]! % ap.length]!,
  };
}
