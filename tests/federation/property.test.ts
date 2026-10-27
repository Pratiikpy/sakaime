import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { canonicalJson } from "../../src/util/canonical.ts";

/**
 * The DuckDB fallback against a reference evaluation written in plain loops. The reference never touches SQL, so an
 * agreement means the translated statements compute what a join and an aggregation are defined to compute, NULL
 * keys and all.
 */
interface Left {
  k: number | null;
  v: number | null;
}
interface Right {
  k: number | null;
  w: number | null;
}

const key = fc.option(fc.integer({ min: 0, max: 4 }), { nil: null });
const val = fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null });
const lefts = fc.array(fc.record({ k: key, v: val }), { maxLength: 25 });
const rights = fc.array(fc.record({ k: key, w: val }), { maxLength: 25 });

const sum = (xs: (number | null)[]): number | null => {
  const present = xs.filter((x): x is number => x !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};

async function load(left: Left[], right: Right[]): Promise<DuckDbFallbackPort> {
  const port = await DuckDbFallbackPort.create();
  await port.registerTable("d.a", [{ name: "k", type: "integer" }, { name: "v", type: "integer" }], left.map((r) => [r.k, r.v]));
  await port.registerTable("d.b", [{ name: "k", type: "integer" }, { name: "w", type: "integer" }], right.map((r) => [r.k, r.w]));
  return port;
}

const canonicalRows = (rows: Record<string, unknown>[]): string[] => rows.map((r) => canonicalJson(r)).sort();

describe("fallback engine against a reference evaluation", () => {
  it("inner join with grouping: row counts, sums and NULL-key handling agree", async () => {
    await fc.assert(
      fc.asyncProperty(lefts, rights, async (left, right) => {
        const port = await load(left, right);
        try {
          const got = await port.sql("SELECT l.k AS k, COUNT(*) AS n, SUM(r.w) AS s FROM d.a l JOIN d.b r ON l.k = r.k GROUP BY l.k");
          // reference: a NULL key never matches; every (left, right) pair with equal non-null keys is one joined row
          const groups = new Map<number, (number | null)[]>();
          for (const l of left) {
            if (l.k === null) continue;
            for (const r of right) if (r.k === l.k) groups.set(l.k, [...(groups.get(l.k) ?? []), r.w]);
          }
          const expected = [...groups.entries()].map(([k, ws]) => ({ k, n: ws.length, s: sum(ws) }));
          expect(canonicalRows(got.rows)).toEqual(canonicalRows(expected));
        } finally {
          port.close();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("the headline shape, aggregate each side then LEFT JOIN: the left side's rows are never multiplied or dropped", async () => {
    await fc.assert(
      fc.asyncProperty(lefts, rights, async (left, right) => {
        const port = await load(left, right);
        try {
          const got = await port.sql(
            "SELECT l.k AS k, l.v AS v, COALESCE(r.cnt, 0) AS cnt, r.total AS total FROM d.a l " +
              "LEFT JOIN (SELECT k, COUNT(*) AS cnt, SUM(w) AS total FROM d.b GROUP BY k) r ON r.k = l.k",
          );
          expect(got.rows).toHaveLength(left.length); // no fan-out, no loss
          const expected = left.map((l) => {
            const matches = l.k === null ? [] : right.filter((r) => r.k === l.k);
            return { k: l.k, v: l.v, cnt: matches.length, total: matches.length === 0 ? null : sum(matches.map((m) => m.w)) };
          });
          expect(canonicalRows(got.rows)).toEqual(canonicalRows(expected));
        } finally {
          port.close();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("a filtered count with IN and CASE agrees", async () => {
    await fc.assert(
      fc.asyncProperty(lefts, async (left) => {
        const port = await load(left, []);
        try {
          const got = await port.sql("SELECT SUM(CASE WHEN k IN (1, 2) THEN 1 ELSE 0 END) AS hits, COUNT(v) AS present, MAX(v) AS top FROM d.a");
          const hits = left.filter((l) => l.k === 1 || l.k === 2).length;
          const present = left.filter((l) => l.v !== null).length;
          const top = left.reduce<number | null>((m, l) => (l.v === null ? m : m === null || l.v > m ? l.v : m), null);
          expect(got.rows).toEqual([{ hits: left.length === 0 ? null : hits, present, top }]);
        } finally {
          port.close();
        }
      }),
      { numRuns: 60 },
    );
  });
});
