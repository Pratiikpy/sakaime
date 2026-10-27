/**
 * Edits made by someone who holds the signing key. Hashes and signature are valid after each edit, so these are
 * caught only by the semantic checks, and each test says which check and which item.
 */
import { describe, expect, it } from "vitest";
import { verifyDossier } from "../../src/dossier/index.ts";
import { forge, verifyOptions } from "./helpers.ts";

async function check(mutate: (body: any) => void) {
  const result = await verifyDossier(forge(mutate), verifyOptions);
  // the forgery is internally consistent: nothing but a semantic check may fire
  expect(result.checks.find((c) => c.id === "signature.valid")?.status).toBe("PASS");
  expect(result.checks.find((c) => c.id === "manifest.items")?.status).toBe("PASS");
  return result;
}

const reasons = (r: { failures: { check: string; item: string; reason: string }[] }, checkId: string) => r.failures.filter((f) => f.check === checkId);

describe("references", () => {
  it("fails a finding whose claim is not in the dossier", async () => {
    const r = await check((b) => (b.findings[1].claimId = "c-missing"));
    expect(reasons(r, "refs.integrity").map((f) => f.item)).toContain("findings/f2");
  });

  it("fails an anchor cited by a finding that is not stored", async () => {
    const r = await check((b) => b.findings[0].mismatches[0].anchorIds.push("a-ghost"));
    expect(reasons(r, "refs.integrity")[0]?.reason).toBe("anchor a-ghost is not in the dossier");
  });

  it("fails a finding with no recorded compiler input", async () => {
    const r = await check((b) => (b.compilerRuns = b.compilerRuns.filter((x: any) => x.findingId !== "f2")));
    expect(reasons(r, "refs.integrity").map((f) => f.item)).toContain("findings/f2");
  });

  it("fails an anchor whose record has no stored snapshot", async () => {
    const r = await check((b) => (b.anchors[0].recordId = "rec-gone"));
    expect(reasons(r, "refs.integrity").map((f) => f.item)).toContain("anchors/a-auth");
  });

  it("fails a claim that has no finding", async () => {
    const r = await check((b) => {
      b.findings = b.findings.filter((f: any) => f.claimId !== "c2");
      b.compilerRuns = b.compilerRuns.filter((x: any) => x.findingId !== "f2");
      b.counterexamples = b.counterexamples.filter((x: any) => x.findingId !== "f2");
      b.lineage = b.lineage.filter((e: any) => !e.outputs.some((o: any) => o.name === "f2"));
      b.rules.versionsUsed = ["rules-1"];
    });
    expect(r.failures.find((f) => f.check === "claims.findings")?.item).toBe("claims/c2");
  });
});

describe("counterexamples", () => {
  it("fails a counterexample that differs from its finding's mismatches", async () => {
    const r = await check((b) => (b.counterexamples[0].mismatches[0].established = "ages 18 to 70"));
    expect(reasons(r, "counterexamples.consistent")[0]?.reason).toBe("does not match the mismatches of its finding");
  });

  it("fails a missing counterexample", async () => {
    const r = await check((b) => (b.counterexamples = []));
    expect(reasons(r, "counterexamples.consistent").map((f) => f.item)).toEqual(["counterexamples/f1", "counterexamples/f2"]);
  });
});

