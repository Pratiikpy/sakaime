import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultClassify, discoverCatalog } from "../../src/federation/catalog.ts";
import { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { PortError, type CheckResult, type FederationPort, type FederationResult } from "../../src/ports/index.ts";
import { SourceSchema } from "../../src/schemas/evidence.ts";
import { fixturePort } from "./helpers/fixtures.ts";

/** A scripted engine: each statement maps to a result or a failure. Records what was asked. */
class ScriptedPort implements FederationPort {
  readonly mode = "live" as const;
  readonly asked: string[] = [];
  constructor(private readonly script: Record<string, FederationResult | PortError>) {}
  async sql(statement: string): Promise<FederationResult> {
    this.asked.push(statement);
    const hit = this.script[statement];
    if (hit === undefined) throw new PortError("INVALID", `unscripted statement: ${statement}`);
    if (hit instanceof PortError) throw hit;
    return hit;
  }
  async check(): Promise<CheckResult> {
    return { health: "OK", detail: "scripted", latencyMs: 0, checkedAt: "2026-10-27T00:00:00.000Z" };
  }
}

const table = (headers: string[], rows: string[][]): FederationResult => ({
  columns: headers.map((name) => ({ name, type: "string" })),
  rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))),
  total: rows.length,
  queryId: `q-${headers.join("")}-${rows.length}`,
  servedFrom: "live",
  respHash: "h",
  elapsedMs: 1,
});

const clock = { now: () => new Date("2026-10-27T06:00:00.000Z") };

describe("discoverCatalog over the DuckDB stand-in for Zetaris", () => {
  let port: DuckDbFallbackPort;
  beforeEach(async () => {
    port = await fixturePort();
  });
  afterEach(() => port.close());

  it("turns every registered database into a valid Source with the tables it holds", async () => {
    const snap = await discoverCatalog(port, { clock });
    expect(snap.capturedAt).toBe("2026-10-27T06:00:00.000Z");
    expect(snap.sources.map((x) => x.id).sort()).toEqual(["zetaris:hospital", "zetaris:registry", "zetaris:regulator", "zetaris:vendor_packets"]);
    for (const source of snap.sources) {
      expect(() => SourceSchema.parse(source)).not.toThrow();
      expect(source.access).toBe("zetaris");
      expect(source.health).toBe("OK");
      expect(source.schemaHash).toMatch(/^[0-9a-f]{64}$/);
      expect(source.lastSuccessAt).toBe("2026-10-27T06:00:00.000Z");
    }
    expect(snap.tables["zetaris:hospital"]).toContain("identity_links");
    expect(snap.tables["zetaris:registry"]).toEqual(["studies"]);
    expect(snap.databases.find((d) => d.name === "hospital")?.kind).toBe("datasource");
    expect(snap.queryIds.length).toBe(2 + 4);
  });

  it("classifies the project's own silos and gives them the right data class", async () => {
    const byId = Object.fromEntries((await discoverCatalog(port, { clock })).sources.map((x) => [x.id, x]));
    expect(byId["zetaris:regulator"]).toMatchObject({ kind: "regulator", dataClass: "public" });
    expect(byId["zetaris:registry"]).toMatchObject({ kind: "registry", dataClass: "public" });
    expect(byId["zetaris:hospital"]).toMatchObject({ kind: "hospital", dataClass: "vendor-confidential" });
    expect(byId["zetaris:vendor_packets"]).toMatchObject({ kind: "vendor", dataClass: "vendor-confidential" });
  });

  it("shows a database added in Zetaris without any code change, unclassified and at the most restrictive data class", async () => {
    const before = await discoverCatalog(port, { clock });
    // The same instance cannot gain a database after it has answered, so the added database goes into a second one.
    const p2 = await DuckDbFallbackPort.create();
    await p2.registerTable("trial_site.visits", [{ name: "visit_id", type: "string" }], [["v1"], ["v2"]], { sourceKind: "lightning", description: "Trial site visits" });
    const after = await discoverCatalog(p2, { clock });
    const added = after.sources.find((x) => x.id === "zetaris:trial_site")!;
    expect(added).toMatchObject({ kind: "other", license: "UNSPECIFIED", dataClass: "phi", health: "OK" });
    expect(added.descriptor).toContain("Trial site visits");
    expect(after.tables["zetaris:trial_site"]).toEqual(["visits"]);
    expect(before.sources.some((x) => x.id === "zetaris:trial_site")).toBe(false);
    p2.close();
  });

  it("lets the caller classify a source, which replaces the default only for what it states", async () => {
    const snap = await discoverCatalog(port, {
      clock,
      classify: (db) => (db.name === "registry" ? { kind: "registry", license: "CC0", dataClass: "public", descriptor: "ClinicalTrials.gov snapshot" } : undefined),
    });
    const registry = snap.sources.find((x) => x.id === "zetaris:registry")!;
    expect(registry).toMatchObject({ license: "CC0", descriptor: "ClinicalTrials.gov snapshot" });
    expect(snap.sources.find((x) => x.id === "zetaris:regulator")).toMatchObject({ kind: "regulator" }); // built-in knowledge still applies
  });

  it("changes the schema hash when a table appears, and not otherwise", async () => {
    const first = await discoverCatalog(port, { clock });
    const again = await discoverCatalog(port, { clock });
    expect(again.sources.map((x) => x.schemaHash)).toEqual(first.sources.map((x) => x.schemaHash));
    const extra = await DuckDbFallbackPort.create();
    await extra.registerTable("registry.studies", [{ name: "nct_id", type: "string" }], []);
    await extra.registerTable("registry.sites", [{ name: "site_id", type: "string" }], []);
    const widened = await discoverCatalog(extra, { clock });
    const hashOf = (s: typeof first, id: string): string | undefined => s.sources.find((x) => x.id === id)?.schemaHash;
    expect(hashOf(widened, "zetaris:registry")).not.toBe(hashOf(first, "zetaris:registry"));
    extra.close();
  });

  it("reads column names too when asked, and folds them into the hash", async () => {
    const plain = await discoverCatalog(port, { clock });
    const withColumns = await discoverCatalog(port, { clock, withColumns: true });
    expect(withColumns.columns["zetaris:registry/studies"]).toEqual(["nct_id", "title", "overall_status", "conditions", "enrollment", "start_date", "completion_date", "intervention_device"]);
    expect(withColumns.sources.find((x) => x.id === "zetaris:registry")!.schemaHash).not.toBe(plain.sources.find((x) => x.id === "zetaris:registry")!.schemaHash);
  });
});

