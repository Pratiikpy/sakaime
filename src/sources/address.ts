/**
 * Address vetting for the safe fetcher (requirement C-03).
 *
 * The question asked of every resolved address is "may this process open a socket to it?". The answer is
 * yes only for globally routable unicast addresses. Everything else is refused with a named category so the
 * refusal can be shown to a reviewer: loopback, private, link-local, unique-local, carrier-grade NAT,
 * multicast, unspecified, documentation, benchmarking, reserved, and the well-known cloud metadata endpoints.
 *
 * IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4) are judged by the embedded address, so
 * `::ffff:169.254.169.254` is refused for the same reason `169.254.169.254` is.
 *
 * Only canonical literals are accepted as input. Decimal, octal and hexadecimal IPv4 spellings
 * (`2130706433`, `0177.0.0.1`, `0x7f.1`) are not canonical: `vetAddress` refuses them as invalid, and the URL
 * parser in safe-fetch.ts rewrites them to dotted decimal before any host check, where an IP-literal host
 * is refused outright.
 */
import { isIP } from "node:net";

export type AddressCategory =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "unique-local"
  | "carrier-grade-nat"
  | "multicast"
  | "documentation"
  | "benchmarking"
  | "reserved"
  | "cloud-metadata"
  | "translation"
  | "invalid";

export interface AddressVerdict {
  allowed: boolean;
  category: AddressCategory;
  /** 0 when the input is not an IP literal at all. */
  family: 0 | 4 | 6;
  /** Human-readable, safe to show to a reviewer. */
  reason: string;
}

interface V4Range {
  base: string;
  prefix: number;
  category: AddressCategory;
  label: string;
}

const V4_RANGES: V4Range[] = [
  { base: "0.0.0.0", prefix: 8, category: "unspecified", label: "this-network 0.0.0.0/8" },
  { base: "10.0.0.0", prefix: 8, category: "private", label: "private 10.0.0.0/8" },
  { base: "100.64.0.0", prefix: 10, category: "carrier-grade-nat", label: "carrier-grade NAT 100.64.0.0/10" },
  { base: "127.0.0.0", prefix: 8, category: "loopback", label: "loopback 127.0.0.0/8" },
  { base: "169.254.0.0", prefix: 16, category: "link-local", label: "link-local 169.254.0.0/16" },
  { base: "172.16.0.0", prefix: 12, category: "private", label: "private 172.16.0.0/12" },
  { base: "192.0.0.0", prefix: 24, category: "reserved", label: "IETF protocol assignments 192.0.0.0/24" },
  { base: "192.0.2.0", prefix: 24, category: "documentation", label: "documentation 192.0.2.0/24" },
  { base: "192.88.99.0", prefix: 24, category: "reserved", label: "deprecated 6to4 relay 192.88.99.0/24" },
  { base: "192.168.0.0", prefix: 16, category: "private", label: "private 192.168.0.0/16" },
  { base: "198.18.0.0", prefix: 15, category: "benchmarking", label: "benchmarking 198.18.0.0/15" },
  { base: "198.51.100.0", prefix: 24, category: "documentation", label: "documentation 198.51.100.0/24" },
  { base: "203.0.113.0", prefix: 24, category: "documentation", label: "documentation 203.0.113.0/24" },
  { base: "224.0.0.0", prefix: 4, category: "multicast", label: "multicast 224.0.0.0/4" },
  { base: "240.0.0.0", prefix: 4, category: "reserved", label: "reserved 240.0.0.0/4 (includes broadcast)" },
];

/**
 * Metadata endpoints that cloud providers expose on addresses that are, or look, routable. Most sit in the
 * link-local or carrier-grade ranges already; 168.63.129.16 (Azure) is in public space and must be named.
 */
