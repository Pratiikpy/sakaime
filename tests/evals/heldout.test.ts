import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaimSchema } from "../../src/schemas/index.ts";
import { EVALS, quoteInText, readJson, readText, sha256 } from "../../evals/lib/core.ts";
import { loadHeldoutCases } from "../../evals/lib/cases.ts";
import { CLAIMS, NOTICE, QUOTES, SOURCES } from "../../evals/heldout/data.ts";
import { oracleLabel } from "../../evals/heldout/oracle.ts";

const docs = new Map(SOURCES.map((s) => [s.id, readText(join(EVALS, "..", s.file))]));

describe("held-out key: internal checks that do not need a system", () => {
  it("has 20 claims over 5 devices that no development claim uses", () => {
    expect(CLAIMS).toHaveLength(20);
    expect(new Set(CLAIMS.map((c) => c.source)).size).toBe(5);
    const dev = readText(join(EVALS, "gate0", "claims.jsonl"));
    for (const s of SOURCES) expect(dev).not.toContain(s.id);
  });

  it("every quote exists, verbatim after whitespace collapse, in its source document", () => {
    for (const [id, q] of Object.entries(QUOTES)) expect(quoteInText(q.quote, docs.get(q.doc) as string), id).toBe(true);
  });

  it("the source text files match the hashes in key.json", () => {
    const key = readJson<{ sources: { id: string; textSha256: string }[] }>(join(EVALS, "heldout", "key.json"));
    for (const s of key.sources) expect(sha256(docs.get(s.id) as string), s.id).toBe(s.textSha256);
  });

  it("pass 2 (the oracle) agrees with pass 1 on every claim, and the recorded disagreement list is empty", () => {
    for (const c of CLAIMS) expect(oracleLabel(c.pass2), c.id).toBe(c.key.expectedLabel);
    expect(readJson<{ pass2Disagreements: unknown[] }>(join(EVALS, "heldout", "key.json")).pass2Disagreements).toEqual([]);
  });

  it("no acceptable label is a SUPPORTED label; a withheld label names a mismatch; positive controls name none", () => {
    for (const c of CLAIMS) {
      expect(c.key.acceptableLabels.some((l) => l.startsWith("SUPPORTED")), c.id).toBe(false);
      if (c.key.expectedLabel === "SUPPORTED_FOR_SCOPE") {
        expect(c.key.mismatches, c.id).toHaveLength(0);
        expect(c.kind).toBe("positive control");
      } else {
        expect(c.key.mismatches.length, c.id).toBeGreaterThan(0);
        expect(c.kind).toBe("mismatch");
      }
    }
  });

  it("every decimal or percentage in a claim text is in a quote (the claimed threshold is the one allowed exception)", () => {
    for (const c of CLAIMS) {
      const quotes = c.quotes.map((q) => (QUOTES[q]?.quote ?? "").replace(/\s+/g, " ")).join(" ");
      const exempt = c.performance ? `${Math.round(c.performance.atLeast * 100)}%` : "";
      for (const n of c.text.match(/\d+\.\d+%?|\d+%/g) ?? []) if (n !== exempt) expect(quotes, `${c.id} ${n}`).toContain(n.replace("%", ""));
    }
  });

  it("claim inputs carry no label, no key and no hint of the expected answer", () => {
    const { cases } = loadHeldoutCases();
    const claimsLines = readText(join(EVALS, "heldout", "claims.jsonl")).trim().split("\n");
    expect(claimsLines).toHaveLength(20);
    for (const line of claimsLines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(row)).not.toContain("key");
      expect(row["notice"]).toBe(NOTICE);
    }
    for (const c of cases) {
      ClaimSchema.parse(c.claim);
      expect(JSON.stringify(c.claim)).not.toMatch(/SUPPORTED_|CONTRADICTED|INSUFFICIENT/);
      expect(c.partition).toBe("held-out");
    }
  });

  it("the label mix is the one SEALED.md states", () => {
    const n = (l: string) => CLAIMS.filter((c) => c.key.expectedLabel === l).length;
    expect([n("SUPPORTED_FOR_SCOPE"), n("SUPPORTED_ONLY_FOR_NARROWER_SCOPE"), n("CONTRADICTED_BY_SPECIFIED_EVIDENCE"), n("INSUFFICIENT_EVIDENCE"), n("REQUIRES_DOMAIN_REVIEW")]).toEqual([5, 2, 8, 4, 1]);
    expect(CLAIMS.filter((c) => c.key.keyConfidence === "contestable")).toHaveLength(11);
  });
});
