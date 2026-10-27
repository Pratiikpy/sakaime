// Polite read-only fetch that saves the body and appends one line to raw/_requests.jsonl (url, date, status, bytes, sha256).
// Usage: node fetch.mjs <url> <out path relative to evals/gate0> [--accept=<mime>]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [url, rel, ...flags] = process.argv.slice(2);
const accept = (flags.find((f) => f.startsWith("--accept=")) || "").slice(9);
const res = await fetch(url, {
  headers: { "user-agent": "sakaime-gate0/1.0 (read-only research)", ...(accept ? { accept } : {}) },
  redirect: "follow",
});
const body = Buffer.from(await res.arrayBuffer());
const sha256 = createHash("sha256").update(body).digest("hex");
const out = join(root, rel);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
appendFileSync(
  join(root, "raw", "_requests.jsonl"),
  JSON.stringify({ url, file: rel, retrieved: new Date().toISOString().slice(0, 10), status: res.status, bytes: body.length, sha256 }) + "\n",
);
console.log(res.status, body.length, sha256, rel);