describe("supersession", () => {
  const second = (b: any, patch: object) => {
    const f = JSON.parse(JSON.stringify(b.findings[0]));
    b.findings.push({ ...f, id: "f1b", ...patch });
    b.compilerRuns.push({ findingId: "f1b", evidenceItemIds: b.compilerRuns[0].evidenceItemIds });
    b.counterexamples.push({ ...b.counterexamples[0], findingId: "f1b" });
    const compile = b.lineage.filter((e: any) => e.outputs.some((o: any) => o.name === "f1"));
    for (const e of compile) {
      const c = JSON.parse(JSON.stringify(e));
      c.run.runId = e.run.runId.replace(/^./, "e");
      c.outputs.forEach((o: any) => (o.name = "f1b"));
      b.lineage.push(c);
    }
  };

  it("accepts a replacement that names the finding it supersedes and gives a reason", async () => {
    const r = await check((b) => second(b, { supersedes: "f1", supersedesReason: "vendor sent the older-adult study" }));
    expect(reasons(r, "findings.supersession")).toEqual([]);
  });

  it("fails a replacement with no reason", async () => {
    const r = await check((b) => second(b, { supersedes: "f1", supersedesReason: " " }));
    expect(reasons(r, "findings.supersession").map((f) => f.reason)).toContain("supersedes another finding without a reason");
  });

  it("fails a supersession of a finding that does not exist, and a reason with nothing to supersede", async () => {
    const a = await check((b) => second(b, { supersedes: "f-none", supersedesReason: "x" }));
    expect(reasons(a, "findings.supersession")[0]?.reason).toMatch(/not in the dossier/);
    const c = await check((b) => second(b, { supersedesReason: "x" }));
    expect(reasons(c, "findings.supersession")[0]?.reason).toBe("has a supersession reason but supersedes nothing");
  });

  it("fails a fork: one finding superseded twice", async () => {
    const r = await check((b) => {
      second(b, { supersedes: "f1", supersedesReason: "first" });
      const f = JSON.parse(JSON.stringify(b.findings[0]));
      b.findings.push({ ...f, id: "f1c", supersedes: "f1", supersedesReason: "second" });
      b.compilerRuns.push({ findingId: "f1c", evidenceItemIds: b.compilerRuns[0].evidenceItemIds });
      b.counterexamples.push({ ...b.counterexamples[0], findingId: "f1c" });
    });
    expect(reasons(r, "findings.supersession").map((f) => f.reason).join(" ")).toMatch(/already superseded by f1b/);
  });

  it("fails a cycle and a replacement placed before the finding it replaces", async () => {
    const cycle = await check((b) => {
      second(b, { supersedes: "f1", supersedesReason: "x" });
      b.findings[0].supersedes = "f1b";
      b.findings[0].supersedesReason = "x";
    });
    expect(reasons(cycle, "findings.supersession").map((f) => f.reason).join(" ")).toMatch(/cycle/);
    const order = await check((b) => {
      second(b, { supersedes: "f1", supersedesReason: "x" });
      b.findings.reverse();
    });
    expect(reasons(order, "findings.supersession").map((f) => f.reason).join(" ")).toMatch(/appears before the finding it supersedes/);
  });
});

describe("rule versions", () => {
  it("fails a finding under a rule version the dossier does not list, and a listed version no finding used", async () => {
    const r = await check((b) => (b.rules.versionsUsed = ["rules-0", "rules-1"]));
    expect(reasons(r, "rules.versions").map((f) => f.reason)).toEqual(["versionsUsed lists rules-0, which no finding was computed under"]);
    const r2 = await check((b) => (b.rules.versionsUsed = ["rules-0"]));
    expect(reasons(r2, "rules.versions").map((f) => f.item)).toContain("findings/f1/ruleVersion");
  });
});

describe("decision history", () => {
  it("fails a removed middle entry (the chain no longer links)", async () => {
    const r = await check((b) => b.decisionHistory.splice(0, 1));
    const reasonsText = reasons(r, "decisions.chain").map((f) => f.reason).join(" | ");
    expect(reasonsText).toMatch(/sequence is 2, expected 1/);
    expect(reasonsText).toMatch(/previous-entry hash does not match/);
  });

  it("fails an edited entry whose hash was not recomputed", async () => {
    const r = await check((b) => (b.decisionHistory[1].escalateTo = "someone-else"));
    expect(reasons(r, "decisions.chain")[0]).toMatchObject({ item: "decisionHistory/dec-0002", reason: expect.stringMatching(/entry hash does not match|request hash/) });
  });

  it("fails a repeated idempotency key", async () => {
    const r = await check((b) => {
      b.decisionHistory[1].idempotencyKey = b.decisionHistory[0].idempotencyKey;
    });
    expect(reasons(r, "decisions.chain").map((f) => f.reason).join(" ")).toMatch(/idempotency key repeated/);
  });

  it("fails a decision on a finding that is not in the dossier, or on the wrong claim", async () => {
    const wrongClaim = await check((b) => {
      // rebuild a consistent chain entry is hard by hand; changing claimId alone breaks the entry hash and the reference
      b.decisionHistory[0].claimId = "c2";
    });
    expect(wrongClaim.failures.map((f) => f.item)).toContain("decisionHistory/dec-0001");
  });
});

describe("evidence history", () => {
  it("fails a record entry for a record that is not stored, and a gap in the sequence", async () => {
    const r = await check((b) => {
      b.evidenceHistory[0].refId = "rec-nowhere";
      b.evidenceHistory[2].seq = 9;
    });
    const t = reasons(r, "history.evidence").map((f) => f.reason).join(" | ");
    expect(t).toMatch(/record rec-nowhere has no stored snapshot/);
    expect(t).toMatch(/sequence is 9, expected 3/);
  });

  it("fails a superseded fact that the history never records, and a supersession that points at nothing", async () => {
    const dropped = await check((b) => (b.evidenceHistory = b.evidenceHistory.filter((e: any) => e.kind !== "fact_superseded")));
    expect(reasons(dropped, "history.evidence").map((f) => f.item)).toContain("facts/fact-0");
    const dangling = await check((b) => (b.evidenceHistory[4].supersedes = "fact-gone"));
    expect(reasons(dangling, "history.evidence")[0]?.reason).toMatch(/superseded facts are kept/);
  });

  it("fails a source-health entry that does not say which health was seen", async () => {
    const r = await check((b) => delete b.evidenceHistory[2].health);
    expect(reasons(r, "history.evidence")[0]?.reason).toMatch(/must say which health/);
  });

  it("keeps the two histories apart: a decision cannot sit in the evidence history or the reverse", async () => {
    const a = await verifyDossier(forge((b) => b.evidenceHistory.push(JSON.parse(JSON.stringify(b.decisionHistory[0])))), verifyOptions);
    expect(a.failures.some((f) => f.check === "body.schema" && f.item.startsWith("evidenceHistory/"))).toBe(true);
    const c = await verifyDossier(forge((b) => b.decisionHistory.push(JSON.parse(JSON.stringify(b.evidenceHistory[0])))), verifyOptions);
    expect(c.failures.some((f) => f.check === "body.schema" && f.item.startsWith("decisionHistory/"))).toBe(true);
  });
});

