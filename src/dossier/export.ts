/**
 * Export guard (F10, C-17).
 *
 * A dossier leaves the system only with a valid signed execution contract. This module does not mint or parse
 * contracts: the Scout engine owns the format and supplies `verifyContract`. Every refusal is a returned value,
 * never a thrown error, so a caller cannot mistake a failure for an exported dossier. The guard fails closed:
 * no contract, no verifier, a verifier that throws, or a contract the verifier rejects all refuse.
 *
 * The contract is checked on every call, replays included. A retry after a crash therefore needs a live contract
 * (Scout refreshes one by parent id); an expired contract never releases bytes just because the key was seen before.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { sha256Hex } from "../util/canonical.ts";
import { serializeDossier } from "./build.ts";
import { verifyDossier, verifyIntegrity } from "./verify.ts";
import type { VerifyOptions, VerifyResult } from "./verify.ts";

export interface ContractVerdict {
  valid: boolean;
  reason?: string;
}

export interface ContractExpectation {
  intent: "export_dossier";
  dossierId: string;
}

/** Provided by the Scout engine. May be synchronous or asynchronous. */
export type VerifyContractFn = (contract: unknown, expectation: ContractExpectation) => ContractVerdict | boolean | Promise<ContractVerdict | boolean>;

export interface ExportRecord {
  idempotencyKey: string;
  exportId: string;
  dossierId: string;
  /** Manifest root of the exported bundle. */
  root: string;
}

export interface ExportLedger {
  get(idempotencyKey: string): ExportRecord | undefined;
  put(record: ExportRecord): void;
}

export function createMemoryExportLedger(): ExportLedger {
  const map = new Map<string, ExportRecord>();
  return { get: (k) => map.get(k), put: (r) => void map.set(r.idempotencyKey, r) };
}

/** One JSON object per line, appended on each new export. Survives a restart, so a resumed run does not export twice. */
export function createFileExportLedger(path: string): ExportLedger {
  const map = new Map<string, ExportRecord>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const r = JSON.parse(line) as ExportRecord;
      map.set(r.idempotencyKey, r);
    }
  }
  return {
    get: (k) => map.get(k),
    put: (r) => {
      appendFileSync(path, `${JSON.stringify(r)}\n`, "utf8");
      map.set(r.idempotencyKey, r);
    },
  };
}

export type ExportRefusalCode =
  | "NO_CONTRACT"
  | "NO_CONTRACT_VERIFIER"
  | "CONTRACT_INVALID"
  | "CONTRACT_CHECK_FAILED"
  | "NO_IDEMPOTENCY_KEY"
  | "BUNDLE_INVALID"
  | "IDEMPOTENCY_CONFLICT";

export type ExportOutcome =
  | { status: "exported"; exportId: string; dossierId: string; contents: string; replayed: boolean }
  | { status: "refused"; code: ExportRefusalCode; reason: string; verification?: VerifyResult };

export interface ExportOptions {
  /** The signed execution contract authorising this export. */
  contract?: unknown;
  verifyContract?: VerifyContractFn;
  /** Required: a retried export with the same key returns the same export and records nothing new. */
  idempotencyKey?: string;
  ledger: ExportLedger;
  /** When given, the bundle is fully verified (including the compiler re-run) before release; otherwise integrity only. */
  verify?: VerifyOptions;
  /** Used for integrity-only verification. */
  pinnedKeyIds?: readonly string[];
}

const refuse = (code: ExportRefusalCode, reason: string, verification?: VerifyResult): ExportOutcome => ({ status: "refused", code, reason, ...(verification ? { verification } : {}) });

export async function exportDossier(bundle: unknown, options: ExportOptions): Promise<ExportOutcome> {
  if (options.contract === undefined || options.contract === null) {
    return refuse("NO_CONTRACT", "export needs a signed execution contract; none was supplied");
  }
  if (!options.verifyContract) {
    return refuse("NO_CONTRACT_VERIFIER", "a contract was supplied but there is no verifier to check it, so it cannot be trusted");
  }
  const key = options.idempotencyKey?.trim();
  if (!key) return refuse("NO_IDEMPOTENCY_KEY", "export needs an idempotency key so a retry cannot release the dossier twice");

  const dossierId = typeof bundle === "object" && bundle !== null ? (bundle as { manifest?: { dossierId?: unknown } }).manifest?.dossierId : undefined;
  if (typeof dossierId !== "string" || dossierId === "") return refuse("BUNDLE_INVALID", "the bundle has no dossier id");

  let verdict: ContractVerdict | boolean;
  try {
    verdict = await options.verifyContract(options.contract, { intent: "export_dossier", dossierId });
  } catch (error) {
    return refuse("CONTRACT_CHECK_FAILED", `the contract could not be checked: ${(error as Error).message}`);
  }
  const valid = typeof verdict === "boolean" ? verdict : verdict.valid === true;
  if (!valid) {
    const why = typeof verdict === "object" && verdict.reason ? `: ${verdict.reason}` : "";
    return refuse("CONTRACT_INVALID", `the execution contract was rejected${why}`);
  }

  const verification = options.verify ? await verifyDossier(bundle, options.verify) : await verifyIntegrity(bundle, options.pinnedKeyIds ? { pinnedKeyIds: options.pinnedKeyIds } : {});
  if (!verification.ok) {
    const first = verification.failures[0];
    return refuse("BUNDLE_INVALID", `the bundle does not verify${first ? `: ${first.item}: ${first.reason}` : ""}`, verification);
  }

  const root = (bundle as { manifest: { root: string } }).manifest.root;
  const prior = options.ledger.get(key);
  if (prior) {
    if (prior.root !== root || prior.dossierId !== dossierId) {
      return refuse("IDEMPOTENCY_CONFLICT", `idempotency key ${key} was already used to export a different dossier`);
    }
    return { status: "exported", exportId: prior.exportId, dossierId, contents: serializeDossier(bundle), replayed: true };
  }
  const exportId = `export-${sha256Hex(`${key}|${root}`).slice(0, 32)}`;
  options.ledger.put({ idempotencyKey: key, exportId, dossierId, root });
  return { status: "exported", exportId, dossierId, contents: serializeDossier(bundle), replayed: false };
}
