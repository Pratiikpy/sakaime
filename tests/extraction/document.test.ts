import { describe, expect, it } from "vitest";
import {
  checkQuoteExists,
  detectOcrDamage,
  documentFromFields,
  documentFromPages,
  documentFromText,
  locateOffset,
  makeAnchor,
  repairGlyphs,
} from "../../src/extraction/document.ts";
import { sha256Hex } from "../../src/util/canonical.ts";
import { EvidenceAnchorSchema } from "../../src/schemas/evidence.ts";

const PAGE1 = "Page one.\nThe device was tested on 300 cases from two sites.\nSensitivity was 87.8% (95% CI: 81.2% -\n92.5%) and non-\nproliferative disease was excluded.";
const PAGE2 = "Page two.\nThe fixed optimum threshold, 60 mm, is marked.\nTranspara@ 1.7.2 was used.";
const doc = documentFromPages("rec1", [{ text: PAGE1 }, { text: "" }, { text: PAGE2 }], "text");

describe("document model", () => {
  it("numbers pages by physical order and keeps an empty page in place", () => {
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(doc.pages[1]?.textLayer).toBe("absent");
    expect(doc.warnings.some((w) => w.includes("page 2 has no text layer"))).toBe(true);
  });

  it("maps any global offset back to its page and local offset", () => {
    for (const p of doc.pages) {
      if (p.text.length === 0) continue;
      const mid = p.start + Math.floor(p.text.length / 2);
      expect(locateOffset(doc, mid)).toEqual({ page: p.page, local: mid - p.start });
    }
    expect(locateOffset(doc, doc.text.length + 5)).toBeUndefined();
  });

  it("normalises line endings once so offsets agree", () => {
    const crlf = documentFromText("crlf", "a\r\nb\r\n\fc\r\n");
    expect(crlf.pages).toHaveLength(2);
    expect(crlf.text).not.toContain("\r");
    expect(crlf.pages[0]?.text).toBe("a\nb\n");
  });

  it("splits pdftotext output on form feeds and drops the empty tail", () => {
    expect(documentFromText("x", "p1\fp2\fp3\f").pages.map((p) => p.text)).toEqual(["p1", "p2", "p3"]);
  });

  it("reads the printed page label without using it as the page number", () => {
    const d = documentFromPages("lbl", [{ text: "intro" }, { text: "body\nPage 6 of 13" }], "text");
    expect(d.pages[1]?.page).toBe(2);
    expect(d.pages[1]?.printedLabel).toBe("Page 6 of 13");
  });
});

describe("anchors", () => {
  it("carry the verbatim slice, its hash and the page, and pass the shared schema", () => {
    const a = makeAnchor(doc, 1, 10, 50);
    expect(a.text).toBe(PAGE1.slice(10, 50));
    expect(a.textHash).toBe(sha256Hex(a.text));
    expect(a.page).toBe(1);
    expect(EvidenceAnchorSchema.safeParse(a).success).toBe(true);
  });

  it("have a stable id and refuse blank or out-of-range spans", () => {
    expect(makeAnchor(doc, 1, 10, 50).id).toBe(makeAnchor(doc, 1, 10, 50).id);
    expect(() => makeAnchor(doc, 1, 0, 99999)).toThrow(RangeError);
    expect(() => makeAnchor(doc, 9, 0, 3)).toThrow(RangeError);
    expect(() => makeAnchor(documentFromPages("b", [{ text: "   " }], "text"), 1, 0, 2)).toThrow(RangeError);
  });

  it("name a record field by JSON path instead of a page", () => {
    const f = documentFromFields("rec", [
      { path: "$.a.b", text: "hello world" },
      { path: "$.c", text: "   " },
      { path: "$.d", text: "second field" },
    ]);
    expect(f.pages).toHaveLength(2);
    const a = makeAnchor(f, 2, 0, 6);
    expect(a.jsonPath).toBe("$.d");
    expect(a.page).toBeUndefined();
    expect(a.text).toBe("second");
  });
});

