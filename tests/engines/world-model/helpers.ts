import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorldModel, type WorldModelOptions } from "../../../src/engines/world-model/index.ts";

export const T = (iso: string) => ({ kind: "manual", at: iso });
export const src = (kind: string, at: string, by?: string) => ({ kind, at, ...(by ? { by } : {}) });

/** A record-time clock the test advances by hand. */
export function steppedClock(start = "2026-01-01T00:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    clock: () => new Date(ms),
    set: (iso: string) => {
      ms = Date.parse(iso);
    },
    advanceDays: (d: number) => {
      ms += d * 86_400_000;
    },
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-wm-"));
}

export function memoryWorld(extra: Partial<WorldModelOptions> = {}): WorldModel {
  return new WorldModel({ storage: "memory", namespace: "t", ...extra });
}

export async function device(world: WorldModel, key: string, at = "2026-01-01T00:00:00.000Z") {
  return world.upsertEntity({ type: "device", externalKey: { system: "fda", id: key }, name: key, source: T(at) });
}

export async function study(world: WorldModel, key: string, at = "2026-01-01T00:00:00.000Z") {
  return world.upsertEntity({ type: "study", externalKey: { system: "nct", id: key }, name: key, source: T(at) });
}
