import { describe, expect, it } from "vitest";
import { NOT_SENT_NOTICE, draftEvidenceRequest, draftEvidenceRequests, missingEvidenceList, supersedeFinding } from "../../src/dossier/index.ts";
import { FindingSchema } from "../../src/schemas/index.ts";
import { baseInput } from "./helpers.ts";

const { findings, claims } = baseInput();
const [f1, f2] = findings as [(typeof findings)[number], (typeof findings)[number]];
const [c1, c2] = claims as [(typeof claims)[number], (typeof claims)[number]];

// Words the wording rules ban in text we produce (CLAUDE.md, brief rule 10).
const BANNED = /\b(best|proof|guaranteed|accurate|production-ready|state-of-the-art|validated)\b/i;

describe("missing-evidence draft request (F6)", () => {
  it("builds a copyable letter that restates the intended use and numbers each request", () => {
    const d = draftEvidenceRequest(f2, c2, { addressee: "Regulatory Affairs, Example Vendor", sender: "Clinical engineering, Example Hospital", productName: "TRIAGE-1" });
    expect(d).toBeDefined();
    expect(d?.subject).toBe("Request for evidence: TRIAGE-1 4.0");
    expect(d?.body).toMatchInlineSnapshot(`
      "Dear Regulatory Affairs, Example Vendor,

      We are assessing the product below for a specific use. The documents we hold do not yet settle the points listed, and we would like to see the evidence for each.

      Our intended use:
        Product: device:constructed:TRIAGE-1
        Software version: 4.0
        Population: ages 18 to 70
        Care setting: emergency_department
        Intended purpose: triage_notification
        Planned start: 2026-03-01
        Performance relied on: sensitivity at least 0.9

      What we are asking for:

      1. Version: A study report or regulator document that covers software version 4.0 of the product.
      2. Metric: Sensitivity results for the intended use on that version.

      For each item, please send the document, or confirm in writing, and name the document, version and page where it can be read.

      Thank you.
      Clinical engineering, Example Hospital"
    `);
  });

  it("is never sent: it is text with a notice, and the module has no way to send it", () => {
    const d = draftEvidenceRequest(f1, c1);
    expect(d?.neverSent).toBe(true);
    expect(d?.notice).toBe(NOT_SENT_NOTICE);
    expect(NOT_SENT_NOTICE).toBe("Draft for the reviewer to edit and send. Nothing in this system sends it.");
    expect(d?.body).not.toContain(NOT_SENT_NOTICE);
  });

  it("asks about a dimension the evidence only partly covers before one it says nothing about", () => {
    const mixed = FindingSchema.parse({
      ...f2,
      id: "f-mixed",
      mechanicalCoverage: [
        { dimension: "version", relation: "UNKNOWN", anchorIds: [], evidenceIds: [] },
        { dimension: "population", relation: "PARTIAL", anchorIds: [], evidenceIds: [] },
        { dimension: "setting", relation: "DISJOINT", anchorIds: [], evidenceIds: [] },
      ],
      requiredEvidence: [
        { dimension: "version", request: "v" },
        { dimension: "population", request: "p" },
        { dimension: "setting", request: "s" },
      ],
    });
    expect(draftEvidenceRequest(mixed, c2)?.items.map((i) => i.dimension)).toEqual(["setting", "population", "version"]);
  });

  it("returns nothing for a finding that names nothing to ask for, and refuses a finding of another claim", () => {
    expect(draftEvidenceRequest(FindingSchema.parse({ ...f1, id: "f-none", requiredEvidence: [] }), c1)).toBeUndefined();
    expect(() => draftEvidenceRequest(f1, c2)).toThrow(/is for claim c1, not c2/);
  });

  it("handles an open-ended age range, no performance claim and no version without printing 'undefined'", () => {
    const claim = { ...c1, performance: undefined, use: { product: "device:x", population: { age: { min: 65 } } } };
    const d = draftEvidenceRequest(f1, claim);
    expect(d?.body).toContain("Population: ages 65 and over");
    expect(d?.body).not.toMatch(/undefined|NaN|\[object/);
    expect(d?.subject).toBe("Request for evidence: device:x");
  });

  it("uses no banned wording", () => {
    for (const [f, c] of [[f1, c1], [f2, c2]] as const) {
      const d = draftEvidenceRequest(f, c);
      expect(`${d?.subject}\n${d?.body}\n${d?.notice}`).not.toMatch(BANNED);
    }
  });
});

describe("missing-evidence list", () => {
  it("puts findings that cannot be supported yet first, and numbers the priority from 1", () => {
    const list = missingEvidenceList(findings);
    expect(list.map((i) => [i.priority, i.findingId, i.dimension, i.relation])).toEqual([
      [1, "f2", "version", "UNKNOWN"],
      [2, "f2", "metric", "UNKNOWN"],
      [3, "f1", "population", "PARTIAL"],
    ]);
  });

  it("lists only current findings: a superseded finding's requests are not asked again", () => {
    const replacement = FindingSchema.parse({ ...f1, id: "f1b", requiredEvidence: [] });
    const next = supersedeFinding(findings, "f1", replacement, "vendor sent the study");
    expect(missingEvidenceList(next).map((i) => i.findingId)).toEqual(["f2", "f2"]);
    expect(draftEvidenceRequests(next, claims).map((d) => d.findingId)).toEqual(["f2"]);
  });

  it("is deterministic and stable under input order", () => {
    const a = missingEvidenceList([f1, f2]);
    const b = missingEvidenceList([f2, f1]);
    expect(b).toEqual(a);
  });

  it("drafts one letter per current finding with requests, in list order", () => {
    expect(draftEvidenceRequests(findings, claims).map((d) => d.findingId)).toEqual(["f2", "f1"]);
    expect(draftEvidenceRequests(findings, [])).toEqual([]);
  });
});
