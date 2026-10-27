import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVALS, exists, readJson, readText } from "../../evals/lib/core.ts";

/*
 * Every number in evals/RESULTS.md is a link to a row of a results file. This checks that each link points at a file that exists and a key
 * that exists in its `summaries`, so a number cannot be typed in by hand or left behind after a re-run changes the shape of a file.
 */
const reportPath = join(EVALS, "RESULTS.md");

function resolve(summaries: Record<string, unknown>, key: string): unknown {
  if (key in summaries) return summaries[key];
  let cur: unknown = summaries;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

describe.skipIf(!exists(reportPath))("RESULTS.md links", () => {
  const md = exists(reportPath) ? readText(reportPath) : "";
  const links = [...md.matchAll(/\]\(results\/([A-Za-z0-9_.-]+\.json)#([^)]+)\)/g)].map((m) => ({ file: m[1] as string, key: decodeURI(m[2] as string) }));

  it("has numbered links at all", () => {
    expect(links.length).toBeGreaterThan(30);
  });

  it("every link resolves to a key of a results file", () => {
    const unresolved: string[] = [];
    for (const l of links) {
      const path = join(EVALS, "results", l.file);
      if (!exists(path)) {
        unresolved.push(`${l.file} (missing file)`);
        continue;
      }
      const file = readJson<{ summaries: Record<string, unknown> }>(path);
      if (resolve(file.summaries, l.key) === undefined) unresolved.push(`${l.file}#${l.key}`);
    }
    expect(unresolved).toEqual([]);
  });

  it("states the classes and the limits it relies on", () => {
    expect(md).toContain("builder-labelled");
    expect(md).toContain("consistency");
    expect(md).toMatch(/No sentence here claims clinical or independent validation/);
    expect(md).toMatch(/What was not run/);
  });

  it("uses none of the words the product's wording lint bans (src/agents/policy.ts)", () => {
    // Mirrors the BANNED list there; kept in step by hand because that list is not exported.
    const banned: [RegExp, string][] = [
      [/best/i, "best"],
      [/proof|proven|proves?/i, "proof"],
      [/guarantee[sd]?/i, "guaranteed"],
      [/accurate(?:ly)?/i, "accurate"],
      [/production[- ]ready/i, "production-ready"],
      [/state[- ]of[- ]the[- ]art/i, "state-of-the-art"],
      [/validated/i, "validated"],
      [/(?:is|are|was|were|deemed|considered|found|declared)\s+(?:safe|cleared|compliant|approved|certified)/i, "a verdict of safety"],
    ];
    for (const file of ["RESULTS.md", "ERRATA.md", "SEALED.md"]) {
      const text = readText(join(EVALS, file));
      for (const [re, name] of banned) expect(text.match(re)?.[0] ?? null, `${file}: ${name}`).toBeNull();
    }
  });
});

describe("results files", () => {
  const meta = (name: string) => (exists(join(EVALS, "results", name)) ? readJson<{ meta: Record<string, unknown> }>(join(EVALS, "results", name)).meta : undefined);

  it("every results file is tagged with a class and a seed", () => {
    for (const name of ["scopeshift-a.json", "identityshift.json", "timeshift.json", "failureshift.json"]) {
      const m = meta(name);
      if (!m) continue;
      expect(Array.isArray(m["class"]) && (m["class"] as string[]).length > 0, name).toBe(true);
      expect(typeof m["seed"], name).toBe("number");
    }
  });

  it("held-out results carry the key hash they were scored against, and it is the sealed one", () => {
    const m = meta("scopeshift-b-held-out.json");
    if (!m) return;
    const seal = readJson<{ files: Record<string, string> }>(join(EVALS, "heldout", "seal.json"));
    expect(m["heldoutKeySha256"]).toBe(seal.files["key.json"]);
  });
});
