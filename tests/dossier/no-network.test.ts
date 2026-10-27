/**
 * The dossier module never sends anything (F6: requests are never sent automatically). This reads the module's own
 * source and fails if it imports a network, process or dynamic-code API, or uses a network global.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dir = resolve(import.meta.dirname, "../../src/dossier");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

const FORBIDDEN_MODULES = ["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:dns", "node:child_process", "node:cluster", "node:worker_threads", "node:vm", "undici", "axios", "node-fetch", "ws", "nodemailer", "http", "https", "net", "tls", "dgram", "dns", "child_process"];
const FORBIDDEN_GLOBALS = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bnavigator\.sendBeacon\b/, /\bprocess\.(exit|kill)\b/, /\beval\s*\(/, /new Function\s*\(/, /\bimport\s*\(\s*["'`](?!node:crypto)/];

describe("src/dossier has no network or process code", () => {
  it("scans the module's files", () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  it.each(files)("%s imports no network, process or dynamic-code module and uses no network global", (file) => {
    const source = readFileSync(resolve(dir, file), "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
    for (const spec of specifiers) expect(FORBIDDEN_MODULES, `${file} imports ${spec}`).not.toContain(spec);
    for (const re of FORBIDDEN_GLOBALS) expect(source, `${file} matches ${re}`).not.toMatch(re);
  });

  it("only touches the filesystem in the two places that need it: the key loader and the export ledger", () => {
    const users = files.filter((f) => /node:fs/.test(readFileSync(resolve(dir, f), "utf8")));
    expect(users.sort()).toEqual(["export.ts", "signer.ts"]);
  });

  it("imports nothing from the compiler: it is injected, not imported", () => {
    for (const file of files) expect(readFileSync(resolve(dir, file), "utf8"), file).not.toMatch(/from\s+["'][^"']*\/compiler\//);
  });
});
