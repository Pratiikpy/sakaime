import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { httpsTransport, type Transport } from "../../src/sources/https-transport.ts";
import { SafeFetcher, validateUrl, vetResolution } from "../../src/sources/safe-fetch.ts";
import { PUBLIC_IP, allowlistOf, pub, resolverDouble, scriptedTransport, startTlsServer, tlsFixture, type ScriptedResponse, type TlsServer } from "./helpers.ts";

const FDA = "api.fda.gov";
const ALLOW = allowlistOf(FDA, "clinicaltrials.gov", { host: "www.accessdata.fda.gov", pathPrefixes: ["/cdrh_docs/"] });

async function failure(promise: Promise<unknown>): Promise<PortError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PortError);
    return err as PortError;
  }
  throw new Error("expected the call to fail");
}

function fetcherWith(opts: { script?: Parameters<typeof scriptedTransport>[0]; resolve?: Parameters<typeof resolverDouble>[0]; [k: string]: unknown } = {}) {
  const t = scriptedTransport(opts.script ?? (() => ({ chunks: ["{}"] })));
  const r = resolverDouble(opts.resolve ?? { [FDA]: [pub()], "clinicaltrials.gov": [pub("34.120.1.1")], "www.accessdata.fda.gov": [pub("23.1.1.1")] });
  const { script: _s, resolve: _r, ...rest } = opts;
  const fetcher = new SafeFetcher({ allowlist: ALLOW, resolver: r.resolver, transport: t.transport, ...rest });
  return { fetcher, t, r };
}

describe("URL validation (before any DNS or network)", () => {
  it("accepts an allowlisted https URL and normalises case, trailing dot, default port and fragment", () => {
    expect(validateUrl("https://API.FDA.GOV/device/510k.json?search=k_number:K200667", ALLOW).url.href).toBe("https://api.fda.gov/device/510k.json?search=k_number:K200667");
    expect(validateUrl("https://api.fda.gov./device/510k.json", ALLOW).url.hostname).toBe("api.fda.gov");
    expect(validateUrl("https://api.fda.gov:443/x#frag", ALLOW).url.href).toBe("https://api.fda.gov/x");
  });

  it.each([
    ["http scheme", "http://api.fda.gov/x", /only https/],
    ["ftp scheme", "ftp://api.fda.gov/x", /only https/],
    ["file scheme", "file:///etc/passwd", /only https/],
    ["javascript scheme", "javascript:alert(1)", /only https/],
    ["data scheme", "data:text/plain;base64,AAAA", /only https/],
    ["userinfo", "https://user:pw@api.fda.gov/x", /credentials/],
    ["userinfo, user only", "https://user@api.fda.gov/x", /credentials/],
    ["userinfo that spoofs the host", "https://api.fda.gov@evil.example/x", /credentials/],
    ["non-allowlisted host", "https://example.com/", /not on the source allowlist/],
    ["suffix lookalike", "https://api.fda.gov.evil.example/", /not on the source allowlist/],
    ["prefix lookalike", "https://evilapi.fda.gov/", /not on the source allowlist/],
    ["subdomain of an allowed host", "https://x.api.fda.gov/", /not on the source allowlist/],
    ["backslash host confusion", "https://evil.example\\@api.fda.gov/x", /credentials|not on the source allowlist/],
    ["Cyrillic lookalike", "https://аpi.fda.gov/", /not on the source allowlist/],
    ["non-default port 8443", "https://api.fda.gov:8443/x", /port 8443/],
    ["port 80 on https", "https://api.fda.gov:80/x", /port 80/],
    ["port 0", "https://api.fda.gov:0/x", /port 0|not on the source allowlist/],
    ["path outside prefix", "https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/x", /outside the allowed path prefixes/],
    ["dot-segment escape from prefix", "https://www.accessdata.fda.gov/cdrh_docs/../scripts/x", /outside the allowed path prefixes/],
    ["encoded dot-segment escape", "https://www.accessdata.fda.gov/cdrh_docs/%2e%2e/scripts/x", /outside the allowed path prefixes/],
    ["newline injection", "https://api.fda.gov/x\r\nHost: evil.example", /whitespace or control/],
    ["tab inside host", "https://api.\tfda.gov/x", /whitespace or control/],
    ["space", "https://api.fda.gov/a b", /whitespace or control/],
    ["NUL", "https://api.fda.gov/x\u0000", /whitespace or control/],
    ["too long", "https://api.fda.gov/" + "a".repeat(3000), /longer than/],
  ])("refuses %s", (_name, raw, reason) => {
    try {
      validateUrl(raw, ALLOW);
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PortError);
      expect((err as PortError).failure).toBe("REFUSED");
      expect((err as PortError).message).toMatch(reason);
    }
  });

  it.each([
    "https://127.0.0.1/",
    "https://127.0.0.1:443/",
    "https://localhost/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/latest/meta-data/",
    "https://[fd00:ec2::254]/latest/meta-data/",
    "https://169.254.169.254/latest/meta-data/",
    "https://2130706433/", // decimal
    "https://0x7f000001/", // hex
    "https://0x7f.0.0.1/", // mixed hex
    "https://0177.0.0.1/", // octal
    "https://017700000001/", // octal, single number
    "https://127.1/", // shortened
    "https://10.0.0.1/",
    "https://192.168.0.1/",
    "https://8.8.8.8/", // even a public literal: names only
  ])("refuses the IP-literal or internal host %s", (raw) => {
    try {
      validateUrl(raw, ALLOW);
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PortError);
      expect((err as PortError).failure).toBe("REFUSED");
    }
  });

  it("reports a malformed URL as INVALID and an empty one as INVALID", () => {
    expect(() => validateUrl("not a url", ALLOW)).toThrow(/whitespace|parsed/);
    expect(() => validateUrl("", ALLOW)).toThrow(/empty/);
    try {
      validateUrl("https://", ALLOW);
    } catch (err) {
      expect((err as PortError).failure).toBe("INVALID");
    }
  });

  it("names the allowlisted hosts in the refusal detail so a reviewer can see what is permitted", () => {
    try {
      validateUrl("https://example.com/", ALLOW);
    } catch (err) {
      expect((err as PortError).detail?.["allowlisted"]).toEqual(["api.fda.gov", "clinicaltrials.gov", "www.accessdata.fda.gov"]);
    }
  });
});

