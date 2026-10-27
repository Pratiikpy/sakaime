/**
 * TimeShift (docs/06 section 3): does the system reconstruct what it knew on an earlier date, and mark stale exactly the findings that
 * depend on what changed?
 *
 * Built on the real World Model (src/engines/world-model) and the compiler. The scopes are the authentic ones the extraction layer reads
 * from real FDA summaries; the changes are constructed events of the four kinds the protocol names (a registry record updated after a
 * finding, a corrected publication, a superseded authorization, a withdrawn record) plus two controls that must change nothing (an
 * unrelated fact, a late-arriving older observation that loses).
 *
 * For every case, with five devices and their findings in one world and one device changed:
 *   R  back in time: the world as it was before the change, recompiled, reproduces every original finding identically.
 *   D  the engine's stale set equals the dependent set computed independently from the findings' recorded inputs (compiler.staleFindings).
 *   M  no finding whose output really changed is left unflagged.
 *   O  findings of the other four devices are untouched.
 *   C  after recomputing only the stale findings and re-declaring them, nothing is stale and the recomputed findings equal a full recompute.
 * Over-flagging (stale although the output did not change) is counted, not hidden: dependence is recorded per evidence item.
 *
 * Class: consistency, on authentic scopes. Not a measurement of how real registries change.
 *
 *   npx tsx evals/suites/timeshift.ts
 */
import { compileDetailed, staleFindings, type CompileOptions } from "../../src/compiler/index.ts";
import { WorldModel, type FactRecord } from "../../src/engines/world-model/index.ts";
import { ClaimSchema, type EvidenceItem, type Finding } from "../../src/schemas/index.ts";
import { wilson, zeroErrorUpperBound } from "../stats/index.ts";
import { hashOfJson, stamp } from "../lib/core.ts";
import { rateRow, writeResult } from "../lib/results.ts";
import { authenticItems } from "../lib/scopes.ts";

const SEED = 20261027;
const DEVICES: { id: string; part: "development" | "held-out" }[] = [
  { id: "K200667", part: "development" },
  { id: "DEN170073", part: "development" },
  { id: "DEN180001", part: "development" },
  { id: "K252360", part: "held-out" },
  { id: "K250680", part: "held-out" },
];

type Slot = "auth.versions" | "auth.settings" | "auth.purpose" | "auth.timing" | "study.age_min";
const SLOT_ITEM: Record<Slot, { type: "authorization" | "study"; dimension: "version" | "setting" | "purpose" | "timing" | "population" }> = {
  "auth.versions": { type: "authorization", dimension: "version" },
  "auth.settings": { type: "authorization", dimension: "setting" },
  "auth.purpose": { type: "authorization", dimension: "purpose" },
  "auth.timing": { type: "authorization", dimension: "timing" },
  "study.age_min": { type: "study", dimension: "population" },
};

// All real clearance dates in the data are on or before 2026-06-15, so the timeline starts after them.
const T0_RECORDED = "2026-07-10T09:00:00.000Z";
const FINDINGS_AT = "2026-07-11T09:00:00.000Z";
const CHANGE_RECORDED = "2026-09-01T09:00:00.000Z";
const BEFORE = "2026-08-01";
const AFTER = "2026-10-01";

interface Initial {
  id: string;
  product: string;
  slots: Partial<Record<Slot, string>>;
  decision?: string;
}

async function initialFor(d: (typeof DEVICES)[number]): Promise<Initial> {
  const { auth, study } = await authenticItems(d.id, d.part);
  const slots: Partial<Record<Slot, string>> = {};
  const s = auth?.scope;
  if (s?.versions?.length) slots["auth.versions"] = JSON.stringify(s.versions);
  if (s?.settings?.length) slots["auth.settings"] = JSON.stringify(s.settings);
  if (s?.purpose) slots["auth.purpose"] = s.purpose;
  if (s?.timing?.from) slots["auth.timing"] = JSON.stringify({ from: s.timing.from });
  const age = study?.scope.population?.age?.min;
  if (age !== undefined) slots["study.age_min"] = String(age);
  return { id: d.id, product: `device:fda:${d.id}`, slots, ...(s?.timing?.from ? { decision: s.timing.from } : {}) };
}

