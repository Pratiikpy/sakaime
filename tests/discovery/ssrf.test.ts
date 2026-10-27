/**
 * C-03 through the real SSRF-safe fetcher: the pipeline hands every URL to the fetcher, and a refusal there ends the
 * run at the probe with the reason, before anything is mapped or registered. The fetcher's own rules have their suite
 * in tests/sources; these tests check that onboarding is wired to it and reports what it says.
 */
import { afterEach, describe, expect, it } from "vitest";
import { onboardSource } from "../../src/discovery/index.ts";
import { SafeFetcher } from "../../src/sources/safe-fetch.ts";
import { clearances, csv, harness, TEST_HOST, urlOf, type Harness } from "./helpers/fixtures.ts";
import { modelMapping } from "./helpers/doubles.ts";
import { pub, resolverDouble, scriptedTransport, type ScriptedResponse } from "../sources/helpers.ts";

let h: Harness;
afterEach(() => h?.close());

const MAP = { k_number: "submission_number", applicant: "applicant", device_name: "device_name" };
const body = csv(["k_number", "applicant", "device_name"], clearances().map((r) => [r[0]!, r[1]!, r[2]!]));

async function withFetcher(script: (url: URL, call: number) => ScriptedResponse, opts: { resolve?: Parameters<typeof resolverDouble>[0]; maxBytes?: number } = {}) {
  h = await harness({ model: modelMapping(MAP), config: { maxProbeBytes: opts.maxBytes ?? 2 * 1024 * 1024 } });
  const dns = resolverDouble(opts.resolve ?? { [TEST_HOST]: [pub()] });
  const transport = scriptedTransport((req, i) => script(req.url, i));
  const fetcher = new SafeFetcher({ allowlist: h.deps.sources.allowlist, resolver: dns.resolver, transport: transport.transport });
  h.deps.sources = { ...h.deps.sources, fetcher, resolver: dns.resolver };
  return { dns, transport };
}

describe("onboarding through the real fetcher", () => {
  it("fetches an allowlisted URL, pinned to the vetted address, and registers", async () => {
    const { transport } = await withFetcher(() => ({ status: 200, headers: { "content-type": "text/csv" }, chunks: [body] }));
    const r = await onboardSource(await h.request("a.csv", { expectedJoinRate: 0.8 }), h.deps);
    expect(r.outcome).toBe("registered");
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.address).toBe("93.184.216.34");
    expect(JSON.stringify(r.stages[0])).toContain("93.184.216.34");
  });

  it("refuses a redirect to the cloud metadata address, to a private host, to another host and to http", async () => {
    for (const target of ["https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/export/a.csv", "https://evil.example.org/export/a.csv", "http://registry.partner-data.test/export/a.csv"]) {
      const { transport } = await withFetcher(() => ({ status: 302, headers: { location: target } }));
      const r = await onboardSource(await h.request("a.csv"), h.deps);
      expect(r.outcome, target).toBe("declined");
      expect(r.stages.find((s) => s.stage === "bounded_probe")?.status, target).toBe("failed");
      expect(r.reason, target).toMatch(/redirect .* was refused|REFUSED/);
      expect(transport.calls, target).toHaveLength(1);
      expect(h.model.requests, target).toEqual([]);
      expect(h.store.puts, target).toBe(0);
      h.close();
    }
  });

  it("refuses a name that resolves to a public address at the pre-check and to a private one when the fetcher resolves it again (DNS rebinding)", async () => {
    const { transport, dns } = await withFetcher(() => ({ status: 200, chunks: [body] }), {
      resolve: (host, call) => (call === 1 ? [pub()] : [{ address: "127.0.0.1", family: 4 as const }]),
    });
    const r = await onboardSource(await h.request("a.csv"), h.deps);
    expect(dns.calls.length).toBeGreaterThanOrEqual(2);
    expect(r.outcome).toBe("declined");
    expect(r.stages[0]!.status).toBe("passed");
    expect(r.reason).toMatch(/blocked address/);
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses a response larger than the probe cap, declared or streamed", async () => {
    await withFetcher(() => ({ status: 200, headers: { "content-length": "999999" }, chunks: [body] }), { maxBytes: 1000 });
    expect((await onboardSource(await h.request("a.csv"), h.deps)).reason).toMatch(/1000-byte cap/);
    h.close();
    await withFetcher(() => ({ status: 200, chunks: [body, body, body] }), { maxBytes: 1000 });
    const r = await onboardSource(await h.request("a.csv"), h.deps);
    expect(r.outcome).toBe("declined");
    expect(r.reason).toMatch(/larger than the 1000-byte cap/);
  });

  it("a timeout is UNAVAILABLE and retryable, not a refusal", async () => {
    await withFetcher(() => ({ fail: Object.assign(new Error("socket hang up"), { name: "TransportError" }) }));
    const r = await onboardSource(await h.request("a.csv"), h.deps);
    expect(r.outcome).toBe("declined");
    expect(h.ledger.get(r.id)?.retryable).toBe(true);
  });

  it("does not follow a redirect to a second allowlisted URL silently: the final URL is the one recorded", async () => {
    await withFetcher((url) => (url.pathname === "/export/a.csv" ? { status: 301, headers: { location: urlOf("b.csv") } } : { status: 200, chunks: [body] }));
    const r = await onboardSource(await h.request("a.csv", { expectedJoinRate: 0.8 }), h.deps);
    expect(r.outcome).toBe("registered");
    const probe = r.stages.find((s) => s.stage === "bounded_probe") as { detail?: { http: { finalUrl: string; redirects: number } } };
    expect(probe.detail?.http.finalUrl).toBe(urlOf("b.csv"));
    expect(probe.detail?.http.redirects).toBe(1);
  });
});
