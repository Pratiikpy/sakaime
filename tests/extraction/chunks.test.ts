import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chunkByPages, chunkBySize, chunkOffsetToPage } from "../../src/extraction/chunks.ts";
import { documentFromPages, documentFromText } from "../../src/extraction/document.ts";
import { fixture } from "./helpers.ts";

const real = documentFromText("DEN180001", fixture("fda", "DEN180001_summary_text.txt"));

describe("page chunks", () => {
  it("cover the document once, in order, with stable ids", () => {
    const a = [...chunkByPages(real, 4)];
    const b = [...chunkByPages(real, 4)];
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a.map((c) => [c.firstPage, c.lastPage])).toEqual([[1, 4], [5, 8], [9, 12], [13, 13]]);
    expect(a.map((c) => c.text).join("\f")).toBe(real.text);
  });

  it("overlap whole pages so a statement across a page break is seen whole once", () => {
    const c = [...chunkByPages(real, 4, 1)];
    expect(c.map((x) => x.firstPage)).toEqual([1, 4, 7, 10]);
    expect(c[1]?.text.startsWith(real.pages[3]?.text ?? "x")).toBe(true);
  });

  it("reject bad parameters", () => {
    expect(() => [...chunkByPages(real, 0)]).toThrow(RangeError);
    expect(() => [...chunkByPages(real, 3, 3)]).toThrow(RangeError);
  });
});

describe("size chunks", () => {
  it("map every character back to the page it came from", () => {
    for (const c of chunkBySize(real, 3000, 200)) {
      for (let off = 0; off < c.text.length; off += 211) {
        const m = chunkOffsetToPage(c, off);
        if (c.text[off] === "\f") continue;
        expect(m).toBeDefined();
        const page = real.pages[(m?.page ?? 1) - 1];
        expect(page?.text[m?.pageOffset ?? 0]).toBe(c.text[off]);
      }
    }
  });

  it("end at a paragraph or sentence break when one is near the end of the window", () => {
    const chunks = [...chunkBySize(real, 3000)];
    const ends = chunks.slice(0, -1).map((c) => c.text.trimEnd().slice(-1));
    const good = ends.filter((e) => /[.!?:;)\f]/.test(e) || e === "").length;
    expect(good / ends.length).toBeGreaterThan(0.7);
  });

  it("is deterministic and reproduces the text without overlap", () => {
    const a = [...chunkBySize(real, 2500)];
    expect(a.map((c) => c.text).join("")).toBe(real.text);
    expect([...chunkBySize(real, 2500)].map((c) => c.id)).toEqual(a.map((c) => c.id));
  });

  it("holds for any document and any window (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 400 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 200, max: 700 }),
        fc.integer({ min: 0, max: 99 }),
        (pages, max, overlap) => {
          const doc = documentFromPages("p", pages.map((text) => ({ text })), "text");
          const chunks = [...chunkBySize(doc, max, overlap)];
          expect(chunks.length === 0 ? doc.text.length === 0 : true).toBe(true);
          let prevEnd = 0;
          for (const c of chunks) {
            expect(c.text).toBe(doc.text.slice(c.start, c.end));
            expect(c.start).toBeLessThanOrEqual(prevEnd);
            expect(c.end).toBeGreaterThan(c.start);
            expect(c.end - c.start).toBeLessThanOrEqual(max);
            prevEnd = c.end;
          }
          if (chunks.length) expect(chunks[chunks.length - 1]?.end).toBe(doc.text.length);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("reject bad parameters", () => {
    expect(() => [...chunkBySize(real, 50)]).toThrow(RangeError);
    expect(() => [...chunkBySize(real, 400, 300)]).toThrow(RangeError);
  });
});