let counter = 0;
function newWorld(clockAt: { ms: number }): WorldModel {
  return new WorldModel({ storage: "memory", namespace: `timeshift-${++counter}`, clock: () => new Date(clockAt.ms) });
}

interface SlotFact {
  slot: Slot;
  fact: FactRecord;
}

const FIRST_SOURCE_AT = (slot: Slot, decision: string | undefined): string => (slot.startsWith("auth.") && decision ? decision : "2021-01-01T00:00:00.000Z");

/** Evidence items for one device, built from the winning fact of each slot at a given record time. One item per slot, so dependence is per slot. */
function itemsAt(world: WorldModel, dev: Initial, asOf: string | undefined): { items: EvidenceItem[]; factIds: Record<string, string[]>; winners: Partial<Record<Slot, FactRecord>> } {
  const items: EvidenceItem[] = [];
  const factIds: Record<string, string[]> = {};
  const winners: Partial<Record<Slot, FactRecord>> = {};
  for (const slot of Object.keys(SLOT_ITEM) as Slot[]) {
    const res = world.resolve(dev.product, slot, asOf ? { asOf } : {});
    if (res.status !== "resolved" || !res.winner) continue;
    winners[slot] = res.winner;
    const value = String(res.winner.value);
    const { type } = SLOT_ITEM[slot];
    const scope: Record<string, unknown> = { product: dev.product };
    if (slot === "auth.versions") scope["versions"] = JSON.parse(value);
    if (slot === "auth.settings") scope["settings"] = JSON.parse(value);
    if (slot === "auth.purpose") scope["purpose"] = value;
    if (slot === "auth.timing") scope["timing"] = JSON.parse(value);
    if (slot === "study.age_min") scope["population"] = { age: { min: Number(value) } };
    const id = `item:${dev.id}:${slot}`;
    items.push({ id, assertionType: type, scope, results: [], limitations: [], anchorIds: [id], ...(type === "study" ? { adequate: true } : {}) } as EvidenceItem);
    factIds[id] = [res.winner.id];
  }
  return { items, factIds, winners };
}

interface ClaimSpec {
  id: string;
  dims: ("version" | "setting" | "purpose" | "timing" | "population")[];
  claim: Record<string, unknown>;
  needsStudy: boolean;
}

function claimsFor(dev: Initial): ClaimSpec[] {
  const out: ClaimSpec[] = [];
  const mk = (suffix: string, dims: ClaimSpec["dims"], use: Record<string, unknown>, needsStudy = false): void => {
    out.push({ id: `${dev.id}-${suffix}`, dims, claim: { product: dev.product, ...use }, needsStudy });
  };
  const raw = (slot: Slot) => dev.slots[slot];
  if (raw("auth.versions")) mk("version", ["version"], { versions: JSON.parse(raw("auth.versions") as string) });
  if (raw("auth.settings")) mk("setting", ["setting"], { settings: JSON.parse(raw("auth.settings") as string) });
  if (raw("auth.purpose")) mk("purpose", ["purpose"], { purpose: raw("auth.purpose") });
  if (raw("study.age_min")) mk("age", ["population"], { population: { age: { min: Number(raw("study.age_min")) } } }, true);
  if (raw("auth.timing")) mk("timing", ["timing"], { timing: { from: addDays((JSON.parse(raw("auth.timing") as string) as { from: string }).from, 400) } });
  const all = out.filter((c) => !c.needsStudy);
  if (all.length >= 2) mk("combined", all.flatMap((c) => c.dims), Object.assign({}, ...all.map((c) => { const { product: _p, ...rest } = c.claim; return rest; })));
  return out;
}

const addDays = (iso: string, days: number): string => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

