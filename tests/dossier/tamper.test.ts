/**
 * Tamper matrix (FR-12): flip one byte anywhere and the verifier fails and names the section that moved.
 * Three views of the same claim: every leaf of the real fixture, every section for add/remove/reorder, and a
 * property over generated dossiers (untampered always verifies, a tampered leaf never does).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DecisionLog, SECTION_NAMES, buildDossier, serializeDossier, verifyDossier } from "../../src/dossier/index.ts";
import type { DossierInput, RecomputeFn } from "../../src/dossier/index.ts";
import { ClaimSchema, EvidenceAnchorSchema, EvidenceItemSchema, FindingSchema, LABELS, SourceSchema } from "../../src/schemas/index.ts";
import type { Label } from "../../src/schemas/index.ts";
import { sha256Hex } from "../../src/util/canonical.ts";
import { baseBundle, buildOptions, fixedClock, snapshotFor, verifyOptions, viaJson } from "./helpers.ts";

type Path = (string | number)[];

function leafPaths(value: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
    for (const [k, v] of entries) leafPaths(v, [...path, k], out);
  } else {
    out.push(path);
  }
  return out;
}

function getAt(root: any, path: Path): any {
  return path.reduce((acc, k) => acc[k], root);
}

/** Changes one leaf by the smallest amount that still changes its bytes: one character, one unit, one flag. */
function mutateLeaf(root: any, path: Path): void {
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1] as string | number;
  const v = parent[key];
  if (typeof v === "string") parent[key] = v.length === 0 ? "x" : `${v.slice(0, -1)}${v.endsWith("x") ? "y" : "x"}`;
  else if (typeof v === "number") parent[key] = v + 1;
  else if (typeof v === "boolean") parent[key] = !v;
  else parent[key] = "tampered"; // null
}

/** Section a path lives in: body.<section>, or the bundle part itself. */
function expectedScope(path: Path): { prefixes: string[] } {
  const [top, sec] = path;
  if (top === "body") return { prefixes: [String(sec)] };
  if (top === "manifest") return { prefixes: ["manifest", "signature"] };
  if (top === "signature") return { prefixes: ["signature"] };
  return { prefixes: ["bundle"] };
}

const named = (item: string, prefix: string): boolean => item === prefix || item.startsWith(`${prefix}/`) || item.startsWith(`${prefix}[`);

describe("tamper matrix: every leaf of the dossier", () => {
  const bundle = baseBundle();
  const paths = leafPaths(viaJson(bundle));

  it("has enough leaves to be a real matrix", () => {
    expect(paths.length).toBeGreaterThan(900);
  });

  it("fails on every single-leaf change and names the section that changed", async () => {
    const misses: string[] = [];
    for (const path of paths) {
      const copy = viaJson(bundle);
      mutateLeaf(copy, path);
      const result = await verifyDossier(copy, verifyOptions);
      const { prefixes } = expectedScope(path);
      const named_ = result.failures.some((f) => prefixes.some((p) => named(f.item, p)));
      if (result.ok || !named_) misses.push(`${path.join(".")} -> ${result.ok ? "ACCEPTED" : result.failures.map((f) => f.item).slice(0, 3).join(", ")}`);
    }
    expect(misses).toEqual([]);
  });

  it("covers all 21 sections with at least one leaf each", () => {
    const covered = new Set(paths.filter((p) => p[0] === "body").map((p) => String(p[1])));
    expect([...covered].sort()).toEqual([...SECTION_NAMES].sort());
  });
});

