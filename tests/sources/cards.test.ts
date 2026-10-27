import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { CardError, allowlistFromCards, defaultCardsDir, loadSourceCards, parseCard } from "../../src/sources/cards.ts";
import { createSourceLayer, windowsOf } from "../../src/sources/factory.ts";
import { SnapshotIntegrityError, loadSnapshot } from "../../src/sources/snapshot.ts";

const dir = defaultCardsDir();
const cards = loadSourceCards(dir);
const cardText = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-card-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("source cards", () => {
  it("loads the nine cards the product needs, in a stable order", () => {
    expect(cards.map((c) => c.file.id)).toEqual([
      "clinicaltrials-v2",
      "crossref",
      "europepmc",
      "fda-accessdata-pdf",
      "fda-ai-list",
      "openfda-510k",
      "openfda-pma",
      "openfda-udi",
      "pubmed-eutils",
    ]);
  });

  it("builds an allowlist of exactly the hosts the cards name", () => {
    expect(allowlistFromCards(cards).hosts()).toEqual(["api.crossref.org", "api.fda.gov", "clinicaltrials.gov", "eutils.ncbi.nlm.nih.gov", "www.accessdata.fda.gov", "www.ebi.ac.uk", "www.fda.gov"]);
  });

  it("states the limits that were read from the sources, with their basis, and no others", () => {
    const limit = (id: string) => cards.find((c) => c.file.id === id)!.file.rateLimit;
    expect(limit("openfda-510k")).toMatchObject({ requests: 240, perSeconds: 60, perDay: 1000 });
    expect(limit("pubmed-eutils")).toMatchObject({ requests: 3, perSeconds: 1 });
    expect(limit("crossref")).toMatchObject({ requests: 5, perSeconds: 1 });
    // No documented limit was found for these, so none is claimed; they get a labelled politeness pace instead.
    for (const id of ["clinicaltrials-v2", "europepmc", "fda-accessdata-pdf", "fda-ai-list"]) {
      const card = cards.find((c) => c.file.id === id)!.file;
      expect(card.rateLimit, id).toBeUndefined();
      expect(card.politeness?.basis, id).toMatch(/our own pacing/);
    }
    for (const { file } of cards) if (file.rateLimit) expect(file.rateLimit.basis.length).toBeGreaterThan(20);
  });

  it("shares one request allowance across the three openFDA endpoints", () => {
    const openfda = cards.filter((c) => c.file.id.startsWith("openfda-"));
    expect(openfda).toHaveLength(3);
    for (const c of openfda) expect(c.file.rateLimitGroup).toBe("openfda");
    expect(windowsOf(openfda[0]!.file)).toEqual([{ requests: 240, perSeconds: 60 }, { requests: 1000, perSeconds: 86_400 }]);
  });

  it("keeps what was not verified visible on every card", () => {
    for (const { file } of cards) {
      expect(file.verification.notVerified.length, file.id).toBeGreaterThan(0);
      expect(file.verification.evidence.length, file.id).toBeGreaterThan(0);
    }
    expect(cards.find((c) => c.file.id === "clinicaltrials-v2")!.file.verification.notVerified.join(" ")).toMatch(/Published rate limit/);
    expect(cards.find((c) => c.file.id === "europepmc")!.file.verification.notVerified.join(" ")).toMatch(/Published rate limits/);
  });

  it("exposes the port-level SourceCard for describe()", () => {
    const c = cards.find((x) => x.file.id === "pubmed-eutils")!.card;
    expect(c).toMatchObject({ id: "pubmed-eutils", kind: "literature", auth: "none", dataClass: "public", rateLimit: { requests: 3, perSeconds: 1 } });
    expect(c.identifierFields).toContain("PMID");
    expect(Object.keys(c)).not.toContain("verification");
  });

  it("uses only https, needs no keys, and holds only public data", () => {
    for (const { file } of cards) {
      expect(file.baseUrl.startsWith("https://")).toBe(true);
      expect(file.auth).toBe("none");
      expect(file.dataClass).toBe("public");
      expect(file.hosts.every((h) => h.pathPrefixes && h.pathPrefixes.length > 0), file.id).toBe(true);
    }
  });

  it("never states a verified fact the record does not support: no claims of completeness or truth in the card text", () => {
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const text = cardText(name);
      // The banned claim words are assembled from parts so this file does not itself contain them.
      const banned = ["bes" + "t", "pro" + "of", "guarantee" + "d", "accura" + "te", "production-" + "ready", "state-of-the-" + "art"];
      for (const word of banned) expect(text.toLowerCase(), `${name}: ${word}`).not.toContain(word);
    }
  });

  it("describes the FDA AI list as a pinned snapshot", () => {
    const f = cards.find((c) => c.file.id === "fda-ai-list")!.file;
    expect(f.access).toBe("pinned-snapshot");
    expect(f.snapshot?.manifest).toBe("snapshots/fda-ai-enabled-devices.yaml");
  });
});