function compileAll(specs: ClaimSpec[], world: WorldModel, dev: Initial, asOf: string | undefined): Map<string, { finding: Finding; items: EvidenceItem[] }> {
  const { items, factIds } = itemsAt(world, dev, asOf);
  const out = new Map<string, { finding: Finding; items: EvidenceItem[] }>();
  for (const sp of specs) {
    const options: CompileOptions = {
      requiredDimensions: ["product", ...sp.dims],
      factIds,
      traceId: sp.id,
      computedAt: "2026-10-27T00:00:00.000Z",
    };
    const claim = ClaimSchema.parse({ id: sp.id, use: sp.claim, dependencies: { required: sp.needsStudy ? ["authorization", "study"] : ["authorization"], corroborating: [] } });
    out.set(sp.id, { finding: compileDetailed(claim, items, options).finding, items });
  }
  return out;
}

const same = (a: Finding, b: Finding): boolean => hashOfJson({ l: a.label, m: a.mismatches, s: a.supportedScope, r: a.requiredEvidence.map((x) => x.dimension) }) === hashOfJson({ l: b.label, m: b.mismatches, s: b.supportedScope, r: b.requiredEvidence.map((x) => x.dimension) });

interface ScenarioResult {
  id: string;
  device: string;
  scenario: string;
  findings: number;
  reconstructed: number;
  staleEqualsDependent: boolean;
  missed: string[];
  staleOtherDevices: string[];
  overFlagged: string[];
  affected: string[];
  stale: string[];
  dependent: string[];
  cleanAfterRecompute: boolean;
  recomputeMatchesFull: boolean;
  note?: string;
}