describe("DNS vetting", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.20.0.5", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "cloud-metadata"],
    ["100.64.0.1", "carrier-grade-nat"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.251", "multicast"],
    ["::1", "loopback"],
    ["fd00:ec2::254", "cloud-metadata"],
    ["fc00::5", "unique-local"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
  ])("refuses an allowlisted name that resolves to %s (%s) and never opens a socket", async (address, category) => {
    const { fetcher, t } = fetcherWith({ resolve: { [FDA]: [{ address, family: address.includes(":") ? 6 : 4 }] } });
    const err = await failure(fetcher.get(`https://${FDA}/device/510k.json`));
    expect(err.failure).toBe("REFUSED");
    expect(err.detail?.["category"]).toBe(category);
    expect(err.message).toMatch(/resolves to a blocked address/);
    expect(t.calls).toHaveLength(0);
  });

  it("refuses if ANY returned address is internal, even when the first is public", async () => {
    const { fetcher, t } = fetcherWith({ resolve: { [FDA]: [pub(), { address: "10.0.0.8", family: 4 }] } });
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("REFUSED");
    expect(t.calls).toHaveLength(0);
    const v6 = fetcherWith({ resolve: { [FDA]: [pub(), { address: "fd00:ec2::254", family: 6 }] } });
    expect((await failure(v6.fetcher.get(`https://${FDA}/x`))).detail?.["category"]).toBe("cloud-metadata");
  });

  it("reports an empty answer and a resolver failure as UNAVAILABLE, not as a refusal", async () => {
    const empty = fetcherWith({ resolve: { [FDA]: [] } });
    expect((await failure(empty.fetcher.get(`https://${FDA}/x`))).failure).toBe("UNAVAILABLE");
    const nx = fetcherWith({ resolve: {} });
    const err = await failure(nx.fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.message).toMatch(/ENOTFOUND/);
  });

  it("vetResolution accepts a list of public addresses unchanged", () => {
    const list = [pub(), pub("2606:4700:4700::1111")];
    expect(vetResolution(FDA, list)).toBe(list);
  });
});

