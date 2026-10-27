import { describe, expect, it } from "vitest";
import { compile, compileDetailed, formatPurposeExclusion, parsePurposeExclusion } from "../../src/compiler/index.ts";
import { AUTH_FROM, auth, claim, study } from "./fixtures.ts";

const NO_PERF = null;
const BOTH = { dependencies: { required: ["authorization", "study"], corroborating: [] } };

describe("explicit purpose limits (R24)", () => {
  const absolute = formatPurposeExclusion({ node: "diagnosis", strength: "absolute", sentence: "The device does not alter the original medical image and is not intended to be used as a diagnostic device." });
  const qualified = formatPurposeExclusion({ node: "diagnosis", strength: "qualified", sentence: "It is not intended to be a stand-alone diagnostic device for cardiac conditions." });
  const evidence = (limitation?: string) => [auth({ purpose: "detection_aid" }, limitation ? { limitations: [limitation] } : {}), study({ purpose: "detection_aid" }, [])];

  it("round-trips the form the reader writes and ignores free text", () => {
    expect(parsePurposeExclusion(absolute)).toEqual({ node: "diagnosis", strength: "absolute", sentence: "The device does not alter the original medical image and is not intended to be used as a diagnostic device." });
    expect(parsePurposeExclusion("not intended to be used as a diagnostic device")).toBeUndefined();
    expect(parsePurposeExclusion("excludes purpose [diagnosis] (sometimes): x")).toBeUndefined();
  });

  it("a claim of the excluded purpose is contradicted, with the sentence in the account", () => {
    const d = compileDetailed(claim({ purpose: "diagnosis" }, NO_PERF, BOTH), evidence(absolute));
    expect(d.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(d.trace.some((t) => t.ruleId === "R24-PURPOSE-EXPLICIT-LIMIT" && /not intended to be used as a diagnostic device/.test(t.effect))).toBe(true);
  });

  it("without the structured exclusion the same escalation is the narrower scope (R25), as before", () => {
    const f = compile(claim({ purpose: "diagnosis" }, NO_PERF, BOTH), evidence());
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(f.supportedScope).toMatchObject({ purpose: "detection_aid" });
  });

  it("a qualified exclusion (stand-alone, primary, beyond notification) goes to a reviewer, never to CONTRADICTED", () => {
    const f = compile(claim({ purpose: "diagnosis" }, NO_PERF, BOTH), evidence(qualified));
    expect(f.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(f.expertReviewFlags.map((x) => x.ruleId)).toContain("SAK-PURPOSE-QUALIFIED-LIMIT");
  });

  it("a claim of the authorized purpose, or a narrower one, is not touched by the exclusion", () => {
    expect(compile(claim({ purpose: "detection_aid" }, NO_PERF, BOTH), evidence(absolute)).label).toBe("SUPPORTED_FOR_SCOPE");
    expect(compile(claim({ purpose: "triage_notification" }, NO_PERF, BOTH), evidence(absolute)).label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("an exclusion of a purpose the taxonomy cannot place is not guessed at", () => {
    const odd = formatPurposeExclusion({ node: "moon base", strength: "absolute", sentence: "Not for use on the moon." });
    expect(compile(claim({ purpose: "diagnosis" }, NO_PERF, BOTH), evidence(odd)).label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
  });

  it("is read from the authorization record even when the claim lists only a study as required", () => {
    const f = compile(claim({ purpose: "diagnosis" }, NO_PERF, { dependencies: { required: ["study"], corroborating: ["authorization"] } }), evidence(absolute));
    expect(f.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("a record that is not an authorization cannot exclude a purpose", () => {
    const f = compile(claim({ purpose: "diagnosis" }, NO_PERF, BOTH), [auth({ purpose: "detection_aid" }), study({ purpose: "detection_aid" }, [], { limitations: [absolute] })]);
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
  });
});

describe("staleness of the authorization record (R20, design inference)", () => {
  const at = (date: string, policy?: number) =>
    compileDetailed(claim({ timing: { from: date } }, NO_PERF, { dependencies: { required: ["authorization"], corroborating: [] } }), [auth()], policy === undefined ? {} : { policy: { stalenessWindowDays: policy } });

  it("flags a claim that begins long after the authorization date once a window is configured, and asks a reviewer", () => {
    const d = at("2026-11-01", 1095);
    expect(d.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    const flag = d.finding.expertReviewFlags.find((f) => f.ruleId === "R20-STALENESS");
    expect(flag?.reason).toMatch(new RegExp(`dated ${AUTH_FROM}`));
    expect(flag?.reason).toMatch(/does not lapse by age/);
    expect(flag?.reason).not.toMatch(/bd+ daysb/);
  });

  it("raises nothing when no window is configured: there is no default, because no standard sets one", () => {
    expect(at("2026-11-01").finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("raises nothing inside the window", () => {
    expect(at("2021-06-01", 1095).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("measures to the end of the claimed period", () => {
    const f = compile(claim({ timing: { from: "2021-06-01", to: "2026-06-01" } }, NO_PERF, { dependencies: { required: ["authorization"], corroborating: [] } }), [auth()], { policy: { stalenessWindowDays: 1095 } });
    expect(f.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("never turns a missing or contradicted dimension into review: INSUFFICIENT and CONTRADICTED keep their precedence", () => {
    const f = compile(claim({ timing: { from: "2026-11-01" }, versions: ["9.9"] }, NO_PERF, { dependencies: { required: ["authorization"], corroborating: [] } }), [auth()], { policy: { stalenessWindowDays: 1095 } });
    expect(f.label).toBe("INSUFFICIENT_EVIDENCE");
  });
});