async function runScenario(devices: Initial[], target: Initial, scenario: string): Promise<ScenarioResult | undefined> {
  const clock = { ms: Date.parse(T0_RECORDED) };
  const world = newWorld(clock);
  const specs = new Map<string, ClaimSpec[]>();
  const initialFacts = new Map<string, Partial<Record<Slot, FactRecord>>>();
  for (const d of devices) {
    await world.upsertEntity({ type: "device", externalKey: { system: "fda", id: d.id }, name: d.id, source: { kind: "manual", at: T0_RECORDED } });
    const facts: Partial<Record<Slot, FactRecord>> = {};
    for (const [slot, value] of Object.entries(d.slots) as [Slot, string][]) {
      facts[slot] = await world.assertFact({ about: d.product, predicate: slot, value, source: { kind: slot.startsWith("auth.") ? "regulator" : "document", at: FIRST_SOURCE_AT(slot, d.decision) } });
    }
    initialFacts.set(d.id, facts);
    specs.set(d.id, claimsFor(d));
  }
  const originals = new Map<string, Finding>();
  clock.ms = Date.parse(FINDINGS_AT);
  for (const d of devices) {
    const compiled = compileAll(specs.get(d.id) as ClaimSpec[], world, d, undefined);
    for (const [id, c] of compiled) {
      originals.set(id, c.finding);
      await world.declareDependencies({ findingId: id, refs: c.finding.dependsOnFacts });
    }
  }

  // The change.
  clock.ms = Date.parse(CHANGE_RECORDED);
  const tf = initialFacts.get(target.id) as Partial<Record<Slot, FactRecord>>;
  const changed: string[] = [];
  let note: string | undefined;
  switch (scenario) {
    case "registry-record-updated": {
      if (!tf["auth.versions"]) return undefined;
      const old = JSON.parse(target.slots["auth.versions"] as string) as string[];
      await world.assertFact({ about: target.product, predicate: "auth.versions", value: JSON.stringify([`${old[0]}.1`]), source: { kind: "regulator", at: "2026-08-20T00:00:00.000Z" } });
      changed.push(tf["auth.versions"].id);
      break;
    }
    case "publication-corrected": {
      if (!tf["study.age_min"]) return undefined;
      await world.assertFact({ about: target.product, predicate: "study.age_min", value: String(Number(target.slots["study.age_min"]) - 1), source: { kind: "document", at: "2026-08-15T00:00:00.000Z" } });
      changed.push(tf["study.age_min"].id);
      break;
    }
    case "authorization-superseded": {
      if (!tf["auth.timing"]) return undefined;
      const from = (JSON.parse(target.slots["auth.timing"] as string) as { from: string }).from;
      await world.assertFact({ about: target.product, predicate: "auth.timing", value: JSON.stringify({ from, to: addDays(from, 200) }), source: { kind: "regulator", at: "2026-08-10T00:00:00.000Z" } });
      changed.push(tf["auth.timing"].id);
      break;
    }
    case "record-withdrawn": {
      const slot: Slot | undefined = tf["study.age_min"] ? "study.age_min" : tf["auth.purpose"] ? "auth.purpose" : undefined;
      if (!slot) return undefined;
      const fact = tf[slot] as FactRecord;
      await world.retractFact({ factId: fact.id, source: { kind: "regulator", at: "2026-08-25T00:00:00.000Z" }, reason: "record withdrawn" });
      changed.push(fact.id);
      note = `retracted ${slot}`;
      break;
    }
    case "unrelated-fact": {
      await world.assertFact({ about: target.product, predicate: "vendor.press-release", value: "new marketing page", source: { kind: "vendor", at: "2026-08-20T00:00:00.000Z" } });
      break;
    }
    case "older-observation-loses": {
      const slot = (Object.keys(tf) as Slot[])[0];
      if (!slot) return undefined;
      await world.assertFact({ about: target.product, predicate: slot, value: String(tf[slot]!.value), source: { kind: "regulator", at: "2019-01-01T00:00:00.000Z" } });
      break;
    }
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }

  // Precondition: a change event that was meant to take effect did. A change that loses to the existing winner would make the oracle meaningless.
  for (const [slot] of Object.entries(tf) as [Slot, FactRecord][]) {
    const w = world.resolve(target.product, slot).winner;
    if (changed.includes((tf[slot] as FactRecord).id) && w && w.id === (tf[slot] as FactRecord).id) throw new Error(`harness error: the ${scenario} change to ${target.id} ${slot} did not take effect`);
  }

  // R: back in time.
  let reconstructed = 0;
  let total = 0;
  for (const d of devices) {
    const before = compileAll(specs.get(d.id) as ClaimSpec[], world, d, BEFORE);
    for (const [id, c] of before) {
      total++;
      if ((originals.get(id) as Finding).id === c.finding.id && same(originals.get(id) as Finding, c.finding)) reconstructed++;
    }
  }

  // Recompute now.
  const now = new Map<string, { finding: Finding; items: EvidenceItem[] }>();
  for (const d of devices) for (const [id, c] of compileAll(specs.get(d.id) as ClaimSpec[], world, d, AFTER)) now.set(id, c);
  const affected = [...now.keys()].filter((id) => !same(originals.get(id) as Finding, (now.get(id) as { finding: Finding }).finding)).sort();
  const stale = world.staleFindings();
  const dependent = staleFindings([...originals.values()], changed).map((f) => f.claimId).sort();
  const missed = affected.filter((id) => !stale.includes(id));
  const targetIds = new Set((specs.get(target.id) as ClaimSpec[]).map((s) => s.id));
  const staleOther = stale.filter((id) => !targetIds.has(id));
  const overFlagged = stale.filter((id) => !affected.includes(id));

  // C: recompute only the stale ones.
  for (const id of stale) {
    const c = now.get(id) as { finding: Finding };
    await world.declareDependencies({ findingId: id, refs: c.finding.dependsOnFacts });
  }
  const clean = world.staleFindings().length === 0;
  const recomputedOnly = new Map(originals);
  for (const id of stale) recomputedOnly.set(id, (now.get(id) as { finding: Finding }).finding);
  const matchesFull = [...now.keys()].every((id) => same(recomputedOnly.get(id) as Finding, (now.get(id) as { finding: Finding }).finding));

  return {
    id: `T-${target.id}-${scenario}`,
    device: target.id,
    scenario,
    findings: total,
    reconstructed,
    staleEqualsDependent: JSON.stringify(stale) === JSON.stringify(dependent),
    missed,
    staleOtherDevices: staleOther,
    overFlagged,
    affected,
    stale,
    dependent,
    cleanAfterRecompute: clean,
    recomputeMatchesFull: matchesFull,
    ...(note ? { note } : {}),
  };
}