describe("tamper matrix: structural edits at every position", () => {
  const bundle = baseBundle();
  const all = leafPaths(viaJson(bundle));
  // every container (object or array) in the file, as a path
  const containers = new Set<string>();
  const paths: Path[] = [];
  for (const p of all) for (let i = 1; i < p.length; i += 1) {
    const key = JSON.stringify(p.slice(0, i));
    if (!containers.has(key)) {
      containers.add(key);
      paths.push(p.slice(0, i));
    }
  }

  const operators: [string, (root: any, path: Path) => boolean, number?][] = [
    ["delete the key or element", (root, path) => {
      const parent = getAt(root, path.slice(0, -1));
      const key = path[path.length - 1] as string | number;
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key];
      return true;
    }],
    ["replace with null", (root, path) => {
      getAt(root, path.slice(0, -1))[path[path.length - 1] as string | number] = null;
      return true;
    }],
    ["replace with an empty object", (root, path) => {
      getAt(root, path.slice(0, -1))[path[path.length - 1] as string | number] = {};
      return true;
    }],
    ["swap with the next sibling (lists only)", (root, path) => {
      const parent = getAt(root, path.slice(0, -1));
      const i = path[path.length - 1];
      if (!Array.isArray(parent) || typeof i !== "number" || i + 1 >= parent.length) return false;
      if (JSON.stringify(parent[i]) === JSON.stringify(parent[i + 1])) return false;
      [parent[i], parent[i + 1]] = [parent[i + 1], parent[i]];
      return true;
    }],
    ["add an unknown field to the bundle itself", (root, path) => {
      if (path.length !== 1) return false;
      root.extra = 1;
      return true;
    }, 1],
    ["add an unknown field to an object", (root, path) => {
      const node = getAt(root, path);
      if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
      node.extra = 1;
      return true;
    }],
  ];

  it.each(operators)("%s: no position is accepted", async (_name, operate, minApplied = 20) => {
    const accepted: string[] = [];
    let applied = 0;
    for (const path of paths) {
      const copy = viaJson(bundle);
      if (!operate(copy, path)) continue;
      applied += 1;
      const result = await verifyDossier(copy, verifyOptions);
      if (result.ok) accepted.push(path.join("."));
    }
    expect(applied).toBeGreaterThanOrEqual(minApplied);
    expect(accepted).toEqual([]);
  });
});

describe("tamper matrix: named items", () => {
  const cases: [string, (b: any) => void, string][] = [
    ["a source hash", (b) => (b.body.snapshots[0].contentHash = "0".repeat(64)), "snapshots/rec-auth"],
    ["a number in a finding", (b) => (b.body.findings[0].mechanicalCoverage[6].established = "sensitivity 0.92"), "findings/f1"],
    ["a rule version", (b) => (b.body.findings[0].ruleVersion = "rules-2"), "findings/f1"],
    ["a reviewer decision", (b) => (b.body.decisionHistory[0].action = "accept"), "decisionHistory/dec-0001"],
    ["a label", (b) => (b.body.findings[1].label = "SUPPORTED_FOR_SCOPE"), "findings/f2"],
    ["a quote", (b) => (b.body.anchors[2].text = "Adults aged 18 to 66 were enrolled"), "anchors/a-study-pop"],
    ["a federation result hash", (b) => (b.body.federation[0].respHash = "1".repeat(64)), "federation/zq-1"],
    ["a model reply label", (b) => (b.body.models[1].label = "live"), "models/m2"],
    ["receipt coverage", (b) => (b.body.receiptCoverage.coverage = 1), "receiptCoverage"],
    ["an egress decision", (b) => (b.body.egress[0].decision = "blocked"), "egress/eg-1"],
    ["a lineage facet", (b) => (b.body.lineage.find((e: any) => e.job.name === "applicability.compile").job.facets.sakaime_ruleVersion.ruleVersion = "rules-9"), "lineage"],
    ["the signature", (b) => (b.signature.value = `${b.signature.value.slice(0, -4)}AAA=`), "signature"],
    ["the manifest root", (b) => (b.manifest.root = "2".repeat(64)), "manifest/root"],
    ["a manifest item hash", (b) => (b.manifest.sections.findings.items[0].sha256 = "3".repeat(64)), "findings/f1"],
  ];

  it.each(cases)("%s", async (_name, change, item) => {
    const copy = viaJson(baseBundle());
    change(copy);
    const result = await verifyDossier(copy, verifyOptions);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.item === item || f.item.startsWith(`${item}/`) || (!item.includes("/") && named(f.item, item)))).toBe(true);
  });

  it("points at the failing item and gives a reason a person can act on", async () => {
    const copy = viaJson(baseBundle());
    copy.body.decisionHistory[0].action = "accept";
    const result = await verifyDossier(copy, verifyOptions);
    const hash = result.failures.find((f) => f.check === "manifest.items");
    expect(hash).toEqual({ item: "decisionHistory/dec-0001", reason: "content changed since signing (hash mismatch)", check: "manifest.items", claimIds: ["c1"] });
  });
});

