import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KEY_FILE_ENV,
  buildDossier,
  createDemoSignerFromSeed,
  createEphemeralDemoSigner,
  generateKeyPem,
  keyIdOfPublicKey,
  loadPinnedSigner,
  resolveSigner,
  verifyDossier,
  verifySignature,
} from "../../src/dossier/index.ts";
import { baseInput, fixedClock, verifyOptions } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "sakaime-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("signers", () => {
  it("an ephemeral key is a demo key, different every time", () => {
    const a = createEphemeralDemoSigner();
    const b = createEphemeralDemoSigner();
    expect(a.keyStatus).toBe("demo");
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.keyId).toBe(keyIdOfPublicKey(Buffer.from(a.publicKeyB64, "base64")));
  });

  it("a seeded key is a demo key and reproducible; signatures are deterministic", () => {
    const seed = new Uint8Array(32).fill(3);
    const a = createDemoSignerFromSeed(seed);
    const b = createDemoSignerFromSeed(seed);
    expect(a.keyId).toBe(b.keyId);
    expect(a.sign("m")).toBe(b.sign("m"));
    expect(a.keyStatus).toBe("demo");
    expect(() => createDemoSignerFromSeed(new Uint8Array(31))).toThrow(/exactly 32 bytes/);
  });

  it("signatures verify with the public key and with nothing else", () => {
    const a = createDemoSignerFromSeed(new Uint8Array(32).fill(1));
    const other = createDemoSignerFromSeed(new Uint8Array(32).fill(2));
    const sig = a.sign("message");
    expect(verifySignature("message", sig, a.publicKeyB64)).toBe(true);
    expect(verifySignature("message!", sig, a.publicKeyB64)).toBe(false);
    expect(verifySignature("message", sig, other.publicKeyB64)).toBe(false);
  });

  it("verifySignature never throws on junk", () => {
    expect(verifySignature("m", "not base64 !!", "also not")).toBe(false);
    expect(verifySignature("m", "", "")).toBe(false);
    expect(verifySignature("m", Buffer.alloc(64).toString("base64"), Buffer.alloc(31).toString("base64"))).toBe(false);
  });

  it("loads a pinned key from a PEM file and labels it pinned", () => {
    const { privateKeyPem, keyId } = generateKeyPem();
    const path = join(dir, "dossier-key.pem");
    writeFileSync(path, privateKeyPem);
    const signer = loadPinnedSigner(path);
    expect(signer.keyStatus).toBe("pinned");
    expect(signer.keyId).toBe(keyId);
  });

  it("a configured key that cannot be used is an error, never a quiet fall back to a demo key", () => {
    expect(() => resolveSigner({ keyFile: join(dir, "missing.pem") })).toThrow(/cannot read key file/);
    const junk = join(dir, "junk.pem");
    writeFileSync(junk, "not a key");
    expect(() => resolveSigner({ keyFile: junk })).toThrow(/not a usable private key/);
    expect(() => resolveSigner({ env: { [KEY_FILE_ENV]: join(dir, "missing.pem") } })).toThrow(/cannot read key file/);
  });

  it("rejects a key that is not Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const path = join(dir, "rsa.pem");
    writeFileSync(path, rsa);
    expect(() => loadPinnedSigner(path)).toThrow(/expected an Ed25519 key, got rsa/);
  });

  it("resolves: option first, then the environment, then a demo key; or refuses when demo keys are off", () => {
    const { privateKeyPem, keyId } = generateKeyPem();
    const path = join(dir, "resolve.pem");
    writeFileSync(path, privateKeyPem);
    expect(resolveSigner({ keyFile: path, env: {} }).keyId).toBe(keyId);
    expect(resolveSigner({ env: { [KEY_FILE_ENV]: path } }).keyStatus).toBe("pinned");
    expect(resolveSigner({ env: {} }).keyStatus).toBe("demo");
    expect(resolveSigner({ env: { [KEY_FILE_ENV]: "" } }).keyStatus).toBe("demo");
    expect(() => resolveSigner({ env: {}, allowDemo: false })).toThrow(/no key configured/);
  });
});

describe("what the bundle says about its key", () => {
  it("a pinned key is stated as pinned inside the signed manifest, and verifies against its own key id", async () => {
    const { privateKeyPem } = generateKeyPem();
    const path = join(dir, "bundle.pem");
    writeFileSync(path, privateKeyPem);
    const signer = loadPinnedSigner(path);
    const bundle = buildDossier(baseInput(), { signer, clock: fixedClock });
    expect(bundle.manifest.signing).toMatchObject({ keyStatus: "pinned", keyId: signer.keyId, algorithm: "Ed25519" });
    const result = await verifyDossier(JSON.parse(JSON.stringify(bundle)), { ...verifyOptions, pinnedKeyIds: [signer.keyId] });
    expect(result.ok).toBe(true);
    expect(result.signer).toMatchObject({ keyStatus: "pinned", pinned: true });
    // without the pin set the claim cannot be confirmed, and the result says so
    const unconfirmed = await verifyDossier(JSON.parse(JSON.stringify(bundle)), verifyOptions);
    expect(unconfirmed.signer?.trust).toMatch(/no pinned set was supplied to confirm it/);
  });

  it("a demo key is stated as demo and the wording says integrity only", () => {
    const bundle = buildDossier(baseInput(), { signer: createEphemeralDemoSigner(), clock: fixedClock });
    expect(bundle.manifest.signing.keyStatus).toBe("demo");
    expect(bundle.manifest.signing.statement).toMatch(/demo key does not identify who signed/);
  });
});
