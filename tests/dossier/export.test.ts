import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileExportLedger, createMemoryExportLedger, exportDossier, serializeDossier } from "../../src/dossier/index.ts";
import type { ExportOutcome, VerifyContractFn } from "../../src/dossier/index.ts";
import { baseBundle, forge, verifyOptions, viaJson } from "./helpers.ts";

/** A named test double for the Scout engine's contract check: accepts exactly one contract id. */
const scoutTestDouble: VerifyContractFn = (contract, expectation) => {
  const c = contract as { id?: string; intent?: string };
  if (c.intent !== expectation.intent) return { valid: false, reason: `contract is for ${String(c.intent)}` };
  return c.id === "contract-ok" ? { valid: true } : { valid: false, reason: "signature mismatch" };
};
const goodContract = { id: "contract-ok", intent: "export_dossier" };

const refused = (o: ExportOutcome) => (o.status === "refused" ? o : (() => { throw new Error("expected a refusal"); })());

describe("export guard", () => {
  it("refuses without a contract", async () => {
    const out = await exportDossier(baseBundle(), { verifyContract: scoutTestDouble, idempotencyKey: "k", ledger: createMemoryExportLedger() });
    expect(refused(out)).toMatchObject({ code: "NO_CONTRACT" });
    const nul = await exportDossier(baseBundle(), { contract: null, verifyContract: scoutTestDouble, idempotencyKey: "k", ledger: createMemoryExportLedger() });
    expect(refused(nul).code).toBe("NO_CONTRACT");
  });

  it("refuses a contract that nothing can check", async () => {
    const out = await exportDossier(baseBundle(), { contract: goodContract, idempotencyKey: "k", ledger: createMemoryExportLedger() });
    expect(refused(out).code).toBe("NO_CONTRACT_VERIFIER");
  });

  it("refuses a rejected contract with the verifier's reason, and a verifier that throws", async () => {
    const ledger = createMemoryExportLedger();
    const bad = await exportDossier(baseBundle(), { contract: { id: "forged", intent: "export_dossier" }, verifyContract: scoutTestDouble, idempotencyKey: "k", ledger });
    expect(refused(bad)).toMatchObject({ code: "CONTRACT_INVALID", reason: "the execution contract was rejected: signature mismatch" });
    const wrongIntent = await exportDossier(baseBundle(), { contract: { id: "contract-ok", intent: "explain_finding" }, verifyContract: scoutTestDouble, idempotencyKey: "k", ledger });
    expect(refused(wrongIntent).reason).toMatch(/contract is for explain_finding/);
    const boom = await exportDossier(baseBundle(), {
      contract: goodContract,
      verifyContract: () => {
        throw new Error("clock unavailable");
      },
      idempotencyKey: "k",
      ledger,
    });
    expect(refused(boom)).toMatchObject({ code: "CONTRACT_CHECK_FAILED", reason: "the contract could not be checked: clock unavailable" });
    expect(await ledger.get("k")).toBeUndefined();
  });

  it("a verifier that returns a bare false or an async result is handled", async () => {
    const ledger = createMemoryExportLedger();
    expect(refused(await exportDossier(baseBundle(), { contract: goodContract, verifyContract: () => false, idempotencyKey: "k", ledger })).code).toBe("CONTRACT_INVALID");
    const ok = await exportDossier(baseBundle(), { contract: goodContract, verifyContract: async () => true, idempotencyKey: "k", ledger });
    expect(ok.status).toBe("exported");
  });

  it("passes the dossier id and the export intent to the verifier", async () => {
    const seen: unknown[] = [];
    const bundle = baseBundle();
    await exportDossier(bundle, {
      contract: goodContract,
      verifyContract: (_c, e) => {
        seen.push(e);
        return true;
      },
      idempotencyKey: "k",
      ledger: createMemoryExportLedger(),
    });
    expect(seen).toEqual([{ intent: "export_dossier", dossierId: bundle.manifest.dossierId }]);
  });

  it("refuses an export with no idempotency key", async () => {
    const out = await exportDossier(baseBundle(), { contract: goodContract, verifyContract: scoutTestDouble, ledger: createMemoryExportLedger() });
    expect(refused(out).code).toBe("NO_IDEMPOTENCY_KEY");
    expect(refused(await exportDossier(baseBundle(), { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "   ", ledger: createMemoryExportLedger() })).code).toBe("NO_IDEMPOTENCY_KEY");
  });

  it("exports the bytes of a valid dossier with a valid contract", async () => {
    const bundle = baseBundle();
    const out = await exportDossier(bundle, { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger: createMemoryExportLedger() });
    expect(out).toMatchObject({ status: "exported", replayed: false, dossierId: bundle.manifest.dossierId });
    if (out.status === "exported") expect(out.contents).toBe(serializeDossier(bundle));
  });

  it("refuses a bundle that does not verify, with the failing item in the reason, and records no export", async () => {
    const ledger = createMemoryExportLedger();
    const tampered = viaJson(baseBundle());
    tampered.body.run.mode = "live";
    const out = refused(await exportDossier(tampered, { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "k", ledger }));
    expect(out.code).toBe("BUNDLE_INVALID");
    expect(out.reason).toMatch(/run: content changed since signing/);
    expect(ledger.get("k")).toBeUndefined();
  });

  it("with full verification supplied, also refuses a re-signed forgery that integrity alone cannot see", async () => {
    const forged = forge((b) => (b.findings[0].label = "SUPPORTED_FOR_SCOPE"));
    const integrityOnly = await exportDossier(forged, { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "a", ledger: createMemoryExportLedger() });
    expect(integrityOnly.status).toBe("exported");
    const full = await exportDossier(forged, { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "b", ledger: createMemoryExportLedger(), verify: verifyOptions });
    expect(refused(full).code).toBe("BUNDLE_INVALID");
  });

  it("refuses a bundle with no dossier id and junk input without throwing", async () => {
    for (const junk of [undefined, null, 4, {}, { manifest: {} }]) {
      const out = await exportDossier(junk, { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "k", ledger: createMemoryExportLedger() });
      expect(refused(out).code).toBe("BUNDLE_INVALID");
    }
  });
});