describe("tamper matrix: structure of each list section", () => {
  const listSections = ["sources", "claims", "findings", "compilerRuns", "counterexamples", "requirements", "evidenceItems", "anchors", "assertions", "links", "facts", "snapshots", "federation", "models", "egress", "evidenceHistory", "decisionHistory", "lineage"];

  it.each(listSections)("%s: removing, adding and duplicating an item are each named", async (section) => {
    const base = viaJson(baseBundle());
    const list: any[] = base.body[section];
    expect(list.length).toBeGreaterThan(0);

    const removed = viaJson(base);
    removed.body[section].pop();
    const r1 = await verifyDossier(removed, verifyOptions);
    expect(r1.ok).toBe(false);
    expect(r1.failures.some((f) => named(f.item, section) && /missing from the body/.test(f.reason))).toBe(true);

    const added = viaJson(base);
    const copy = viaJson(list[0]);
    // give the added item a fresh identity so it is a new item, not a duplicate
    const idKey = section === "federation" ? "queryId" : section === "compilerRuns" || section === "counterexamples" ? "findingId" : "id";
    if (section === "lineage") copy.run.runId = "00000000-0000-5000-8000-000000000000";
    else copy[idKey as string] = "added-item";
    added.body[section].push(copy);
    const r2 = await verifyDossier(added, verifyOptions);
    expect(r2.ok).toBe(false);
    expect(r2.failures.some((f) => named(f.item, section) && /not listed in the manifest/.test(f.reason))).toBe(true);

    const duplicated = viaJson(base);
    duplicated.body[section].push(viaJson(list[0]));
    const r3 = await verifyDossier(duplicated, verifyOptions);
    expect(r3.ok).toBe(false);
    expect(r3.failures.some((f) => named(f.item, section) && /appears more than once/.test(f.reason))).toBe(true);
  });

  it.each(["run", "rules", "receiptCoverage"])("%s (a single value): removing it is named", async (section) => {
    const copy = viaJson(baseBundle());
    delete copy.body[section];
    const result = await verifyDossier(copy, verifyOptions);
    expect(result.failures.some((f) => f.item === section && /missing from the body/.test(f.reason))).toBe(true);
  });

  it("a section the format does not define is rejected, not ignored", async () => {
    const copy = viaJson(baseBundle());
    copy.body.notes = [{ id: "n1", text: "smuggled" }];
    const result = await verifyDossier(copy, verifyOptions);
    expect(result.failures.map((f) => f.item)).toContain("body/notes");
  });

  it("an extra field inside an item changes its hash and is rejected", async () => {
    const copy = viaJson(baseBundle());
    copy.body.claims[0].approved = true;
    const result = await verifyDossier(copy, verifyOptions);
    expect(result.failures.map((f) => f.item)).toContain("claims/c1");
  });
});

describe("tamper at the byte level of the written file", () => {
  const text = serializeDossier(baseBundle());
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (!/\s/.test(text.charAt(i))) positions.push(i);

  it("rejects a changed character at random positions in the serialized text (or the text no longer parses)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: positions.length - 1 }), fc.integer({ min: 1, max: 9 }), async (pick, bump) => {
        const at = positions[pick] as number;
        const original = text.charAt(at);
        const replacement = String.fromCharCode(33 + ((original.charCodeAt(0) - 33 + bump) % 90));
        fc.pre(replacement !== original && replacement !== '"' && replacement !== "\\");
        const mutated = text.slice(0, at) + replacement + text.slice(at + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(mutated);
        } catch {
          return; // a corrupt file is rejected by the parser
        }
        const result = await verifyDossier(parsed, verifyOptions);
        expect(result.ok, `position ${at}: ${original} -> ${replacement}`).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("serialization is itself stable: parsing and writing again gives the same bytes", () => {
    expect(serializeDossier(JSON.parse(text))).toBe(text);
  });
});

// ---------------------------------------------------------------- generated dossiers

interface Spec {
  words: string[];
  values: number[];
  counts: number[];
  labels: Label[];
  actions: ("accept" | "narrow" | "request_evidence" | "escalate")[];
}

const specArb: fc.Arbitrary<Spec> = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.record({
    words: fc.array(fc.stringMatching(/^[a-z]{3,10}$/), { minLength: n, maxLength: n }),
    values: fc.array(fc.integer({ min: 1, max: 99 }), { minLength: n, maxLength: n }),
    counts: fc.array(fc.integer({ min: 10, max: 5000 }), { minLength: n, maxLength: n }),
    labels: fc.array(fc.constantFrom(...LABELS), { minLength: n, maxLength: n }),
    actions: fc.array(fc.constantFrom("accept", "narrow", "request_evidence", "escalate" as const), { minLength: 0, maxLength: 5 }),
  }),
);