const METADATA_V4: Record<string, string> = {
  "169.254.169.254": "instance metadata service (AWS, GCP, Azure, OpenStack and others)",
  "169.254.169.253": "AWS DNS resolver",
  "169.254.169.123": "AWS time sync",
  "169.254.170.2": "AWS container credentials endpoint",
  "100.100.100.200": "Alibaba Cloud metadata service",
  "168.63.129.16": "Azure platform wire server",
  "192.0.0.192": "Oracle Cloud legacy metadata address",
};

const METADATA_V6: Record<string, string> = {
  "fd00:ec2:0:0:0:0:0:254": "AWS instance metadata service over IPv6",
  "fd00:ec2:0:0:0:0:0:253": "AWS DNS resolver over IPv6",
};

function parseV4(text: string): number | undefined {
  if (isIP(text) !== 4) return undefined;
  const parts = text.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inV4(value: number, base: string, prefix: number): boolean {
  const b = parseV4(base)!;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (b & mask) >>> 0;
}

function vetV4(value: number, text: string, via?: string): AddressVerdict {
  const prefixNote = via ? `${via} ` : "";
  const meta = METADATA_V4[text];
  if (meta) {
    return { allowed: false, category: "cloud-metadata", family: 4, reason: `${prefixNote}${text} is a cloud metadata address: ${meta}` };
  }
  for (const range of V4_RANGES) {
    if (inV4(value, range.base, range.prefix)) {
      return { allowed: false, category: range.category, family: 4, reason: `${prefixNote}${text} is in ${range.label}` };
    }
  }
  return { allowed: true, category: "public", family: 4, reason: `${prefixNote}${text} is a globally routable IPv4 address` };
}

/** Expand an IPv6 literal to eight 16-bit groups, or undefined if it is not a plain (zone-free) IPv6 literal. */
export function expandV6(text: string): number[] | undefined {
  if (text.includes("%")) return undefined; // zone ids select an interface; never a public destination
  if (isIP(text) !== 6) return undefined;
  let head = text;
  let tail = "";
  const dbl = text.indexOf("::");
  if (dbl >= 0) {
    head = text.slice(0, dbl);
    tail = text.slice(dbl + 2);
  }
  const toGroups = (s: string): number[] | undefined => {
    if (s === "") return [];
    const out: number[] = [];
    const pieces = s.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.includes(".")) {
        if (i !== pieces.length - 1) return undefined;
        const v4 = parseV4(piece);
        if (v4 === undefined) return undefined;
        out.push(v4 >>> 16, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const h = toGroups(head);
  const t = toGroups(tail);
  if (!h || !t) return undefined;
  if (dbl < 0) return h.length === 8 ? h : undefined;
  const missing = 8 - h.length - t.length;
  if (missing < 1) return undefined;
  return [...h, ...new Array<number>(missing).fill(0), ...t];
}

function groupsToBig(groups: number[]): bigint {
  let out = 0n;
  for (const g of groups) out = (out << 16n) | BigInt(g);
  return out;
}

function inV6(value: bigint, base: string, prefix: number): boolean {
  const b = groupsToBig(expandV6(base)!);
  const shift = BigInt(128 - prefix);
  return value >> shift === b >> shift;
}

const v4FromGroups = (hi: number, lo: number): { value: number; text: string } => {
  const value = ((hi << 16) | lo) >>> 0;
  return { value, text: `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}` };
};

function vetV6(groups: number[], text: string): AddressVerdict {
  const value = groupsToBig(groups);
  const canonical = groups.map((g) => g.toString(16)).join(":");
  const refuse = (category: AddressCategory, label: string): AddressVerdict => ({
    allowed: false,
    category,
    family: 6,
    reason: `${text} is ${label}`,
  });

  const meta = METADATA_V6[canonical];
  if (meta) return refuse("cloud-metadata", `a cloud metadata address: ${meta}`);

  if (value === 0n) return refuse("unspecified", "the unspecified address ::");
  if (value === 1n) return refuse("loopback", "the IPv6 loopback address ::1");

  // IPv4-mapped ::ffff:0:0/96: judged by the embedded IPv4 address.
  if (inV6(value, "::ffff:0:0", 96)) {
    const { value: v4, text: v4text } = v4FromGroups(groups[6]!, groups[7]!);
    return { ...vetV4(v4, v4text, "IPv4-mapped IPv6 address,"), family: 6 };
  }
  // ::/96 holds the deprecated IPv4-compatible form; no public destination uses it.
  if (inV6(value, "::", 96)) return refuse("reserved", "in the deprecated IPv4-compatible range ::/96");
  // NAT64 well-known prefix: judged by the embedded IPv4 address.
  if (inV6(value, "64:ff9b::", 96)) {
    const { value: v4, text: v4text } = v4FromGroups(groups[6]!, groups[7]!);
    return { ...vetV4(v4, v4text, "NAT64 address,"), family: 6 };
  }
  if (inV6(value, "64:ff9b:1::", 48)) return refuse("translation", "in the local-use NAT64 range 64:ff9b:1::/48");
  if (inV6(value, "100::", 64)) return refuse("reserved", "in the discard-only range 100::/64");
  // 6to4 2002::/16 embeds the IPv4 address in bits 16..47.
  if (inV6(value, "2002::", 16)) {
    const { value: v4, text: v4text } = v4FromGroups(groups[1]!, groups[2]!);
    return { ...vetV4(v4, v4text, "6to4 address,"), family: 6 };
  }
  if (inV6(value, "fe80::", 10)) return refuse("link-local", "link-local fe80::/10");
  if (inV6(value, "fec0::", 10)) return refuse("reserved", "in the deprecated site-local range fec0::/10");
  if (inV6(value, "fc00::", 7)) return refuse("unique-local", "unique-local fc00::/7");
  if (inV6(value, "ff00::", 8)) return refuse("multicast", "multicast ff00::/8");
  if (inV6(value, "2001:db8::", 32)) return refuse("documentation", "documentation 2001:db8::/32");
  if (inV6(value, "3fff::", 20)) return refuse("documentation", "documentation 3fff::/20");
  // 2001::/23 is the IETF protocol-assignment block: Teredo, benchmarking, ORCHID, AMT and similar. Nothing a
  // source card would name lives there, and Teredo can tunnel to arbitrary IPv4 destinations.
  if (inV6(value, "2001::", 23)) return refuse("reserved", "in the IETF protocol-assignment block 2001::/23");
  // Anything outside 2000::/3 is not global unicast.
  if (!inV6(value, "2000::", 3)) return refuse("reserved", "outside the global unicast range 2000::/3");

  return { allowed: true, category: "public", family: 6, reason: `${text} is a globally routable IPv6 address` };
}

/** Decide whether an address literal may be connected to. Never throws. */
export function vetAddress(raw: string): AddressVerdict {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    return { allowed: false, category: "invalid", family: 0, reason: "not an IP address literal" };
  }
  const kind = isIP(raw);
  if (kind === 4) {
    const value = parseV4(raw);
    if (value === undefined) return { allowed: false, category: "invalid", family: 4, reason: `${raw} is not a canonical IPv4 literal` };
    // Reject leading-zero octets: some stacks read 010 as octal 8, so the text and the socket could disagree.
    if (raw.split(".").some((p) => p.length > 1 && p.startsWith("0"))) {
      return { allowed: false, category: "invalid", family: 4, reason: `${raw} has a leading-zero octet and is ambiguous between decimal and octal` };
    }
    return vetV4(value, raw);
  }
  if (kind === 6) {
    const groups = expandV6(raw);
    if (!groups) return { allowed: false, category: "invalid", family: 6, reason: `${raw} is not a plain IPv6 literal (zone ids are refused)` };
    return vetV6(groups, raw);
  }
  return { allowed: false, category: "invalid", family: 0, reason: `${raw} is not a canonical IP address literal` };
}

/** True when a URL host is an IP literal in any spelling the WHATWG parser accepts (it rewrites them to canonical form). */
export function isIpLiteralHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}
