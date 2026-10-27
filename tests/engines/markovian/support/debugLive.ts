// Scratch diagnostic: one live chunk call, to see what the model returns and why facts are dropped. Not a test.
import { readFileSync } from "node:fs";
import { buildDocument } from "../../../../src/engines/markovian/ablation/corpus.ts";
import { HarnessChatPort } from "../../../../src/engines/markovian/ablation/harnessPort.ts";
import { FactLedger, parseModelOutput, planChunks, buildPrompt, READER_INSTRUCTIONS_FOR_DEBUG } from "./debugExports.ts";

const env = Object.fromEntries(
  readFileSync("C:/Users/prate/Downloads/genai-track1/.env", "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], (m[2] ?? "").trim()]),
);
const port = new HarnessChatPort({ apiKey: env.NVIDIA_API_KEY as string, baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3.5-lightning-30b-a3b", timeoutMs: 240_000 });
const doc = buildDocument({ seed: 20261027, pages: 40 });
const plan = planChunks(doc.pages, 16000);
const chunk = plan[0]!;
const prompt = buildPrompt({ mode: "DOCUMENT", goal: "g", step: 1, totalSteps: plan.length, carryover: "", overlapText: "", attachments: [], input: chunk.input, instructions: READER_INSTRUCTIONS_FOR_DEBUG });
const t0 = Date.now();
const resp = await port.complete({ role: "reader", system: "You read one chunk of a long evidence document and report what it states, as JSON.", user: prompt, maxTokens: 2400, dataClass: "public", memoryScope: "dbg" });
console.log("ms", Date.now() - t0, "usage", JSON.stringify(resp.usage));
console.log("reply head:", resp.text.slice(0, 1500));
const parsed = parseModelOutput(resp.text);
const ledger = new FactLedger(new Map(doc.pages.map((p) => [p.page, p.text] as const)));
if (parsed) ledger.ingest(parsed.facts, parsed.definitions, { step: 1, shownPages: chunk.pages });
console.log("parsed", !!parsed, "facts in reply", parsed?.facts.length, "accepted", ledger.facts.length, "drops", JSON.stringify(ledger.drops));
console.log("planted", JSON.stringify(doc.planted), "restriction", doc.restriction.page, doc.restriction.sentence.slice(0, 80));
