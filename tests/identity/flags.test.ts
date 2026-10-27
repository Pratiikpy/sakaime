/** The mismatch flags the design requires, each on the real pair the feasibility report names for it. */
import { describe, expect, it } from "vitest";
import { corpus, rec, resolve2 } from "./helpers.ts";

const known = () => [...corpus().records.values()].map((r) => r.record);
const flagsOf = (a: string, b: string, t: Parameters<typeof resolve2>[2]) => resolve2(a, b, t, known()).flags.join(" | ");

describe("mismatch flags are shown and do not change the link", () => {
  it("version differs: the MASAI paper ran Transpara 1.7.0, the product was cleared as 1.7.2", () => {
    const r = resolve2("pubmed:37541274", "510k:K221347", "STUDY_EVALUATES");
    expect(r.flags.join(" ")).toContain("version-differs: 1.7.0 versus 1.7.2");
    expect(r.link?.flags.join(" ")).toContain("version-differs");
  });

  it("intended use differs: Lunit INSIGHT CXR in tuberculosis screening against pleural effusion and pneumothorax triage", () => {
    expect(flagsOf("ctgov:NCT06401434", "510k:K211733", "STUDY_EVALUATES")).toMatch(/intended-use-differs: .*tb-screening-cxr.*cxr-triage/);
    expect(resolve2("ctgov:NCT06401434", "510k:K211733", "STUDY_EVALUATES").link?.state).toBe("AMBIGUOUS");
  });

  it("module differs: BriefCase ICH against abdominal CT", () => {
    expect(flagsOf("pubmed:41444826", "510k:K253265", "STUDY_EVALUATES")).toMatch(/module-differs: ich versus abdominal ct free gas/);
  });

  it("build differs: Paige Prostate Alpha against the locked v2.1.501", () => {
    const f = flagsOf("pubmed:32393768", "510k:DEN200080", "STUDY_EVALUATES");
    expect(f).toContain("build-differs: Alpha versus 2.1.501");
    expect(f).toContain("version-differs");
  });

  it("multiple releases under one submission: Viz LVO's GUDID versions under DEN170073", () => {
    expect(flagsOf("510k:DEN170073", "gudid:DEN170073:1.5", "SAME_SUBMISSION")).toMatch(/multiple-releases-under-submission: DEN170073 carries \d+ distinct version labels/);
    // The GUDID labels "Guidance" and "AI" are not release numbers, so they are not counted as releases.
    expect(flagsOf("510k:DEN190040", "gudid:DEN190040:Guidance", "SAME_SUBMISSION")).not.toContain("multiple-releases-under-submission");
  });

  it("owner and name drift: IDx to Digital Diagnostics, Bay Labs to Caption Health, Cosmo to Medtronic", () => {
    expect(flagsOf("510k:DEN180001", "list:K203629", "SAME_PRODUCT")).toContain("owner-alias-drift: Idx, LLC and Digital Diagnostics Inc.");
    expect(flagsOf("510k:DEN190040", "list:K201992", "SAME_PRODUCT")).toContain("owner-alias-drift: Bay Labs, Inc. and Caption Health");
    expect(flagsOf("ctgov:NCT04723758", "510k:DEN200055", "STUDY_EVALUATES")).toMatch(/owner-alias-drift: Medtronic and Cosmo/);
    expect(flagsOf("ctgov:NCT02963441", "510k:DEN180001", "STUDY_EVALUATES")).toContain("product-name-drift: IDx-DR and LumineticsCore");
    expect(flagsOf("ctgov:NCT03897140", "510k:DEN190040", "STUDY_EVALUATES")).toContain("product-name-drift: Caption Guidance and EchoGPS");
  });

  it("does not report drift between a common word in prose and the product named after it", () => {
    expect(flagsOf("pubmed:35183401", "list:K223042", "STUDY_EVALUATES")).not.toContain("product-name-drift");
  });

  it("same name, different company is flagged for BodyGuardian and not for unrelated products", () => {
    expect(flagsOf("list:K243349", "list:K192732", "SAME_PRODUCT")).toContain("same-name-different-company");
    expect(flagsOf("510k:K253265", "510k:K221347", "SAME_PRODUCT")).not.toContain("same-name-different-company");
  });

  it("a name shared by many list rows is flagged, with the row count", () => {
    expect(flagsOf("list:K251406", "list:K251195", "SAME_PRODUCT")).toMatch(/family-name: at least 3 reference rows share this name \(briefcase triage \(\d+ reference rows\)\)/);
  });

  it("names the values on both sides, so the compiler and the reviewer can use them", () => {
    for (const f of resolve2("510k:K221347", "list:K241831", "SAME_MARKETED_VERSION").flags) expect(f.length).toBeGreaterThan(10);
    expect(rec("510k:K221347").name).toBe("Transpara 1.7.2");
  });
});
