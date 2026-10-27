import { type ISODate, WorldModelError } from "./types.ts";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalises a timestamp to the canonical `toISOString()` form so that lexicographic order is
 * chronological order everywhere in the store. A bare date means "by the end of that day" when it is
 * used as a query point (`endOfDay`), which is what "what did we know on 2026-03-01" asks for; as a
 * written value it means the start of the day.
 */
export function toIso(value: string | Date, label: string, opts: { endOfDay?: boolean } = {}): ISODate {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new WorldModelError("INVALID_INPUT", `${label} is an invalid Date`);
    return value.toISOString();
  }
  if (typeof value !== "string" || value === "") throw new WorldModelError("INVALID_INPUT", `${label} must be an ISO-8601 string or a Date`);
  // A time of day without an offset would be read in the machine's local zone, which breaks replay on another machine.
  if (!DATE_ONLY.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new WorldModelError("INVALID_INPUT", `${label} needs a UTC offset (e.g. a trailing Z): ${JSON.stringify(value)}`);
  }
  const text = DATE_ONLY.test(value) ? `${value}${opts.endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}` : value;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new WorldModelError("INVALID_INPUT", `${label} is not a valid timestamp: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}