describe("check 1: quote-exists", () => {
  it("finds a verbatim passage and reports the tier", () => {
    const r = checkQuoteExists(doc, { quote: "The device was tested on 300 cases" });
    expect(r).toMatchObject({ exists: true, page: 1, tier: "verbatim" });
  });

  it("finds a passage across a line break and a hyphenated break, and returns the ORIGINAL characters", () => {
    const r = checkQuoteExists(doc, { quote: "Sensitivity was 87.8% (95% CI: 81.2% - 92.5%) and non-proliferative disease" });
    expect(r.exists).toBe(true);
    if (r.exists) {
      expect(r.tier).toBe("normalized");
      expect(r.verbatim).toContain("\n");
      expect(PAGE1.slice(r.start, r.end)).toBe(r.verbatim);
    }
  });

  it("needs the damage-tolerant tier for glyph damage and says so", () => {
    const r = checkQuoteExists(doc, { quote: "Transpara 1.7.2 was used" });
    expect(r).toMatchObject({ exists: true, page: 3, tier: "damage_tolerant" });
  });

  it("rejects a quote that changes one digit", () => {
    const r = checkQuoteExists(doc, { quote: "Sensitivity was 87.9% (95% CI: 81.2% - 92.5%)" });
    expect(r).toMatchObject({ exists: false, reason: "NOT_FOUND" });
  });

  it("does not fold a damage glyph between digits into a number", () => {
    const d = documentFromPages("g", [{ text: "the count was 1\uFFFD2 cases" }], "text");
    const r = checkQuoteExists(d, { quote: "the count was 12 cases" });
    expect(r).toMatchObject({ exists: false, reason: "NOT_FOUND" });
    const dot = documentFromPages("g2", [{ text: "it rose to 0.\uFFFD5 overall" }], "text");
    expect(checkQuoteExists(dot, { quote: "it rose to 0.5 overall" }).exists).toBe(false);
  });

  it("rejects an empty or missing quote, and reports a quote on the wrong page", () => {
    expect(checkQuoteExists(doc, {})).toMatchObject({ exists: false, reason: "UNQUOTED" });
    expect(checkQuoteExists(doc, { quote: "   " })).toMatchObject({ exists: false, reason: "EMPTY_QUOTE" });
    expect(checkQuoteExists(doc, { quote: "The device was tested on 300 cases", page: 3 })).toMatchObject({ exists: false, reason: "PAGE_MISMATCH" });
  });

  it("names a passage that crosses a page break", () => {
    const d = documentFromPages("sp", [{ text: "the study enrolled 900" }, { text: "participants at 10 sites" }], "text");
    expect(checkQuoteExists(d, { quote: "enrolled 900 participants at 10 sites" })).toMatchObject({ exists: false, reason: "SPANS_PAGES" });
  });

  it("requires every number the assertion states to be in the passage, as a percent or a proportion", () => {
    const q = "Sensitivity was 87.8% (95% CI: 81.2% - 92.5%)";
    expect(checkQuoteExists(doc, { quote: q, numbers: [{ value: 0.878, form: "percent" }, { value: 0.812, form: "percent" }] }).exists).toBe(true);
    expect(checkQuoteExists(doc, { quote: q, numbers: [{ value: 0.879, form: "percent" }] })).toMatchObject({ exists: false, reason: "NUMBER_NOT_IN_QUOTE" });
    // 0.878 as a proportion is not what the passage shows
    expect(checkQuoteExists(doc, { quote: q, numbers: [{ value: 0.878, form: "proportion" }] })).toMatchObject({ exists: false, reason: "NUMBER_NOT_IN_QUOTE" });
    expect(checkQuoteExists(doc, { quote: "tested on 300 cases from two sites", numbers: [{ value: 2, form: "count" }] }).exists).toBe(true);
  });

  it("never matches a page with no text layer", () => {
    expect(checkQuoteExists(doc, { quote: "anything", page: 2 }).exists).toBe(false);
  });

  it("reports how often the passage occurs", () => {
    const d = documentFromPages("dup", [{ text: "same words here. And same words here again." }], "text");
    const r = checkQuoteExists(d, { quote: "same words here" });
    expect(r).toMatchObject({ exists: true, occurrences: 2 });
  });
});

describe("glyph damage", () => {
  it("flags damage without editing the text", () => {
    const hits = detectOcrDamage("Transpara@ and meti\uFFFDic and repo1ts");
    expect(hits.map((h) => h.kind).sort()).toEqual(["digit_in_word", "glued_symbol", "replacement_char"]);
    expect(detectOcrDamage("K200667 and COVID19 and 12 months")).toHaveLength(0);
  });

  it("repairs the ti and ft ligature glyphs only between lowercase letters", () => {
    expect(repairGlyphs("retrospec\u019Fve study a\u014Cer")).toEqual({ text: "retrospective study after", replaced: 2 });
    expect(repairGlyphs("\u019F alone and \u014CK")).toEqual({ text: "\u019F alone and \u014CK", replaced: 0 });
  });
});
