import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../../src/identity/default-model.ts";
import { loadCorpus, type Corpus } from "../../src/identity/corpus.ts";
import { resolveDeterministic, type LinkResolution } from "../../src/identity/resolver.ts";
import type { LinkType } from "../../src/schemas/index.ts";
import type { IdentityRecord, IdentityRecordInput } from "../../src/identity/types.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(REPO, "data", "fixtures", "feasibility");

let cached: Corpus | undefined;
export function corpus(): Corpus {
  cached ??= loadCorpus();
  return cached;
}

export function rec(id: string): IdentityRecord {
  const r = corpus().records.get(id);
  if (!r) throw new Error(`no corpus record ${id}`);
  return r.record;
}

export const MODEL = DEFAULT_MODEL;

export function resolve2(a: IdentityRecordInput | string, b: IdentityRecordInput | string, linkType: LinkType, knownRecords?: IdentityRecord[]): LinkResolution {
  const ra = typeof a === "string" ? rec(a) : a;
  const rb = typeof b === "string" ? rec(b) : b;
  return resolveDeterministic(ra, rb, linkType, { model: MODEL, ...(knownRecords ? { knownRecords } : {}) });
}

export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

/** A minimal valid record for property tests and junk tests. */
export function blank(overrides: Partial<IdentityRecordInput> & { id: string }): IdentityRecordInput {
  return { kind: "AuthorizationSubmission", source: "test", ...overrides };
}