describe("discoverCatalog failure semantics", () => {
  const dbs = (rows: string[][]) => table(["name", "description", "id"], rows);
  const tables = (names: string[]) => table(["namespace", "tableName", "isTemporary"], names.map((n) => ["x", n, "false"]));

  it("an empty listing is an empty catalog, not an error", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([]), "SHOW DATASOURCES": dbs([]) });
    const snap = await discoverCatalog(port, { clock });
    expect(snap.sources).toEqual([]);
    expect(snap.databases).toEqual([]);
  });

  it("a failed top-level listing is thrown, because it cannot be told from 'nothing registered'", async () => {
    for (const failure of ["UNAVAILABLE", "FORBIDDEN", "DRIFTED"] as const) {
      const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": new PortError(failure, "down") });
      await expect(discoverCatalog(port, { clock })).rejects.toMatchObject({ failure });
    }
    const second = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([]), "SHOW DATASOURCES": new PortError("UNAVAILABLE", "down") });
    await expect(discoverCatalog(second, { clock })).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("a database whose table listing fails keeps its place with health that says why", async () => {
    const port = new ScriptedPort({
      "SHOW LIGHTNING DATABASES": dbs([["alpha", "a", "1"], ["beta", "b", "2"], ["gamma", "c", "3"], ["delta", "d", "4"]]),
      "SHOW DATASOURCES": dbs([]),
      "SHOW TABLES IN alpha": new PortError("UNAVAILABLE", "down"),
      "SHOW TABLES IN beta": new PortError("FORBIDDEN", "no access"),
      "SHOW TABLES IN gamma": new PortError("DRIFTED", "shape"),
      "SHOW TABLES IN delta": tables(["t"]),
    });
    const snap = await discoverCatalog(port, { clock });
    const health = Object.fromEntries(snap.sources.map((x) => [x.id, x.health]));
    expect(health).toEqual({ "zetaris:alpha": "UNAVAILABLE", "zetaris:beta": "FORBIDDEN", "zetaris:gamma": "DRIFTED", "zetaris:delta": "OK" });
    expect(snap.sources.find((x) => x.id === "zetaris:alpha")!.schemaHash).toBeUndefined();
    expect(snap.sources.find((x) => x.id === "zetaris:alpha")!.lastSuccessAt).toBeUndefined();
    expect(snap.tables["zetaris:alpha"]).toEqual([]);
  });

  it("a database with no tables is EMPTY, which is different from unavailable", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([["alpha", "a", "1"]]), "SHOW DATASOURCES": dbs([]), "SHOW TABLES IN alpha": tables([]) });
    const snap = await discoverCatalog(port, { clock });
    expect(snap.sources[0]).toMatchObject({ health: "EMPTY", lastSuccessAt: "2026-10-27T06:00:00.000Z" });
  });

  it("does not query a database whose name could not be addressed safely", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([["bad-name; DROP", "x", "1"], ["good", "y", "2"]]), "SHOW DATASOURCES": dbs([]), "SHOW TABLES IN good": tables(["t"]) });
    const snap = await discoverCatalog(port, { clock });
    expect(port.asked).not.toContain("SHOW TABLES IN bad-name; DROP");
    expect(port.asked.some((q) => q.includes("DROP"))).toBe(false);
    expect(snap.sources.find((x) => x.id === "zetaris:bad-name; drop")).toMatchObject({ health: "UNAVAILABLE" });
    expect(snap.sources.find((x) => x.id === "zetaris:good")).toMatchObject({ health: "OK" });
  });

  it("fails as DRIFTED, not by guessing, when the listing has no name column", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": table(["foo", "bar"], [["a", "b"]]), "SHOW DATASOURCES": dbs([]) });
    await expect(discoverCatalog(port, { clock })).rejects.toMatchObject({ failure: "DRIFTED", detail: { reason: "CATALOG_SHAPE" } });
  });

  it("marks a database DRIFTED when its table listing has no table-name column", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([["alpha", "a", "1"]]), "SHOW DATASOURCES": dbs([]), "SHOW TABLES IN alpha": table(["foo"], [["x"]]) });
    expect((await discoverCatalog(port, { clock })).sources[0]!.health).toBe("DRIFTED");
  });

  it("accepts other plausible header spellings for the same columns", async () => {
    const port = new ScriptedPort({
      "SHOW LIGHTNING DATABASES": table(["Database", "Description", "Id"], [["alpha", "a", "1"]]),
      "SHOW DATASOURCES": dbs([]),
      "SHOW TABLES IN alpha": table(["table_name"], [["t1"], ["t2"]]),
    });
    expect((await discoverCatalog(port, { clock })).tables["zetaris:alpha"]).toEqual(["t1", "t2"]);
  });

  it("tries the documented datasource listing only for a datasource, and only when the generic form is rejected as invalid", async () => {
    const port = new ScriptedPort({
      "SHOW LIGHTNING DATABASES": dbs([]),
      "SHOW DATASOURCES": dbs([["pg", "postgres", "9"]]),
      "SHOW TABLES IN pg": new PortError("INVALID", "unsupported"),
      "SHOW DATASOURCE TABLES pg": table(["tableName"], [["orders"]]),
    });
    const snap = await discoverCatalog(port, { clock });
    expect(port.asked).toContain("SHOW DATASOURCE TABLES pg");
    expect(snap.tables["zetaris:pg"]).toEqual(["orders"]);

    const lightning = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([["files", "f", "1"]]), "SHOW DATASOURCES": dbs([]), "SHOW TABLES IN files": new PortError("INVALID", "unsupported") });
    expect((await discoverCatalog(lightning, { clock })).sources[0]!.health).toBe("UNAVAILABLE");
    expect(lightning.asked.some((q) => q.startsWith("SHOW DATASOURCE TABLES"))).toBe(false);
  });

  it("lists a name once when both listings return it", async () => {
    const port = new ScriptedPort({ "SHOW LIGHTNING DATABASES": dbs([["dup", "a", "1"]]), "SHOW DATASOURCES": dbs([["DUP", "b", "2"]]), "SHOW TABLES IN dup": tables(["t"]) });
    expect((await discoverCatalog(port, { clock })).sources).toHaveLength(1);
  });

  it("asks as the identity given, so the catalog shows what that reviewer may see", async () => {
    const seen: (string | undefined)[] = [];
    const port: FederationPort = {
      mode: "live",
      sql: async (statement, options) => {
        seen.push(options?.identity);
        return statement.startsWith("SHOW TABLES") ? tables([]) : statement === "SHOW LIGHTNING DATABASES" ? dbs([["alpha", "a", "1"]]) : dbs([]);
      },
      check: async () => ({ health: "OK", detail: "", latencyMs: 0, checkedAt: "2026-10-27T00:00:00.000Z" }),
    };
    await discoverCatalog(port, { clock, identity: "reviewer" });
    expect(seen.every((i) => i === "reviewer")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("defaultClassify", () => {
  it("knows the project's databases and nothing else", () => {
    expect(defaultClassify({ name: "HOSPITAL", description: "", kind: "datasource" })?.kind).toBe("hospital");
    expect(defaultClassify({ name: "NY_TAXI", description: "", kind: "lightning" })).toBeUndefined();
  });
});
