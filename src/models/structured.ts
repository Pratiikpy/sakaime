import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { PortError } from "../ports/index.ts";
import { hashOf } from "../util/canonical.ts";
import type { ChatUsage } from "./chat.ts";

/*
 * Structured output: take the model's reply, find the one JSON value in it, validate the whole value against the
 * caller's schema, and either return it complete or fail. A partially parsed object is never returned.
 */

type AnyAjv = Ajv | InstanceType<typeof Ajv2020>;
type AddFormats = (ajv: AnyAjv) => unknown;
const addFormats: AddFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ?? addFormatsModule) as AddFormats;

/** Opening and closing reasoning tags some serving stacks leave in `content`. */
const THINK_OPEN = /<(think|thinking)>/i;

/**
 * Removes reasoning the model wrote into the reply: leading `<think>...</think>` blocks, and everything up to a lone
 * closing tag when the serving template supplied the opening one. A leading block that never closes means the reply is
 * all reasoning, so nothing is left. Tags in the middle of the text are data and are left alone.
 */
export function stripReasoning(text: string): string {
  let t = text;
  for (;;) {
    const m = /^\s*<(think|thinking)>[\s\S]*?<\/\1>/i.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  if (/^\s*<(think|thinking)>/i.test(t)) return "";
  if (!THINK_OPEN.test(t)) {
    const lower = t.toLowerCase();
    const closes = ["</think>", "</thinking>"].map((tag) => ({ tag, at: lower.lastIndexOf(tag) })).filter((c) => c.at >= 0);
    if (closes.length > 0) {
      const last = closes.reduce((a, b) => (b.at > a.at ? b : a));
      t = t.slice(last.at + last.tag.length);
    }
  }
  return t.trim();
}

/** Every balanced top-level `{...}` or `[...]` in the text, honouring JSON strings and escapes. */
function balancedValues(text: string): { values: string[]; cutOff: boolean } {
  const out: string[] = [];
  let cutOff = false;
  let i = 0;
  while (i < text.length) {
    const open = text[i];
    if (open !== "{" && open !== "[") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j] as string;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") depth += 1;
      else if (c === "}" || c === "]") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      cutOff = true; // unbalanced: the reply was cut off, or a brace is prose
      break;
    }
    out.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return { values: out, cutOff };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export type Extraction = { ok: true; value: unknown; json: string } | { ok: false; message: string };

/**
 * Finds the single JSON value in a reply. Order: the whole reply; the only fenced block; the only balanced top-level
 * value in the prose. If more than one distinct value could be meant, it refuses to choose.
 */
export function extractJson(reply: string): Extraction {
  const whole = tryParse(reply.trim());
  if (whole.ok) return { ok: true, value: whole.value, json: reply.trim() };

  const text = stripReasoning(reply);
  if (text === "") return { ok: false, message: "the reply holds no answer after the reasoning was removed" };
  const direct = tryParse(text);
  if (direct.ok) return { ok: true, value: direct.value, json: text };

  const fenced: string[] = [];
  for (const m of text.matchAll(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)) fenced.push((m[1] ?? "").trim());
  const fencedValues = fenced.filter((f) => tryParse(f).ok);
  if (fencedValues.length === 1) {
    const only = fencedValues[0] as string;
    return { ok: true, value: (tryParse(only) as { value: unknown }).value, json: only };
  }
  if (fencedValues.length > 1) return { ok: false, message: `the reply holds ${fencedValues.length} separate JSON blocks and it cannot tell which is meant` };

  const scanned = balancedValues(text);
  const values = scanned.values.filter((v) => tryParse(v).ok);
  if (values.length > 0 && scanned.cutOff) return { ok: false, message: "the reply holds a JSON value and then an unfinished one, so it cannot tell which is meant" };
  if (values.length === 1) {
    const only = values[0] as string;
    return { ok: true, value: (tryParse(only) as { value: unknown }).value, json: only };
  }
  if (values.length > 1) return { ok: false, message: `the reply holds ${values.length} separate JSON values and it cannot tell which is meant` };
  return { ok: false, message: "the reply holds no complete JSON value (it may have been cut off)" };
}

export class SchemaValidator {
  private readonly compiled = new Map<string, ValidateFunction>();
  private readonly ajv = new Map<"draft7" | "2020", AnyAjv>();

  private engine(schema: Record<string, unknown>): AnyAjv {
    const kind = typeof schema["$schema"] === "string" && (schema["$schema"] as string).includes("2020-12") ? "2020" : "draft7";
    let engine = this.ajv.get(kind);
    if (!engine) {
      // strict is off so a schema may carry annotations; nothing is coerced, defaulted or stripped, so a validated
      // value is exactly what the model wrote.
      const options = { allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false };
      engine = kind === "2020" ? new Ajv2020(options) : new Ajv(options);
      addFormats(engine);
      this.ajv.set(kind, engine);
    }
    return engine;
  }

  compile(schema: Record<string, unknown>): ValidateFunction {
    const key = hashOf(schema);
    const hit = this.compiled.get(key);
    if (hit) return hit;
    let validate: ValidateFunction;
    try {
      validate = this.engine(schema).compile(schema);
    } catch (error) {
      throw new PortError("INVALID", `jsonSchema is not a valid JSON Schema: ${(error as Error).message}`);
    }
    if (this.compiled.size >= 64) this.compiled.delete(this.compiled.keys().next().value as string);
    this.compiled.set(key, validate);
    return validate;
  }

  /** Returns undefined when valid, otherwise a short description of the first problems. */
  problems(schema: Record<string, unknown>, value: unknown): string | undefined {
    const validate = this.compile(schema);
    if (validate(value)) return undefined;
    const errors = validate.errors ?? [];
    const lines = errors.slice(0, 5).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
    const more = errors.length > 5 ? `; and ${errors.length - 5} more` : "";
    const text = `${lines.join("; ")}${more}`;
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  }
}

export interface StructuredResult {
  value: unknown;
  /** The exact JSON text that parsed. */
  json: string;
}

export function parseAgainstSchema(reply: string, schema: Record<string, unknown>, validator: SchemaValidator): { ok: true; result: StructuredResult } | { ok: false; message: string } {
  const found = extractJson(reply);
  if (!found.ok) return { ok: false, message: found.message };
  const problems = validator.problems(schema, found.value);
  if (problems !== undefined) return { ok: false, message: `the JSON does not match the schema: ${problems}` };
  return { ok: true, result: { value: found.value, json: found.json } };
}

export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "Reply with one JSON value that validates against the JSON Schema below, and nothing else: no code fence, no commentary before or after.",
    "JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

export function repairMessage(problem: string): string {
  return `Your previous reply was not accepted: ${problem}\nReply again with one complete JSON value that validates against the schema, and nothing else.`;
}

/**
 * Usage is `measured` only when the provider returned both token counts for every call that made up the reply.
 * Otherwise the figures are an estimate (one token per four characters) and say so.
 */
export function combineUsage(calls: { usage?: ChatUsage; promptChars: number; completionChars: number }[]): { promptTokens: number; completionTokens: number; measured: boolean } {
  let promptTokens = 0;
  let completionTokens = 0;
  let measured = calls.length > 0;
  for (const call of calls) {
    const p = call.usage?.promptTokens;
    const c = call.usage?.completionTokens;
    if (p === undefined || c === undefined) measured = false;
    promptTokens += p ?? Math.ceil(call.promptChars / 4);
    completionTokens += c ?? Math.ceil(call.completionChars / 4);
  }
  return { promptTokens, completionTokens, measured };
}
