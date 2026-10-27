import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEvidenceMatrixSql,
  buildEvidenceRowsSql,
  EVIDENCE_MATRIX_SCHEMA,
  EVIDENCE_ROWS_SCHEMA,
  type EvidenceMatrixInput,
} from "../../src/federation/evidence-matrix.ts";
import type { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { assertReadOnly, prepareStatement } from "../../src/federation/sql.ts";
import { PortError } from "../../src/ports/index.ts";
import { fixturePort, TRICKY_DEVICE } from "./helpers/fixtures.ts";

let port: DuckDbFallbackPort;
beforeAll(async () => {
  port = await fixturePort();
});
afterAll(() => port.close());

const ED: EvidenceMatrixInput["intendedUse"] = { setting: "emergency department", purpose: "triage support" };
const matrix = async (input: EvidenceMatrixInput) => port.sql(buildEvidenceMatrixSql(input), { schema: EVIDENCE_MATRIX_SCHEMA });
const failure = (fn: () => unknown): PortError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected a PortError");
};

describe("buildEvidenceMatrixSql", () => {
  it("returns one summary row per submission and requirement, with each silo aggregated before the join", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: ED });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({
      submission_id: "S1",
      vendor_name: "Acme Imaging",
      device_name: "EyeScan AI",
      device_version: "2.1",
      packet_id: "PK1",
      claimed_setting: "emergency department",
      claimed_population: "adults",
      claimed_purpose: "triage support",
      requirement_id: "R1",
      required_setting: "emergency department",
      required_purpose: "triage support",
      min_validation_type: "external prospective",
      subgroup_reporting_required: true,
      update_control_required: true,
      regulator_confirmed: 2,
      regulator_candidates: 1,
      regulator_latest_decision: "2025-02-10",
      registry_confirmed: 2,
      registry_candidates: 1,
      registry_confirmed_enrollment: 650,
      registry_latest_completion: "2026-01-15",
      vendor_claims: 4,
      vendor_claims_for_version: 3,
    });
  });

  it("does not multiply rows: a naive join of the same silos inflates the counts the statement gets right", async () => {
    const naive = await port.sql(
      "SELECT s.submission_id AS submission_id FROM hospital.submissions s " +
        "JOIN hospital.identity_links la ON la.from_id = s.submission_id AND la.to_system = 'regulator' " +
        "JOIN hospital.identity_links lr ON lr.from_id = s.submission_id AND lr.to_system = 'registry' " +
        "JOIN vendor_packets.claims c ON c.packet_id = s.packet_id WHERE s.submission_id = 'S1'",
    );
    expect(naive.rows).toHaveLength(3 * 3 * 4); // authorizations x studies x claims: the fan-out
    const r = await matrix({ submissionId: "S1", intendedUse: ED });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!["vendor_claims"]).toBe(4); // not 36
  });

  it("keeps candidate and ambiguous links apart from confirmed ones", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: ED });
    expect(r.rows[0]).toMatchObject({ regulator_confirmed: 2, regulator_candidates: 1, registry_confirmed: 2, registry_candidates: 1 });
  });

  it("shows claims written for another version of the device", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: ED });
    expect(r.rows[0]).toMatchObject({ device_version: "2.1", vendor_claims: 4, vendor_claims_for_version: 3 });
  });

  it("selects the hospital requirement by setting and purpose, case-insensitively", async () => {
    expect((await matrix({ submissionId: "S1", intendedUse: { setting: "INPATIENT", purpose: "Triage Support" } })).rows[0]).toMatchObject({ requirement_id: "R2", required_setting: "inpatient" });
  });

  it("keeps the submission when no requirement matches, with the requirement columns unknown rather than defaulted", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: { setting: "outpatient", purpose: "triage support" } });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ requirement_id: null, min_validation_type: null, subgroup_reporting_required: null, regulator_confirmed: 2 });
  });

  it("zero is a count, not a missing value: a submission with no links reports 0 and null dates", async () => {
    const r = await matrix({ submissionId: "S2", intendedUse: { setting: "inpatient", purpose: "triage support" } });
    expect(r.rows[0]).toMatchObject({ regulator_confirmed: 0, regulator_candidates: 0, regulator_latest_decision: null, registry_confirmed_enrollment: null, vendor_claims: 1, vendor_claims_for_version: 1 });
  });

  it("finds a submission by device name and version, and returns no rows (not an error) for an unknown device", async () => {
    expect((await matrix({ deviceName: "eyescan ai", deviceVersion: "3.0", intendedUse: ED })).rows.map((x) => x["submission_id"])).toEqual(["S2"]);
    expect((await matrix({ deviceName: "EyeScan AI", intendedUse: ED })).rows.map((x) => x["submission_id"])).toEqual(["S1", "S2"]);
    const none = await matrix({ deviceName: "No Such Device", intendedUse: ED });
    expect(none.rows).toEqual([]);
  });

  it("reproduces a past review when given a date: records after it are left out", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: ED, asOf: "2025-01-01" });
    expect(r.rows[0]).toMatchObject({
      regulator_confirmed: 1,
      regulator_candidates: 0,
      regulator_latest_decision: "2024-05-01",
      registry_confirmed: 1,
      registry_candidates: 0,
      registry_confirmed_enrollment: 400,
    });
  });

  it("declares a type for every column it returns", async () => {
    const r = await matrix({ submissionId: "S1", intendedUse: ED });
    for (const c of r.columns) expect(EVIDENCE_MATRIX_SCHEMA, c.name).toHaveProperty(c.name);
    const raw = await port.sql(buildEvidenceMatrixSql({ submissionId: "S1", intendedUse: ED }));
    expect(raw.columns.map((c) => c.name)).toEqual(r.columns.map((c) => c.name));
  });

  it("is a single read-only statement that the live port accepts", () => {
    const prepared = prepareStatement(buildEvidenceMatrixSql({ submissionId: "S1", intendedUse: ED }));
    expect(() => assertReadOnly(prepared)).not.toThrow();
  });

  it("is deterministic", () => {
    const input: EvidenceMatrixInput = { deviceName: "EyeScan AI", deviceVersion: "2.1", intendedUse: ED, asOf: "2026-01-01" };
    expect(buildEvidenceMatrixSql(input)).toBe(buildEvidenceMatrixSql({ ...input }));
  });
});

