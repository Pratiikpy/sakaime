import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendor = path.join(root, "third_party", "meterless");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Content as git stores it: LF line endings, so the hashes agree whatever a checkout did to them. */
const normalised = (file: string): Buffer => Buffer.from(fs.readFileSync(file).toString("latin1").replace(/\r\n/g, "\n"), "latin1");

describe("the vendored Meterless references are unmodified", () => {
  const rows = fs
    .readFileSync(path.join(vendor, "PROVENANCE.md"), "utf8")
    .split("\n")
    .map((l) => /^\| `([^`]+)` \| `([^`]+)` \| ([0-9a-f]{12}) \| ([0-9a-f]{64}) \| (.+) \|$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[1]!, blob: m[3]!, sha256: m[4]!, status: m[5]! }));

  it("the record lists every vendored file and nothing else", () => {
    const onDisk = walk(vendor)
      .map((f) => path.relative(vendor, f).split(path.sep).join("/"))
      .filter((f) => f !== "PROVENANCE.md" && f !== "NOTICE.md")
      .sort();
    expect(rows.map((r) => r.file).sort()).toEqual(onDisk);
    expect(rows.length).toBeGreaterThan(50);
  });

  it("each file still has the recorded SHA-256 and git blob hash, and matched upstream when it was recorded", () => {
    for (const r of rows) {
      const body = normalised(path.join(vendor, r.file));
      expect(createHash("sha256").update(body).digest("hex"), `${r.file} sha256`).toBe(r.sha256);
      const blob = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
      expect(blob.startsWith(r.blob), `${r.file} git blob`).toBe(true);
      expect(["match", "root LICENSE of the upstream repository"], `${r.file} upstream status`).toContain(r.status);
    }
  });

  it("the licence and the notice are present, and the runners are the sponsor's (no Sakaime edits)", () => {
    expect(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8")).toMatch(/Apache License[\s\S]*Version 2\.0/);
    expect(fs.readFileSync(path.join(vendor, "NOTICE.md"), "utf8")).toMatch(/Copyright 2026 Meterless/);
    for (const engine of ["hmem", "world-model"]) {
      const runner = fs.readFileSync(path.join(vendor, engine, "conformance", "runner.ts"), "utf8");
      expect(runner).not.toMatch(/sakaime/i);
    }
  });
});
