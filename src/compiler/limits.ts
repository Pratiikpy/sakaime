/*
 * Explicit purpose limits stated by an authorization record.
 *
 * The evidence schema carries scope values but no negations. A sentence such as "not intended to be used as a diagnostic device"
 * must still reach the compiler as something it can test a claimed purpose against, without anyone parsing prose inside the
 * compiler. The reader therefore writes it into the item's `limitations` in one fixed, versioned form, with the verbatim
 * sentence kept, and the compiler reads only that form:
 *
 *   excludes purpose [<taxonomy node>] (absolute|qualified): <verbatim sentence>
 *
 * absolute   the sentence excludes the purpose outright ("is not intended to be used as a diagnostic device")
 * qualified  the sentence excludes it with a reservation the code does not interpret ("stand-alone", "primary", "solely",
 *            "beyond notification"): a claim of that purpose is sent to a reviewer instead of being contradicted.
 *
 * A limitation that does not match the form is free text and is ignored here, so no prose is ever guessed into a rule.
 */

export type PurposeExclusionStrength = "absolute" | "qualified";

export interface PurposeExclusion {
  /** A purpose taxonomy key or alias. */
  node: string;
  strength: PurposeExclusionStrength;
  /** The sentence of the record the limit was read from. */
  sentence: string;
}

const FORM = /^excludes purpose \[([A-Za-z0-9_ -]{1,60})\] \((absolute|qualified)\): ([\s\S]+)$/;

export function formatPurposeExclusion(e: PurposeExclusion): string {
  return `excludes purpose [${e.node}] (${e.strength}): ${e.sentence.replace(/\s+/g, " ").trim()}`;
}

export function parsePurposeExclusion(limitation: string): PurposeExclusion | undefined {
  const m = FORM.exec(limitation.trim());
  if (!m) return undefined;
  return { node: m[1] as string, strength: m[2] as PurposeExclusionStrength, sentence: (m[3] as string).trim() };
}
