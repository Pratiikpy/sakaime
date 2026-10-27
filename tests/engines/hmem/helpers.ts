import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HMEM, type HMEMOptions } from "../../../src/engines/hmem/index.ts";

export const T0 = 1_750_000_000_000;
export const DAY = 86_400_000;

/** A clock the test moves by hand. */
export function manualClock(start = T0) {
  let now = start;
  return {
    clock: () => now,
    advanceDays: (d: number) => {
      now += d * DAY;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-hmem-"));
}

export function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function memory(extra: HMEMOptions = {}): { hmem: HMEM; time: ReturnType<typeof manualClock> } {
  const time = manualClock();
  return { hmem: new HMEM({ clock: time.clock, ...extra }), time };
}

export const actions = (hmem: HMEM, id: string): string[] => hmem.ledger.history(id).map((e) => e.action);
