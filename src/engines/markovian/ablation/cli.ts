/**
 * Live MA-3 run. Reads NVIDIA_API_KEY from the environment or the gitignored .env, never prints it, writes the
 * report incrementally as JSON and ends with a plain-text summary. Without a key it prints NOT RUN and exits 3.
 *
 *   npx tsx src/engines/markovian/ablation/cli.ts --docs 4 --pages 40 --out tests/engines/markovian/results/ma3-live.json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildCorpus } from "./corpus.ts";
import { HarnessChatPort } from "./harnessPort.ts";
import { ARMS, formatMA3, runMA3, type ArmName } from "./ma3.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..", "..", "..");
  // The repository's own .env wins over an ambient variable: another project's NVIDIA_API_KEY in the shell shadowed it once and every call returned 403.
  const env = { ...process.env, ...readEnv(resolve(root, ".env")) } as Record<string, string | undefined>;
  const apiKey = env.NVIDIA_API_KEY;
  if (!apiKey || apiKey.length < 8) {
    console.log("MA-3 live run: NOT RUN (no NVIDIA_API_KEY in the environment or .env)");
    process.exit(3);
  }
  const baseUrl = env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const model = arg("model", "nvidia/nemotron-3.5-lightning-30b-a3b");
  const docs = Number(arg("docs", "4"));
  const pages = Number(arg("pages", "40"));
  const out = resolve(root, arg("out", "tests/engines/markovian/results/ma3-live.json"));
  const seed = Number(arg("seed", "20261027"));

  const port = new HarnessChatPort({ apiKey, baseUrl, model, minGapMs: 1500, timeoutMs: 240_000 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.partial.jsonl`, "");
  const documents = buildCorpus(docs, { seed, pages });
  console.log(`MA-3 live: ${docs} constructed documents x ${pages} pages, model ${model}, endpoint host ${new URL(baseUrl).hostname}`);

  const report = await runMA3({
    model: port,
    modelLabel: model,
    live: true,
    documents,
    arms: arg("arms", "") ? (arg("arms", "").split(",") as ArmName[]).filter((a) => (ARMS as readonly string[]).includes(a)) : undefined,
    fullContextMaxBytes: 140_000,
    retryDelayMs: 3000,
    onProgress: (l) => console.log(l),
    onResult: (r) => appendFileSync(`${out}.partial.jsonl`, JSON.stringify(r) + "\n"),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ ...report, http: { requests: port.requests.length, statuses: countBy(port.requests.map((r) => r.status)) } }, null, 2)}\n`);
  console.log(`\n${formatMA3(report)}\n\nreport written to ${out}`);
}

function countBy(xs: number[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[String(x)] = (o[String(x)] ?? 0) + 1;
  return o;
}

main().catch((err) => {
  console.error(`MA-3 live run failed: ${(err as Error).message}`);
  process.exit(1);
});
