/**
 * Checks against a real Zetaris instance. These run only when ZETARIS_REST_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID
 * are set (in the environment, or in a local .env that is never committed); otherwise they are skipped and say so.
 * Everything here is read-only and uses the default identity.
 *
 * What they establish that the local test server cannot: that the request shape is accepted, that SELECT 1 and the
 * discovery statements work, that the portable string-literal form means the same thing on the real engine as on
 * DuckDB, how an unknown table and a wrong key are reported, and how the engine renders the types the casting layer
 * depends on.
 */
import { describe, expect, it } from "vitest";
import { discoverCatalog } from "../../src/federation/catalog.ts";
import { sqlString } from "../../src/federation/sql.ts";
import { ZetarisPort, zetarisConfigFromEnv } from "../../src/federation/zetaris-port.ts";
import { PortError } from "../../src/ports/index.ts";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env: rely on the process environment */
}

const config = zetarisConfigFromEnv(process.env);
const run = config ? describe : describe.skip;
if (!config) console.warn("live.test.ts: skipped, ZETARIS_REST_URL / ZETARIS_API_KEY / ZETARIS_ORG_ID are not set");

run("live Zetaris (read-only)", () => {
  const port = (): ZetarisPort => new ZetarisPort({ ...config!, maxAttempts: 2 });

  it("answers SELECT 1 through the engine and reports the probe as healthy", async () => {
    const c = await port().check();
    expect(c.health, c.detail).toBe("OK");
    const r = await port().sql("SELECT 1 AS one", { schema: { one: "integer" } });
    expect(r.rows).toEqual([{ one: 1 }]);
    expect(r.servedFrom).toBe("live");
  });

  it("lists the Lightning databases and the datasources, and maps them to sources", async () => {
    const snap = await discoverCatalog(port());
    expect(Array.isArray(snap.sources)).toBe(true);
    for (const source of snap.sources) expect(["OK", "EMPTY", "FORBIDDEN", "UNAVAILABLE", "DRIFTED"]).toContain(source.health);
  });

  it("means the same thing by a quote or a backslash in a value as DuckDB does", async () => {
    for (const value of ["it's", "a\\b", "x'; DROP TABLE t; --", "''", "\\'"]) {
      const r = await port().sql(`SELECT ${sqlString(value)} AS v`);
      expect(r.rows, JSON.stringify(value)).toEqual([{ v: value }]);
    }
  });

  it("reports an unknown table as INVALID, not as an outage and not as an empty result", async () => {
    const e = await port().sql("SELECT * FROM no_such_database.no_such_table").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).failure).toBe("INVALID");
  });

  it("reports a wrong key as FORBIDDEN", async () => {
    const wrong = new ZetarisPort({ ...config!, identities: { default: { apiKey: "not-a-real-key-0000" } }, maxAttempts: 1 });
    const c = await wrong.check();
    expect(c.health).toBe("FORBIDDEN");
  });

  it("returns a typed timestamp, boolean and decimal the casting layer can read", async () => {
    const r = await port().sql("SELECT CAST('2026-08-31 11:22:21' AS TIMESTAMP) AS at, TRUE AS ok, CAST(1.250 AS DECIMAL(10,3)) AS d, CAST(NULL AS STRING) AS nothing", {
      schema: { at: "timestamp", ok: "boolean", d: "decimal" },
    });
    expect(r.rows).toEqual([{ at: "2026-08-31T11:22:21", ok: true, d: 1.25, nothing: null }]);
  });

  it("refuses a result larger than the limit instead of returning part of it", async () => {
    const e = await port()
      .sql("SELECT id FROM (SELECT explode(sequence(1, 50)) AS id) t", { limit: 10 })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).failure).toBe("TRUNCATED");
  });
});