describe("DNS rebinding", () => {
  it("resolves once per hop and hands the transport the address it vetted", async () => {
    const { fetcher, t, r } = fetcherWith();
    const res = await fetcher.get(`https://${FDA}/device/510k.json`);
    expect(r.calls).toEqual([FDA]);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.address).toBe(PUBLIC_IP);
    expect(res.resolvedAddress).toBe(PUBLIC_IP);
  });

  it("a hostname that starts answering with an internal address on the next lookup is refused on that lookup", async () => {
    // First answer public (the check passes and the socket is pinned to it); every later answer is loopback.
    const { fetcher, t, r } = fetcherWith({
      resolve: (_host: string, call: number) => (call === 1 ? [pub()] : [{ address: "127.0.0.1", family: 4 }]),
      script: (_req: unknown, i: number) => (i === 0 ? { status: 302, headers: { location: `https://${FDA}/second` } } : { chunks: ["secret"] }),
    });
    const err = await failure(fetcher.get(`https://${FDA}/first`));
    expect(err.failure).toBe("REFUSED");
    expect(err.message).toMatch(/redirect from https:\/\/api\.fda\.gov\/first|resolves to a blocked address/);
    expect(r.calls).toHaveLength(2);
    // The first hop connected to the vetted public address; the second hop never reached the transport.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.address).toBe(PUBLIC_IP);
  });

  it("falls through to the next vetted address only when the connection could not be made", async () => {
    const { TransportError } = await import("../../src/sources/https-transport.ts");
    const { fetcher, t } = fetcherWith({
      resolve: { [FDA]: [pub("93.184.216.34"), pub("93.184.216.35")] },
      script: (req: { address: string }) => (req.address === "93.184.216.34" ? { fail: new TransportError("connect ECONNREFUSED", "ECONNREFUSED", "connect") } : { chunks: ["ok"] }),
    });
    const res = await fetcher.get(`https://${FDA}/x`);
    expect(res.resolvedAddress).toBe("93.184.216.35");
    expect(t.calls.map((c) => c.address)).toEqual(["93.184.216.34", "93.184.216.35"]);
  });

  it("does not retry another address after the server has started answering", async () => {
    const { TransportError } = await import("../../src/sources/https-transport.ts");
    const { fetcher, t } = fetcherWith({
      resolve: { [FDA]: [pub("93.184.216.34"), pub("93.184.216.35")] },
      script: () => ({ fail: new TransportError("socket hang up", "ECONNRESET", "response") }),
    });
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(t.calls).toHaveLength(1);
  });
});

