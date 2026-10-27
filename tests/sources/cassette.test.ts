import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PortError } from "../../src/ports/index.ts";
import { sha256Hex } from "../../src/util/canonical.ts";
import { CassetteFetcher, CassetteIntegrityError, CassetteStore, RecordingFetcher, requestHashOf } from "../../src/sources/cassette.ts";
import { CASSETTE_DIR, allowlistOf, cassette, liveDouble } from "./helpers.ts";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-cass-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const copyCassette = (): string => {
  const dir = tmp();
  fs.cpSync(CASSETTE_DIR, dir, { recursive: true });
  return dir;
};

const enc = (s: string) => new TextEncoder().encode(s);
const ALLOW = allowlistOf("api.fda.gov", "www.fda.gov", "clinicaltrials.gov");

describe("the shipped cassette", () => {
  it("loads with every body verified against its hash", () => {
    const store = CassetteStore.load(CASSETTE_DIR);
    expect(store.size).toBe(JSON.parse(fs.readFileSync(path.join(CASSETTE_DIR, "index.json"), "utf8")).entries.length);
    expect(store.size).toBeGreaterThan(150);
    for (const e of store.entries()) {
      const hit = store.find(e.request.url)!;
      expect(sha256Hex(hit.body)).toBe(e.response.sha256);
      expect(hit.body.length).toBe(e.response.bytes);
    }
  });

  it("holds the real responses the architecture table is built from", () => {
    const c = cassette();
    const status = (url: string) => c.find(url)?.entry.response.status;
    expect(status("https://api.fda.gov/device/510k.json?search=k_number:K200667")).toBe(200);
    expect(status("https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number:%22K253265%22&limit=100")).toBe(404);
    expect(status("https://clinicaltrials.gov/api/v2/version")).toBe(200);
    expect(status("https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN180001.pdf")).toBe(200);
    expect(status("https://www.fda.gov/media/178541/download?attachment")).toBe(200);
  });

  it("labels where each response came from, with the precision of its time", () => {
    const entries = cassette().entries();
    const fixture = entries.filter((e) => e.origin.kind === "feasibility-fixture");
    const live = entries.filter((e) => e.origin.kind === "live-recording");
    expect(fixture.length + live.length).toBe(entries.length);
    expect(live.length).toBeGreaterThanOrEqual(10);
    for (const e of fixture) {
      expect(e.recordedAtPrecision).toBe("day");
      expect(e.origin.ref).toMatch(/^research\/feasibility\/fixtures\//);
    }
    for (const e of live) expect(e.recordedAtPrecision).toBe("instant");
  });

  it("does not store cookies, credentials or tracking headers", () => {
    for (const e of cassette().entries()) {
      expect(Object.keys(e.response.headers).every((h) => ["content-type", "last-modified", "location", "retry-after", "etag"].includes(h))).toBe(true);
    }
  });

  it("records what it left out, with a reason", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(CASSETTE_DIR, "index.json"), "utf8"));
    expect(raw.skipped.some((s: { reason: string }) => /over the \d+-byte repository budget/.test(s.reason))).toBe(true);
    expect(raw.skipped.some((s: { reason: string }) => /timed out or failed/.test(s.reason))).toBe(true);
    expect(raw.unsaved["api.fda.gov"]).toBeGreaterThan(100);
  });
});

describe("integrity: a cassette that differs from its index fails loudly", () => {
  it("a changed body byte is caught", () => {
    const dir = copyCassette();
    const entry = CassetteStore.load(dir).entries()[0]!;
    const file = path.join(dir, "bodies", entry.response.sha256);
    const bytes = fs.readFileSync(file);
    bytes[0] = (bytes[0]! + 1) % 256;
    fs.writeFileSync(file, bytes);
    expect(() => CassetteStore.load(dir)).toThrow(CassetteIntegrityError);
    expect(() => CassetteStore.load(dir)).toThrow(/hashes to/);
  });

  it("a missing body, a truncated body and a missing index are caught", () => {
    const dir = copyCassette();
    const [first, second] = CassetteStore.load(dir).entries();
    fs.rmSync(path.join(dir, "bodies", first!.response.sha256));
    expect(() => CassetteStore.load(dir)).toThrow(/is missing/);
    fs.cpSync(CASSETTE_DIR, dir, { recursive: true });
    const file = path.join(dir, "bodies", second!.response.sha256);
    fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 1));
    expect(() => CassetteStore.load(dir)).toThrow(CassetteIntegrityError);
    expect(() => CassetteStore.load(tmp())).toThrow(/index not found/);
  });

  it("an index entry whose request hash does not match its URL, or that is duplicated, is caught", () => {
    const dir = copyCassette();
    const indexPath = path.join(dir, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const tampered = structuredClone(index);
    tampered.entries[0].request.url = "https://api.fda.gov/device/510k.json?search=k_number:K999999";
    fs.writeFileSync(indexPath, JSON.stringify(tampered));
    expect(() => CassetteStore.load(dir)).toThrow(/hashes to|carries requestHash/);
    const dup = structuredClone(index);
    dup.entries.push(dup.entries[0]);
    fs.writeFileSync(indexPath, JSON.stringify(dup));
    expect(() => CassetteStore.load(dir)).toThrow(/duplicate recording/);
    fs.writeFileSync(indexPath, JSON.stringify({ version: 2 }));
    expect(() => CassetteStore.load(dir)).toThrow(/malformed/);
  });
});

