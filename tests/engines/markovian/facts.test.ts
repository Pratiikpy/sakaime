import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FactLedger,
  PageInputError,
  factsDropped,
  normalisePages,
  numberAppearsIn,
  pageRanges,
  parseModelOutput,
  planChunks,
  quoteExists,
  type Coverage,
} from "../../../src/engines/markovian/index.ts";

describe("quote existence", () => {
  const page = "The  device is not indicated for patients under 22 years of age.\nSee Section 4 for the follow-up of an exam-\nination protocol.";

  it("ignores case and whitespace and joins hyphenated line breaks", () => {
    expect(quoteExists(page, "The device is NOT indicated for patients under 22 years of age.")).toBe(true);
    expect(quoteExists(page, "follow-up of an examination protocol")).toBe(true);
  });

  it("folds typographic quotes, dashes and ligatures", () => {
    expect(quoteExists("The patient’s ﬁrst visit — within 2 weeks", "the patient's first visit - within 2 weeks")).toBe(true);
  });

  it("accepts an elided quote only when every fragment appears in order", () => {
    expect(quoteExists(page, "not indicated for patients ... 22 years of age")).toBe(true);
    expect(quoteExists(page, "not indicated for patients ... 99 years of age")).toBe(false);
    expect(quoteExists(page, "The device is not indicated ... for patients under 22 years of age")).toBe(true);
    expect(quoteExists(page, "for patients under 22 years of age ... The device is not indicated")).toBe(false);
  });

  it("rejects a quote that is absent, too short or only punctuation", () => {
    expect(quoteExists(page, "not indicated for patients over 22")).toBe(false);
    expect(quoteExists(page, "device")).toBe(false);
    expect(quoteExists(page, "...")).toBe(false);
    expect(quoteExists(page, "")).toBe(false);
  });
});

describe("numbers in quotes", () => {
  it("finds plain, separated, decimal and percent forms", () => {
    expect(numberAppearsIn("under 22 years", 22)).toBe(true);
    expect(numberAppearsIn("1,234 participants", 1234)).toBe(true);
    expect(numberAppearsIn("a threshold of 0.85", 0.85)).toBe(true);
    expect(numberAppearsIn("a threshold of .85", 0.85)).toBe(true);
    expect(numberAppearsIn("sensitivity of 85%", 0.85)).toBe(true);
    expect(numberAppearsIn("sensitivity of 85%", 85)).toBe(true);
  });
  it("does not find a number that is not there, and does not read a version as a number", () => {
    expect(numberAppearsIn("under 22 years", 23)).toBe(false);
    expect(numberAppearsIn("version 2.1.0", 2)).toBe(false);
    expect(numberAppearsIn("version 2.1.0", 21)).toBe(false);
  });
});

describe("model output parsing", () => {
  it("accepts a fenced reply and prose around the object", () => {
    expect(parseModelOutput('```json\n{"facts":[{"a":1}]}\n```')?.facts).toHaveLength(1);
    expect(parseModelOutput('Here you go: {"facts":[],"definitions":[{"x":1}]} thanks')?.definitions).toHaveLength(1);
  });
  it("returns undefined when there is no facts array", () => {
    expect(parseModelOutput("nothing to report")).toBeUndefined();
    expect(parseModelOutput('{"result":[]}')).toBeUndefined();
    expect(parseModelOutput("")).toBeUndefined();
  });
  it("salvages the complete objects of a reply cut off mid-array and says so", () => {
    const cut = '{"facts":[{"field":"limitation","value":"a, \\"b\\" {c}","quote":"q q q q q","page":1},{"field":"setting","value":"x","quo';
    const out = parseModelOutput(cut);
    expect(out?.salvaged).toBe(true);
    expect(out?.facts).toHaveLength(1);
  });
  it("property: never throws on arbitrary text", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => { parseModelOutput(s); }), { numRuns: 300 });
  });
});