describe("redirects", () => {
  it("follows a redirect inside the allowlist and re-resolves the new host", async () => {
    const { fetcher, t, r } = fetcherWith({
      script: (_req: unknown, i: number) => (i === 0 ? { status: 301, headers: { location: "https://clinicaltrials.gov/api/v2/version" } } : { chunks: ['{"apiVersion":"2.0.5"}'] }),
    });
    const res = await fetcher.get(`https://${FDA}/moved`);
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe("https://clinicaltrials.gov/api/v2/version");
    expect(res.redirects).toEqual([{ from: `https://${FDA}/moved`, to: "https://clinicaltrials.gov/api/v2/version", status: 301 }]);
    expect(r.calls).toEqual([FDA, "clinicaltrials.gov"]);
    expect(t.calls.map((c) => c.address)).toEqual([PUBLIC_IP, "34.120.1.1"]);
  });

  it("resolves relative and root-relative Location values against the current URL", async () => {
    const { fetcher } = fetcherWith({ script: (_req: unknown, i: number) => (i === 0 ? { status: 302, headers: { location: "/device/udi.json" } } : { chunks: ["{}"] }) });
    expect((await fetcher.get(`https://${FDA}/device/510k.json`)).finalUrl).toBe(`https://${FDA}/device/udi.json`);
  });

  it.each([
    ["to plain http", "http://api.fda.gov/x", /only https/],
    ["to a host outside the allowlist", "https://evil.example/x", /not on the source allowlist/],
    ["to the cloud metadata address", "https://169.254.169.254/latest/meta-data/", /IP-literal/],
    ["to loopback", "https://127.0.0.1/admin", /IP-literal/],
    ["to localhost", "https://localhost/admin", /not on the source allowlist/],
    ["to an IPv6 literal", "https://[::1]/", /IP-literal/],
    ["to a decimal IP literal", "https://2130706433/", /IP-literal/],
    ["protocol-relative to another host", "//evil.example/x", /not on the source allowlist/],
    ["with embedded credentials", "https://u:p@api.fda.gov/x", /credentials/],
    ["to a path outside the host's prefixes", "https://www.accessdata.fda.gov/scripts/x", /outside the allowed path prefixes/],
  ])("refuses a redirect %s and says it was a redirect", async (_name, location, reason) => {
    const { fetcher, t } = fetcherWith({ script: (_req: unknown, i: number) => (i === 0 ? { status: 302, headers: { location } } : { chunks: ["must not be fetched"] }) });
    const err = await failure(fetcher.get(`https://${FDA}/start`));
    expect(err.failure).toBe("REFUSED");
    expect(err.message).toMatch(/^redirect from https:\/\/api\.fda\.gov\/start was refused/);
    expect(err.message).toMatch(reason);
    expect(t.calls).toHaveLength(1);
  });

  it("refuses an allowlisted host that the redirect target resolves to an internal address", async () => {
    const { fetcher, t } = fetcherWith({
      resolve: { [FDA]: [pub()], "clinicaltrials.gov": [{ address: "10.9.9.9", family: 4 }] },
      script: (_req: unknown, i: number) => (i === 0 ? { status: 302, headers: { location: "https://clinicaltrials.gov/x" } } : { chunks: ["x"] }),
    });
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("REFUSED");
    expect(err.detail?.["category"]).toBe("private");
    expect(t.calls).toHaveLength(1);
  });

  it("stops after the hop limit and on a loop", async () => {
    const hops = fetcherWith({ maxRedirects: 3, script: (_req: unknown, i: number) => ({ status: 302, headers: { location: `https://${FDA}/hop${i + 1}` } }) });
    const err = await failure(hops.fetcher.get(`https://${FDA}/hop0`));
    expect(err.message).toMatch(/more than 3 redirects/);
    expect(hops.t.calls).toHaveLength(4);

    const loop = fetcherWith({ script: () => ({ status: 302, headers: { location: `https://${FDA}/a` } }) });
    expect((await failure(loop.fetcher.get(`https://${FDA}/a`))).message).toMatch(/loop/);
  });

  it("returns a 3xx without Location, and a 3xx in manual mode, as they are", async () => {
    const noLoc = fetcherWith({ script: () => ({ status: 302 }) });
    expect((await noLoc.fetcher.get(`https://${FDA}/x`)).status).toBe(302);
    const manual = fetcherWith({ script: () => ({ status: 302, headers: { location: "https://evil.example/apology" } }) });
    const res = await manual.fetcher.get(`https://${FDA}/x`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("https://evil.example/apology");
    expect(manual.t.calls).toHaveLength(1);
  });

  it("never carries cookies: response cookies are dropped and the second hop sends none", async () => {
    const { fetcher, t } = fetcherWith({
      script: (_req: unknown, i: number): ScriptedResponse =>
        i === 0 ? { status: 302, headers: { location: "/y", "set-cookie": "sid=1" } } : { headers: { "set-cookie": "sid=2", "content-type": "text/plain" }, chunks: ["z"] },
    });
    const res = await fetcher.get(`https://${FDA}/x`);
    expect(res.headers["set-cookie"]).toBeUndefined();
    for (const call of t.calls) {
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });
});

describe("request shape", () => {
  it("identifies itself and sends only non-credential headers", async () => {
    const { fetcher, t } = fetcherWith();
    await fetcher.get(`https://${FDA}/x`, { headers: { Accept: "application/json", "Accept-Language": "en" } });
    const h = t.calls[0]!.headers;
    expect(h["user-agent"]).toMatch(/^sakaime-evidence-reader\/\d/);
    expect(h["accept"]).toBe("application/json");
    expect(h["accept-language"]).toBe("en");
    expect(Object.keys(h).sort()).toEqual(["accept", "accept-encoding", "accept-language", "user-agent"]);
  });

  it.each(["Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key", "api_key", "Host", "X-Forwarded-For"])("refuses a caller-supplied %s header", async (name) => {
    const { fetcher, t } = fetcherWith();
    const err = await failure(fetcher.get(`https://${FDA}/x`, { headers: { [name]: "v" } }));
    expect(err.failure).toBe("REFUSED");
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a header value that would split the request", async () => {
    const { fetcher } = fetcherWith();
    const err = await failure(fetcher.get(`https://${FDA}/x`, { headers: { accept: "a\r\nX-Evil: 1" } }));
    expect(err.message).toMatch(/line break/);
  });

  it("exposes GET only", () => {
    const { fetcher } = fetcherWith();
    for (const verb of ["post", "put", "delete", "patch", "request", "head"]) expect((fetcher as unknown as Record<string, unknown>)[verb]).toBeUndefined();
  });
});

describe("body limits", () => {
  it("refuses a body whose declared length is over the cap without reading it", async () => {
    const { fetcher, t } = fetcherWith({ script: () => ({ headers: { "content-length": "999999" }, chunks: ["never read"] }) });
    const err = await failure(fetcher.get(`https://${FDA}/x`, { maxBytes: 1000 }));
    expect(err.failure).toBe("REFUSED");
    expect(err.message).toMatch(/declares 999999 bytes/);
    expect(t.destroyed).toBe(1);
  });

  it("stops a stream with no declared length once it crosses the cap, and closes the connection", async () => {
    const { fetcher, t } = fetcherWith({ script: () => ({ chunks: ["a".repeat(400), "b".repeat(400), "c".repeat(400), "d".repeat(400)] }) });
    const err = await failure(fetcher.get(`https://${FDA}/x`, { maxBytes: 1000 }));
    expect(err.failure).toBe("REFUSED");
    expect(err.message).toMatch(/larger than the 1000-byte cap/);
    expect(t.destroyed).toBe(1);
  });

  it("accepts a body of exactly the cap and refuses one byte more", async () => {
    const exact = fetcherWith({ script: () => ({ chunks: ["a".repeat(500), "b".repeat(500)] }) });
    expect((await exact.fetcher.get(`https://${FDA}/x`, { maxBytes: 1000 })).body.length).toBe(1000);
    const over = fetcherWith({ script: () => ({ chunks: ["a".repeat(500), "b".repeat(501)] }) });
    expect((await failure(over.fetcher.get(`https://${FDA}/x`, { maxBytes: 1000 }))).failure).toBe("REFUSED");
  });

  it("abandons a body that goes quiet (idle timeout) as UNAVAILABLE", async () => {
    const { fetcher, t } = fetcherWith({ idleTimeoutMs: 80, script: () => ({ chunks: ["first", { delayMs: 2000, data: "late" }] }) });
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.message).toMatch(/no data for 80 ms/);
    expect(t.destroyed).toBe(1);
  });

  it("enforces the total time cap on a body that trickles forever", async () => {
    const trickle = Array.from({ length: 200 }, () => ({ delayMs: 20, data: "x" }));
    const { fetcher, t } = fetcherWith({ timeoutMs: 250, idleTimeoutMs: 1000, script: () => ({ chunks: trickle }) });
    const started = Date.now();
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.message).toMatch(/timed out after 250 ms/);
    expect(t.destroyed).toBe(1);
  });

  it("times out a server that accepts the connection and never answers", async () => {
    const { fetcher } = fetcherWith({ timeoutMs: 150, script: () => ({ hang: true }) });
    const err = await failure(fetcher.get(`https://${FDA}/x`));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.detail?.["timeout"]).toBe(true);
  });

  it("times out a resolver that never answers", async () => {
    const { fetcher, t } = fetcherWith({ timeoutMs: 120, resolve: () => new Promise(() => undefined) as never });
    const stuck = new SafeFetcher({ allowlist: ALLOW, resolver: () => new Promise(() => undefined), transport: t.transport, timeoutMs: 120 });
    void fetcher;
    const err = await failure(stuck.get(`https://${FDA}/x`));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(t.calls).toHaveLength(0);
  });

  it("peekBytes returns the first bytes, flags truncation and closes the connection", async () => {
    const { fetcher, t } = fetcherWith({ script: () => ({ chunks: ["%PDF-1.7 ", "x".repeat(50_000)] }) });
    const res = await fetcher.get(`https://${FDA}/x`, { peekBytes: 8 });
    expect(new TextDecoder().decode(res.body)).toBe("%PDF-1.7");
    expect(res.truncated).toBe(true);
    expect(t.destroyed).toBe(1);
  });

  it("peekBytes on a short body returns all of it and does not flag truncation", async () => {
    const { fetcher } = fetcherWith({ script: () => ({ chunks: ["short"] }) });
    const res = await fetcher.get(`https://${FDA}/x`, { peekBytes: 100 });
    expect(new TextDecoder().decode(res.body)).toBe("short");
    expect(res.truncated).toBe(false);
  });

  it("maps transport errors to UNAVAILABLE and TLS failures to non-retryable UNAVAILABLE", async () => {
    const { TransportError } = await import("../../src/sources/https-transport.ts");
    const reset = fetcherWith({ script: () => ({ fail: new TransportError("read ECONNRESET", "ECONNRESET", "response") }) });
    const a = await failure(reset.fetcher.get(`https://${FDA}/x`));
    expect([a.failure, a.detail?.["retryable"]]).toEqual(["UNAVAILABLE", true]);
    const tls = fetcherWith({ script: () => ({ fail: new TransportError("certificate has expired", "CERT_HAS_EXPIRED", "connect") }) });
    const b = await failure(tls.fetcher.get(`https://${FDA}/x`));
    expect([b.failure, b.detail?.["tls"], b.detail?.["retryable"]]).toEqual(["UNAVAILABLE", true, false]);
    expect(b.message).toMatch(/TLS verification failed/);
  });
});

