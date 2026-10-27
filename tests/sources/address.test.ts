import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isIpLiteralHost, vetAddress } from "../../src/sources/address.ts";

const refused = (ip: string, category?: string) => {
  const v = vetAddress(ip);
  expect(v.allowed, `${ip}: ${v.reason}`).toBe(false);
  if (category) expect(v.category, `${ip}: ${v.reason}`).toBe(category);
};
const allowed = (ip: string) => {
  const v = vetAddress(ip);
  expect(v.allowed, `${ip}: ${v.reason}`).toBe(true);
  expect(v.category).toBe("public");
};

describe("IPv4 vetting", () => {
  it("refuses loopback, private, link-local, carrier-grade NAT, multicast, reserved and unspecified", () => {
    refused("127.0.0.1", "loopback");
    refused("127.255.255.254", "loopback");
    refused("10.0.0.1", "private");
    refused("10.255.255.255", "private");
    refused("172.16.0.1", "private");
    refused("172.31.255.255", "private");
    refused("192.168.1.1", "private");
    refused("169.254.1.1", "link-local");
    refused("100.64.0.1", "carrier-grade-nat");
    refused("100.127.255.255", "carrier-grade-nat");
    refused("0.0.0.0", "unspecified");
    refused("0.1.2.3", "unspecified");
    refused("224.0.0.1", "multicast");
    refused("239.255.255.255", "multicast");
    refused("240.0.0.1", "reserved");
    refused("255.255.255.255", "reserved");
    refused("192.0.2.5", "documentation");
    refused("198.51.100.5", "documentation");
    refused("203.0.113.5", "documentation");
    refused("198.18.0.1", "benchmarking");
  });

  it("names the cloud metadata endpoints", () => {
    refused("169.254.169.254", "cloud-metadata");
    refused("169.254.170.2", "cloud-metadata");
    refused("100.100.100.200", "cloud-metadata");
    // 168.63.129.16 is in public address space, so only an explicit entry stops it.
    refused("168.63.129.16", "cloud-metadata");
    expect(vetAddress("169.254.169.254").reason).toMatch(/metadata/);
  });

  it("allows addresses just outside every blocked range", () => {
    allowed("8.8.8.8");
    allowed("1.1.1.1");
    allowed("172.15.255.255");
    allowed("172.32.0.1");
    allowed("100.63.255.255");
    allowed("100.128.0.1");
    allowed("169.253.255.255");
    allowed("169.255.0.1");
    allowed("11.0.0.1");
    allowed("192.169.0.1");
    allowed("223.255.255.255");
    allowed("168.63.129.15");
  });

  it("refuses non-canonical spellings of an IPv4 address", () => {
    for (const spelling of ["2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "127.1", "127.0.1", "0177.0.0.1", "127.000.000.001", "1.2.3.4.5", "256.1.1.1", "1.2.3", "", " 127.0.0.1"]) {
      refused(spelling, "invalid");
    }
  });

  it("agrees with an independent integer-range oracle on random addresses", () => {
    const ranges: Array<[number, number]> = [
      [0x00000000, 0x00ffffff],
      [0x0a000000, 0x0affffff],
      [0x64400000, 0x647fffff],
      [0x7f000000, 0x7fffffff],
      [0xa9fe0000, 0xa9feffff],
      [0xac100000, 0xac1fffff],
      [0xc0000000, 0xc00000ff],
      [0xc0000200, 0xc00002ff],
      [0xc0586300, 0xc05863ff],
      [0xc0a80000, 0xc0a8ffff],
      [0xc6120000, 0xc613ffff],
      [0xc6336400, 0xc63364ff],
      [0xcb007100, 0xcb0071ff],
      [0xe0000000, 0xffffffff],
      [0xa83f8110, 0xa83f8110], // 168.63.129.16
    ];
    const text = (n: number) => `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const expectBlocked = ranges.some(([lo, hi]) => n >= lo && n <= hi);
        expect(vetAddress(text(n)).allowed).toBe(!expectBlocked);
      }),
      { numRuns: 4000 },
    );
  });
});

describe("IPv6 vetting", () => {
  it("refuses loopback, unspecified, unique-local, link-local, multicast and the AWS metadata address", () => {
    refused("::1", "loopback");
    refused("0:0:0:0:0:0:0:1", "loopback");
    refused("::", "unspecified");
    refused("fc00::1", "unique-local");
    refused("fd12:3456:789a::1", "unique-local");
    refused("fe80::1", "link-local");
    refused("febf::1", "link-local");
    refused("ff02::1", "multicast");
    refused("fd00:ec2::254", "cloud-metadata");
    refused("FD00:EC2:0:0:0:0:0:254", "cloud-metadata");
  });

  it("judges IPv4-mapped addresses by the embedded IPv4 address, in both spellings", () => {
    refused("::ffff:127.0.0.1", "loopback");
    refused("::ffff:7f00:1", "loopback");
    refused("::ffff:169.254.169.254", "cloud-metadata");
    refused("::ffff:a9fe:a9fe", "cloud-metadata");
    refused("::ffff:10.1.2.3", "private");
    refused("0:0:0:0:0:ffff:c0a8:101", "private");
    allowed("::ffff:8.8.8.8");
    allowed("::ffff:808:808");
  });

  it("judges NAT64 and 6to4 addresses by the embedded IPv4 address", () => {
    refused("64:ff9b::7f00:1", "loopback");
    refused("64:ff9b::169.254.169.254", "cloud-metadata");
    allowed("64:ff9b::808:808");
    refused("2002:7f00:1::1", "loopback");
    refused("2002:a9fe:a9fe::1", "cloud-metadata");
    allowed("2002:808:808::1");
    refused("64:ff9b:1::1", "translation");
  });

  it("refuses documentation, Teredo, protocol-assignment, deprecated and non-global ranges", () => {
    refused("2001:db8::1", "documentation");
    refused("3fff::1", "documentation");
    refused("2001::1", "reserved"); // Teredo
    refused("2001:2::1", "reserved"); // benchmarking, inside 2001::/23
    refused("fec0::1", "reserved");
    refused("::1.2.3.4", "reserved"); // IPv4-compatible
    refused("100::1", "reserved");
    refused("4000::1", "reserved");
    refused("8000::1", "reserved");
  });

  it("refuses the blocks IANA lists as RESERVED inside 2000::/3, including the returned 6bone 3ffe::/16", () => {
    // From the IANA IPv6 Global Unicast Address Assignments registry (status RESERVED), read 2026-10-27. 3ffe::/16 was the 6bone, returned under RFC 5156.
    for (const ip of ["3ffe::1", "3ffe:831f::1", "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "3ffc::1", "3ff8::1", "3ff0::1", "3fe0::1", "3fc0::1", "3f80::1", "3f00::1", "3e00::1", "3c00::1", "3800::1", "3000::1", "3123:4567::1", "2d00::1", "2dff::1", "2e00::1", "2fff::1"]) {
      refused(ip, "reserved");
    }
    expect(vetAddress("3ffe::1").reason).toMatch(/RESERVED/);
  });

  it("refuses everything in 3000::/4, 2d00::/8 and 2e00::/7, for random suffixes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0x3000, max: 0x3fff }),
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 7, maxLength: 7 }),
        (first, rest) => {
          const ip = [first.toString(16), ...rest.map((n) => n.toString(16))].join(":");
          const v = vetAddress(ip);
          expect(v.allowed, ip).toBe(false);
          expect(["reserved", "documentation"]).toContain(v.category);
        },
      ),
      { numRuns: 400 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 0x2d00, max: 0x2fff }), fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 7, maxLength: 7 }), (first, rest) => {
        const ip = [first.toString(16), ...rest.map((n) => n.toString(16))].join(":");
        expect(vetAddress(ip).allowed, ip).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("allows the blocks next to the reserved ones that IANA has delegated to a registry", () => {
    // RIPE NCC 2a00::/12 and 2a10::/12, AFRINIC 2c00::/12, LACNIC 2800::/12, APNIC 2400::/12, ARIN 2600::/12, RIPE 2003::/18.
    for (const ip of ["2c00::1", "2c0f:ffff::1", "2a10::1", "2800::1", "2003::1", "2620:4f:8000::1"]) allowed(ip);
  });

  it("refuses every entry of the IANA IPv6 special-purpose registry that sits inside 2000::/3, except the globally reachable AS112 delegation", () => {
    const entries: [string, string][] = [
      ["2001::1", "reserved"], // 2001::/23 IETF protocol assignments and Teredo 2001::/32
      ["2001:1::1", "reserved"], // PCP anycast
      ["2001:1::2", "reserved"], // TURN anycast
      ["2001:1::3", "reserved"], // DNS-SD SRP anycast
      ["2001:2::1", "reserved"], // benchmarking
      ["2001:3::1", "reserved"], // AMT
      ["2001:4:112::1", "reserved"], // AS112-v6
      ["2001:10::1", "reserved"], // deprecated ORCHID
      ["2001:20::1", "reserved"], // ORCHIDv2
      ["2001:30::1", "reserved"], // drone remote id
      ["2001:db8::1", "documentation"],
      ["3fff::1", "documentation"],
    ];
    for (const [ip, category] of entries) refused(ip, category as never);
    // 2002::/16 (6to4) is judged by the IPv4 address it embeds, and 2620:4f:8000::/48 is delegated and reachable.
    allowed("2002:808:808::1");
    allowed("2620:4f:8000::53");
    // The registry entries outside 2000::/3 are refused as non-global.
    for (const ip of ["5f00::1", "100:0:0:1::1", "64:ff9b:1::1", "fc00::1", "fe80::1"]) expect(vetAddress(ip).allowed, ip).toBe(false);
  });

  it("allows ordinary global unicast addresses", () => {
    allowed("2606:4700:4700::1111");
    allowed("2001:4860:4860::8888");
    allowed("2a00:1450:4001:81b::200e");
    allowed("2400:cb00::1");
  });

  it("refuses zone ids and malformed literals", () => {
    refused("fe80::1%eth0", "invalid");
    refused("2606:4700::1%1", "invalid");
    refused("::ffff:999.1.1.1", "invalid");
    refused("1:2:3:4:5:6:7:8:9", "invalid");
    refused(":::", "invalid");
    refused("g::1", "invalid");
  });

  it("blocks every address inside a blocked IPv6 prefix, for random suffixes", () => {
    const prefixes: Array<[string, number]> = [
      ["fc00", 7],
      ["fe80", 10],
      ["ff00", 8],
    ];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 7, maxLength: 7 }), fc.constantFrom(...prefixes), (rest, [first]) => {
        const ip = [first, ...rest.map((n) => n.toString(16))].join(":");
        expect(vetAddress(ip).allowed).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("IP-literal host detection", () => {
  it("recognises v4 and bracketed v6 hosts and ignores names", () => {
    expect(isIpLiteralHost("127.0.0.1")).toBe(true);
    expect(isIpLiteralHost("[::1]")).toBe(true);
    expect(isIpLiteralHost("[2606:4700::1111]")).toBe(true);
    expect(isIpLiteralHost("api.fda.gov")).toBe(false);
    expect(isIpLiteralHost("localhost")).toBe(false);
  });
});
