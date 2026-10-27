import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(import.meta.dirname, "..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("metadata.json", () => {
  const metadata = read("metadata.json") as Record<string, unknown>;

  it("follows the community draft schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const validate = ajv.compile(read("docs/schemas/community-metadata.schema.json") as object);
    const ok = validate(metadata);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("lists only paths that exist", () => {
    const paths: string[] = [];
    const walk = (value: unknown, key = ""): void => {
      if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string" && ["where", "evidence", "decisions"].includes(key)) paths.push(v);
          else walk(v, key);
        }
      } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, k);
      }
    };
    walk(metadata);
    paths.push(String(metadata["evidence_logs"]));
    const missing = paths.filter((p) => !existsSync(join(root, p)));
    expect(missing).toEqual([]);
  });

  it("states the sponsors honestly: Cursor unused, Nightshift not claimed as the recorded route", () => {
    const sponsors = metadata["sponsors"] as Record<string, { status: string; provider?: string }>;
    expect(sponsors["cursor"]?.status).toBe("planned");
    expect(sponsors["meterless"]?.provider).toBe("none");
  });
});
