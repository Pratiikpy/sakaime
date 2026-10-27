// Constat arm: one device_evidence_lookup call per distinct K/DEN number, anonymous, serial, 25 s apart.
// Published limit: 10 work units per minute, 50 per day. A first run at 8 s spacing was refused after six calls
// (minute_work_units_exceeded, retry_after_seconds 60), so one lookup costs more than one unit. The spacing was
// widened, and a refusal is honoured by waiting the stated time, never by retrying early or rotating anything.
// Terms (constat.dev/terms, updated 2026-07-11, s.2) allow querying the MCP endpoint within its limits for
// internal evaluation; s.3 forbids republishing the parsed output, so raw bodies stay in arms/constat/raw
// (gitignored) and only their sha256 is committed.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devices = process.argv.slice(2);
const rawDir = join(root, "arms", "constat", "raw");
mkdirSync(rawDir, { recursive: true });
const log = (entry) => appendFileSync(join(root, "arms", "constat", "calls.jsonl"), JSON.stringify(entry) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sseData = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
};

let id = 100;
for (const k of devices) {
  const out = join(rawDir, `${k}.sse`);
  if (existsSync(out)) {
    console.log(k, "already cached, no call made");
    continue;
  }
  const body = { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "device_evidence_lookup", arguments: { k_number: k } } };
  let res;
  let buf;
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = await fetch("https://constat.dev/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "sakaime-gate0/1.0 (read-only research)" },
      body: JSON.stringify(body),
    });
    buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 429) break;
    const wait = (sseData(buf.toString()).error?.data?.retry_after_seconds ?? 60) + 5;
    log({ tool: "device_evidence_lookup", k_number: k, retrieved: new Date().toISOString(), status: res.status, bytes: buf.length, sha256: sha(buf), outcome: "quota_denied", waitedSeconds: wait });
    console.log(k, "quota_denied, waiting", wait, "s");
    await sleep(wait * 1000);
    res = undefined;
  }
  if (!res) {
    console.log("stopping: still refused after one wait");
    break;
  }
  writeFileSync(out, buf);
  log({ tool: "device_evidence_lookup", k_number: k, retrieved: new Date().toISOString(), status: res.status, bytes: buf.length, sha256: sha(buf) });
  console.log(k, res.status, buf.length, sha(buf).slice(0, 16));
  if (res.status >= 500) {
    console.log("stopping: server error");
    break;
  }
  await sleep(25000);
}
