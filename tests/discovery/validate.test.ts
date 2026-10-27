/**
 * Stage 5 on constructed columns: every semantic mutation the task names, each in the state a real export would put it,
 * plus the controls that must pass. The data we hold is the real silo files, queried through the engine double.
 */
import { afterAll, describe, expect, it } from "vitest";
import { check, closeSharedEngine, verdictOf } from "./helpers/validate.ts";
import { clearances } from "./helpers/fixtures.ts";

afterAll(() => closeSharedEngine());

const frac = [0.93, 0.88, 0.95, 0.91, 0.87, 0.9, 0.96, 0.84];
const pmids = ["34779843", "31304320", "33782551", "37450425", "41230302", "32393768", "36457286", "31335200"];
const withKey = { pmid: pmids };
const nct = ["NCT03112005", "NCT01757678", "NCT02963441", "NCT00084136", "NCT00334516"];

describe("proportions: unit and scale", () => {
  it("accepts fractions between 0 and 1 for a sensitivity", async () => {
    const r = await check({ sensitivity: frac, ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    expect(verdictOf(r, "sensitivity")).toMatchObject({ check: "ok", unit: "fraction" });
  });

  it("holds a 0..100 scale and proposes the conversion; never accepts it silently", async () => {
    const r = await check({ sensitivity: frac.map((v) => v * 100), ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    const v = verdictOf(r, "sensitivity");
    expect(v.check).toBe("needs_review");
    expect(v.conversions).toContainEqual({ kind: "percent_to_fraction" });
    expect(v.findings.find((f) => f.severity === "hold")?.signature).toBe("scale#percent");
  });

  it("holds percent strings", async () => {
    const r = await check({ sensitivity: frac.map((v) => `${(v * 100).toFixed(1)}%`), ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    expect(verdictOf(r, "sensitivity").check).toBe("needs_review");
  });

  it("rejects a value no proportion scale allows", async () => {
    const r = await check({ sensitivity: [...frac.slice(0, 7), 150], ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    expect(verdictOf(r, "sensitivity").check).toBe("rejected");
  });

  it("rejects a column that mixes the two scales", async () => {
    const r = await check({ sensitivity: [0.93, 0.88, 95, 91, 0.87, 90, 0.96, 84], ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    expect(verdictOf(r, "sensitivity")).toMatchObject({ check: "rejected" });
  });

  it("holds a numeric missing-value code and does not average it into the data", async () => {
    const r = await check({ sensitivity: [0.93, 0.88, -1, 0.91, 0.87, -1, 0.96, 0.84], ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    const v = verdictOf(r, "sensitivity");
    expect(v.check).toBe("needs_review");
    expect(v.conversions).toContainEqual({ kind: "null_codes", tokens: [-1] });
  });

  it("holds a 0/1 flag column filed as a rate", async () => {
    const r = await check({ sensitivity: [1, 0, 1, 1, 0, 1, 0, 1], ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    expect(verdictOf(r, "sensitivity").check).toBe("needs_review");
  });

  it("reads text missing-value codes as empty without complaint", async () => {
    const r = await check({ sensitivity: [0.93, "NA", 0.95, "-", 0.87, "", 0.96, "N/A"], ...withKey }, { sensitivity: "sensitivity", pmid: "pmid" });
    const v = verdictOf(r, "sensitivity");
    expect(v.check).toBe("ok");
    expect(v.conversions.some((c) => c.kind === "null_codes")).toBe(true);
  });

  it("holds a column nothing says is a sensitivity rather than a specificity", async () => {
    const r = await check({ x1: frac, ...withKey }, { x1: "sensitivity", pmid: "pmid" });
    const v = verdictOf(r, "x1");
    expect(v.check).toBe("needs_review");
    expect(v.findings.some((f) => f.rule === "uncorroborated")).toBe(true);
  });

  it("a description naming the column corroborates it", async () => {
    const r = await check({ x1: frac, ...withKey }, { x1: "sensitivity", pmid: "pmid" }, { description: "Reported performance; x1 is the sensitivity of the algorithm" });
    expect(verdictOf(r, "x1").check).toBe("renamed");
  });
});

describe("counts, ages, years", () => {
  it("rejects proportions filed as counts", async () => {
    const r = await check({ enrollment: [0.93, 0.5, 0.25, 0.75, 0.6], nct }, { enrollment: "enrollment", nct: "nct_id" });
    expect(verdictOf(r, "enrollment").check).toBe("rejected");
  });

  it("holds 9999 in a count column as a likely missing-value code", async () => {
    const r = await check({ enrollment: [942, 9999, 120, 9999, 300], nct }, { enrollment: "enrollment", nct: "nct_id" });
    expect(verdictOf(r, "enrollment").check).toBe("needs_review");
  });

  it("rejects planned or estimated enrolment by name and holds an unlabelled count", async () => {
    const planned = await check({ planned_enrollment: [942, 100, 120, 80, 300], nct }, { planned_enrollment: "enrollment", nct: "nct_id" });
    expect(verdictOf(planned, "planned_enrollment").check).toBe("rejected");
    const both = await check({ estimated_enrollment_count: [942, 100, 120, 80, 300], nct }, { estimated_enrollment_count: "enrollment", nct: "nct_id" });
    expect(verdictOf(both, "estimated_enrollment_count").check).toBe("rejected");
    const generic = await check({ n: [942, 100, 120, 80, 300], nct }, { n: "enrollment", nct: "nct_id" });
    expect(verdictOf(generic, "n").check).toBe("needs_review");
    const actual = await check({ enrollment_count: [942, 100, 120, 80, 300], nct }, { enrollment_count: "enrollment", nct: "nct_id" });
    expect(verdictOf(actual, "enrollment_count").check).toBe("renamed");
  });

  it("parses ages with units and holds 999", async () => {
    const ok = await check({ minimum_age: ["18 Years", "6 Months", "21 Years", "N/A", "40 Years"], nct }, { minimum_age: "min_age_years", nct: "nct_id" });
    expect(verdictOf(ok, "minimum_age")).toMatchObject({ check: "renamed", unit: "years" });
    const bad = await check({ minimum_age: [18, 999, 21, 999, 40], nct }, { minimum_age: "min_age_years", nct: "nct_id" });
    expect(verdictOf(bad, "minimum_age").check).toBe("needs_review");
    const impossible = await check({ minimum_age: [18, 400, 21, 33, 40], nct }, { minimum_age: "min_age_years", nct: "nct_id" });
    expect(verdictOf(impossible, "minimum_age").check).toBe("rejected");
  });

  it("rejects two-digit and future years", async () => {
    const p = pmids.slice(0, 5);
    expect(verdictOf(await check({ pub_year: [21, 19, 20, 22, 23], pmid: p }, { pub_year: "publication_year", pmid: "pmid" }), "pub_year").check).toBe("rejected");
    expect(verdictOf(await check({ pub_year: [2021, 2019, 2020, 2031, 2023], pmid: p }, { pub_year: "publication_year", pmid: "pmid" }), "pub_year").check).toBe("rejected");
    expect(verdictOf(await check({ pub_year: [2021, 2018, 2021, 2023, 2025], pmid: p }, { pub_year: "publication_year", pmid: "pmid" }), "pub_year").check).toBe("renamed");
  });
});

describe("dates", () => {
  const k = ["K200667", "K211733", "K221347", "K253265", "DEN180001"];
  const run = (cells: (string | number)[]) => check({ decision_date: cells, k }, { decision_date: "decision_date", k: "submission_number" });
  it("accepts ISO dates", async () => {
    expect(verdictOf(await run(["2020-08-03", "2021-11-10", "2022-08-03", "2025-11-06", "2018-04-11"]), "decision_date")).toMatchObject({ check: "ok", unit: "ISO date" });
  });
  it("determines day-first when a day exceeds 12 and converts", async () => {
    const v = verdictOf(await run(["03/08/2020", "10/11/2021", "13/08/2022", "06/11/2025", "11/04/2018"]), "decision_date");
    expect(v.check).toBe("ok");
    expect(v.conversions).toContainEqual({ kind: "date", family: "dmy" });
  });
  it("determines month-first when the second part exceeds 12", async () => {
    const v = verdictOf(await run(["08/03/2020", "11/10/2021", "08/13/2022", "11/06/2025", "04/11/2018"]), "decision_date");
    expect(v.conversions).toContainEqual({ kind: "date", family: "mdy" });
  });
  it("holds a column whose every value reads either way", async () => {
    const v = verdictOf(await run(["03/08/2020", "10/11/2021", "02/08/2022", "06/11/2025", "11/04/2018"]), "decision_date");
    expect(v.check).toBe("needs_review");
    expect(v.findings.find((f) => f.severity === "hold")?.signature).toBe("date-ambiguous#dmy|mdy");
  });
  it("rejects a day that does not exist and mixed formats", async () => {
    expect(verdictOf(await run(["2020-08-03", "2021-02-30", "2022-08-03", "2025-11-06", "2018-04-11"]), "decision_date").check).toBe("rejected");
    expect(verdictOf(await run(["2020-08-03", "13/11/2021", "2022-08-03", "2025-11-06", "2018-04-11"]), "decision_date").check).toBe("rejected");
  });
  it("converts epoch seconds and compact dates, and rejects dates after today", async () => {
    expect(verdictOf(await run([1596412800, 1636502400, 1659484800, 1762387200, 1523404800]), "decision_date").conversions).toContainEqual({ kind: "date", family: "epoch-s" });
    expect(verdictOf(await run([20200803, 20211110, 20220803, 20251106, 20180411]), "decision_date").check).toBe("ok");
    expect(verdictOf(await run(["2020-08-03", "2021-11-10", "2022-08-03", "2031-11-06", "2018-04-11"]), "decision_date").check).toBe("rejected");
  });
  it("notes a time zone offset and keeps the calendar date as written", async () => {
    const v = verdictOf(await run(["2020-08-03T00:00:00-05:00", "2021-11-10T09:30:00Z", "2022-08-03T10:00:00+02:00", "2025-11-06T00:00:00Z", "2018-04-11T00:00:00Z"]), "decision_date");
    expect(v.check).toBe("ok");
    expect(v.findings.some((f) => f.rule === "timezone")).toBe(true);
  });
  it("a date nothing names as a decision date is held: received is not decided", async () => {
    const r = await check({ date_received: ["2020-08-03", "2021-11-10", "2022-08-03", "2025-11-06", "2018-04-11"], k }, { date_received: "decision_date", k: "submission_number" });
    expect(verdictOf(r, "date_received").check).toBe("needs_review");
  });
});

describe("identifiers", () => {
  const d = { d: ["2020-08-03", "2021-11-10", "2022-08-03", "2025-11-06", "2018-04-11"] };
  it("undoes case, spacing and hyphens, and says so", async () => {
    const v = verdictOf(await check({ id: ["k200667", "K 211733", "K-221347", "k253265", " DEN180001 "], ...d }, { id: "submission_number", d: "decision_date" }), "id");
    expect(v.check).toBe("renamed");
    expect(v.conversions).toContainEqual({ kind: "identifier", family: "submission_number" });
  });
  it("does not restore a lost prefix: six digits could be anything", async () => {
    expect(verdictOf(await check({ id: ["200667", "211733", "221347", "253265", "180001"], ...d }, { id: "submission_number", d: "decision_date" }), "id").check).toBe("rejected");
  });
  it("names the family a swapped column actually holds, and reads it as that family when nothing else claims it", async () => {
    const v = verdictOf(await check({ id: nct, ...d }, { id: "submission_number", d: "decision_date" }), "id");
    expect(v).toMatchObject({ canonicalField: "nct_id", check: "renamed", proposer: "repair" });
    const taken = verdictOf(await check({ id: nct, trial: nct, ...d }, { id: "submission_number", trial: "nct_id", d: "decision_date" }), "id");
    expect(taken.check).toBe("rejected");
    expect(taken.reason).toContain("nct_id");
  });
  it("extracts a PMID from a URL", async () => {
    const link = pmids.slice(0, 5).map((p) => `https://pubmed.ncbi.nlm.nih.gov/${p}/`);
    expect(verdictOf(await check({ link }, { link: "pmid" }, { description: "PubMed links" }), "link").check).toBe("renamed");
  });
  it("a bare run of digits is not a PMID without name or join evidence", async () => {
    expect(verdictOf(await check({ ref: ["998877", "998878", "998879", "998880", "998881"] }, { ref: "pmid" }), "ref").check).toBe("needs_review");
  });
  it("validates the GS1 check digit of a UDI-DI", async () => {
    const k = ["K200667", "K211733", "K221347"];
    const gtin = (body: string): string => {
      let sum = 0;
      for (let i = 0; i < body.length; i += 1) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
      return body + String((10 - (sum % 10)) % 10);
    };
    const good = ["0081234567890", "0081234567891", "0081234567892"].map(gtin);
    expect(verdictOf(await check({ di: good, k }, { di: "udi_di", k: "submission_number" }), "di").check).toBe("renamed");
    const wrong = good.map((g) => g.slice(0, -1) + String((Number(g.at(-1)) + 1) % 10));
    expect(verdictOf(await check({ di: wrong, k }, { di: "udi_di", k: "submission_number" }), "di").check).toBe("rejected");
  });
});

describe("meaning: population and sets", () => {
  const eligibility = [
    "Inclusion Criteria: adults aged 18 or older with diabetes. Exclusion Criteria: pregnancy.",
    "Inclusion Criteria: patients must be eligible for screening.",
    "Eligible participants must be able to provide consent.",
    "Inclusion Criteria: aged 21 and over.",
    "Inclusion Criteria: willing to attend all visits.",
  ];
  const enrolled = ["942 participants were enrolled at 15 sites", "n=120 patients enrolled", "300 subjects were recruited", "n=80 participants analysed", "500 patients were enrolled"];

  it("rejects eligibility text filed as the enrolled population when the name says so, and reads it as the target population", async () => {
    const v = verdictOf(await check({ target_population: eligibility, nct }, { target_population: "study_population", nct: "nct_id" }), "target_population");
    expect(v).toMatchObject({ canonicalField: "target_population", check: "ok", proposer: "repair" });
    const both = verdictOf(await check({ target_population: eligibility, eligibility: eligibility, nct }, { target_population: "study_population", eligibility: "target_population", nct: "nct_id" }), "target_population");
    expect(both.check).toBe("rejected");
  });
  it("holds the swap when the header was changed but the values were not", async () => {
    expect(verdictOf(await check({ study_population: eligibility, nct }, { study_population: "study_population", nct: "nct_id" }), "study_population").check).toBe("needs_review");
  });
  it("holds a bare 'population' column that nothing disambiguates", async () => {
    const r = await check({ population: ["adults with diabetes", "adults", "adults 21+", "children", "adults with DR"], nct }, { population: "study_population", nct: "nct_id" });
    expect(verdictOf(r, "population").check).toBe("needs_review");
  });
  it("accepts a column whose name and values agree", async () => {
    expect(verdictOf(await check({ enrolled_cohort: enrolled, nct }, { enrolled_cohort: "study_population", nct: "nct_id" }), "enrolled_cohort").check).toBe("renamed");
    expect(verdictOf(await check({ eligibility_summary: eligibility, nct }, { eligibility_summary: "target_population", nct: "nct_id" }), "eligibility_summary").check).toBe("renamed");
  });
  it("uses the description's clause about the column", async () => {
    const r = await check({ pop: eligibility, nct }, { pop: "study_population", nct: "nct_id" }, { description: "Registry export. The pop column lists the intended-use population (inclusion criteria), not who was enrolled." });
    expect(verdictOf(r, "pop")).toMatchObject({ canonicalField: "target_population", proposer: "repair" });
  });
  it("tells a development set from a study set by name, and holds the unlabelled one", async () => {
    const p = pmids.slice(0, 5);
    expect(verdictOf(await check({ n_train: [12000, 8000, 9500, 20000, 7000], pmid: p }, { n_train: "study_sample_size", pmid: "pmid" }), "n_train")).toMatchObject({ canonicalField: "development_set_size", proposer: "repair" });
    expect(verdictOf(await check({ n_train: [12000, 8000, 9500, 20000, 7000], pmid: p }, { n_train: "development_set_size", pmid: "pmid" }), "n_train").check).toBe("renamed");
    expect(verdictOf(await check({ test_set_size: [942, 800, 950, 200, 700], pmid: p }, { test_set_size: "study_sample_size", pmid: "pmid" }), "test_set_size").check).toBe("renamed");
    expect(verdictOf(await check({ sample_size: [942, 800, 950, 200, 700], pmid: p }, { sample_size: "study_sample_size", pmid: "pmid" }), "sample_size").check).toBe("needs_review");
  });
});

describe("cross-source validation against what we hold", () => {
  const rows = clearances();
  it("applicant names filed as device names: the values join to the applicant column, the name says device, so a person decides", async () => {
    const v = verdictOf(await check({ device_name: rows.map((x) => x[1]!), k: rows.map((x) => x[0]!) }, { device_name: "device_name", k: "submission_number" }), "device_name");
    expect(v).toMatchObject({ canonicalField: "applicant", check: "needs_review", proposer: "repair" });
    expect(v.reason).toContain('says device_name but the values read as applicant');
    const both = verdictOf(await check({ device_name: rows.map((x) => x[1]!), applicant: rows.map((x) => x[1]!), k: rows.map((x) => x[0]!) }, { device_name: "device_name", applicant: "applicant", k: "submission_number" }), "device_name");
    expect(both.check).toBe("rejected");
    expect(both.reason).toContain("applicant");
  });
  it("rejects a key that is expected to join and does not", async () => {
    const r = await check({ id: ["K900001", "K900002", "K900003", "K900004", "K900005"], n: ["a", "b", "c", "d", "e"] }, { id: "submission_number", n: "device_name" }, { expectedJoinRate: 0.8 });
    expect(r.tableFindings.find((f) => f.rule === "join-expected")?.severity).toBe("reject");
  });
  it("holds a key that joins below expectation, and passes one that meets it", async () => {
    const half = [...rows.slice(0, 6).map((x) => x[0]!), "K900001", "K900002", "K900003", "K900004", "K900005", "K900006"];
    const low = await check({ id: half }, { id: "submission_number" }, { expectedJoinRate: 0.8 });
    expect(low.tableFindings.find((f) => f.rule === "join-low")?.severity).toBe("hold");
    const fine = await check({ id: half }, { id: "submission_number" }, { expectedJoinRate: 0.4 });
    expect(fine.tableFindings.find((f) => f.rule === "join")?.severity).toBe("note");
    expect(fine.tableFindings.some((f) => f.severity !== "note")).toBe(false);
  });
  it("applies the expected overlap to the source as a whole: one identifier that reaches it is enough", async () => {
    const r = await check({ id: rows.map((x) => x[0]!), nct: rows.map((_, i) => `NCT${String(99000000 + i)}`) }, { id: "submission_number", nct: "nct_id" }, { expectedJoinRate: 0.8 });
    expect(r.tableFindings.some((f) => f.severity !== "note")).toBe(false);
  });
  it("records that a key shares nothing with what we hold when no overlap is expected, without rejecting it", async () => {
    const v = verdictOf(await check({ id: ["K900001", "K900002", "K900003", "K900004", "K900005"] }, { id: "submission_number" }), "id");
    expect(v.check).toBe("renamed");
    expect(v.join?.rate).toBe(0);
  });
  it("holds a key when the federation engine cannot be asked, instead of assuming it joins", async () => {
    const { EngineDouble, ObjectStoreDouble } = await import("./helpers/doubles.ts");
    const dead = await EngineDouble.create(new ObjectStoreDouble(), []);
    dead.reachable = false;
    const v = verdictOf(await check({ id: rows.map((x) => x[0]!) }, { id: "submission_number" }, { federation: dead, expectedJoinRate: 0.8 }), "id");
    dead.close();
    expect(v.check).toBe("needs_review");
    expect(v.findings.some((f) => f.rule === "join-unavailable")).toBe(true);
  });
});

describe("table-level", () => {
  it("declines a source with no usable identifier", async () => {
    const r = await check({ device_name: ["a", "b", "c"], applicant: ["x", "y", "z"] }, { device_name: "device_name", applicant: "applicant" });
    expect(r.tableFindings.some((f) => f.rule === "no-key" && f.severity === "reject")).toBe(true);
  });
  it("keeps exact duplicate records once and holds one key with different contents", async () => {
    const rows = clearances();
    const dupe = await check({ k: [...rows.map((x) => x[0]!), rows[0]![0]!], name: [...rows.map((x) => x[2]!), rows[0]![2]!] }, { k: "submission_number", name: "device_name" });
    expect(dupe.duplicates).toEqual({ exact: 1, conflicting: 0 });
    const conflict = await check({ k: [...rows.map((x) => x[0]!), rows[0]![0]!], name: [...rows.map((x) => x[2]!), "A different name"] }, { k: "submission_number", name: "device_name" });
    expect(conflict.duplicates.conflicting).toBe(1);
    expect(conflict.tableFindings.some((f) => f.rule === "duplicate-key" && f.severity === "hold")).toBe(true);
  });
  it("sends two columns that claim one canonical field to a person", async () => {
    const rows = clearances();
    const r = await check({ a: rows.map((x) => x[0]!), b: rows.map((x) => x[0]!) }, { a: "submission_number", b: "submission_number" });
    expect(r.fields.every((f) => f.check === "needs_review")).toBe(true);
  });
});

describe("reviewer approvals cover exactly what was shown", () => {
  const sens = [93, 88, 95, 91, 87, 90, 96, 84];
  const cols = { sensitivity: sens, pmid: pmids };
  const approve = new Map([["sensitivity", { by: "rev-2", signatures: ["scale#percent"], representation: "percent" as const }]]);
  it("an approval of the percent scale turns the hold into a note and keeps the conversion", async () => {
    const v = verdictOf(await check(cols, { sensitivity: "sensitivity", pmid: "pmid" }, { approvals: approve }), "sensitivity");
    expect(v.check).toBe("ok");
    expect(v.conversions).toContainEqual({ kind: "percent_to_fraction" });
  });
  it("the same approval does not cover a column that now arrives as fractions", async () => {
    const r = await check({ ...cols, sensitivity: sens.map((v) => v / 100) }, { sensitivity: "sensitivity", pmid: "pmid" }, { approvals: approve });
    expect(verdictOf(r, "sensitivity").check).toBe("needs_review");
  });
  it("an approval never covers a rejection", async () => {
    const r = await check({ ...cols, sensitivity: [...sens.slice(0, 7), 150] }, { sensitivity: "sensitivity", pmid: "pmid" }, { approvals: approve });
    expect(verdictOf(r, "sensitivity").check).toBe("rejected");
  });
});
