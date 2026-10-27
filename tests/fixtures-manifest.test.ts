import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "data", "fixtures", "feasibility");

interface ManifestFile {
  file: string;
  source: string;
  httpStatus: number | null;
  bytes: number;
  sha256: string;
}
const manifest = JSON.parse(readFileSync(join(ROOT, "MANIFEST.json"), "utf8")) as { retrievedOn: string; files: ManifestFile[] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [relative(ROOT, full).replaceAll("\\", "/")];
  });
}

describe("tracked feasibility fixtures", () => {
  it("every file listed in the manifest exists with the recorded size and sha256", () => {
    for (const f of manifest.files) {
      const path = join(ROOT, f.file);
      expect(existsSync(path), `${f.file} is missing`).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.length, `${f.file} size`).toBe(f.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), `${f.file} sha256`).toBe(f.sha256);
    }
  });

  it("no file in the folder is missing from the manifest", () => {
    const listed = new Set(manifest.files.map((f) => f.file));
    const unlisted = walk(ROOT).filter((f) => f !== "MANIFEST.json" && !listed.has(f));
    expect(unlisted).toEqual([]);
  });

  it("every row names the public source it was fetched from, and the folder holds no full-text journal article", () => {
    for (const f of manifest.files) expect(f.source, f.file).toMatch(/^https:\/\//);
    expect(manifest.retrievedOn).toBe("2026-10-27");
    // The only PDF is the FDA De Novo decision summary (a US government work). Journal PDFs and PMC full texts are not kept.
    expect(manifest.files.filter((f) => /\.pdf$/i.test(f.file)).map((f) => f.file)).toEqual(["fda/DEN180001_denovo_summary.pdf"]);
    expect(manifest.files.some((f) => /(^|[/_])PMC\d+|fulltext/i.test(f.file))).toBe(false);
  });
});
