import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { buildIdentifierQueries, buildSearchQueries, cleanTerm } from "../../src/identity/query.ts";

describe("search queries refuse the bare names that failed in the feasibility probe", () => {
  it("refuses a bare ContaCT (446,198 PubMed records) with a reason and a working example", () => {
    const plan = buildSearchQueries({ product: "ContaCT" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toBe("MISSING_VENDOR");
      expect(plan.example).toMatch(/vendor/);
    }
  });

  it("refuses a single-word product even with a vendor, until a condition is given", () => {
    for (const product of ["ContaCT", "BriefCase", "Caption", "FFRct", "EyeArt"]) {
      const plan = buildSearchQueries({ vendor: "Somebody", product });
      expect(plan.ok, product).toBe(false);
      if (!plan.ok) expect(plan.reason).toBe("BARE_AMBIGUOUS_NAME");
    }
    const plan = buildSearchQueries({ vendor: "Viz.ai", product: "ContaCT", condition: "large vessel occlusion" });
    expect(plan.ok).toBe(true);
  });

  it("quotes vendor, product and condition for each source, in the syntax the probe used", () => {
    const plan = buildSearchQueries({ vendor: "Aidoc Medical, Ltd.", product: "BriefCase", condition: "intracranial hemorrhage" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const byTarget = Object.fromEntries(plan.queries.map((q) => [q.target, q]));
    expect(byTarget.pubmed!.text).toBe('"Aidoc Medical"[tiab] AND "BriefCase"[tiab] AND "intracranial hemorrhage"[tiab]');
    expect(byTarget.clinicaltrials!).toMatchObject({ parameter: "query.term", text: '"Aidoc Medical" AND "BriefCase" AND "intracranial hemorrhage"' });
    expect(byTarget.europepmc!.text).toBe('"Aidoc Medical" AND "BriefCase" AND "intracranial hemorrhage"');
  });

  it("searches the vendor's earlier names together, from the documented owner drift", () => {
    const plan = buildSearchQueries({ vendor: "Bay Labs, Inc.", product: "Caption Guidance" }, ["pubmed"]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.queries[0]!.text).toContain('"Bay Labs"[tiab]');
    expect(plan.queries[0]!.text).toContain('"Caption Health"[tiab]');
    expect(plan.queries[0]!.text).toMatch(/^\(.* OR .*\) AND "Caption Guidance"\[tiab\]$/);
  });

  it("drops a trailing version from the product name, since studies cite other versions", () => {
    const plan = buildSearchQueries({ vendor: "ScreenPoint Medical", product: "Transpara 1.7.2", condition: "breast cancer" }, ["europepmc"]);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.queries[0]!.text).toBe('"ScreenPoint Medical" AND "Transpara" AND "breast cancer"');
    // Without the version the name is one word, so a condition is required.
    expect(buildSearchQueries({ vendor: "ScreenPoint Medical", product: "Transpara 1.7.2" }).ok).toBe(false);
  });

  it("warns when it has no condition to narrow with", () => {
    const plan = buildSearchQueries({ vendor: "Lunit", product: "INSIGHT CXR" });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.warnings.join(" ")).toMatch(/no condition/);
  });

  it("refuses empty and unusable input", () => {
    for (const subject of [{ product: "" }, { product: "   ", vendor: "x" }, { product: '"""', vendor: "Acme" }, { product: "()", vendor: "Acme" }]) {
      const plan = buildSearchQueries(subject);
      expect(plan.ok).toBe(false);
    }
    expect(buildSearchQueries({ product: "Thing Two", vendor: "Acme" }).ok).toBe(true);
  });

  it("neutralises quote and syntax characters so a term cannot break out of its quotes", () => {
    expect(cleanTerm('Viz" OR "x')).toBe("Viz OR x");
    expect(cleanTerm("a[tiab] AND (b)")).toBe("a tiab AND b");
    expect(cleanTerm("tab\tnew\nline")).toBe("tab new line");
    expect(cleanTerm("x".repeat(500)).length).toBeLessThanOrEqual(100);
  });

  it("every term in every generated query is inside quotes", () => {
    const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .'-]{2,18}$/);
    fc.assert(
      fc.property(word, word, word, (vendor, product, condition) => {
        const plan = buildSearchQueries({ vendor, product, condition });
        if (!plan.ok) return true;
        return plan.queries.every((q) => {
          const stripped = q.text.replace(/"[^"]*"(\[tiab\])?/g, "").replace(/\bAND\b|\bOR\b|[()\s]/g, "");
          return stripped === "";
        });
      }),
    );
  });

  it("never throws, whatever the input", () => {
    fc.assert(fc.property(fc.string(), fc.string(), fc.string(), (v, p, c) => {
      buildSearchQueries({ vendor: v, product: p, condition: c });
      return true;
    }));
    expect(() => buildSearchQueries({ product: 5 as never, vendor: {} as never })).not.toThrow();
  });
});

describe("identifier queries", () => {
  it("builds the registry and bibliographic lookups the probe used", () => {
    const q = buildIdentifierQueries({ nct: "nct03112005", submission: "den170073" });
    expect(q).toContainEqual({ target: "pubmed", text: "NCT03112005[si]" });
    expect(q).toContainEqual({ target: "europepmc", text: '"DEN170073"' });
    expect(q).toContainEqual({ target: "clinicaltrials", text: "DEN170073", parameter: "query.term" });
  });

  it("refuses anything that is not an identifier", () => {
    expect(() => buildIdentifierQueries({ nct: 'NCT03112005" OR "x' })).toThrow(PortError);
    expect(() => buildIdentifierQueries({ submission: "K12" })).toThrow(PortError);
    expect(buildIdentifierQueries({})).toEqual([]);
  });
});
