/**
 * T3 (identity ambiguity), C-02 (typed identity links) and I-4 (a model hypothesis is not a verified link),
 * run on the real records from the feasibility fixtures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applicableLinkTypes } from "../../src/identity/exact.ts";
import { rankCandidates } from "../../src/identity/resolver.ts";
import { LINK_TYPES, type LinkType } from "../../src/schemas/index.ts";
import type { IdentityRecord } from "../../src/identity/types.ts";
import { FIXTURES, MODEL, corpus, rec, resolve2 } from "./helpers.ts";

const state = (a: string, b: string, t: LinkType) => resolve2(a, b, t).link?.state ?? "NOT_LINKED";

describe("T3: a true match is found, a false match is not merged, an ambiguous pair stays AMBIGUOUS", () => {
  it("finds the EyeArt chain end to end: submission, trial, paper", () => {
    expect(state("ctgov:NCT03112005", "510k:K200667", "STUDY_EVALUATES")).toBe("CONFIRMED");
    expect(state("pubmed:34779843", "ctgov:NCT03112005", "PUBLICATION_REPORTS")).toBe("CONFIRMED");
    expect(state("gudid:K200667:2.1.0", "510k:K200667", "SAME_MARKETED_VERSION")).toBe("CONFIRMED");
    const r = resolve2("ctgov:NCT03112005", "510k:K200667", "STUDY_EVALUATES");
    expect(r.candidateClass).toBe("EXACT-IDENTIFIER");
    expect(r.presentation).toBe("CONFIRMED_FACT");
  });

  it("does not merge two products that share a name and are made by different companies", () => {
    for (const [a, b] of [["list:K251153", "list:K231355"], ["list:K231355", "list:P220012/S059"], ["list:K251153", "list:K251167"]] as const) {
      for (const t of ["SAME_PRODUCT", "SAME_SUBMISSION"] as const) {
        const s = state(a, b, t);
        expect(["CONFIRMED", "CANDIDATE"]).not.toContain(s);
      }
    }
    expect(state("list:K251153", "list:K231355", "SAME_SUBMISSION")).toBe("REJECTED");
  });

  it("leaves a same-name, different-company pair AMBIGUOUS and says so (BodyGuardian)", () => {
    const r = resolve2("list:K243349", "list:K192732", "SAME_PRODUCT");
    expect(r.link?.state).toBe("AMBIGUOUS");
    expect(r.presentation).toBe("WEAK_CANDIDATE");
    expect(r.link?.flags.join(" ")).toMatch(/same-name-different-company/);
  });

  it("leaves BriefCase rows with the same name, company and code AMBIGUOUS because the name is shared by many rows", () => {
    const r = resolve2("list:K251406", "list:K251195", "SAME_PRODUCT");
    expect(r.link?.state).toBe("AMBIGUOUS");
    expect(r.link?.flags.join(" ")).toMatch(/family-name/);
  });

  it("does not link a different module's study to the abdominal BriefCase submission as a candidate", () => {
    const r = resolve2("pubmed:41444826", "510k:K253265", "STUDY_EVALUATES");
    expect(r.link?.state).not.toBe("CONFIRMED");
    expect(r.link?.state).not.toBe("CANDIDATE");
    expect(r.flags.join(" ")).toMatch(/module-differs/);
  });

  it("does not link retrieval collisions: contact dermatitis, contact angle, a briefcase essay, a MammoScreen decision aid", () => {
    for (const [a, b] of [
      ["pubmed:35183401", "510k:DEN170073"],
      ["pubmed:24140073", "510k:DEN170073"],
      ["pubmed:36862835", "510k:K253265"],
      ["pubmed:30251484", "510k:K253265"],
      ["ctgov:NCT04996316", "510k:K240301"],
      ["pubmed:32159424", "510k:K240301"],
      ["ctgov:NCT04965857", "510k:DEN180001"],
    ] as const) {
      const s = state(a, b, "STUDY_EVALUATES");
      expect(["CONFIRMED", "CANDIDATE"], `${a} against ${b}`).not.toContain(s);
    }
  });

  it("does not take a same-company, different-product trial as the cleared product's study", () => {
    expect(["CONFIRMED", "CANDIDATE"]).not.toContain(state("ctgov:NCT06717373", "510k:DEN190040", "STUDY_EVALUATES"));
    expect(["CONFIRMED", "CANDIDATE"]).not.toContain(state("ctgov:NCT05867407", "list:K253801", "STUDY_EVALUATES"));
  });

  it("treats a cited identifier as a data source, not a study, when the passage says training data (DEN200055)", () => {
    const origin = resolve2("ctgov:NCT01694966", "510k:DEN200055", "STUDY_EVALUATES");
    expect(origin.link?.state).toBe("AMBIGUOUS");
    expect(origin.candidateClass).toBe("EXACT-IDENTIFIER");
    expect(origin.link?.flags).toContain("identifier-cited-as-data-origin");
    expect(state("ctgov:NCT04079478", "510k:DEN200055", "STUDY_EVALUATES")).toBe("CONFIRMED");
  });

  it("rejects a paper that the registry lists as a background reference, and confirms one it lists as a result", () => {
    // NCT04142879 lists four background references; none of them reports the trial.
    const trial = { ...rec("ctgov:NCT04142879") };
    const background = {
      ...rec("pubmed:34779843"),
      id: "pubmed:29386200",
      ids: { ...rec("pubmed:34779843").ids, pmid: ["29386200"] },
      mentions: [],
    };
    expect(resolve2(background, trial, "PUBLICATION_REPORTS").link?.state).toBe("REJECTED");
    expect(state("pubmed:37541274", "ctgov:NCT04838756", "PUBLICATION_REPORTS")).toBe("CONFIRMED");
  });

  it("does not report a design match as a confirmed link (paper and registry record with equal enrolment and no identifier)", () => {
    const r = resolve2("pubmed:33599681", "ctgov:NCT03897140", "PUBLICATION_REPORTS");
    expect(r.link?.state).not.toBe("CONFIRMED");
  });
});

describe("C-02: a shared identifier supports only the link type it supports", () => {
  it("a shared submission number yields SAME_SUBMISSION and nothing more", () => {
    const a = "510k:DEN170073";
    const b = "gudid:DEN170073:1.5";
    const result: Partial<Record<LinkType, string>> = {};
    for (const t of applicableLinkTypes(rec(a), rec(b))) result[t] = state(a, b, t);
    expect(result.SAME_SUBMISSION).toBe("CONFIRMED");
    expect(result.SAME_MARKETED_VERSION).toBe("REJECTED");
    expect(result.SAME_PRODUCT).not.toBe("CONFIRMED");
    for (const t of LINK_TYPES) if (t !== "SAME_SUBMISSION") expect(result[t]).not.toBe("CONFIRMED");
  });

  it("the eleven GUDID releases under DEN170073 are eleven marketed versions, one authorization", () => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, "openfda", "udi_DEN170073.json"), "utf8")) as {
      results: { brand_name: string; version_or_model_number: string; company_name: string; identifiers: { id: string; type: string }[] }[];
    };
    expect(raw.results).toHaveLength(11);
    const releases: IdentityRecord[] = raw.results.map((r) => ({
      id: `gudid:DEN170073:${r.version_or_model_number}`,
      kind: "SoftwareRelease",
      source: "gudid",
      name: r.brand_name,
      manufacturer: r.company_name,
      version: r.version_or_model_number,
      ids: { submission: ["DEN170073"], nct: [], pmid: [], doi: [], udiDi: r.identifiers.filter((i) => i.type === "Primary").map((i) => i.id) },
      aliases: [],
      purposeTags: [],
      mentions: [],
      supersedes: [],
    }));
    const deNovo = rec("510k:DEN170073");
    let pairs = 0;
    const parent = new Map(releases.map((r) => [r.id, r.id] as const));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    for (let i = 0; i < releases.length; i++) {
      for (let j = i + 1; j < releases.length; j++) {
        pairs++;
        expect(resolve2(releases[i]!, releases[j]!, "SAME_SUBMISSION", releases).link?.state).toBe("CONFIRMED");
        const v = resolve2(releases[i]!, releases[j]!, "SAME_MARKETED_VERSION", releases);
        expect(v.link?.state, `${releases[i]!.version} against ${releases[j]!.version}`).toBe("REJECTED");
        if (v.link?.state === "CONFIRMED") parent.set(find(releases[i]!.id), find(releases[j]!.id));
      }
      // The De Novo's own record says "initial version 1.0": it is not any of the eleven.
      expect(resolve2(deNovo, releases[i]!, "SAME_MARKETED_VERSION").link?.state).toBe("REJECTED");
    }
    expect(pairs).toBe(55);
    expect(new Set(releases.map((r) => find(r.id))).size).toBe(11);
    const flagged = resolve2(releases[0]!, deNovo, "SAME_SUBMISSION", releases);
    // Eleven GUDID labels plus the De Novo's own initial "1.0".
    expect(flagged.flags).toContain("multiple-releases-under-submission: DEN170073 carries 12 distinct version labels");
  });

  it("Transpara 1.7.0 and 1.7.2 stay separate releases of one product", () => {
    expect(state("510k:K221347", "list:K210404", "SAME_MARKETED_VERSION")).toBe("REJECTED");
    expect(state("510k:K221347", "list:K210404", "SAME_SUBMISSION")).toBe("REJECTED");
    expect(["CANDIDATE", "AMBIGUOUS"]).toContain(state("510k:K221347", "list:K210404", "SAME_PRODUCT"));
    // The paper that ran 1.7.0 is tied to the product, with the difference shown and the state unchanged.
    const r = resolve2("pubmed:37541274", "510k:K221347", "STUDY_EVALUATES");
    expect(r.flags.join(" ")).toMatch(/version-differs: 1\.7\.0 versus 1\.7\.2/);
    expect(["CANDIDATE", "AMBIGUOUS"]).toContain(r.link?.state);
  });

  it("a shared NCT number never makes two submissions, products or versions the same", () => {
    const study = { ...rec("ctgov:NCT03112005") };
    const a = { ...rec("510k:K200667") };
    const b = { ...rec("list:K223357"), mentions: [{ type: "nct" as const, value: "NCT03112005", channel: "field" as const }] };
    for (const t of ["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION"] as const) {
      expect(resolve2(a, b, t).link?.state).not.toBe("CONFIRMED");
    }
    expect(resolve2(study, b, "STUDY_EVALUATES").link?.state).toBe("CONFIRMED");
  });

  it("a shared device identifier supports SAME_MARKETED_VERSION and only that", () => {
    const a = { ...rec("gudid:K200667:2.1.0") };
    const b = { ...rec("gudid:K200667:2.1.0"), id: "gudid:copy", ids: { ...a.ids, submission: [] } };
    expect(resolve2(a, b, "SAME_MARKETED_VERSION").link?.state).toBe("CONFIRMED");
    expect(resolve2(a, b, "SAME_SUBMISSION").link?.state).not.toBe("CONFIRMED");
    expect(resolve2(a, b, "SAME_PRODUCT").link?.state).not.toBe("CONFIRMED");
  });

  it("a shared device identifier against disagreeing versions is flagged, not confirmed", () => {
    const a = { ...rec("gudid:K200667:2.1.0") };
    const b = { ...a, id: "gudid:other", version: "9.9.9" };
    expect(resolve2(a, b, "SAME_MARKETED_VERSION").link?.state).toBe("AMBIGUOUS");
  });

  it("a supplement of a PMA is a different submission from the original", () => {
    const a = { ...rec("list:P220012/S059") };
    const b = { ...a, id: "list:P220012", ids: { ...a.ids, submission: ["P220012"] } };
    expect(resolve2(a, b, "SAME_SUBMISSION").link?.state).toBe("REJECTED");
  });

  it("two submissions tied to one GUDID record are not merged through it", () => {
    expect(state("510k:DEN190040", "list:K243065", "SAME_SUBMISSION")).toBe("REJECTED");
    expect(state("510k:DEN190040", "gudid:DEN190040:Guidance", "SAME_SUBMISSION")).toBe("CONFIRMED");
    expect(state("list:K243065", "gudid:DEN190040:Guidance", "SAME_SUBMISSION")).toBe("CONFIRMED");
  });

  it("SAME_PRODUCT is never confirmed by an identifier, only by a reviewer", () => {
    for (const p of corpus().pairs.filter((p) => p.linkType === "SAME_PRODUCT")) {
      expect(resolve2(p.a, p.b, "SAME_PRODUCT").link?.state, p.id).not.toBe("CONFIRMED");
    }
  });
});

describe("supersession", () => {
  it("is confirmed only by an explicit statement", () => {
    const older = rec("list:K203629");
    const newer = { ...rec("list:K213037"), supersedes: [older.id] };
    const r = resolve2(newer, older, "SUPERSEDES");
    expect(r.link?.state).toBe("CONFIRMED");
    expect([r.link?.from, r.link?.to]).toEqual([newer.id, older.id]);
    expect(resolve2(rec("list:K213037"), older, "SUPERSEDES").link).toBeNull();
  });

  it("does not confirm a supersession that contradicts the dates", () => {
    const newer = { ...rec("list:K203629"), supersedes: ["list:K213037"] };
    expect(resolve2(newer, "list:K213037", "SUPERSEDES").link?.state).toBe("AMBIGUOUS");
  });
});

describe("ranking", () => {
  it("puts the identifier-confirmed record first and is independent of pool order", () => {
    const pool = [...corpus().records.values()].map((r) => r.record).filter((r) => r.kind === "AuthorizationSubmission");
    const target = rec("ctgov:NCT03112005");
    const forward = rankCandidates(target, pool, "STUDY_EVALUATES", { model: MODEL });
    const backward = rankCandidates(target, [...pool].reverse(), "STUDY_EVALUATES", { model: MODEL });
    expect(forward.map((c) => c.other.id)).toEqual(backward.map((c) => c.other.id));
    expect(forward[0]?.other.id).toBe("510k:K200667");
    expect(forward[0]?.resolution.link?.state).toBe("CONFIRMED");
  });
});
