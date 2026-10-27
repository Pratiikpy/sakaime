import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalDoi,
  canonicalNct,
  canonicalPmid,
  canonicalSubmissionId,
  canonicalUdiDi,
  classifyMentionContext,
  extractNctIds,
  extractSubmissionIds,
} from "../../src/identity/identifiers.ts";
import { rec } from "./helpers.ts";

describe("identifier canonicalisation", () => {
  it("canonicalises K, DEN and P numbers and drops an original-submission supplement", () => {
    expect(canonicalSubmissionId(" k221347 ")).toBe("K221347");
    expect(canonicalSubmissionId("den170073")).toBe("DEN170073");
    expect(canonicalSubmissionId("P220012/S059")).toBe("P220012/S059");
    expect(canonicalSubmissionId("P220012 / S000")).toBe("P220012");
    expect(canonicalSubmissionId("P130020/S5")).toBe("P130020/S005");
  });

  it("rejects strings that only resemble submission numbers", () => {
    for (const bad of ["K22134", "K2213471", "KX21347", "DEN17007", "NCT03112005", "", "K221347 and K211733", "xK221347"]) {
      expect(canonicalSubmissionId(bad)).toBeUndefined();
    }
  });

  it("canonicalises registry and bibliographic identifiers", () => {
    expect(canonicalNct("nct03112005")).toBe("NCT03112005");
    expect(canonicalNct("NCT0311200")).toBeUndefined();
    expect(canonicalPmid("034779843")).toBe("34779843");
    expect(canonicalPmid("PMID 1")).toBeUndefined();
    expect(canonicalDoi("https://doi.org/10.1001/JAMACARDIO.2021.0185.")).toBe("10.1001/jamacardio.2021.0185");
    expect(canonicalDoi("not a doi")).toBeUndefined();
    expect(canonicalUdiDi("(01) 0081 1852 0301 89")).toBe("00811852030189");
    expect(canonicalUdiDi("123")).toBeUndefined();
  });

  it("extracts identifiers from prose without inventing any", () => {
    expect(extractSubmissionIds("Cleared under K221347 and DEN170073; also P220012/S059, not K12345.")).toEqual(["K221347", "DEN170073", "P220012/S059"]);
    expect(extractNctIds("see NCT03112005, nct04079478 and NCT0123")).toEqual(["NCT03112005", "NCT04079478"]);
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        extractSubmissionIds(s);
        extractNctIds(s);
        canonicalSubmissionId(s);
        canonicalDoi(s);
        return true;
      }),
    );
  });
});

describe("reading the role of a cited identifier (real passages from the FDA summaries)", () => {
  const contextOf = (recordId: string, nct: string) => rec(recordId).mentions.find((m) => m.value === nct)!.context;

  it("establishes the EyeArt pivotal trial as a study of the device", () => {
    expect(classifyMentionContext(contextOf("510k:K200667", "NCT03112005"), "evaluation").verdict).toBe("ESTABLISHED");
  });

  it("establishes the GI Genius AID study as a study of the device", () => {
    expect(classifyMentionContext(contextOf("510k:DEN200055", "NCT04079478"), "evaluation").verdict).toBe("ESTABLISHED");
  });

  it("recognises the methylene blue trial as the origin of training videos, not a test of the device", () => {
    const reading = classifyMentionContext(contextOf("510k:DEN200055", "NCT01694966"), "evaluation");
    expect(reading.verdict).toBe("CONTRADICTED");
    expect(reading.cues.join(" ")).toMatch(/training|originally from/);
  });

  it("establishes a paper's own preregistration but not a citation of earlier work", () => {
    expect(classifyMentionContext(contextOf("pubmed:34779843", "NCT03112005"), "report").verdict).toBe("ESTABLISHED");
    expect(classifyMentionContext("as described in NCT01234567, training data were drawn from an earlier cohort", "report").verdict).toBe("CONTRADICTED");
  });

  it("leaves the role unknown when the passage says nothing, or says both", () => {
    expect(classifyMentionContext("NCT03112005", "evaluation").verdict).toBe("UNKNOWN");
    expect(classifyMentionContext(undefined, "evaluation").verdict).toBe("UNKNOWN");
    expect(classifyMentionContext("prospective validation; the training set came from NCT01234567", "evaluation").verdict).toBe("UNKNOWN");
  });
});
