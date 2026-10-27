import { describe, expect, it } from "vitest";
import { parseStrictJsonArray } from "../../../src/engines/hmem/index.ts";
import { actions, memory } from "./helpers.ts";

describe("model-free mining", () => {
  const chat = "I always prefer dark mode in every editor. The weather is nice. We decided to use sqlite because it needs no server.";

  it("keeps sentences with a signal word as short-term records with a source and a ledger entry", async () => {
    const { hmem } = memory();
    const mined = await hmem.mine("chat_message", chat);
    expect(mined).toHaveLength(2);
    expect(mined.every((m) => m.layer === "short_term" && m.source === "interaction:chat_message" && m.tags.includes("event:chat_message"))).toBe(true);
    expect(actions(hmem, mined[0]!.id)).toEqual(["create"]);
  });

  it("carries the caller's scope onto every mined record", async () => {
    const { hmem } = memory();
    const mined = await hmem.mine("chat_message", chat, { organizationId: "hospital-a", caseId: "case-1" });
    expect(mined.every((m) => m.organizationId === "hospital-a" && m.caseId === "case-1")).toBe(true);
  });

  it("returns nothing, and writes nothing, for text with no signal", async () => {
    const { hmem } = memory();
    expect(await hmem.mine("chat_message", "Nice weather. See you later.")).toEqual([]);
    expect(await hmem.mine("chat_message", "")).toEqual([]);
    expect(hmem.store.all()).toHaveLength(0);
  });

  it("mines a document from a bounded window and tags the file", async () => {
    const { hmem } = memory();
    const text = `${"filler sentence without signal. ".repeat(400)}We must use the prospective cohort for validation of every triage device.`;
    const mined = await hmem.mining.mineDocument("report.pdf", text);
    expect(mined).toHaveLength(0);
    const near = await hmem.mining.mineDocument("short.pdf", "We must record the software version because the label depends on it.");
    expect(near[0]).toMatchObject({ source: "document:short.pdf", layer: "working", type: "factual" });
    expect(near[0]!.tags).toContain("file:short.pdf");
  });
});

describe("model-assisted mining", () => {
  it("parses strict JSON, tolerates fences and prose, drops short or non-string entries", () => {
    expect(parseStrictJsonArray('```json\n["The board decided on prospective evidence", "ok", 3]\n```')).toEqual(["The board decided on prospective evidence"]);
    expect(parseStrictJsonArray('Here you go: ["Remember to record the version"] Hope that helps')).toEqual(["Remember to record the version"]);
    for (const bad of ["not json", "{}", '"a string"', "[", ""]) expect(parseStrictJsonArray(bad)).toEqual([]);
  });

  it("records mined by a model start at the model tier, in the working layer", async () => {
    const { hmem } = memory({ minerFn: async () => '["The vendor reports AUC 0.92 on the validation set"]' });
    const [m] = await hmem.mine("model_response", "anything");
    expect(m).toMatchObject({ layer: "working", confidence: 0.4, provenance: { tier: "model" } });
  });

  it("a miner that returns garbage writes nothing; a miner that throws surfaces the error and writes nothing", async () => {
    const { hmem } = memory({ minerFn: async () => "I could not find anything" });
    expect(await hmem.mine("chat_message", "text")).toEqual([]);
    const { hmem: broken } = memory({ minerFn: async () => { throw new Error("model down"); } });
    await expect(broken.mine("chat_message", "text")).rejects.toThrow(/model down/);
    expect(broken.store.all()).toHaveLength(0);
  });
});
