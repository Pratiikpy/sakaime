import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../../src/service/config.ts";

const NAMES = ["SAKAIME_TEST_PORT", "SAKAIME_TEST_API_KEY", "SAKAIME_TEST_ONLY_IN_FILE", "SAKAIME_NO_ENV"];

describe("loadDotEnv", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sakaime-env-"));
    for (const n of NAMES) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
  });

  afterEach(() => {
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const writeEnv = (text: string): void => writeFileSync(join(dir, ".env"), text);

  it("lets a setting already in the shell win, so a port or mode can be chosen per run", () => {
    process.env["SAKAIME_TEST_PORT"] = "8830";
    writeEnv("SAKAIME_TEST_PORT=8787\n");
    loadDotEnv(dir);
    expect(process.env["SAKAIME_TEST_PORT"]).toBe("8830");
  });

  it("replaces a stale credential in the shell with the project's own", () => {
    process.env["SAKAIME_TEST_API_KEY"] = "stale-key";
    writeEnv("SAKAIME_TEST_API_KEY=project-key\n");
    loadDotEnv(dir);
    expect(process.env["SAKAIME_TEST_API_KEY"]).toBe("project-key");
  });

  it("never replaces a working credential with an empty placeholder", () => {
    process.env["SAKAIME_TEST_API_KEY"] = "working-key";
    writeEnv("SAKAIME_TEST_API_KEY=\n");
    loadDotEnv(dir);
    expect(process.env["SAKAIME_TEST_API_KEY"]).toBe("working-key");
  });

  it("fills a value that is only in the file, and does nothing without a file or with SAKAIME_NO_ENV", () => {
    writeEnv("SAKAIME_TEST_ONLY_IN_FILE=yes\n");
    loadDotEnv(dir);
    expect(process.env["SAKAIME_TEST_ONLY_IN_FILE"]).toBe("yes");

    delete process.env["SAKAIME_TEST_ONLY_IN_FILE"];
    process.env["SAKAIME_NO_ENV"] = "1";
    loadDotEnv(dir);
    expect(process.env["SAKAIME_TEST_ONLY_IN_FILE"]).toBeUndefined();

    delete process.env["SAKAIME_NO_ENV"];
    expect(() => loadDotEnv(join(dir, "missing"))).not.toThrow();
  });
});