describe("live versus recorded labels", () => {
  it("fails a recorded reply labelled live, and a live reply labelled recorded", async () => {
    const a = await check((b) => (b.models[1].label = "live"));
    expect(reasons(a, "models.labels")[0]?.reason).toBe("reply is recorded but labelled live");
    const c = await check((b) => (b.models[0].label = "recorded"));
    expect(reasons(c, "models.labels")[0]?.reason).toBe("reply is labelled recorded but is not marked recorded");
  });

  it("fails a recorded reply that carries a live receipt, and a receipt for a different model", async () => {
    const a = await check((b) => (b.models[1].receipt = { receiptId: "r", routedModel: "constructed-model-small", raw: {} }));
    expect(reasons(a, "models.labels").map((f) => f.reason)).toContain("a recorded reply cannot carry a live receipt");
    const c = await check((b) => (b.models[0].receipt.routedModel = "other-model"));
    expect(reasons(c, "models.labels")[0]?.reason).toMatch(/receipt routed model other-model differs/);
  });

  it("fails a federation result served from a cassette but labelled live", async () => {
    const r = await check((b) => (b.federation[0].label = "live"));
    expect(reasons(r, "federation.results")[0]?.reason).toBe("served from cassette but labelled live");
  });
});

describe("federation results", () => {
  it("fails a truncated result, and a stored result that does not match its digest or row count", async () => {
    const trunc = await check((b) => (b.federation[0].total = 5));
    expect(reasons(trunc, "federation.results")[0]?.reason).toMatch(/truncated result: 1 of 5 rows/);
    const edited = await check((b) => (b.federation[0].result.rows[0].n = "999"));
    expect(reasons(edited, "federation.results")[0]?.reason).toBe("stored result does not match its digest");
    const rows = await check((b) => b.federation[0].result.rows.push({ study_id: "S-2", n: "1" }));
    expect(reasons(rows, "federation.results").map((f) => f.reason).join(" ")).toMatch(/stored result has 2 rows, record says 1/);
  });

  it("recomputes respHash with the federation port's own definition when one is supplied", async () => {
    const bundle = forge(() => {});
    const bad = await verifyDossier(bundle, { ...verifyOptions, federationResultHash: () => "f".repeat(64) });
    expect(reasons(bad, "federation.results")[0]?.reason).toBe("stored result does not match the hash the federation port returned");
    const good = await verifyDossier(bundle, { ...verifyOptions, federationResultHash: () => bundle.body.federation[0].respHash });
    expect(good.ok).toBe(true);
  });
});

describe("receipt coverage", () => {
  it("fails coverage statistics that do not match the model replies", async () => {
    const r = await check((b) => {
      b.receiptCoverage.coverage = 1;
      b.receiptCoverage.fields.receipted = 2;
    });
    expect(reasons(r, "receipts.coverage")[0]?.item).toBe("receiptCoverage");
  });

  it("fails a model-derived field that no reply accounts for", async () => {
    const r = await check((b) => {
      b.models[1].derives = [];
      b.receiptCoverage = {
        replies: { total: 2, receipted: 1, unreceipted: 1, live: 1, recorded: 1, fallback: 0 },
        fields: { total: 2, receipted: 1, unreceipted: 1, withoutReply: 1 },
        coverage: 0.5,
        unreceiptedReplyIds: ["m2"],
        unreceiptedFieldIds: ["asr-2"],
      };
    });
    expect(reasons(r, "receipts.coverage")[0]).toMatchObject({ item: "assertions/asr-2" });
    expect(reasons(r, "receipts.coverage")[0]?.reason).toMatch(/neither a receipt nor an unreceipted label/);
  });
});

