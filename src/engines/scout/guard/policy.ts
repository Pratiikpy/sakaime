/**
 * Layers 2 and 3: policy gate and scope.
 *
 * The policy gate is explicit: either a rule matched or it did not. It enforces who may invoke which intent
 * from which surface, that an export or a case-bound action is for a case the user is assigned to, that a
 * source URL cannot reach the machine's own network, and that nothing leaves the hospital by way of an export
 * destination. Scope is advisory: it lifts the risk level, it never blocks by itself.
 */
import type { ApprovalSpec, DecideContext, Intent, RiskFlag, UserRef } from "../types.ts";

export interface PolicyInput {
  intent: Intent;
  user: UserRef;
  surface: string;
  /** Bindings: the semantic keys plus the typed parameters. */
  params: Record<string, unknown>;
  context?: DecideContext;
}

export interface PolicyResult {
  flags: RiskFlag[];
  approvalsRequired: ApprovalSpec[];
  blocked: boolean;
}

const flag = (verdict: "warn" | "block", rule: string, detail: string, kind = "policy"): RiskFlag => ({ layer: "policy", verdict, kind, rule, detail });

export function evaluatePolicy(i: PolicyInput): PolicyResult {
  const flags: RiskFlag[] = [];
  const approvalsRequired: ApprovalSpec[] = [];
  const { intent, user } = i;

  if (intent.guarded === "block") {
    flags.push(flag("block", `guarded-intent:${intent.id}`, `${intent.id} is never executed${intent.alternatives?.length ? `; ask for ${intent.alternatives.join(" or ")} instead` : ""}`, "guarded-intent"));
  }
  if (!intent.roles.includes("*") && !intent.roles.includes(user.role)) {
    flags.push(flag("block", "role-not-allowed", `role ${JSON.stringify(user.role)} may not invoke ${intent.id}`, "role"));
  }
  if (!intent.surfaces.includes("*") && !intent.surfaces.includes(i.surface)) {
    flags.push(flag("block", "surface-not-allowed", `${intent.id} cannot be invoked from the ${i.surface} surface`, "surface"));
  }
  if (intent.requiresAssignment) {
    const caseId = (i.params.caseId as string | undefined) ?? i.context?.caseId;
    if (caseId && !(user.cases ?? []).includes(caseId)) {
      flags.push(flag("block", "not-assigned", `${user.id} is not assigned to ${caseId}`, "assignment"));
    }
  }
  if (intent.id === "add_source") {
    const url = i.params.url as string | undefined;
    if (url) {
      const bad = checkSourceUrl(url);
      if (bad) flags.push(flag("block", bad.rule, bad.detail, "ssrf"));
    }
  }
  if (intent.id === "export_dossier" && typeof i.params.destination === "string") {
    flags.push(flag("block", "external-destination", "a dossier is written to the case store; it is not sent to an address", "egress"));
  }
  if (intent.riskClass === "high" && intent.guarded === undefined) {
    approvalsRequired.push({ kind: "user-confirm", reason: `${intent.id} is a high-risk action` });
  }
  return { flags, approvalsRequired, blocked: flags.some((f) => f.verdict === "block") };
}

// ---------------------------------------------------------------- source URLs

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

function privateIPv4(h: string): boolean {
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateIPv6(h: string): boolean {
  const x = h.replace(/^\[|\]$/g, "").toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("::ffff:");
}

/**
 * A string-level screen for a URL a user asks to register as a source. It is the first of two defences: the
 * fetcher resolves the name and checks the address it actually connects to. This one only refuses what is
 * wrong on its face.
 */
export function checkSourceUrl(raw: string): { rule: string; detail: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { rule: "url-malformed", detail: "the source URL does not parse" };
  }
  if (u.protocol !== "https:") return { rule: "url-scheme", detail: `only https sources are accepted, not ${u.protocol.replace(":", "")}` };
  if (u.username || u.password) return { rule: "url-credentials", detail: "a source URL may not carry credentials" };
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || METADATA_HOSTS.has(host)) return { rule: "url-internal-host", detail: `${host} is an internal name` };
  if (privateIPv4(host) || (host.startsWith("[") && privateIPv6(host))) return { rule: "url-private-address", detail: `${host} is a private or loopback address` };
  if (!host.includes(".") && !host.startsWith("[")) return { rule: "url-internal-host", detail: `${host} is a single-label name` };
  if (u.port && u.port !== "443") return { rule: "url-port", detail: `port ${u.port} is not accepted` };
  return undefined;
}

// ---------------------------------------------------------------- scope

/** Remembers recent high-risk decisions per user so that a burst of them lifts the risk level. */
export class ScopeTracker {
  private readonly events = new Map<string, number[]>();
  constructor(
    private readonly now: () => number,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  note(user: string): void {
    const t = this.now();
    const list = (this.events.get(user) ?? []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.events.set(user, list);
  }

  recent(user: string): number {
    const t = this.now();
    return (this.events.get(user) ?? []).filter((x) => t - x < this.windowMs).length;
  }

  check(user: string, intent: Intent, prompt: string, context?: DecideContext): RiskFlag[] {
    const flags: RiskFlag[] = [];
    const named = prompt.match(/\bCASE-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i)?.[0]?.toUpperCase();
    if (named && context?.caseId && named !== context.caseId.toUpperCase()) {
      flags.push({ layer: "scope", verdict: "warn", kind: "case-mismatch", rule: "case-mismatch", detail: `the request names ${named} but the active case is ${context.caseId}` });
    }
    if (intent.riskClass === "high" && this.recent(user) >= this.limit) {
      flags.push({ layer: "scope", verdict: "warn", kind: "burst", rule: "recent-high-risk", detail: `${this.recent(user)} high-risk requests in the last ${Math.round(this.windowMs / 60_000)} minutes` });
    }
    return flags;
  }
}