describe("buildEvidenceRowsSql", () => {
  it("returns one row per source record with its source system, table, link state and version", async () => {
    const r = await port.sql(buildEvidenceRowsSql({ submissionId: "S1", intendedUse: ED }), { schema: EVIDENCE_ROWS_SCHEMA });
    expect(r.rows).toHaveLength(10);
    const bySystem = (s: string) => r.rows.filter((x) => x["source_system"] === s);
    expect(bySystem("regulator").map((x) => [x["record_id"], x["link_state"], x["version"]])).toEqual([
      ["A1", "CONFIRMED", "2.0"],
      ["A2", "CONFIRMED", "2.1"],
      ["A3", "CANDIDATE", "2.1"],
    ]);
    expect(bySystem("registry").map((x) => [x["record_id"], x["link_state"], x["amount"]])).toEqual([
      ["N1", "CONFIRMED", 400],
      ["N2", "CONFIRMED", 250],
      ["N3", "AMBIGUOUS", 100],
    ]);
    expect(bySystem("vendor_packet").map((x) => [x["record_id"], x["version"], x["link_state"]])).toEqual([
      ["CL1", "2.1", "PACKET"],
      ["CL2", "2.1", "PACKET"],
      ["CL3", "2.0", "PACKET"],
      ["CL4", "2.1", "PACKET"],
    ]);
    expect(r.rows.every((x) => ["regulator.authorizations", "registry.studies", "vendor_packets.claims"].includes(String(x["source_table"])))).toBe(true);
    for (const c of r.columns) expect(EVIDENCE_ROWS_SCHEMA, c.name).toHaveProperty(c.name);
  });

  it("agrees with the summary statement on the counts", async () => {
    const rows = await port.sql(buildEvidenceRowsSql({ submissionId: "S1", intendedUse: ED }));
    const summary = (await matrix({ submissionId: "S1", intendedUse: ED })).rows[0]!;
    const count = (system: string, state: string): number => rows.rows.filter((x) => x["source_system"] === system && x["link_state"] === state).length;
    expect(count("regulator", "CONFIRMED")).toBe(summary["regulator_confirmed"]);
    expect(count("registry", "CONFIRMED")).toBe(summary["registry_confirmed"]);
    expect(rows.rows.filter((x) => x["source_system"] === "vendor_packet").length).toBe(summary["vendor_claims"]);
  });

  it("applies the date to the dated sources", async () => {
    const r = await port.sql(buildEvidenceRowsSql({ submissionId: "S1", intendedUse: ED, asOf: "2025-01-01" }));
    expect(r.rows.filter((x) => x["source_system"] === "regulator").map((x) => x["record_id"])).toEqual(["A1"]);
  });

  it("returns nothing for an unknown submission", async () => {
    expect((await port.sql(buildEvidenceRowsSql({ submissionId: "S404", intendedUse: ED }))).rows).toEqual([]);
  });
});

