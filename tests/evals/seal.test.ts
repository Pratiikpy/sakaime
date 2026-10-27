import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVALS } from "../../evals/lib/core.ts";
import { SealBrokenError, currentHashes, verifySeal } from "../../evals/lib/seal.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sakaime-seal-"));
  for (const f of ["claims.jsonl", "key.json", "seal.json"]) cpSync(join(EVALS, "heldout", f), join(dir, f));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the held-out seal", () => {
  it("holds for the committed files", () => {
    const seal = verifySeal();
    expect(Object.keys(seal.files).sort()).toEqual(["claims.jsonl", "key.json"]);
    expect(seal.files["key.json"]).toBe(currentHashes()["key.json"]);
  });

  it("is the hash written in SEALED.md", () => {
    const md = readFileSync(join(EVALS, "SEALED.md"), "utf8");
    const seal = verifySeal();
    expect(md).toContain(seal.files["claims.jsonl"] as string);
    expect(md).toContain(seal.files["key.json"] as string);
  });

  it("fails when one byte of the key changes", () => {
    const path = join(dir, "key.json");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace('"SUPPORTED_FOR_SCOPE"', '"INSUFFICIENT_EVIDENCE"'));
    expect(() => verifySeal(dir)).toThrow(SealBrokenError);
    try {
      verifySeal(dir);
    } catch (e) {
      expect((e as SealBrokenError).differences.join(" ")).toContain("key.json");
    }
  });

  it("fails when a label is moved without touching anything else (a trailing space is enough)", () => {
    const path = join(dir, "key.json");
    writeFileSync(path, readFileSync(path, "utf8") + " ");
    expect(() => verifySeal(dir)).toThrow(SealBrokenError);
  });

  it("fails when a case input changes", () => {
    const path = join(dir, "claims.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("HO-CA-01", "HO-CA-99"));
    expect(() => verifySeal(dir)).toThrow(/claims\.jsonl/);
  });

  it("fails when there is no seal at all", () => {
    rmSync(join(dir, "seal.json"));
    expect(() => verifySeal(dir)).toThrow(/not been sealed/);
  });

  it("the held-out loader refuses to hand out cases when the seal is broken", async () => {
    // loadHeldoutCases reads the committed directory, which is intact; the broken copy is rejected by verifySeal above.
    const { loadHeldoutCases } = await import("../../evals/lib/cases.ts");
    const { cases, keyHash } = loadHeldoutCases();
    expect(cases).toHaveLength(20);
    expect(keyHash).toBe(verifySeal().files["key.json"]);
  });
});
