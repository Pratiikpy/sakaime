import { describe, expect, it } from "vitest";
import { measureRepeatQuestions } from "../../../src/engines/hmem/ablation.ts";
import { HMEM, identifiersAgree } from "../../../src/engines/hmem/index.ts";
import { buildMa2Session } from "./ablation-session.ts";

const make = () => new HMEM({ clock: () => 1_750_000_000_000 });

/**
 * MA-2 measurement. The numbers below are what the code produced when it was first run on this
 * session; they are pinned so that tests/engines/ABLATIONS.md cannot drift from the code. The session
 * is constructed (see ablation-session.ts).
 */
describe("MA-2: repeated questions across a ten-case session, with and without H-MEM", () => {
  const session = buildMa2Session();
  const report = measureRepeatQuestions(session, make);
  const arm = (name: string) => report.arms.find((a) => a.arm === name)!;

  it("of the 22 repeats, 4 repeat the earlier wording exactly and 18 reword it", () => {
    const earlier = (i: number) => session.slice(0, i).filter((q) => q.organizationId === session[i]!.organizationId && q.key === session[i]!.key);
    const repeats = session.map((_, i) => i).filter((i) => earlier(i).length > 0);
    expect(repeats).toHaveLength(22);
    expect(repeats.filter((i) => earlier(i).some((q) => q.text === session[i]!.text))).toHaveLength(4);
  });

  it("the session has ten cases at two hospitals and 22 questions that repeat an earlier one in the same hospital", () => {
    expect(new Set(session.map((q) => q.caseId)).size).toBe(10);
    expect(new Set(session.map((q) => q.organizationId)).size).toBe(2);
    expect(arm("no-memory")).toMatchObject({ questions: 34, repeatable: 22, asked: 34, repeatQuestions: 22, answeredFromMemory: 0 });
  });

  it("with scoped memory 12 of the 22 repeats are avoided, but 4 questions are answered with the answer to a different question", () => {
    expect(arm("scoped-memory")).toMatchObject({
      questions: 34,
      repeatable: 22,
      asked: 19,
      repeatQuestions: 10,
      answeredFromMemory: 15,
      correctReuse: 11,
      falseReuse: 4,
      crossOrganizationLeaks: 0,
    });
  });

  it("the false reuses are identity-link questions about different products, which share almost all their words", () => {
    const wrong = report.scopedTrace.filter((t) => t.outcome === "memory-wrong");
    expect(wrong.map((t) => session[t.index]!.key).sort()).toEqual(["retinascan-link", "retinascan-link", "strokealert-link", "strokealert-link"]);
  });

  it("an identifier guard removes every false reuse and keeps 11 of the 22 repeats avoided", () => {
    expect(arm("scoped-memory-id-guard")).toMatchObject({ asked: 23, repeatQuestions: 11, answeredFromMemory: 11, correctReuse: 11, falseReuse: 0, crossOrganizationLeaks: 0 });
  });

  it("the guard compares the registry identifiers two texts name", () => {
    expect(identifiersAgree("Does K900001 cover ChestRead?", "Is submission K900001 the same product?")).toBe(true);
    expect(identifiersAgree("Does K900002 cover StrokeAlert?", "Is submission K900001 the same product?")).toBe(false);
    expect(identifiersAgree("Which clearance covers the stroke software?", "Is submission K900002 the same product?")).toBe(false);
    expect(identifiersAgree("Is age in months?", "Age is reported in months.")).toBe(true);
  });

  it("without organization scoping the other hospital's answers are used: 9 cross-organization leaks and 12 wrong reuses", () => {
    expect(arm("unscoped-memory")).toMatchObject({ answeredFromMemory: 20, correctReuse: 8, falseReuse: 12, crossOrganizationLeaks: 9 });
  });

  it("the first time a hospital meets an ambiguity it is asked, even if the other hospital resolved it", () => {
    const firstAtB = report.scopedTrace.find((t, i) => session[i]!.organizationId === "hospital-b" && t.key === "chestread-link");
    expect(firstAtB?.outcome).toBe("asked");
    expect(arm("scoped-memory").crossOrganizationLeaks).toBe(0);
  });

  it("every repeat that memory missed is a paraphrase or a different wording; none is a lookup failure of an identical question", () => {
    const missed = report.guardedTrace.filter((t, i) => t.outcome === "asked" && session.slice(0, i).some((q) => q.organizationId === session[i]!.organizationId && q.key === session[i]!.key));
    expect(missed).toHaveLength(11);
    // A word-for-word repeat (phrasing 0 after phrasing 0) is never missed.
    const verbatimMisses = missed.filter((t) => {
      const earlier = session.slice(0, t.index).filter((q) => q.organizationId === session[t.index]!.organizationId && q.key === session[t.index]!.key);
      return earlier.some((q) => q.text === session[t.index]!.text);
    });
    expect(verbatimMisses).toEqual([]);
  });
});
