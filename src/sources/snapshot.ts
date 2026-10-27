/**
 * Pinned snapshots: a hashed copy of a source that refuses scripted access.
 *
 * The FDA AI-enabled device list sits behind bot protection (scripted requests are redirected to an abuse
 * page), so the CSV was fetched once in a real browser session and pinned. A snapshot is not the live source:
 * it carries its capture date and the source's own "current as of" date, it is always reported as a stale
 * snapshot, and a row missing from it means "not in the snapshot dated D", never "not on the FDA list".
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Sha256 } from "../schemas/evidence.ts";
import { sha256Hex } from "../util/canonical.ts";

export const SnapshotManifestSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  sha256: Sha256,
  bytes: z.number().int().positive(),
  sourceUrl: z.string().url(),
  /** Day the bytes were captured. */
  capturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  capturedBy: z.string().min(1),
  /** The server's Last-Modified for the captured file. */
  sourceLastModified: z.string().datetime(),
  /** The date the source page states its content is current as of. */
  contentCurrentAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rows: z.number().int().positive(),
  columns: z.array(z.string()).min(1),
  notes: z.array(z.string()).default([]),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

export interface LoadedSnapshot {
  manifest: SnapshotManifest;
  bytes: Uint8Array;
}

/** Load a snapshot and verify its bytes against the manifest. Fails loudly on any mismatch. */
export function loadSnapshot(manifestPath: string): LoadedSnapshot {
  if (!fs.existsSync(manifestPath)) throw new SnapshotIntegrityError(`snapshot manifest not found: ${manifestPath}`);
  const parsed = SnapshotManifestSchema.safeParse(parseYaml(fs.readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new SnapshotIntegrityError(`snapshot manifest is malformed: ${issue.path.join(".")} ${issue.message}`);
  }
  const manifest = parsed.data;
  const file = path.join(path.dirname(manifestPath), manifest.file);
  if (!fs.existsSync(file)) throw new SnapshotIntegrityError(`snapshot file not found: ${file}`);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const actual = sha256Hex(bytes);
  if (actual !== manifest.sha256) throw new SnapshotIntegrityError(`snapshot ${manifest.id} hashes to ${actual}; the manifest pins ${manifest.sha256}`);
  if (bytes.length !== manifest.bytes) throw new SnapshotIntegrityError(`snapshot ${manifest.id} is ${bytes.length} bytes; the manifest says ${manifest.bytes}`);
  return { manifest, bytes };
}
