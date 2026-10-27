import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aliasGroupOf,
  foldText,
  jaroWinkler,
  normaliseManufacturer,
  normaliseName,
  repairMojibake,
  splitDeviceCell,
  stripMarks,
} from "../../src/identity/normalize.ts";

describe("mojibake, marks and ligatures", () => {
  it("reverses the double-encoded registered mark found in the FDA list", () => {
    expect(repairMojibake("MammoScreenÂ® (3)")).toBe("MammoScreen® (3)");
    expect(normaliseName("MammoScreenÂ® (3)").key).toBe("mammoscreen");
  });

  it("strips the double-encoded trademark mark", () => {
    expect(normaliseName("GI GeniusÂ™ Module 100 (GGM100.US)").key.startsWith("gi genius module 100")).toBe(true);
    expect(stripMarks("GI GeniusÂ™")).toBe("GI Genius");
  });

  it("removes the replacement character and the degraded registered mark seen in PDF text", () => {
    expect(normaliseName("Transpara@ software").key).toBe("transpara");
    expect(normaliseName("MammoScreen�").key).toBe("mammoscreen");
  });

  it("leaves correct text alone and never throws on lone surrogates or control characters", () => {
    expect(repairMojibake("Ångström and café")).toBe("Ångström and café");
    expect(() => normaliseName("\ud800\u0000\u001f broken")).not.toThrow();
  });

  it("folds ligatures and diacritics", () => {
    expect(foldText("ﬁnal Café")).toBe("final cafe");
  });

  it("is idempotent", () => {
    fc.assert(fc.property(fc.string(), (s) => foldText(foldText(s)) === foldText(s)));
  });
});

describe("device names", () => {
  it("separates version tokens from the identity of the name", () => {
    expect(normaliseName("Transpara 1.7.2")).toMatchObject({ key: "transpara", versions: ["1.7.2"] });
    expect(normaliseName("Transpara (2.1.0)")).toMatchObject({ key: "transpara", versions: ["2.1.0"] });
    expect(normaliseName("IDx-DR v2.3")).toMatchObject({ key: "idx dr", versions: ["2.3"] });
    expect(normaliseName("Lunit INSIGHT MMG (v1.1.10)")).toMatchObject({ key: "lunit insight mmg", versions: ["1.1.10"] });
    expect(normaliseName("EyeArt v2.2.0")).toMatchObject({ key: "eyeart", versions: ["2.2.0"] });
    expect(normaliseName("FFRct version 3")).toMatchObject({ key: "ffrct", versions: ["3"] });
  });

  it("reads product generations, algorithm identifiers and pre-release words as versions", () => {
    expect(normaliseName("MammoScreen (3)").versions).toEqual(["(3)"]);
    expect(normaliseName("ECG-AI Low Ejection Fraction (LEF) 12-Lead algorithm (1010)").versions).toEqual(["alg:1010"]);
    expect(normaliseName("Paige Prostate Alpha")).toMatchObject({ key: "paige prostate", versions: ["alpha"] });
  });

  it("does not mistake model numbers for versions", () => {
    expect(normaliseName("GI Genius Module 100 (GGM100.US)").versions).toEqual([]);
  });

  it("splits multi-device cells on semicolons and on commas outside parentheses", () => {
    expect(splitDeviceCell("Voluson Expert 18; Voluson Expert 20; Voluson Expert 22")).toHaveLength(3);
    expect(splitDeviceCell("Auto-Seg (SO-0012), Spine Auto-Seg (SO-0012)")).toEqual(["Auto-Seg (SO-0012)", "Spine Auto-Seg (SO-0012)"]);
    expect(splitDeviceCell("Viz Subdural+, Viz SUBDURAL PLUS")).toHaveLength(2);
    expect(splitDeviceCell("Model 1,000 and 2,000")).toHaveLength(1);
    expect(splitDeviceCell("Module 100, GI Genius")).toHaveLength(2);
    expect(splitDeviceCell("")).toEqual([]);
    expect(splitDeviceCell(" ; , ")).toEqual([]);
  });

  it("makes a plus sign equal to the word, so the two spellings of one device compare equal", () => {
    const [a, b] = splitDeviceCell("Viz Subdural+, Viz SUBDURAL PLUS").map((d) => normaliseName(d).key);
    expect(a).toBe(b);
  });
});

describe("manufacturers", () => {
  it("folds the Viz.ai spellings seen in the list, including the OCR confusion of ai and Al", () => {
    const keys = ["Viz.ai, Inc.", "Viz. ai, Inc.", "Viz.Al, Inc.", "VIZ.AI, INC."].map((n) => normaliseManufacturer(n).key);
    expect(new Set(keys).size).toBe(1);
  });

  it("folds corporate suffix variants", () => {
    const keys = ["Screenpoint Medical B.V.", "ScreenPoint Medical BV", "ScreenPoint Medical B.V."].map((n) => normaliseManufacturer(n).key);
    expect(new Set(keys).size).toBe(1);
    expect(normaliseManufacturer("Aidoc Medical , Ltd.").key).toBe(normaliseManufacturer("Aidoc Medical, Ltd.").key);
    expect(normaliseManufacturer("Eyenuk, Inc").key).toBe(normaliseManufacturer("Eyenuk, Inc.").key);
  });

  it("does not fold different companies", () => {
    expect(normaliseManufacturer("GE Medical Systems Israel").key).not.toBe(normaliseManufacturer("EnsoData").key);
    expect(normaliseManufacturer("Eko Health, Inc.").key).not.toBe(normaliseManufacturer("Eko Devices, Inc.").key);
  });

  it("knows the documented owner drift and nothing else", () => {
    const idx = aliasGroupOf(normaliseManufacturer("Idx, LLC").key);
    expect(idx).toBeDefined();
    expect(idx).toBe(aliasGroupOf(normaliseManufacturer("Digital Diagnostics Inc.").key));
    expect(aliasGroupOf(normaliseManufacturer("Bay Labs, Inc.").key)).toBe(aliasGroupOf(normaliseManufacturer("Caption Health").key));
    expect(aliasGroupOf(normaliseManufacturer("Medtronic, Inc.").key)).toBe(aliasGroupOf(normaliseManufacturer("Cosmo Artificial Intelligence - Ai, Ltd.").key));
    expect(aliasGroupOf(normaliseManufacturer("Preventice Technologies, Inc.").key)).toBeUndefined();
  });

  it("is total", () => {
    fc.assert(fc.property(fc.string(), (s) => typeof normaliseManufacturer(s).key === "string"));
  });
});

describe("string similarity", () => {
  it("is symmetric, bounded and 1 for equal non-empty strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        const x = jaroWinkler(a, b);
        return x >= 0 && x <= 1 + 1e-12 && Math.abs(x - jaroWinkler(b, a)) < 1e-12;
      }),
    );
    expect(jaroWinkler("mammoscreen", "mammoscreen")).toBe(1);
    expect(jaroWinkler("", "")).toBe(0);
  });
});