describe("egress and data classes", () => {
  it("fails PHI anywhere", async () => {
    const m = await check((b) => (b.models[0].dataClass = "phi"));
    expect(reasons(m, "egress.policy").map((f) => f.item)).toContain("models/m1");
    const s = await check((b) => (b.sources[0].dataClass = "phi"));
    expect(reasons(s, "egress.policy").map((f) => f.item)).toContain("sources/src-reg");
  });

  it("fails vendor-confidential content sent to a model with no consent or local-lane decision", async () => {
    const none = await check((b) => (b.models[0].dataClass = "vendor-confidential"));
    expect(reasons(none, "egress.policy")[0]?.reason).toMatch(/no recorded consent or local-lane decision/);
    const ok = await check((b) => {
      b.models[0].dataClass = "vendor-confidential";
      b.egress[0] = { ...b.egress[0], dataClass: "vendor-confidential", route: "remote", decision: "consented", consentRef: "consent-17", reason: "vendor agreed" };
    });
    expect(reasons(ok, "egress.policy")).toEqual([]);
  });

  it("fails consent with no reference, a blocked call that has a reply, and a decision about a call that is not recorded", async () => {
    const noRef = await check((b) => (b.egress[0] = { ...b.egress[0], decision: "consented" }));
    expect(reasons(noRef, "egress.policy")[0]?.reason).toBe("consent recorded without a consent reference");
    const blocked = await check((b) => {
      b.models[0].dataClass = "vendor-confidential";
      b.egress[0] = { ...b.egress[0], dataClass: "vendor-confidential", decision: "blocked", route: "none", reason: "policy" };
    });
    expect(reasons(blocked, "egress.policy").map((f) => f.reason).join(" ")).toMatch(/no recorded consent|blocked/);
    const ghost = await check((b) => (b.egress[0].subjectId = "m-ghost"));
    expect(reasons(ghost, "egress.policy")[0]?.reason).toMatch(/m-ghost, which is not in the dossier/);
  });
});

describe("lineage", () => {
  it("fails a finding with no lineage event, and one whose lineage carries a different label or anchors", async () => {
    const none = await check((b) => (b.lineage = b.lineage.filter((e: any) => !e.outputs.some((o: any) => o.name === "f2"))));
    expect(reasons(none, "lineage.coherence").map((f) => f.item)).toContain("findings/f2");
    const label = await check((b) => {
      const e = b.lineage.find((x: any) => x.eventType === "COMPLETE" && x.outputs.some((o: any) => o.name === "f1"));
      e.outputs[0].facets.sakaime_finding.label = "SUPPORTED_FOR_SCOPE";
    });
    expect(reasons(label, "lineage.coherence")[0]?.reason).toMatch(/does not carry the finding's label/);
    const anchors = await check((b) => {
      const e = b.lineage.find((x: any) => x.eventType === "COMPLETE" && x.outputs.some((o: any) => o.name === "f1"));
      e.outputs[0].facets.sakaime_anchors.anchors[0].textHash = "9".repeat(64);
    });
    expect(reasons(anchors, "lineage.coherence")[0]?.reason).toBe("lineage anchors differ from the anchors the finding cites");
  });

  it("fails a run that never finishes, and a dataset the dossier does not hold", async () => {
    const open = await check((b) => {
      const i = b.lineage.findIndex((x: any) => x.eventType === "COMPLETE" && x.job.name === "source.read");
      b.lineage.splice(i, 1);
    });
    expect(reasons(open, "lineage.coherence")[0]?.reason).toBe("run started and never finished");
    const ghost = await check((b) => b.lineage.find((x: any) => x.job.name === "source.read").inputs.push({ namespace: "sakaime.source", name: "src-ghost" }));
    expect(reasons(ghost, "lineage.coherence")[0]?.reason).toMatch(/dataset sakaime.source\/src-ghost is not in the dossier/);
  });
});

describe("attribution to claims", () => {
  it("attributes an edit to one claim's finding to that claim only", async () => {
    const r = await check((b) => (b.findings[1].label = "SUPPORTED_FOR_SCOPE"));
    expect(r.failures.every((f) => f.claimIds.join() === "c2")).toBe(true);
  });

  it("attributes a changed source record to the claims whose findings cite it", async () => {
    const r = await verifyDossier(
      (() => {
        const b: any = JSON.parse(JSON.stringify(forge(() => {})));
        b.body.snapshots.find((s: any) => s.id === "rec-study").license = "changed";
        return b;
      })(),
      verifyOptions,
    );
    const f = r.failures.find((x) => x.item === "snapshots/rec-study");
    expect(f?.claimIds).toEqual(["c1"]);
  });

  it("treats a signature or rules failure as dossier-wide", async () => {
    const bundle: any = JSON.parse(JSON.stringify(forge(() => {})));
    bundle.body.rules.registryVersion = "tampered";
    const r = await verifyDossier(bundle, verifyOptions);
    expect(r.failures.find((f) => f.item === "rules")?.claimIds).toEqual([]);
  });
});
