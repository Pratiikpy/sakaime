/**
 * Ed25519 signing keys for dossiers (node:crypto).
 *
 * Two kinds of key, and the bundle says which one signed it:
 *   pinned - the operator's own key, loaded from a PEM file, distributed out of band. A verifier that is given
 *            the key id can tell the bundle came from that key.
 *   demo   - an ephemeral key generated for this run (or a fixed-seed key for tests). Anyone can make one, so a
 *            demo signature shows the bundle is internally unchanged and nothing about who made it.
 *
 * A configured key that cannot be read is an error. The signer never falls back to a demo key in that case,
 * because a silent downgrade would turn a pinned dossier into an unattributable one without anyone noticing.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export type KeyStatus = "demo" | "pinned";

export interface DossierSigner {
  readonly keyId: string;
  readonly keyStatus: KeyStatus;
  /** Base64 of the raw 32-byte public key. */
  readonly publicKeyB64: string;
  /** Returns a base64 signature. */
  sign(message: string): string;
}

export const KEY_FILE_ENV = "SAKAIME_DOSSIER_KEY_FILE";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function rawPublicKey(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function keyIdOfPublicKey(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

function signerFrom(privateKey: KeyObject, keyStatus: KeyStatus): DossierSigner {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`dossier signer: expected an Ed25519 key, got ${privateKey.asymmetricKeyType ?? "unknown"}`);
  }
  const raw = rawPublicKey(privateKey);
  return {
    keyId: keyIdOfPublicKey(raw),
    keyStatus,
    publicKeyB64: raw.toString("base64"),
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

/** A fresh random key. Labelled demo: nothing about who holds it can be inferred from a signature it makes. */
export function createEphemeralDemoSigner(): DossierSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  return signerFrom(privateKey, "demo");
}

/**
 * A demo key derived from a 32-byte seed, for tests and for the committed sample dossier, where the same inputs must
 * give the same bytes. Ed25519 signing is deterministic, so a fixed seed and fixed inputs give a fixed signature.
 */
export function createDemoSignerFromSeed(seed: Uint8Array): DossierSigner {
  if (seed.length !== 32) throw new Error("dossier signer: a seed must be exactly 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return signerFrom(key, "demo");
}

/** Loads a pinned key from a PEM (PKCS#8) file. Throws if the file is missing, unreadable or not an Ed25519 key. */
export function loadPinnedSigner(path: string): DossierSigner {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`dossier signer: cannot read key file ${path}: ${(error as Error).message}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new Error(`dossier signer: ${path} is not a usable private key: ${(error as Error).message}`);
  }
  return signerFrom(key, "pinned");
}

export interface ResolveSignerOptions {
  /** Explicit key file. Takes precedence over the environment. */
  keyFile?: string;
  env?: Record<string, string | undefined>;
  /** When no key is configured: generate a demo key (true, default) or throw (false). */
  allowDemo?: boolean;
}

/**
 * Pinned key if one is configured (option or SAKAIME_DOSSIER_KEY_FILE), otherwise an ephemeral demo key.
 * With allowDemo false and nothing configured, throws instead of generating one.
 */
export function resolveSigner(options: ResolveSignerOptions = {}): DossierSigner {
  const env = options.env ?? process.env;
  const path = options.keyFile ?? env[KEY_FILE_ENV];
  if (path !== undefined && path !== "") return loadPinnedSigner(path);
  if (options.allowDemo === false) throw new Error(`dossier signer: no key configured (set ${KEY_FILE_ENV}) and demo keys are disabled`);
  return createEphemeralDemoSigner();
}

/** Writes nothing; returns a PEM for a new key so an operator can store it themselves. */
export function generateKeyPem(): { privateKeyPem: string; publicKeyB64: string; keyId: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKey(privateKey);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyB64: raw.toString("base64"),
    keyId: keyIdOfPublicKey(raw),
  };
}

/** Verifies a base64 Ed25519 signature against a base64 raw public key. Never throws on malformed input. */
export function verifySignature(message: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}
