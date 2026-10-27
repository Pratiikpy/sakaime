import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  SECTION_NAMES,
  SIGNATURE_STATEMENT,
  buildDossier,
  createDemoSignerFromSeed,
  createEphemeralDemoSigner,
  renderVerifyResult,
  serializeDossier,
  verifyDossier,
  verifyIntegrity,
} from "../../src/dossier/index.ts";
import { canonicalJson, sha256Hex } from "../../src/util/canonical.ts";
import { baseBundle, baseInput, buildOptions, compilerTestDouble, failedItems, fixedClock, forge, seedSigner, verifyOptions, viaJson } from "./helpers.ts";

describe("untampered dossier", () => {
  it("verifies after a round trip through text, with every check run except the receipt verifier", async () => {
    const text = serializeDossier(baseBundle());
    const result = await verifyDossier(JSON.parse(text), verifyOptions);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("full");
    expect(result.checks.filter((c) => c.status === "FAIL")).toHaveLength(0);
    expect(result.skipped).toEqual(["receipts.verify: no receipt verifier supplied: receipt signatures, key ids and hashes were not checked"]);
  });

  it("covers every section of the format in the manifest", () => {
    const b = baseBundle();
    expect(Object.keys(b.manifest.sections).sort()).toEqual([...SECTION_NAMES].sort());
    expect(Object.keys(b.body).sort()).toEqual([...SECTION_NAMES].sort());
  });

  it("states that a signature shows integrity, not clinical truth", () => {
    const b = baseBundle();
    expect(b.manifest.signing.statement).toBe(SIGNATURE_STATEMENT);
    expect(SIGNATURE_STATEMENT).toMatch(/does not show that any finding is clinically correct/);
    expect(renderVerifyResult({ ok: true, mode: "full", checks: [], failures: [], skipped: [] })).toMatch(/does not show that any finding is clinically correct/);
  });

  it("runs the injected receipt verifier when given one, and fails on a rejected receipt", async () => {
    const bundle = viaJson(baseBundle());
    const ok = await verifyDossier(bundle, { ...verifyOptions, verifyReceipt: () => ({ valid: true }) });
    expect(ok.ok).toBe(true);
    expect(ok.skipped).toEqual([]);
    const bad = await verifyDossier(bundle, { ...verifyOptions, verifyReceipt: (r) => ({ valid: false, reason: `key for ${r.receiptId} is not installed` }) });
    expect(failedItems(bad)).toEqual(["models/m1"]);
    expect(bad.failures[0]?.reason).toMatch(/rcpt-1 rejected: key for rcpt-1 is not installed/);
  });
});

describe("determinism", () => {
  it("gives byte-identical bundles for identical inputs, clock and key", () => {
    const a = serializeDossier(buildDossier(baseInput(), buildOptions()));
    const b = serializeDossier(buildDossier(baseInput(), buildOptions()));
    expect(a).toBe(b);
  });

  it("changes the bytes when any input changes", () => {
    const input = baseInput();
    input.run = { mode: "live" };
    expect(serializeDossier(buildDossier(input, buildOptions()))).not.toBe(serializeDossier(baseBundle()));
  });

  it("gives a different signature for a different key but the same body", () => {
    const other = buildDossier(baseInput(), { signer: createDemoSignerFromSeed(new Uint8Array(32).fill(9)), clock: fixedClock });
    expect(other.body).toEqual(baseBundle().body);
    expect(other.signature.value).not.toBe(baseBundle().signature.value);
  });
});

describe("canonical order independence", () => {
  const shuffleKeys = (value: unknown, rnd: () => number): unknown => {
    if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rnd));
    if (value !== null && typeof value === "object") {
      const keys = Object.keys(value as object);
      for (let i = keys.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
      }
      return Object.fromEntries(keys.map((k) => [k, shuffleKeys((value as Record<string, unknown>)[k], rnd)]));
    }
    return value;
  };

  it("still verifies when object keys are re-ordered anywhere in the file", async () => {
    const bundle = baseBundle();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        let s = seed;
        const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
        const result = await verifyDossier(shuffleKeys(bundle, rnd), verifyOptions);
        expect(result.failures).toEqual([]);
      }),
      { numRuns: 40 },
    );
    expect(canonicalJson(shuffleKeys(bundle, () => 0.3))).toBe(canonicalJson(bundle));
  });

  it("does not treat a re-ordered list as the same dossier", async () => {
    const bundle = viaJson(baseBundle());
    bundle.body.anchors.reverse();
    const result = await verifyDossier(bundle, verifyOptions);
    expect(result.ok).toBe(false);
    expect(failedItems(result)).toContain("anchors");
    expect(result.failures.find((f) => f.item === "anchors")?.reason).toMatch(/order changed/);
  });
});