async function main(): Promise<void> {
  const started = stamp("timeshift", SEED);
  const devices = await Promise.all(DEVICES.map(initialFor));
  const scenarios = ["registry-record-updated", "publication-corrected", "authorization-superseded", "record-withdrawn", "unrelated-fact", "older-observation-loses"];
  const results: ScenarioResult[] = [];
  const notApplicable: { device: string; scenario: string; reason: string }[] = [];
  for (const target of devices) {
    for (const sc of scenarios) {
      const r = await runScenario(devices, target, sc);
      if (r) results.push(r);
      else notApplicable.push({ device: target.id, scenario: sc, reason: "the device's extracted scope has no fact in the slot this change acts on" });
    }
  }

  const rate = (k: number, n: number) => ({ ...rateRow({ ...wilson(k, n), ...(k === 0 && n > 0 ? { zeroUpper: zeroErrorUpperBound(n) } : {}) } as never) });
  const findingsTotal = results.reduce((s, r) => s + r.findings, 0);
  const real = results.filter((r) => !["unrelated-fact", "older-observation-loses"].includes(r.scenario));
  const controls = results.filter((r) => ["unrelated-fact", "older-observation-loses"].includes(r.scenario));
  const staleTotal = real.reduce((s, r) => s + r.stale.length, 0);
  const affectedTotal = real.reduce((s, r) => s + r.affected.length, 0);
  const summaries: Record<string, unknown> = {
    cases: { cases: results.length, devices: devices.length, findingsPerCase: results[0]?.findings, changeCases: real.length, controlCases: controls.length, notApplicable: notApplicable.length },
    backInTimeFindingsReproduced: rate(results.reduce((s, r) => s + r.reconstructed, 0), findingsTotal),
    staleSetEqualsDependentSet: rate(results.filter((r) => r.staleEqualsDependent).length, results.length),
    noAffectedFindingMissed: rate(results.filter((r) => r.missed.length === 0).length, results.length),
    findingsOfOtherDevicesLeftAlone: rate(results.filter((r) => r.staleOtherDevices.length === 0).length, results.length),
    controlsChangeNothing: rate(controls.filter((r) => r.stale.length === 0 && r.affected.length === 0).length, controls.length),
    cleanAfterRecomputingOnlyTheStale: rate(results.filter((r) => r.cleanAfterRecompute && r.recomputeMatchesFull).length, results.length),
    overFlagging: { staleFindings: staleTotal, reallyAffected: affectedTotal, staleButUnchanged: real.reduce((s, r) => s + r.overFlagged.length, 0), note: "Dependence is recorded per evidence item, so a change in one slot marks every finding that read any item of the device; the cost side of the guarantee." },
    notApplicable,
  };
  writeResult("timeshift.json", {
    meta: {
      ...started,
      class: ["consistency"],
      description: "TimeShift: back-in-time reconstruction and change impact on the real World Model and compiler, over authentic scopes with constructed change events. Consistency, not a study of real registry churn.",
      clock: { recorded: T0_RECORDED, findingsComputed: FINDINGS_AT, changeRecorded: CHANGE_RECORDED, before: BEFORE, after: AFTER },
      resultsHash: hashOfJson(results).slice(0, 16),
    },
    summaries,
    cases: results,
  });
  const g = (k: string) => summaries[k] as { k: number; n: number };
  console.log(`TimeShift: ${results.length} cases (${controls.length} controls), reproduced ${g("backInTimeFindingsReproduced").k}/${g("backInTimeFindingsReproduced").n}, stale==dependent ${g("staleSetEqualsDependentSet").k}/${g("staleSetEqualsDependentSet").n}, none missed ${g("noAffectedFindingMissed").k}/${g("noAffectedFindingMissed").n}`);
}

await main();
