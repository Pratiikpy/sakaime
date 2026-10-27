/**
 * Smaller units: value parsing, the name matcher, the object-store lander, and state that survives a restart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileLedger, JsonFileReviewQueue, ObjectStoreLander, onboardSource, resolveReview } from "../../src/discovery/index.ts";
import { lexicalProposals, nameEvidence } from "../../src/discovery/lexical.ts";
import { parseProbe } from "../../src/discovery/tabular.ts";
import { synonymTarget } from "../../src/discovery/canonical.ts";
import { canonicalise, familiesOf, idFamily } from "../../src/discovery/identifiers.ts";
import { isNullToken, parseAgeYears, parseNumber, readDateColumn } from "../../src/discovery/values.ts";
import { convertCell, toCsv } from "../../src/discovery/normalise.ts";
import { PortError } from "../../src/ports/index.ts";
import { sha256Hex } from "../../src/util/canonical.ts";
import { login, openZetaris, zetarisAuthFromEnv } from "../../src/discovery/zetaris-auth.ts";
import { csv, harness, urlOf, type Harness } from "./helpers/fixtures.ts";
import { modelMapping } from "./helpers/doubles.ts";

describe("values", () => {
  it("parses numbers the way exports write them", () => {
    expect(parseNumber("0.93")).toMatchObject({ value: 0.93, percent: false });
    expect(parseNumber("93.2 %")).toMatchObject({ value: 93.2, percent: true });
    expect(parseNumber("1,571")).toMatchObject({ value: 1571 });
    expect(parseNumber("0,93")).toMatchObject({ value: 0.93, decimalComma: true });
    expect(parseNumber("9.3e-1")?.value).toBeCloseTo(0.93);
    for (const bad of ["", "n/a", "high", "93.2% (95% CI 90-96)", "12-14", "1.2.3"]) expect(parseNumber(bad)).toBeNull();
  });
  it("knows the text codes for missing, and not the numeric ones", () => {
    for (const t of ["", " ", "NA", "n/a", "N/A", "-", "--", "null", "None", "unknown", "Not reported", "NaN", "?"]) expect(isNullToken(t), t).toBe(true);
    for (const t of ["0", "9999", "-1", "no", "K200667"]) expect(isNullToken(t), t).toBe(false);
  });
  it("reads ages with their unit", () => {
    expect(parseAgeYears("18 Years")).toBe(18);
    expect(parseAgeYears("6 Months")).toBe(0.5);
    expect(parseAgeYears("18 Years and older")).toBe(18);
    expect(parseAgeYears("adult")).toBeNull();
  });
  it("tells the date families apart and keeps the partial dates a registry uses", () => {
    expect(readDateColumn(["2005-05", "2006-06-06", "2007"], true).family).toBe("iso");
    expect(readDateColumn(["13 Aug 2020", "Nov 10, 2021"], false).family).toBe("text");
    expect(readDateColumn(["2020/08/03", "2021/11/10"], false).family).toBe("ymd-slash");
    expect(readDateColumn(["31/12/2020"], false).family).toBe("dmy");
    expect(readDateColumn(["12/31/2020"], false).family).toBe("mdy");
    expect(readDateColumn(["01/02/2020"], false).ambiguous).toBe(true);
    expect(readDateColumn(["32/13/2020"], false).impossible).toHaveLength(1);
    expect(readDateColumn(["2020-02-29", "2019-02-29"], false).impossible).toEqual(["2019-02-29"]);
  });
});

describe("identifiers", () => {
  it("canonicalises only lexical changes", () => {
    const k = idFamily("submission_number")!;
    expect(canonicalise(k, "k 200667")).toBe("K200667");
    expect(canonicalise(k, "510(k) K200667")).toBe("K200667");
    expect(canonicalise(k, "P200012S004")).toBe("P200012S004");
    expect(canonicalise(k, "200667")).toBeNull();
    expect(canonicalise(k, "K2006")).toBeNull();
    expect(canonicalise(idFamily("nct_id")!, "https://clinicaltrials.gov/study/NCT03112005")).toBe("NCT03112005");
    expect(canonicalise(idFamily("doi")!, "https://doi.org/10.1038/S41746-021-00000-1")).toBe("10.1038/s41746-021-00000-1");
    expect(canonicalise(idFamily("pmid")!, "PMID: 34779843")).toBe("34779843");
    expect(familiesOf("NCT03112005")).toEqual(["nct_id"]);
  });
});

describe("the name matcher", () => {
  it("maps known names, whatever the casing or style", () => {
    for (const [name, field] of [["K_Number", "submission_number"], ["NCTId", "nct_id"], ["protocolSection.identificationModule.nctId", "nct_id"], ["PubMed ID", "pmid"], ["Cleared On", "decision_date"], ["TPR", "sensitivity"]] as const) {
      expect(synonymTarget(name), name).toBe(field);
    }
    expect(synonymTarget("device identifier")).toBeUndefined();
    expect(synonymTarget("x1")).toBeUndefined();
  });
  it("proposes from identifier shapes when the name says nothing", () => {
    const t = parseProbe(new TextEncoder().encode(csv(["col_a", "col_b"], [["NCT03112005", "x"], ["NCT01757678", "y"], ["NCT02963441", "z"]])));
    expect(lexicalProposals(t).map((p) => [p.sourceField, p.canonicalField])).toEqual([["col_a", "nct_id"]]);
  });
  it("evidence from the name, the path or the description", () => {
    expect(nameEvidence("sensitivity", "reported_sensitivity_pct", "")).toBe("contains");
    expect(nameEvidence("sensitivity", "x1", "")).toBe("none");
    expect(nameEvidence("sensitivity", "x1", "x1 is the sensitivity of the algorithm")).toBe("description");
    expect(nameEvidence("decision_date", "date_received", "")).toBe("none");
  });
});

describe("normalisation", () => {
  it("applies exactly the recorded conversions and turns what it cannot convert into empty", () => {
    const f = (conversions: Parameters<typeof convertCell>[1]["conversions"]) => ({ sourceField: "s", canonicalField: "sensitivity", conversions });
    expect(convertCell("95.5", f([{ kind: "percent_to_fraction" }]), "proportion")).toBe("0.955");
    expect(convertCell(0.93, f([]), "proportion")).toBe("0.93");
    expect(convertCell(-1, f([{ kind: "null_codes", tokens: [-1] }]), "proportion")).toBeNull();
    expect(convertCell("NA", f([]), "proportion")).toBeNull();
    expect(convertCell("03/08/2020", { sourceField: "d", canonicalField: "decision_date", conversions: [{ kind: "date", family: "dmy" }] }, "date")).toBe("2020-08-03");
    expect(convertCell("Class II", { sourceField: "c", canonicalField: "device_class", conversions: [] }, "enum")).toBe("2");
  });
  it("writes CSV that round-trips quotes, commas and line breaks", () => {
    const text = toCsv(["a", "b"], [['say "hi", ok', "line\nbreak"], [null, " padded "]]);
    const back = parseProbe(new TextEncoder().encode(text));
    expect(back.rows).toEqual([{ a: 'say "hi", ok', b: "line\nbreak" }, { a: "", b: " padded " }]);
  });
});

describe("the object-store lander", () => {
  const store = new Map<string, Uint8Array>();
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.slice(1);
    if (init?.method === "PUT") {
      if (!path.includes("/")) {
        const existed = store.has(`bucket:${path}`);
        store.set(`bucket:${path}`, new Uint8Array());
        return new Response(null, { status: existed ? 409 : 200 });
      }
      store.set(path, new Uint8Array(init.body as Buffer));
      return new Response(null, { status: 200 });
    }
    const hit = store.get(path);
    return hit ? new Response(hit as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;

  it("writes, reads back and verifies the hash", async () => {
    const lander = new ObjectStoreLander({ endpoint: "http://127.0.0.1:19190/", fetch: fakeFetch });
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const out = await lander.put("sakaime-onboarded", "t/t.csv", bytes);
    expect(out).toEqual({ uri: "s3a://sakaime-onboarded/t/t.csv", sha256: sha256Hex(bytes), bytes: bytes.length });
    await expect(lander.put("sakaime-onboarded", "t/t.csv", bytes)).resolves.toMatchObject({ sha256: sha256Hex(bytes) });
  });
  it("refuses names that could leave their prefix, and an endpoint with credentials", async () => {
    const lander = new ObjectStoreLander({ endpoint: "http://127.0.0.1:19190", fetch: fakeFetch });
    for (const [b, k] of [["Bad_Bucket", "k"], ["good-bucket", "../k"], ["good-bucket", "a//b"], ["good-bucket", "/abs"]] as const) {
      await expect(lander.put(b, k, new Uint8Array(1))).rejects.toMatchObject({ failure: "INVALID" });
    }
    expect(() => new ObjectStoreLander({ endpoint: "http://u:p@127.0.0.1:19190" })).toThrow(PortError);
  });
  it("reports a store that returns different bytes than were written", async () => {
    const lying = (async (url: string, init?: RequestInit) => (init?.method === "GET" ? new Response("not what you sent", { status: 200 }) : new Response(null, { status: 200 }))) as unknown as typeof fetch;
    await expect(new ObjectStoreLander({ endpoint: "http://127.0.0.1:1", fetch: lying }).put("good-bucket", "k.csv", new TextEncoder().encode("x"))).rejects.toMatchObject({ failure: "INVALID" });
  });
  it("an unreachable store is UNAVAILABLE", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(new ObjectStoreLander({ endpoint: "http://127.0.0.1:1", fetch: down }).put("good-bucket", "k.csv", new Uint8Array(1))).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });
});

describe("state that survives a restart", () => {
  let h: Harness;
  let dir: string;
  afterEach(() => {
    h?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("a held onboarding is resolved from files written by an earlier process", async () => {
    dir = mkdtempSync(join(tmpdir(), "sakaime-discovery-"));
    const map = { pmid: "pmid", reported_sensitivity: "sensitivity" };
    const percent = csv(["pmid", "reported_sensitivity"], [["34779843", 95.5], ["31304320", 87.2], ["33782551", 97.7], ["37450425", 81.4], ["41230302", 93]]);
    h = await harness({ model: modelMapping(map), ledger: new JsonFileLedger(join(dir, "ledger")), reviews: new JsonFileReviewQueue(join(dir, "reviews")) });
    h.fetcher.set(urlOf("p.csv"), percent);
    const held = await onboardSource(await h.request("p.csv"), h.deps);
    expect(held.outcome).toBe("held_for_review");

    // A new process: new objects over the same directories. The held ticket and the ledger entry are read back.
    const ledger = new JsonFileLedger(join(dir, "ledger"));
    const reviews = new JsonFileReviewQueue(join(dir, "reviews"));
    expect(ledger.get(held.id)?.state).toBe("held");
    expect(reviews.list("pending")).toHaveLength(1);
    h.deps.ledger = ledger;
    h.deps.reviews = reviews;
    const done = await resolveReview(held.id, { reviewer: "dr-lee", decision: "accept", contract: await h.contract("rev-1", urlOf("p.csv")) }, h.deps);
    expect(done.outcome).toBe("registered");
    expect(new JsonFileLedger(join(dir, "ledger")).get(held.id)?.state).toBe("registered");
    expect(new JsonFileReviewQueue(join(dir, "reviews")).get(held.id)?.status).toBe("accepted");
  });
});

describe("connecting to the local Zetaris stack", () => {
  const jwt = "header.payload.signature";
  const okFetch = (seen: { url: string; auth: string; org: string }[]) =>
    (async (url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seen.push({ url, auth: h["Authorization"]!, org: h["X-Org-ID"]! });
      return new Response(JSON.stringify({ idToken: jwt }), { status: 200 });
    }) as unknown as typeof fetch;

  it("names what is missing instead of guessing", () => {
    const r = zetarisAuthFromEnv({});
    expect("missing" in r && r.missing).toEqual(["SAKAIME_ZETARIS_ADMIN_PASSWORD", "SAKAIME_ZETARIS_READER_EMAIL", "SAKAIME_ZETARIS_READER_PASSWORD"]);
  });
  it("logs in with HTTP Basic and the organisation, and opens two identities", async () => {
    const env = { SAKAIME_ZETARIS_ADMIN_PASSWORD: "Adm1n!pass", SAKAIME_ZETARIS_READER_EMAIL: "r@x.example", SAKAIME_ZETARIS_READER_PASSWORD: "Rdr!pass1" };
    const r = zetarisAuthFromEnv(env);
    if (!("config" in r)) throw new Error("expected a configuration");
    const seen: { url: string; auth: string; org: string }[] = [];
    const port = await openZetaris(r.config, okFetch(seen));
    expect(port.identityNames().sort()).toEqual(["admin", "default"]);
    expect(seen.map((s) => s.url)).toEqual(["http://127.0.0.1:8988/api/v1.0/auth/login", "http://127.0.0.1:8988/api/v1.0/auth/login"]);
    expect(seen.every((s) => s.org === "1" && s.auth.startsWith("Basic "))).toBe(true);
  });
  it("a refused login reports the status and never echoes the password or the response", async () => {
    const refuse = (async () => new Response(JSON.stringify({ detail: "bad password hunter2 for admin" }), { status: 401 })) as unknown as typeof fetch;
    const e = await login("http://127.0.0.1:8988/api/v1.0", "1", { email: "a@x.example", password: "hunter2" }, refuse).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).failure).toBe("FORBIDDEN");
    expect((e as PortError).message).not.toContain("hunter2");
  });
  it("an unreachable stack is UNAVAILABLE", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8988");
    }) as unknown as typeof fetch;
    await expect(login("http://127.0.0.1:8988/api/v1.0", "1", { email: "a@x.example", password: "p" }, down)).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });
});