describe("recompute (the compiler re-run)", () => {
  it("fails a re-signed forgery whose label the compiler does not reproduce, and names the finding and the claim", async () => {
    const forged = forge((body) => {
      body.findings[0].label = "SUPPORTED_FOR_SCOPE";
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(result.ok).toBe(false);
    // every hash and the signature are valid, so the hash checks pass and only the re-run catches it
    expect(result.checks.find((c) => c.id === "manifest.items")?.status).toBe("PASS");
    expect(result.checks.find((c) => c.id === "signature.valid")?.status).toBe("PASS");
    const f = result.failures.find((x) => x.check === "findings.recompute");
    expect(f?.item).toBe("findings/f1/label");
    expect(f?.reason).toBe("recorded SUPPORTED_FOR_SCOPE, but the compiler on the recorded inputs gives SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(f?.claimIds).toEqual(["c1"]);
  });

  it("compares per-dimension relations when the compiler returns them", async () => {
    const options = { recompute: compilerTestDouble({ coverage: true }) };
    expect((await verifyDossier(viaJson(baseBundle()), options)).ok).toBe(true);
    const forged = forge((body) => {
      body.findings[0].mechanicalCoverage.find((a: any) => a.dimension === "setting").relation = "UNKNOWN";
    });
    const result = await verifyDossier(forged, options);
    expect(failedItems(result)).toContain("findings/f1/mechanicalCoverage/setting");
  });

  it("fails when the compiler cannot run the recorded rule version", async () => {
    const forged = forge((body) => {
      body.findings[0].ruleVersion = "unknown-rules";
      body.rules.versionsUsed = ["rules-1", "unknown-rules"];
      body.lineage.forEach((e: any) => {
        if (e.job.facets?.sakaime_ruleVersion && e.outputs.some((o: any) => o.name === "f1")) e.job.facets.sakaime_ruleVersion.ruleVersion = "unknown-rules";
      });
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(result.failures.find((f) => f.check === "findings.recompute")?.reason).toMatch(/could not re-run this finding under rule version unknown-rules: no rule set unknown-rules/);
  });

  it("uses exactly the recorded evidence items: dropping one from the compiler input changes what is recomputed", async () => {
    const forged = forge((body) => {
      body.compilerRuns[0].evidenceItemIds = ["e-auth", "e-req"]; // study left out, label stays
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(failedItems(result)).toContain("findings/f1/label");
  });

  it("reports a thrown compiler as a failure on that finding rather than crashing", async () => {
    const result = await verifyDossier(viaJson(baseBundle()), {
      recompute: () => {
        throw new Error("rule registry missing");
      },
    });
    expect(result.ok).toBe(false);
    expect(failedItems(result)).toEqual(["findings/f1", "findings/f2"]);
  });
});

describe("quotes (FR-2) and numbers", () => {
  it("fails when a quote is not verbatim in the stored record text", async () => {
    const forged = forge((body) => {
      const a = body.anchors.find((x: any) => x.id === "a-study-sens");
      a.text = "Sensitivity 0.93 (95% CI 0.87 to 0.94) among 412 patients";
      a.textHash = sha256Hex(a.text);
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(failedItems(result)).toContain("anchors/a-study-sens");
    expect(result.failures.find((f) => f.check === "anchors.quote")?.reason).toMatch(/not found verbatim in record rec-study/);
  });

  it("fails when stored record text is edited but the quote is left as it was", async () => {
    const forged = forge((body) => {
      const s = body.snapshots.find((x: any) => x.id === "rec-study");
      s.text = s.text.replace("0.91", "0.71");
      s.textHash = sha256Hex(s.text);
      s.contentHash = s.textHash;
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(failedItems(result)).toContain("anchors/a-study-sens");
  });

  it("fails when stored record text no longer matches its content hash", async () => {
    const forged = forge((body) => {
      body.snapshots.find((x: any) => x.id === "rec-auth").text += " ";
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(failedItems(result)).toContain("snapshots/rec-auth");
  });

  it("fails when a number in a finding is not in any anchor it cites", async () => {
    const forged = forge((body) => {
      const dim = body.findings[0].mechanicalCoverage.find((a: any) => a.dimension === "metric");
      dim.established = "sensitivity 0.97 (95% CI 0.87 to 0.94)";
    });
    const result = await verifyDossier(forged, verifyOptions);
    const f = result.failures.find((x) => x.check === "findings.numbers");
    expect(f?.item).toBe("findings/f1/mechanicalCoverage/metric");
    expect(f?.reason).toMatch(/number 0\.97 in the established value/);
  });

  it("accepts a percent rendering of a fraction and a thousands separator", async () => {
    const forged = forge((body) => {
      const dim = body.findings[0].mechanicalCoverage.find((a: any) => a.dimension === "metric");
      dim.established = "sensitivity 91% (95% CI 87% to 94%), 412 patients";
    });
    expect((await verifyDossier(forged, verifyOptions)).failures.filter((f) => f.check === "findings.numbers")).toEqual([]);
  });

  it("fails an evidence result whose value is not in its anchor, and one with no anchor at all", async () => {
    const wrongValue = forge((body) => {
      body.evidenceItems.find((e: any) => e.id === "e-study").results[0].value = 0.97;
    });
    expect(failedItems(await verifyDossier(wrongValue, verifyOptions))).toContain("evidenceItems/e-study/results/sensitivity");
    const noAnchor = forge((body) => {
      const item = body.evidenceItems.find((e: any) => e.id === "e-study");
      delete item.results[0].anchorId;
      item.anchorIds = [];
    });
    const r = await verifyDossier(noAnchor, verifyOptions);
    expect(r.failures.find((f) => f.check === "evidence.numbers")?.reason).toBe("result has no anchor");
  });
});

describe("closed label set and review state", () => {
  it("fails a label outside the five, naming the label field", async () => {
    const forged = forge((body) => {
      body.findings[1].label = "SAFE";
    });
    const result = await verifyDossier(forged, verifyOptions);
    const f = result.failures.find((x) => x.check === "findings.label");
    expect(f?.item).toBe("findings/f2/label");
    expect(f?.reason).toMatch(/"SAFE" is not one of the five labels/);
  });

  it("fails a stored finding that carries a review state; the decision history holds it", async () => {
    const forged = forge((body) => {
      body.findings[0].reviewerState = "accepted";
    });
    const result = await verifyDossier(forged, verifyOptions);
    expect(failedItems(result)).toContain("findings/f1/reviewerState");
  });

  it("resets a review state on the way in, so the stored finding is the finding as computed", () => {
    const input = baseInput();
    input.findings[0] = { ...(input.findings[0] as any), reviewerState: "accepted" };
    expect(buildDossier(input, buildOptions()).body.findings[0]?.reviewerState).toBe("unreviewed");
  });
});

describe("signature and signer", () => {
  it("accepts a demo key without pins and says what that means", async () => {
    const result = await verifyDossier(viaJson(baseBundle()), verifyOptions);
    expect(result.signer?.keyStatus).toBe("demo");
    expect(result.signer?.pinned).toBeNull();
    expect(result.signer?.trust).toMatch(/says nothing about who signed it/);
  });

  it("confirms the signer when its key id is in the pinned set", async () => {
    const result = await verifyDossier(viaJson(baseBundle()), { ...verifyOptions, pinnedKeyIds: [seedSigner().keyId] });
    expect(result.ok).toBe(true);
    expect(result.signer?.pinned).toBe(true);
  });

  it("fails a bundle re-signed with a different key when a pinned set is given, and passes it without one", async () => {
    const attacker = createDemoSignerFromSeed(new Uint8Array(32).fill(66));
    const forged = forge(() => {}, attacker);
    expect((await verifyDossier(forged, verifyOptions)).ok).toBe(true); // internally consistent: integrity only
    const pinned = await verifyDossier(forged, { ...verifyOptions, pinnedKeyIds: [seedSigner().keyId] });
    expect(pinned.ok).toBe(false);
    expect(failedItems(pinned)).toEqual(["manifest/signing/keyId"]);
  });

  it("fails a signature made over a different manifest", async () => {
    const bundle = viaJson(baseBundle());
    bundle.signature.value = seedSigner().sign("something else");
    const result = await verifyDossier(bundle, verifyOptions);
    expect(failedItems(result)).toContain("signature");
  });

  it("fails an altered key id and a signature that is valid text for different bytes", async () => {
    const bundle = viaJson(baseBundle());
    bundle.manifest.signing.keyId = "0".repeat(64);
    expect(failedItems(await verifyDossier(bundle, verifyOptions))).toContain("manifest/signing/keyId");
  });

  it("does not let an ephemeral demo key be mistaken for a pinned one", () => {
    const eph = createEphemeralDemoSigner();
    expect(eph.keyStatus).toBe("demo");
    expect(buildDossier(baseInput(), { signer: eph, clock: fixedClock }).manifest.signing.keyStatus).toBe("demo");
  });
});

describe("integrity-only verification", () => {
  it("passes an intact bundle, lists what it did not run, and still catches a changed byte", async () => {
    const bundle = viaJson(baseBundle());
    const ok = await verifyIntegrity(bundle);
    expect(ok.ok).toBe(true);
    expect(ok.mode).toBe("integrity");
    expect(ok.skipped.length).toBeGreaterThan(10);
    bundle.body.run.mode = "live";
    expect(failedItems(await verifyIntegrity(bundle))).toEqual(["run"]);
  });

  it("cannot see a re-signed forgery, which is why it says it did not re-run the compiler", async () => {
    const forged = forge((body) => {
      body.findings[0].label = "SUPPORTED_FOR_SCOPE";
    });
    expect((await verifyIntegrity(forged)).ok).toBe(true);
    expect((await verifyDossier(forged, verifyOptions)).ok).toBe(false);
  });
});

describe("junk input", () => {
  it.each([undefined, null, 5, "text", [], {}, { format: "sakaime.dossier" }])("fails %j without throwing", async (junk) => {
    const result = await verifyDossier(junk, verifyOptions);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("fails an unsupported format version", async () => {
    const bundle = viaJson(baseBundle());
    bundle.formatVersion = "9.0.0";
    expect(failedItems(await verifyDossier(bundle, verifyOptions))).toContain("bundle/formatVersion");
  });
});
