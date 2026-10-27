import { describe, expect, it } from "vitest";
import { renderJudgeReport, renderVerifyResult, verifyDossier } from "../../src/dossier/index.ts";
import { baseBundle, forge, verifyOptions, viaJson } from "./helpers.ts";

const BANNED = /\b(best|proof|guaranteed|accurate|production-ready|state-of-the-art|validated)\b/i;

describe("judge report", () => {
  it("prints PASS per claim, the recorded label, the signer, and what was not run", async () => {
    const bundle = viaJson(baseBundle());
    const result = await verifyDossier(bundle, verifyOptions);
    expect(renderJudgeReport(bundle, result)).toMatchInlineSnapshot(`
      "Sakaime dossier check
      ------------------------------------------------------------------------------
      Dossier  ${bundle.manifest.dossierId}
      Signer   demo key ${bundle.manifest.signing.keyId.slice(0, 16)}: demo key: shows the bundle is unchanged since signing, says nothing about who signed it
      Mode     full: hashes, signature, quotes, numbers, compiler re-run
      Result   PASS

      Claims
        PASS  c1   recorded: SUPPORTED_ONLY_FOR_NARROWER_SCOPE (f1)
        PASS  c2   recorded: INSUFFICIENT_EVIDENCE (f2)
        2 of 2 claims pass

      Not run
        receipts.verify: no receipt verifier supplied: receipt signatures, key ids and hashes were not checked

      PASS means the recorded finding for that claim can be reproduced from the stored inputs and nothing in the bundle changed.
      It is not a judgement that the claim is true. A signature shows integrity, never clinical truth."
    `);
  });

  it("fails only the claim a re-signed edit touched, and shows the reason under it", async () => {
    const bundle = forge((b) => (b.findings[1].label = "SUPPORTED_FOR_SCOPE"));
    const result = await verifyDossier(bundle, verifyOptions);
    const text = renderJudgeReport(bundle, result);
    expect(text).toMatch(/PASS {2}c1 /);
    expect(text).toMatch(/FAIL {2}c2 {3}recorded: SUPPORTED_FOR_SCOPE \(f2\)/);
    expect(text).toContain("findings/f2/label: recorded SUPPORTED_FOR_SCOPE, but the compiler on the recorded inputs gives INSUFFICIENT_EVIDENCE");
    expect(text).toContain("1 of 2 claims pass");
    expect(text).toMatch(/Result {3}FAIL/);
  });

  it("fails every claim when the failure is dossier-wide (a broken signature)", async () => {
    const bundle = viaJson(baseBundle());
    bundle.signature.value = "AAAA";
    const text = renderJudgeReport(bundle, await verifyDossier(bundle, verifyOptions));
    expect(text).toMatch(/FAIL {2}c1 /);
    expect(text).toMatch(/FAIL {2}c2 /);
    expect(text).toContain("Dossier-level problems");
    expect(text).toContain("0 of 2 claims pass");
  });

  it("reports a damaged bundle without throwing", async () => {
    for (const junk of [null, 7, {}, { body: { claims: "x" } }, { body: { claims: [{ id: 1 }, null] } }]) {
      const result = await verifyDossier(junk, verifyOptions);
      const text = renderJudgeReport(junk, result);
      expect(text).toMatch(/Result {3}FAIL/);
      expect(text).toContain("(no readable claims in this bundle)");
    }
  });

  it("shows the current finding when a claim has been recomputed, not the superseded one", async () => {
    const bundle = viaJson(baseBundle());
    const result = await verifyDossier(bundle, verifyOptions);
    bundle.body.findings.push({ ...bundle.body.findings[0], id: "f1b", label: "SUPPORTED_FOR_SCOPE", supersedes: "f1", supersedesReason: "x" });
    expect(renderJudgeReport(bundle, result)).toContain("PASS  c1   recorded: SUPPORTED_FOR_SCOPE (f1b)");
  });

  it("is deterministic: the same inputs render the same bytes, with no timestamps or paths", async () => {
    const bundle = viaJson(baseBundle());
    const a = renderJudgeReport(bundle, await verifyDossier(bundle, verifyOptions));
    const b = renderJudgeReport(bundle, await verifyDossier(bundle, verifyOptions));
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T|[A-Z]:\\|\/Users\//);
  });

  it("uses no banned wording", async () => {
    const bundle = forge((b) => (b.findings[0].label = "SUPPORTED_FOR_SCOPE"));
    const result = await verifyDossier(bundle, verifyOptions);
    expect(renderJudgeReport(bundle, result)).not.toMatch(BANNED);
    expect(renderVerifyResult(result)).not.toMatch(BANNED);
  });
});

describe("verify result rendering", () => {
  it("lists every check with its status and then each failure with its item and reason", async () => {
    const bundle = viaJson(baseBundle());
    bundle.body.run.mode = "live";
    const text = renderVerifyResult(await verifyDossier(bundle, verifyOptions));
    expect(text).toMatch(/^Dossier verification \(full\): FAIL/);
    expect(text).toMatch(/FAIL +manifest\.items +1 problem found/);
    expect(text).toContain("Failures\n  run\n    content changed since signing (hash mismatch)");
    expect(text).toMatch(/SKIPPED receipts\.verify/);
  });
});