describe("export idempotency (C-17)", () => {
  it("a retry with the same key returns the same export id and records nothing new", async () => {
    const ledger = createMemoryExportLedger();
    const options = { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger };
    const a = await exportDossier(baseBundle(), options);
    const b = await exportDossier(baseBundle(), options);
    expect(a).toMatchObject({ status: "exported", replayed: false });
    expect(b).toMatchObject({ status: "exported", replayed: true });
    if (a.status === "exported" && b.status === "exported") expect(b.exportId).toBe(a.exportId);
  });

  it("the same key for a different dossier is refused", async () => {
    const ledger = createMemoryExportLedger();
    const options = { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger };
    await exportDossier(baseBundle(), options);
    const other = forge((b) => (b.run.note = "another run"));
    expect(refused(await exportDossier(other, options)).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("a replay still needs a live contract: an expired contract releases nothing", async () => {
    const ledger = createMemoryExportLedger();
    await exportDossier(baseBundle(), { contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger });
    const replay = await exportDossier(baseBundle(), { contract: { id: "expired", intent: "export_dossier" }, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger });
    expect(refused(replay).code).toBe("CONTRACT_INVALID");
  });

  describe("durable ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "sakaime-ledger-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("survives a restart: a second process reading the same file sees the export as already done", async () => {
      const path = join(dir, "exports.jsonl");
      const options = (ledger: ReturnType<typeof createFileExportLedger>) => ({ contract: goodContract, verifyContract: scoutTestDouble, idempotencyKey: "export-1", ledger });
      const first = await exportDossier(baseBundle(), options(createFileExportLedger(path)));
      const afterRestart = await exportDossier(baseBundle(), options(createFileExportLedger(path)));
      expect(first).toMatchObject({ replayed: false });
      expect(afterRestart).toMatchObject({ replayed: true });
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    });
  });
});
