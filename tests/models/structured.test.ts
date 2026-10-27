import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { combineUsage, extractJson, parseAgainstSchema, SchemaValidator, stripReasoning } from "../../src/models/structured.ts";
import { PortError } from "../../src/ports/index.ts";

const schema = {
  type: "object",
  properties: { label: { type: "string", enum: ["a", "b"] }, n: { type: "integer", minimum: 0 } },
  required: ["label", "n"],
  additionalProperties: false,
};

describe("stripReasoning", () => {
  it("removes a leading think block", () => {
    expect(stripReasoning("<think>let me see</think>\n{\"a\":1}")).toBe('{"a":1}');
  });
  it("removes several leading blocks", () => {
    expect(stripReasoning("<think>a</think><think>b</think>answer")).toBe("answer");
  });
  it("removes everything up to a lone closing tag (the template supplied the opening one)", () => {
    expect(stripReasoning("I reasoned about it.\n</think>\nanswer")).toBe("answer");
  });
  it("returns nothing for a leading block that never closes: the reply is all reasoning", () => {
    expect(stripReasoning("<think>still thinking and the budget ran out")).toBe("");
  });
  it("leaves a tag in the middle of the text alone", () => {
    expect(stripReasoning('He wrote <think> in the margin.')).toBe("He wrote <think> in the margin.");
  });
  it("is case-insensitive about the tag", () => {
    expect(stripReasoning("<THINK>x</THINK>ok")).toBe("ok");
  });
});

describe("extractJson", () => {
  it("parses a bare object", () => {
    const r = extractJson('{"label":"a","n":1}');
    expect(r).toMatchObject({ ok: true, value: { label: "a", n: 1 } });
  });
  it("parses a fenced block", () => {
    const r = extractJson('Here you go:\n```json\n{"label":"a","n":1}\n```\nDone.');
    expect(r).toMatchObject({ ok: true, value: { label: "a", n: 1 } });
  });
  it("parses a reply that is entirely one fenced block", () => {
    expect(extractJson('```\n[1,2,3]\n```')).toMatchObject({ ok: true, value: [1, 2, 3] });
  });
  it("finds the one object in surrounding prose", () => {
    expect(extractJson('The answer is {"label":"b","n":2} as requested.')).toMatchObject({ ok: true, value: { label: "b", n: 2 } });
  });
  it("skips a reasoning block that contains braces", () => {
    const r = extractJson('<think>maybe {"label":"zzz"}?</think>{"label":"a","n":1}');
    expect(r).toMatchObject({ ok: true, value: { label: "a", n: 1 } });
  });
  it("handles braces and quotes inside strings", () => {
    const r = extractJson('prefix {"label":"a","n":1,"note":"a } and a \\" quote"} suffix');
    expect(r).toMatchObject({ ok: true, value: { note: 'a } and a " quote' } });
  });
  it("does not strip text that is itself valid JSON, even if a string holds a tag", () => {
    const r = extractJson('{"label":"a","n":1,"note":"</think> literal"}');
    expect(r).toMatchObject({ ok: true, value: { note: "</think> literal" } });
  });
  it("refuses to choose between two separate JSON values in prose", () => {
    const r = extractJson('first {"label":"a","n":1} then {"label":"b","n":2}');
    expect(r.ok).toBe(false);
  });
  it("refuses to choose between two fenced blocks", () => {
    const r = extractJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```');
    expect(r.ok).toBe(false);
  });
  it("refuses a value followed by an unfinished one", () => {
    expect(extractJson('{"a":1} and then {"b":').ok).toBe(false);
  });
  it("never returns a partial object from a truncated reply", () => {
    expect(extractJson('{"label":"a","n":').ok).toBe(false);
    expect(extractJson('{"label":"a","items":[1,2,').ok).toBe(false);
  });
  it("fails on a reply that is only reasoning", () => {
    expect(extractJson("<think>no answer yet").ok).toBe(false);
  });
  it("fails on empty and on prose without JSON", () => {
    expect(extractJson("").ok).toBe(false);
    expect(extractJson("I cannot do that.").ok).toBe(false);
  });
  it("never throws on arbitrary text (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = extractJson(s);
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 300 },
    );
  });
  it("round-trips any JSON value placed in prose (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue().filter((v) => typeof v === "object" && v !== null), (value) => {
        const text = `Result:\n${JSON.stringify(value)}\nThat is all.`;
        const r = extractJson(text);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 200 },
    );
  });
});

describe("SchemaValidator and parseAgainstSchema", () => {
  const validator = new SchemaValidator();
  it("accepts a conforming value and returns exactly what was written", () => {
    const r = parseAgainstSchema('{"label":"a","n":3}', schema, validator);
    expect(r).toMatchObject({ ok: true, result: { value: { label: "a", n: 3 } } });
  });
  it("rejects a wrong enum, a missing field and an extra field, naming the path", () => {
    const wrong = parseAgainstSchema('{"label":"c","n":1}', schema, validator);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toMatch(/label/);
    expect(parseAgainstSchema('{"label":"a"}', schema, validator).ok).toBe(false);
    expect(parseAgainstSchema('{"label":"a","n":1,"x":1}', schema, validator).ok).toBe(false);
  });
  it("does not coerce types or fill in defaults", () => {
    expect(parseAgainstSchema('{"label":"a","n":"3"}', schema, validator).ok).toBe(false);
    const withDefault = { type: "object", properties: { a: { type: "integer", default: 5 } }, required: ["a"] };
    expect(parseAgainstSchema("{}", withDefault, validator).ok).toBe(false);
  });
  it("supports draft 2020-12 schemas and string formats", () => {
    const s2020 = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { when: { type: "string", format: "date" } }, required: ["when"] };
    expect(parseAgainstSchema('{"when":"2026-10-27"}', s2020, validator).ok).toBe(true);
    expect(parseAgainstSchema('{"when":"27 October"}', s2020, validator).ok).toBe(false);
  });
  it("throws INVALID for a schema that is not a schema", () => {
    expect(() => validator.compile({ type: "nonsense" })).toThrowError(PortError);
  });
  it("caps the description of problems", () => {
    const strict = { type: "object", properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, { type: "integer" }])), required: Array.from({ length: 30 }, (_, i) => `k${i}`) };
    const r = parseAgainstSchema("{}", strict, validator);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeLessThan(800);
  });
});

describe("combineUsage", () => {
  it("is measured only when every call reported both counts", () => {
    expect(combineUsage([{ usage: { promptTokens: 10, completionTokens: 5 }, promptChars: 40, completionChars: 20 }])).toEqual({ promptTokens: 10, completionTokens: 5, measured: true });
  });
  it("is estimated, and says so, when a count is missing", () => {
    const u = combineUsage([{ promptChars: 40, completionChars: 21 }]);
    expect(u).toEqual({ promptTokens: 10, completionTokens: 6, measured: false });
  });
  it("is estimated when only some calls were measured", () => {
    const u = combineUsage([
      { usage: { promptTokens: 10, completionTokens: 5 }, promptChars: 40, completionChars: 20 },
      { usage: { promptTokens: 3 }, promptChars: 8, completionChars: 8 },
    ]);
    expect(u.measured).toBe(false);
    expect(u.promptTokens).toBe(13);
  });
  it("is not measured when there are no calls", () => {
    expect(combineUsage([]).measured).toBe(false);
  });
});