function generated(spec: Spec): { input: DossierInput; recompute: RecomputeFn } {
  const labels = new Map<string, Label>();
  const claims: DossierInput["claims"] = [];
  const findings: DossierInput["findings"] = [];
  const snapshots: DossierInput["snapshots"] = [];
  const anchors: DossierInput["anchors"] = [];
  const evidenceItems: DossierInput["evidenceItems"] = [];
  const compilerRuns: DossierInput["compilerRuns"] = [];
  spec.words.forEach((word, i) => {
    const value = spec.values[i] as number;
    const n = spec.counts[i] as number;
    const fraction = (value / 100).toFixed(2);
    const text = `Report on ${word}. Result ${fraction} measured among ${n} people.`;
    const quote = `Result ${fraction} measured among ${n} people`;
    snapshots.push(snapshotFor(`rec-${i}`, "s1", text));
    anchors.push(EvidenceAnchorSchema.parse({ id: `a-${i}`, recordId: `rec-${i}`, text: quote, textHash: sha256Hex(quote) }));
    evidenceItems.push(EvidenceItemSchema.parse({ id: `e-${i}`, assertionType: "study", scope: { versions: [`v${i}`] }, results: [{ metric: "m", value: Number(fraction), n, anchorId: `a-${i}` }], anchorIds: [`a-${i}`] }));
    claims.push(ClaimSchema.parse({ id: `c-${i}`, use: { product: "p", versions: [`v${i}`] }, performance: { metric: "m", atLeast: Number(fraction) } }));
    labels.set(`c-${i}`, spec.labels[i] as Label);
    findings.push(
      FindingSchema.parse({
        id: `f-${i}`,
        claimId: `c-${i}`,
        label: spec.labels[i],
        mechanicalCoverage: [{ dimension: "metric", relation: "CONTAINED", claimed: `m at least ${fraction}`, established: `m ${fraction} among ${n}`, anchorIds: [`a-${i}`], evidenceIds: [`e-${i}`] }],
        ruleVersion: "r1",
        computedAt: "2026-10-27T10:00:00.000Z",
      }),
    );
    compilerRuns.push({ findingId: `f-${i}`, evidenceItemIds: [`e-${i}`] });
  });
  const log = DecisionLog.create({ clock: fixedClock, findings });
  spec.actions.forEach((action, k) => {
    const idx = k % findings.length;
    log.append({
      idempotencyKey: `key-${k}`,
      claimId: `c-${idx}`,
      findingId: `f-${idx}`,
      action,
      reviewer: "reviewer",
      ...(action === "narrow" ? { narrowedScope: { product: "p" } } : {}),
    });
  });
  const input: DossierInput = {
    run: { mode: "sample" },
    rules: { registryVersion: "reg-1" },
    sources: [SourceSchema.parse({ id: "s1", kind: "literature", access: "file", descriptor: "generated", license: "x", health: "OK", dataClass: "public" })],
    claims,
    findings,
    compilerRuns,
    evidenceItems,
    anchors,
    snapshots,
    decisions: log,
  };
  return { input, recompute: (claim) => ({ label: labels.get(claim.id) as Label }) };
}

describe("properties over generated dossiers", () => {
  it("an untampered dossier always verifies, in memory and after a round trip through text", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, async (spec) => {
        const { input, recompute } = generated(spec);
        const bundle = buildDossier(input, buildOptions());
        const direct = await verifyDossier(bundle, { recompute });
        expect(direct.failures).toEqual([]);
        const reread = await verifyDossier(JSON.parse(serializeDossier(bundle)), { recompute });
        expect(reread.failures).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it("a dossier with any one leaf changed never verifies, and the failure names the section", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.nat(), async (spec, pick) => {
        const { input, recompute } = generated(spec);
        const bundle = viaJson(buildDossier(input, buildOptions()));
        const paths = leafPaths(bundle);
        const path = paths[pick % paths.length] as Path;
        mutateLeaf(bundle, path);
        const result = await verifyDossier(bundle, { recompute });
        expect(result.ok, path.join(".")).toBe(false);
        const { prefixes } = expectedScope(path);
        expect(result.failures.some((f) => prefixes.some((p) => named(f.item, p))), path.join(".")).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("same inputs, clock and key give the same bytes", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const a = serializeDossier(buildDossier(generated(spec).input, buildOptions()));
        const b = serializeDossier(buildDossier(generated(spec).input, buildOptions()));
        expect(a).toBe(b);
      }),
      { numRuns: 30 },
    );
  });
});
