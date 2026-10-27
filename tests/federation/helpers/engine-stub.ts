/**
 * A stand-in "Zetaris engine" for the oracle tests: it answers the REST route from its own DuckDB instance and
 * renders values the way Spark prints them (timestamps with a trailing `.0`, every value a string). Because it runs
 * on a separate DuckDB instance from the oracle, a change to one instance's data is a genuine disagreement for the
 * harness to find. It does not prove anything about the real engine; live.test.ts does that when a stack is up.
 */
import type { DuckDbFallbackPort } from "../../../src/federation/fallback.ts";
import { PortError, type FederationResult } from "../../../src/ports/index.ts";
import type { StubHandler, StubReply } from "./zetaris-stub.ts";

function sparkText(value: unknown, type: string): string | null {
  if (value === null || value === undefined) return null;
  if (type === "timestamp" && typeof value === "string") {
    const spaced = value.replace("T", " ");
    return /\.\d/.test(spaced) ? spaced : `${spaced}.0`;
  }
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return String(value);
}

export function toWire(result: FederationResult): StubReply {
  return {
    body: {
      headers: result.columns.map((c) => c.name),
      data: result.rows.map((row) => result.columns.map((c) => sparkText(row[c.name], c.type))),
      total: result.total,
      timeUsed: 3,
    },
  };
}

export function engineHandler(engine: DuckDbFallbackPort): StubHandler {
  return async (req) => {
    const sql = String(req.json?.["sql"] ?? "");
    const limit = Number(req.json?.["limit"] ?? 5000);
    try {
      return toWire(await engine.sql(sql, { limit }));
    } catch (e) {
      if (e instanceof PortError && e.failure === "TRUNCATED") {
        // Behave like the real route: return `limit` rows and report the full total.
        const all = await engine.sql(sql, { limit: 100_000 });
        return toWire({ ...all, rows: all.rows.slice(0, limit) });
      }
      return { status: 400, body: { msg: e instanceof Error ? e.message : String(e) } };
    }
  };
}