describe("page input", () => {
  it("orders pages, strips control characters and rejects duplicates and bad numbers", () => {
    const ok = normalisePages([{ page: 3, text: "c\u0000d" }, { page: 1, text: "a\r\nb" }]);
    expect(ok.map((p) => p.page)).toEqual([1, 3]);
    expect(ok[0]!.text).toBe("a\nb");
    expect(ok[1]!.text).toBe("cd");
    expect(() => normalisePages([{ page: 1, text: "a" }, { page: 1, text: "b" }])).toThrow(PageInputError);
    expect(() => normalisePages([{ page: 0, text: "a" }])).toThrow(PageInputError);
    expect(() => normalisePages([{ page: 1.5, text: "a" }])).toThrow(PageInputError);
  });

  it("formats page ranges", () => {
    expect(pageRanges([1, 2, 3, 5, 9, 10])).toBe("1-3, 5, 9-10");
    expect(pageRanges([])).toBe("none");
  });

  it("splits an oversized page into parts that keep the page number, within the byte budget", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something specific about the study.`).join(" ");
    const plan = planChunks([{ page: 7, text: long }], 600);
    expect(plan.length).toBeGreaterThan(2);
    for (const c of plan) {
      expect(Buffer.byteLength(c.input.text, "utf8")).toBeLessThanOrEqual(600 + 64);
      expect(c.pages).toEqual([7]);
      expect(c.input.text).toMatch(/\[PAGE 7, part \d+\/\d+\]/);
    }
    // nothing is lost: every sentence is in exactly one part
    const joined = plan.map((c) => c.input.text).join(" ");
    for (let i = 0; i < 60; i++) expect(joined.match(new RegExp(`Sentence number ${i} says`, "g"))).toHaveLength(1);
  });

  it("property: every page appears, in order, and no chunk exceeds the budget", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 0, maxLength: 900 }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 700, max: 3000 }), (texts, budget) => {
        const pages = texts.map((text, i) => ({ page: i + 1, text }));
        const plan = planChunks(pages, budget);
        const seen = plan.flatMap((c) => c.pages);
        expect([...new Set(seen)]).toEqual(pages.map((p) => p.page));
        for (const c of plan) expect(Buffer.byteLength(c.input.text, "utf8")).toBeLessThanOrEqual(budget + 80);
      }),
      { numRuns: 120 },
    );
  });
});

describe("fact ledger", () => {
  const pages = new Map<number, string>([
    [2, "In this summary, the Device means the AcmeScope software, software version 2.1.0."],
    [38, "The device is not indicated for patients under 22 years of age. No data exist for that group."],
    [39, "A boilerplate sentence that appears on two pages of this document."],
    [40, "A boilerplate sentence that appears on two pages of this document."],
  ]);
  const cov = (over: Partial<Coverage> = {}): Coverage => ({ allPages: [2, 38, 39, 40], readPages: new Set([2]), failedPages: new Set(), partialPages: new Set(), chunksDone: 1, chunksTotal: 4, ...over });
  const fact = (o: Record<string, unknown>) => ({ field: "limitation", value: "not for patients under 22", quote: "The device is not indicated for patients under 22 years of age.", page: 38, number: 22, ...o });

  it("records a verified fact with its anchor, drops what cannot be verified and counts why", () => {
    const l = new FactLedger(pages);
    const n = l.ingest(
      [
        fact({}),
        fact({ value: "not for patients over 90", quote: "The device must never be used in patients over 90 years old." }), // not on any page
        fact({ value: "second reading of the age bound", number: 23 }), // quote is real, the number is not in it
        { field: "limitation", value: "x" }, // schema
        fact({ field: "nonsense" }), // schema
      ],
      [],
      { step: 4, shownPages: [38] },
    );
    expect(n).toBe(2);
    expect(l.facts).toHaveLength(2);
    expect(l.facts[0]).toMatchObject({ id: "F1", field: "limitation", number: 22 });
    expect(l.facts[0]!.anchors[0]).toMatchObject({ page: 38, step: 4 });
    expect(l.facts[1]!.number).toBeUndefined();
    expect(l.drops).toEqual({ schemaInvalid: 2, quoteNotFound: 1, anchorAmbiguous: 0, numbersDiscarded: 1 });
    expect(factsDropped(l.drops)).toBe(3);
  });

  it("reads null and empty optional fields as absent, as models write them", () => {
    const l = new FactLedger(pages);
    const n = l.ingest([fact({ number: null, unit: null, relates_to: null }), fact({ value: "second", number: "", unit: "" })], [], { step: 1, shownPages: [38] });
    expect(n).toBe(2);
    expect(l.drops.schemaInvalid).toBe(0);
    expect(l.facts.map((f) => f.number)).toEqual([undefined, undefined]);
  });

  it("corrects a wrong page when the quote is on exactly one page of the chunk, and refuses an ambiguous one", () => {
    const l = new FactLedger(pages);
    l.ingest([fact({ page: 2 })], [], { step: 1, shownPages: [38] });
    expect(l.facts[0]!.anchors[0]).toMatchObject({ page: 38, anchorCorrected: true });
    const m = new FactLedger(pages);
    m.ingest([{ field: "limitation", value: "boilerplate", quote: "A boilerplate sentence that appears on two pages", page: 2 }], [], { step: 1, shownPages: [39, 40] });
    expect(m.facts).toHaveLength(0);
    expect(m.drops.anchorAmbiguous).toBe(1);
  });

  it("a quote on a page that was not shown in the chunk and not cited is not accepted", () => {
    const l = new FactLedger(pages);
    l.ingest([fact({ page: 2 })], [], { step: 1, shownPages: [2] });
    expect(l.facts).toHaveLength(0);
    expect(l.drops.quoteNotFound).toBe(1);
  });

  it("merges a restatement on another page into one fact with two anchors", () => {
    const p = new Map(pages).set(41, "Reminder: the device is not indicated for patients under 22 years of age in any setting.");
    const l = new FactLedger(p);
    l.ingest([fact({})], [], { step: 1, shownPages: [38] });
    l.ingest([fact({ page: 41, value: "Not for patients under 22", quote: "the device is not indicated for patients under 22 years of age" })], [], { step: 2, shownPages: [41] });
    expect(l.facts).toHaveLength(1);
    expect(l.facts[0]!.anchors.map((a) => a.page)).toEqual([38, 41]);
  });

  it("keeps only relations to facts that exist, and verifies definitions", () => {
    const l = new FactLedger(pages);
    l.ingest(
      [fact({}), { field: "software_version", value: "2.1.0", quote: "software version 2.1.0", page: 2, relates_to: { fact_id: "F1", kind: "narrows" } }, { field: "setting", value: "clinic", quote: "software version 2.1.0", page: 2, relates_to: { fact_id: "F99", kind: "restates" } }],
      [{ term: "the Device", meaning: "AcmeScope software", quote: "the Device means the AcmeScope software", page: 2 }, { term: "ghost", meaning: "not on the page", quote: "this text does not exist anywhere", page: 2 }],
      { step: 1, shownPages: [2, 38] },
    );
    expect(l.facts[1]!.relations).toEqual([{ factId: "F1", kind: "narrows" }]);
    expect(l.facts[2]!.relations).toEqual([]);
    expect(l.definitions.map((d) => d.term)).toEqual(["the Device"]);
  });

  it("lists checklist groups with no verified fact", () => {
    const l = new FactLedger(pages);
    expect(l.missing()).toContain("limitations");
    l.ingest([fact({})], [], { step: 1, shownPages: [38] });
    expect(l.missing()).not.toContain("limitations");
    expect(l.missing()).toContain("sample_size");
  });

  it("renders the COMPLETED / REMAINING / DECISIONS / CONTEXT state", () => {
    const l = new FactLedger(pages);
    l.ingest([fact({})], [{ term: "the Device", meaning: "AcmeScope software", quote: "the Device means the AcmeScope software", page: 2 }], { step: 1, shownPages: [2, 38] });
    const { text, warnings } = l.render(800, cov({ readPages: new Set([2, 38]) }));
    expect(text).toMatch(/^COMPLETED: pages 2, 38 read/);
    expect(text).toContain("REMAINING: pages 39-40 unread");
    expect(text).toContain("F1 limitation p.38: not for patients under 22");
    expect(text).toContain('"the Device" = AcmeScope software (p.2)');
    expect(warnings).toEqual([]);
  });

  it("property: the rendered state never exceeds its budget, and a limitation outlives lower-priority facts", () => {
    fc.assert(
      fc.property(fc.integer({ min: 128, max: 700 }), fc.integer({ min: 1, max: 60 }), (budget, count) => {
        const text = "The device is not indicated for patients under 22 years of age.";
        const p = new Map<number, string>([[1, text]]);
        const l = new FactLedger(p);
        const raw: unknown[] = [{ field: "limitation", value: "not for patients under 22", quote: text, page: 1 }];
        for (let i = 0; i < count; i++) raw.push({ field: "comparator", value: `comparator number ${i} with a long description of what it is`, quote: text, page: 1 });
        l.ingest(raw, [], { step: 1, shownPages: [1] });
        const { text: out } = l.render(budget, { allPages: [1], readPages: new Set([1]), failedPages: new Set(), partialPages: new Set(), chunksDone: 1, chunksTotal: 1 });
        expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(budget);
        if (budget >= 200) expect(out).toContain("limitation p.1: not for patients under 22");
      }),
      { numRuns: 150 },
    );
  });
});