describe("user text cannot change the statement", () => {
  const PAYLOADS = [
    "x' OR '1'='1",
    "'; DROP TABLE hospital.submissions; --",
    "\\'; DROP TABLE hospital.submissions; --",
    "x\\",
    "' UNION SELECT vendor_name FROM hospital.vendors --",
    "') OR 1=1 --",
    '"; DROP TABLE x; --',
    "a`b",
    "line one\nline two; SELECT 1",
    "/* comment */ OR 1=1",
    "%",
    "emergency department' AND '1'='1",
  ];

  const words = (sql: string): string[] => prepareStatement(sql).words.filter((w) => w !== "CHR");
  const benign = words(buildEvidenceMatrixSql({ deviceName: "benign", intendedUse: ED }));

  it.each(PAYLOADS)("device name %j adds no keyword to the statement and selects nothing", async (payload) => {
    const sql = buildEvidenceMatrixSql({ deviceName: payload, intendedUse: ED });
    expect(words(sql)).toEqual(benign);
    expect((await port.sql(sql)).rows).toEqual([]);
  });

  it.each(PAYLOADS)("intended use %j adds no keyword and cannot widen the match", async (payload) => {
    const sql = buildEvidenceMatrixSql({ submissionId: "S1", intendedUse: { setting: payload, purpose: payload } });
    expect(words(sql)).toEqual(words(buildEvidenceMatrixSql({ submissionId: "S1", intendedUse: ED })));
    expect((await port.sql(sql)).rows[0]).toMatchObject({ submission_id: "S1", requirement_id: null });
  });

  it.each(PAYLOADS)("submission id and version %j are values, not code", async (payload) => {
    const a = buildEvidenceRowsSql({ submissionId: payload, intendedUse: ED });
    const b = buildEvidenceMatrixSql({ deviceName: "EyeScan AI", deviceVersion: payload, intendedUse: ED });
    expect(words(a)).toEqual(words(buildEvidenceRowsSql({ submissionId: "S1", intendedUse: ED })));
    expect((await port.sql(a)).rows).toEqual([]);
    expect((await port.sql(b)).rows).toEqual([]);
  });

  it("a device whose real name contains a quote and a backslash is found, and only that device", async () => {
    const r = await matrix({ deviceName: TRICKY_DEVICE, intendedUse: ED });
    expect(r.rows.map((x) => [x["submission_id"], x["vendor_name"], x["regulator_confirmed"]])).toEqual([["S3", "O'Neil Health \\ Labs", 1]]);
  });

  it("leaves the silos untouched after every hostile statement above", async () => {
    expect((await port.sql("SELECT count(*) AS n FROM hospital.submissions")).rows).toEqual([{ n: 3 }]);
    expect((await port.sql("SELECT count(*) AS n FROM hospital.vendors")).rows).toEqual([{ n: 2 }]);
  });
});

describe("input validation", () => {
  const ok: EvidenceMatrixInput = { submissionId: "S1", intendedUse: ED };
  it("needs a submission id or a device name", () => {
    expect(failure(() => buildEvidenceMatrixSql({ intendedUse: ED })).detail?.["reason"]).toBe("MISSING_INPUT");
  });
  it("needs a setting and a purpose", () => {
    expect(failure(() => buildEvidenceMatrixSql({ ...ok, intendedUse: { setting: "", purpose: "x" } })).failure).toBe("INVALID");
    expect(failure(() => buildEvidenceMatrixSql({ ...ok, intendedUse: { purpose: "x" } as never })).failure).toBe("INVALID");
    expect(failure(() => buildEvidenceMatrixSql({ ...ok, intendedUse: undefined as never })).failure).toBe("INVALID");
  });
  it("refuses blank and oversized text", () => {
    expect(failure(() => buildEvidenceMatrixSql({ ...ok, submissionId: "   " })).failure).toBe("INVALID");
    expect(failure(() => buildEvidenceMatrixSql({ deviceName: "x".repeat(501), intendedUse: ED })).failure).toBe("INVALID");
  });
  it("refuses a date that is not a calendar date", () => {
    for (const asOf of ["2026-02-30", "last week", "2026-01-01' OR 1=1"]) expect(failure(() => buildEvidenceMatrixSql({ ...ok, asOf })).failure, asOf).toBe("INVALID");
    expect(failure(() => buildEvidenceRowsSql({ ...ok, asOf: "x" })).failure).toBe("INVALID");
  });
});
