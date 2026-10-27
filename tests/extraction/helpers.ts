import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "..", "..", "data", "fixtures", "feasibility");

export function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf8");
}

export function fixtureBytes(...parts: string[]): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, ...parts)));
}