// ---------------------------------------------------------------- real sockets

const fixture = tlsFixture();
const realIt = fixture ? it : it.skip;

describe.skipIf(!fixture)("real HTTPS transport against a local TLS server", () => {
  let server: TlsServer;
  beforeAll(async () => {
    if (fixture) server = await startTlsServer(fixture);
  });
  afterAll(async () => {
    await server?.close();
  });

  const request = (path: string, over: Partial<Parameters<Transport>[0]> = {}) => ({
    url: new URL(`https://pinned.test:${server.port}${path}`),
    address: "127.0.0.1",
    family: 4 as const,
    headers: { "user-agent": "t", "accept-encoding": "gzip, deflate, br" },
    signal: new AbortController().signal,
    extraCa: fixture!.cert,
    ...over,
  });
  const readAll = async (res: Awaited<ReturnType<Transport>>) => {
    const parts: Buffer[] = [];
    for await (const c of res.body) parts.push(Buffer.from(c));
    return Buffer.concat(parts).toString("utf8");
  };

  realIt("connects to the pinned address although the hostname resolves nowhere, and sends Host and SNI for the hostname", async () => {
    const res = await httpsTransport(request("/echo"));
    const echoed = JSON.parse(await readAll(res)) as Record<string, string>;
    expect(res.status).toBe(200);
    expect(echoed["host"]).toBe(`pinned.test:${server.port}`);
    expect(echoed["user-agent"]).toBe("t");
  });

  realIt("drops Set-Cookie and decodes gzip and brotli", async () => {
    const ok = await httpsTransport(request("/ok"));
    expect(ok.headers["set-cookie"]).toBeUndefined();
    await readAll(ok);
    const gz = await httpsTransport(request("/gzip"));
    expect(await readAll(gz)).toBe("hello gzip");
    expect(gz.headers["content-encoding"]).toBeUndefined();
    expect(await readAll(await httpsTransport(request("/br")))).toBe("hello brotli");
  });

  realIt("fails the TLS handshake when the certificate does not match the hostname", async () => {
    const err = await httpsTransport(request("/ok", { url: new URL(`https://other.test:${server.port}/ok`) })).catch((e) => e);
    expect(err.name).toBe("TransportError");
    expect(err.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(err.phase).toBe("connect");
  });

  realIt("fails the TLS handshake when the certificate is not trusted", async () => {
    const err = await httpsTransport(request("/ok", { extraCa: undefined })).catch((e) => e);
    expect(err.name).toBe("TransportError");
    expect(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]).toContain(err.code);
  });

  realIt("reports a refused connection in the connect phase", async () => {
    const err = await httpsTransport(request("/ok", { url: new URL("https://pinned.test:1/ok") })).catch((e) => e);
    expect(err.phase).toBe("connect");
    expect(["ECONNREFUSED", "ETIMEDOUT"]).toContain(err.code);
  });

  /** Fetcher over a real socket: the resolver says "public", the adapter points the vetted address at loopback. */
  const realFetcher = (over: Record<string, unknown> = {}) => {
    const seen: string[] = [];
    const transport: Transport = (req) => {
      seen.push(req.address);
      return httpsTransport({ ...req, address: "127.0.0.1", extraCa: fixture!.cert });
    };
    const fetcher = new SafeFetcher({
      allowlist: allowlistOf({ host: "pinned.test", ports: [server.port] }),
      resolver: resolverDouble({ "pinned.test": [pub()] }).resolver,
      transport,
      ...over,
    });
    return { fetcher, seen };
  };
  const url = (p: string) => `https://pinned.test:${server.port}${p}`;

  realIt("end to end: the transport is handed the vetted public address, redirects are followed, cookies are not kept", async () => {
    const { fetcher, seen } = realFetcher();
    const res = await fetcher.get(url("/redirect-ok"));
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
    expect(res.redirects).toHaveLength(1);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(seen).toEqual([PUBLIC_IP, PUBLIC_IP]);
  });

  realIt("caps a 6 MB stream at the byte limit and stops the transfer", async () => {
    const { fetcher } = realFetcher();
    const before = Date.now();
    const err = await failure(fetcher.get(url("/big"), { maxBytes: 256 * 1024 }));
    expect(err.failure).toBe("REFUSED");
    expect(Date.now() - before).toBeLessThan(5000);
  });

  realIt("caps the decoded size of a compressed response (decompression bomb)", async () => {
    const { fetcher } = realFetcher();
    const err = await failure(fetcher.get(url("/bomb"), { maxBytes: 1024 * 1024 }));
    expect(err.failure).toBe("REFUSED");
    expect(err.message).toMatch(/larger than the 1048576-byte cap/);
  });

  realIt("abandons a stalled body and a silent server", async () => {
    const { fetcher } = realFetcher({ idleTimeoutMs: 150 });
    expect((await failure(fetcher.get(url("/stall")))).message).toMatch(/no data for 150 ms/);
    const silent = realFetcher({ timeoutMs: 200 });
    expect((await failure(silent.fetcher.get(url("/silent")))).message).toMatch(/timed out after 200 ms/);
    const trickle = realFetcher({ timeoutMs: 300, idleTimeoutMs: 2000 });
    expect((await failure(trickle.fetcher.get(url("/trickle")))).message).toMatch(/timed out after 300 ms/);
  });

  realIt("a name that resolves to loopback never reaches the server", async () => {
    const before = server.connections;
    const hostile = new SafeFetcher({
      allowlist: allowlistOf({ host: "pinned.test", ports: [server.port] }),
      resolver: resolverDouble({ "pinned.test": [{ address: "127.0.0.1", family: 4 }] }).resolver,
      extraCa: fixture!.cert,
    });
    const err = await failure(hostile.get(url("/ok")));
    expect(err.failure).toBe("REFUSED");
    expect(err.detail?.["category"]).toBe("loopback");
    expect(server.connections).toBe(before);
  });
});

if (!fixture) {
  describe("real HTTPS transport", () => {
    it.skip("SKIPPED: openssl is not available, so the local TLS server tests cannot run", () => undefined);
  });
}