describe("card validation", () => {
  const base = () => parseYaml(cardText("crossref.yaml")) as Record<string, any>;
  const check = (mutate: (c: Record<string, any>) => void) => {
    const c = base();
    mutate(c);
    return () => parseCard(stringifyYaml(c), "test.yaml");
  };

  it("accepts the unmodified card", () => {
    expect(check(() => undefined)).not.toThrow();
  });

  it.each([
    ["a missing id", (c: any) => delete c.id, /id/],
    ["an upper-case id", (c: any) => (c.id = "Crossref"), /id/],
    ["an http base URL", (c: any) => (c.baseUrl = "http://api.crossref.org"), /baseUrl/],
    ["a base URL whose host is not listed", (c: any) => (c.baseUrl = "https://elsewhere.example"), /not in hosts/],
    ["a host with a path prefix that does not start with a slash", (c: any) => (c.hosts[0].pathPrefixes = ["works"]), /hosts/],
    ["an upper-case host", (c: any) => (c.hosts[0].host = "API.CROSSREF.ORG"), /lower-case/],
    ["no hosts", (c: any) => (c.hosts = []), /hosts/],
    ["an unknown connector", (c: any) => (c.connector = "mystery"), /connector/],
    ["an unknown kind", (c: any) => (c.kind = "blog"), /kind/],
    ["a negative rate", (c: any) => (c.rateLimit.requests = -1), /requests/],
    ["a rate with no basis", (c: any) => delete c.rateLimit.basis, /basis/],
    ["a daily cap with no shared group", (c: any) => ((c.rateLimit.perDay = 100), delete c.rateLimitGroup), /rateLimitGroup/],
    ["a pinned snapshot with no manifest", (c: any) => (c.access = "pinned-snapshot"), /snapshot/],
    ["an unknown data class", (c: any) => (c.dataClass = "secret"), /dataClass/],
    ["a verification with no evidence", (c: any) => (c.verification.evidence = []), /evidence/],
    ["a malformed verification date", (c: any) => (c.verification.verifiedOn = "yesterday"), /verifiedOn/],
    ["a contract with an unknown type", (c: any) => (c.responseContracts.work[0].type = "text"), /type/],
  ])("rejects %s", (_name, mutate, message) => {
    expect(check(mutate as never)).toThrow(CardError);
    expect(check(mutate as never)).toThrow(message);
  });

  it("rejects malformed YAML and an empty directory, and duplicate ids", () => {
    expect(() => parseCard("id: [unterminated", "bad.yaml")).toThrow(/invalid YAML/);
    expect(() => loadSourceCards(tmp())).toThrow(/no source cards/);
    const d = tmp();
    fs.writeFileSync(path.join(d, "a.yaml"), cardText("crossref.yaml"));
    fs.writeFileSync(path.join(d, "b.yaml"), cardText("crossref.yaml"));
    expect(() => loadSourceCards(d)).toThrow(/duplicate source card id "crossref"/);
  });

  it("rejects two cards in one rate-limit group that state different limits", () => {
    const d = tmp();
    fs.cpSync(dir, d, { recursive: true });
    const text = fs.readFileSync(path.join(d, "openfda-pma.yaml"), "utf8").replace("requests: 240", "requests: 120");
    fs.writeFileSync(path.join(d, "openfda-pma.yaml"), text);
    expect(() => createSourceLayer({ mode: "cassette", cardsDir: d })).toThrow(/share rate-limit group "openfda" but state different limits/);
  });
});

describe("pinned FDA AI-list snapshot", () => {
  const manifest = path.join(dir, "snapshots", "fda-ai-enabled-devices.yaml");

  it("loads, matches its hash, and describes itself", () => {
    const s = loadSnapshot(manifest);
    expect(s.manifest.rows).toBe(1614);
    expect(s.manifest.columns).toEqual(["Date of Final Decision", "Submission Number", "Device", "Company", "Panel (Lead)", "Primary Product Code"]);
    expect(s.manifest.contentCurrentAsOf).toBe("2026-09-04");
    expect(s.manifest.sourceLastModified).toBe("2026-09-04T11:54:09.000Z");
    expect(s.bytes.length).toBe(s.manifest.bytes);
    expect(s.manifest.notes.join(" ")).toMatch(/introduced by the capture/);
  });

  it("fails on a changed byte, a missing file, a wrong size and a malformed manifest", () => {
    const d = tmp();
    fs.cpSync(path.join(dir, "snapshots"), d, { recursive: true });
    const csv = path.join(d, "fda-ai-enabled-devices.csv");
    const original = fs.readFileSync(csv);
    const changed = Buffer.from(original);
    changed[10] = changed[10]! ^ 1;
    fs.writeFileSync(csv, changed);
    expect(() => loadSnapshot(path.join(d, "fda-ai-enabled-devices.yaml"))).toThrow(SnapshotIntegrityError);
    expect(() => loadSnapshot(path.join(d, "fda-ai-enabled-devices.yaml"))).toThrow(/hashes to/);
    fs.rmSync(csv);
    expect(() => loadSnapshot(path.join(d, "fda-ai-enabled-devices.yaml"))).toThrow(/not found/);
    fs.writeFileSync(path.join(d, "fda-ai-enabled-devices.yaml"), "id: x\n");
    expect(() => loadSnapshot(path.join(d, "fda-ai-enabled-devices.yaml"))).toThrow(/malformed/);
    expect(() => loadSnapshot(path.join(d, "missing.yaml"))).toThrow(/manifest not found/);
  });
});
