/**
 * Manifest construction shared by the builder and the verifier, so both hash the same things in the same way.
 *
 * Granularity: a singleton section is one leaf; a list section has one leaf per item, named by the item's id.
 * That is what lets the verifier say "findings/f-12 changed" rather than "something changed".
 */
import { canonicalJson, hashOf } from "../util/canonical.ts";
import { SECTIONS } from "./schema.ts";
import type { SectionEntry, SectionSpec } from "./schema.ts";

export function sectionEntryFor(spec: SectionSpec, raw: unknown): SectionEntry {
  if (spec.kind === "singleton") return { kind: "singleton", sha256: hashOf(raw) };
  if (!Array.isArray(raw)) throw new TypeError(`section ${spec.name} must be a list`);
  const items = raw.map((item, index) => {
    const id = spec.idOf?.(item);
    if (id === undefined) throw new TypeError(`section ${spec.name}[${index}] has no usable id`);
    return { id, sha256: hashOf(item) };
  });
  return { kind: "list", items };
}

export function buildManifestSections(body: Record<string, unknown>): Record<string, SectionEntry> {
  const out: Record<string, SectionEntry> = {};
  for (const spec of SECTIONS) out[spec.name] = sectionEntryFor(spec, body[spec.name]);
  return out;
}

/** The root commits to the full listing: every section, every item id, every item hash. */
export function rootOf(sections: Record<string, unknown>): string {
  return hashOf(sections);
}

/** The exact string that is signed: canonical JSON of the whole manifest. */
export function manifestMessage(manifest: unknown): string {
  return canonicalJson(manifest);
}