describe("request identity", () => {
  it("ignores parameter order, + versus %20, and a trailing dot on the host", () => {
    const a = requestHashOf("https://api.fda.gov/device/udi.json?search=a%3Ab&limit=100");
    expect(requestHashOf("https://api.fda.gov/device/udi.json?limit=100&search=a:b")).toBe(a);
    expect(requestHashOf("https://api.fda.gov./device/udi.json?limit=100&search=a:b")).toBe(a);
    expect(requestHashOf("https://api.fda.gov/x?term=a+b")).toBe(requestHashOf("https://api.fda.gov/x?term=a%20b"));
  });

  it("separates different requests", () => {
    const urls = [
      "https://api.fda.gov/device/510k.json?search=k_number:K1",
      "https://api.fda.gov/device/510k.json?search=k_number:K2",
      "https://api.fda.gov/device/udi.json?search=k_number:K1",
      "https://clinicaltrials.gov/device/510k.json?search=k_number:K1",
      "https://api.fda.gov/device/510k.json?search=k_number:K1&limit=2",
    ];
    expect(new Set(urls.map(requestHashOf)).size).toBe(urls.length);
  });

  it("is stable under any permutation of parameters with distinct names (property)", () => {
    const pairs = fc.uniqueArray(fc.tuple(fc.string({ minLength: 1, maxLength: 6 }), fc.string({ maxLength: 8 })), { minLength: 1, maxLength: 7, selector: ([k]) => k });
    fc.assert(
      fc.property(
        pairs.chain((list) => fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }))),
        ([list, permuted]) => {
          const build = (l: typeof list) => `https://api.fda.gov/x?${l.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
          expect(requestHashOf(build(permuted))).toBe(requestHashOf(build(list)));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("replay", () => {
  const replay = (dir = CASSETTE_DIR) => new CassetteFetcher(CassetteStore.load(dir), ALLOW);

  it("serves the recorded status, headers and bytes and labels them recorded", async () => {
    const res = await replay().get("https://api.fda.gov/device/510k.json?search=k_number:K200667");
    expect(res.servedFrom).toBe("recorded");
    expect(res.status).toBe(200);
    expect(res.recordedAt).toBe("2026-10-27T00:00:00.000Z");
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(JSON.parse(new TextDecoder().decode(res.body)).results[0].k_number).toBe("K200667");
  });

  it("serves a recorded 404 as a 404, not as an error", async () => {
    const res = await replay().get("https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number:%22K253265%22&limit=100");
    expect(res.status).toBe(404);
  });

  it("has no answer for an unrecorded request and says so, instead of inventing one", async () => {
    const err = await replay().get("https://api.fda.gov/device/510k.json?search=k_number:K111111").catch((e) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.detail.noRecording).toBe(true);
    expect(err.detail.retryable).toBe(false);
    expect(err.message).toMatch(/no recording for/);
  });

  it("still refuses what the live fetcher refuses: other hosts, plain http, credentials, IP literals", async () => {
    for (const url of ["https://example.com/", "http://api.fda.gov/x", "https://u:p@api.fda.gov/x", "https://127.0.0.1/x", "https://api.fda.gov:8443/x"]) {
      const err = await replay().get(url).catch((e) => e);
      expect(err).toBeInstanceOf(PortError);
      expect(err.failure, url).toBe("REFUSED");
    }
  });

  it("applies the same byte cap and peek as the live fetcher", async () => {
    const f = replay();
    const url = "https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN180001.pdf";
    const wide = new CassetteFetcher(CassetteStore.load(CASSETTE_DIR), allowlistOf("www.accessdata.fda.gov"));
    const err = await wide.get(url, { maxBytes: 1000 }).catch((e) => e);
    expect(err.failure).toBe("REFUSED");
    const peek = await wide.get(url, { peekBytes: 8 });
    expect(new TextDecoder().decode(peek.body)).toMatch(/^%PDF-1\./);
    expect(peek.truncated).toBe(true);
    void f;
  });

  it("returns a recorded redirect as is in manual mode and follows it in follow mode", async () => {
    const dir = tmp();
    const store = CassetteStore.create(dir, "t", "t");
    store.add({ url: "https://www.fda.gov/media/1/download", status: 302, headers: { location: "https://www.fda.gov/media/2/download" }, body: new Uint8Array(0), recordedAt: "2026-10-27T00:00:00.000Z", precision: "instant", origin: { kind: "live-recording", ref: "t" } });
    store.add({ url: "https://www.fda.gov/media/2/download", status: 200, headers: { "content-type": "text/csv" }, body: enc("a,b\n"), recordedAt: "2026-10-27T00:00:00.000Z", precision: "instant", origin: { kind: "live-recording", ref: "t" } });
    store.save();
    const f = replay(dir);
    const manual = await f.get("https://www.fda.gov/media/1/download", { redirect: "manual" });
    expect(manual.status).toBe(302);
    expect(manual.headers["location"]).toBe("https://www.fda.gov/media/2/download");
    const followed = await f.get("https://www.fda.gov/media/1/download");
    expect(followed.status).toBe(200);
    expect(followed.redirects).toHaveLength(1);
    expect(new TextDecoder().decode(followed.body)).toBe("a,b\n");
  });
});

describe("recording", () => {
  it("writes what a live fetcher returned, replays it byte for byte, and refuses to overwrite a different answer", async () => {
    const dir = tmp();
    const store = CassetteStore.create(dir, "rec", "recorded in a test");
    const dbl = liveDouble((url) => ({ status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" }, body: `{"url":"${url}"}` }));
    const rec = new RecordingFetcher(dbl, store, { ref: "test", now: () => new Date("2026-10-27T12:00:00Z") });
    const url = "https://api.fda.gov/device/510k.json?search=k_number:K1";
    const live = await rec.get(url);
    store.save();

    const reloaded = CassetteStore.load(dir);
    const replayed = await new CassetteFetcher(reloaded, ALLOW).get(url);
    expect(new TextDecoder().decode(replayed.body)).toBe(new TextDecoder().decode(live.body));
    expect(replayed.recordedAt).toBe("2026-10-27T12:00:00.000Z");
    expect(Object.keys(reloaded.find(url)!.entry.response.headers)).toEqual(["content-type"]); // cookie not kept

    const other = new RecordingFetcher(liveDouble(() => ({ status: 200, body: "different" })), reloaded, { ref: "test" });
    await expect(other.get(url)).rejects.toThrow(/different response is already recorded/);
    const forced = new RecordingFetcher(liveDouble(() => ({ status: 200, body: "different" })), reloaded, { ref: "test", overwrite: true });
    await forced.get(url);
    expect(new TextDecoder().decode(reloaded.find(url)!.body)).toBe("different");
  });

  it("never records a truncated peek as if it were the whole response", async () => {
    const dir = tmp();
    const store = CassetteStore.create(dir, "rec", "t");
    const dbl = liveDouble(() => ({ status: 200, body: "x".repeat(100) }));
    const rec = new RecordingFetcher(dbl, store, { ref: "t" });
    await rec.get("https://api.fda.gov/x", { peekBytes: 10 });
    expect(dbl.calls[0]!.init?.peekBytes).toBeUndefined();
    expect(store.find("https://api.fda.gov/x")!.body.length).toBe(100);
  });

  it("removes bodies that no entry references when saving", () => {
    const dir = tmp();
    const store = CassetteStore.create(dir, "rec", "t");
    store.add({ url: "https://api.fda.gov/a", status: 200, headers: {}, body: enc("one"), recordedAt: "2026-10-27T00:00:00.000Z", precision: "instant", origin: { kind: "live-recording", ref: "t" } });
    store.save();
    fs.writeFileSync(path.join(dir, "bodies", "0".repeat(64)), "stray");
    store.save();
    expect(fs.readdirSync(path.join(dir, "bodies"))).toEqual([sha256Hex(enc("one"))]);
  });
});
