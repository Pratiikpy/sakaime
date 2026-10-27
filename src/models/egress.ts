import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PortError, type ModelPort } from "../ports/index.ts";
import { DATA_CLASSES, type DataClass } from "../schemas/common.ts";
import type { TraceSink } from "./trace.ts";
import type { LaneDescriptor, SakaimeModelRequest } from "./types.ts";

/*
 * Egress policy (docs/02-architecture.md s12, decision D-019, requirement C-14).
 *
 *   public               may be sent to a remote model.
 *   vendor-confidential  only to a local lane, or to a remote lane under a recorded, unexpired, scope-matching consent.
 *   phi                  never, to any lane.
 *
 * Every decision, allowed or refused, is written to the trace with its basis. The trace and the prompt log never
 * hold prompt text for anything above `public`, and never hold a forbidden value in any class.
 */

// ---------------------------------------------------------------- consent

export interface ConsentGrant {
  id: string;
  dataClass: "vendor-confidential";
  /** What the consent covers: `case:<id>`, `org:<id>`, or `*` for everything (recorded as deliberate). */
  subject: string;
  /** Lane destinations the consent allows. `*` allows any remote destination. */
  destinations: string[];
  grantedBy: string;
  reason: string;
  grantedAt: string;
  expiresAt: string;
}

export interface ConsentUse {
  at: string;
  role: string;
  requestHash: string;
  destination: string;
}

export type ConsentCheck = { ok: true; grant: ConsentGrant } | { ok: false; reason: string };

type LedgerLine =
  | { op: "grant"; grant: ConsentGrant }
  | { op: "revoke"; id: string; by: string; at: string }
  | { op: "use"; id: string; use: ConsentUse };

/**
 * An append-only record of who allowed vendor-confidential content to leave, for what, until when. The token a caller
 * presents is the grant id; it has no meaning outside this ledger. Optionally persisted as JSON lines so a consent and
 * every use of it survive a restart and can be audited.
 */
export class ConsentLedger {
  private readonly grants = new Map<string, ConsentGrant>();
  private readonly revoked = new Map<string, { by: string; at: string }>();
  private readonly usesById = new Map<string, ConsentUse[]>();

  constructor(
    private readonly options: { path?: string; now?: () => Date } = {},
  ) {
    if (options.path && existsSync(options.path)) this.load(options.path);
  }

  now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  grant(input: { subject: string; destinations?: string[]; grantedBy: string; reason: string; ttlMs: number }): ConsentGrant {
    if (!input.subject.trim()) throw new PortError("INVALID", "a consent must name its subject (for example case:K123456)");
    if (!input.grantedBy.trim()) throw new PortError("INVALID", "a consent must name who granted it");
    if (!input.reason.trim()) throw new PortError("INVALID", "a consent must record why it was granted");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new PortError("INVALID", "a consent must expire: ttlMs must be positive");
    const at = this.now();
    const grant: ConsentGrant = {
      id: `consent_${randomBytes(12).toString("hex")}`,
      dataClass: "vendor-confidential",
      subject: input.subject,
      destinations: input.destinations && input.destinations.length > 0 ? [...input.destinations] : ["*"],
      grantedBy: input.grantedBy,
      reason: input.reason,
      grantedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + input.ttlMs).toISOString(),
    };
    this.grants.set(grant.id, grant);
    this.append({ op: "grant", grant });
    return grant;
  }

  revoke(id: string, by: string): boolean {
    if (!this.grants.has(id) || this.revoked.has(id)) return false;
    const at = this.now().toISOString();
    this.revoked.set(id, { by, at });
    this.append({ op: "revoke", id, by, at });
    return true;
  }

  check(token: string | undefined, context: { subject?: string; destination: string }): ConsentCheck {
    if (!token) return { ok: false, reason: "no consent token was presented" };
    const grant = this.grants.get(token);
    if (!grant) return { ok: false, reason: "the consent token is not in the ledger" };
    if (this.revoked.has(token)) return { ok: false, reason: "the consent was revoked" };
    if (this.now().getTime() >= Date.parse(grant.expiresAt)) return { ok: false, reason: "the consent has expired" };
    if (grant.subject !== "*" && grant.subject !== context.subject) {
      return { ok: false, reason: `the consent covers ${grant.subject}, not ${context.subject ?? "an unnamed subject"}` };
    }
    if (!grant.destinations.includes("*") && !grant.destinations.includes(context.destination)) {
      return { ok: false, reason: `the consent does not cover the destination ${context.destination}` };
    }
    return { ok: true, grant };
  }

  recordUse(id: string, use: ConsentUse): void {
    const list = this.usesById.get(id) ?? [];
    list.push(use);
    this.usesById.set(id, list);
    this.append({ op: "use", id, use });
  }

  uses(id: string): readonly ConsentUse[] {
    return this.usesById.get(id) ?? [];
  }

  /** Grants that are neither revoked nor expired. */
  activeCount(): number {
    const t = this.now().getTime();
    let n = 0;
    for (const g of this.grants.values()) if (!this.revoked.has(g.id) && t < Date.parse(g.expiresAt)) n += 1;
    return n;
  }

  private append(line: LedgerLine): void {
    if (!this.options.path) return;
    mkdirSync(dirname(this.options.path), { recursive: true });
    appendFileSync(this.options.path, `${JSON.stringify(line)}\n`, "utf8");
  }

  private load(path: string): void {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let line: LedgerLine;
      try {
        line = JSON.parse(raw) as LedgerLine;
      } catch {
        throw new PortError("DRIFTED", `the consent ledger ${path} holds a line that is not JSON; it is not trusted`);
      }
      if (line.op === "grant") this.grants.set(line.grant.id, line.grant);
      else if (line.op === "revoke") this.revoked.set(line.id, { by: line.by, at: line.at });
      else if (line.op === "use") {
        const list = this.usesById.get(line.id) ?? [];
        list.push(line.use);
        this.usesById.set(line.id, list);
      }
    }
  }
}

// ---------------------------------------------------------------- values that must never leave or be logged

export interface ForbiddenHit {
  label: string;
}

/**
 * Values the product must never send to a model or write to a log: literals registered by the caller (for example the
 * unmasked form of a column Zetaris masks for the current identity) plus the shapes of credentials. Matching is
 * case-insensitive on the literal. Hits report the label only, never the value.
 */
export class ForbiddenValues {
  private static readonly MIN_LENGTH = 4;
  private readonly literals: { label: string; needle: string }[] = [];

  private static readonly SECRET_SHAPES: { label: string; pattern: RegExp }[] = [
    { label: "nvidia-api-key", pattern: /nvapi-[A-Za-z0-9_-]{16,}/g },
    { label: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
    { label: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
    { label: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  ];

  add(value: string, label: string): this {
    if (value.length < ForbiddenValues.MIN_LENGTH) {
      throw new TypeError(`a forbidden value must be at least ${ForbiddenValues.MIN_LENGTH} characters, or it would match ordinary text`);
    }
    this.literals.push({ label, needle: value.toLowerCase() });
    return this;
  }

  addAll(values: Iterable<string>, label: string): this {
    for (const v of values) this.add(v, label);
    return this;
  }

  scan(text: string): ForbiddenHit[] {
    const hits: ForbiddenHit[] = [];
    const lower = text.toLowerCase();
    for (const { label, needle } of this.literals) if (lower.includes(needle)) hits.push({ label });
    for (const { label, pattern } of ForbiddenValues.SECRET_SHAPES) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) hits.push({ label });
    }
    return hits;
  }

  mask(text: string): string {
    let out = text;
    for (const { label, needle } of this.literals) {
      out = replaceAllInsensitive(out, needle, `[MASKED:${label}]`);
    }
    for (const { label, pattern } of ForbiddenValues.SECRET_SHAPES) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, `[MASKED:${label}]`);
    }
    return out;
  }
}

function replaceAllInsensitive(text: string, needleLower: string, replacement: string): string {
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;
  for (let at = lower.indexOf(needleLower); at !== -1; at = lower.indexOf(needleLower, from)) {
    out += text.slice(from, at) + replacement;
    from = at + needleLower.length;
  }
  return out + text.slice(from);
}

/**
 * A backstop, not a classifier: the caller declares the data class, and a caller can be wrong. These are the few
 * high-precision shapes of patient identifiers. A match on a prompt declared below `phi` refuses it. Absence of a
 * match proves nothing; the product holds no PHI by design (docs/02 s12) and this only catches an accident.
 */
const PHI_SHAPES: { label: string; pattern: RegExp }[] = [
  { label: "us-ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: "medical-record-number", pattern: /\b(?:MRN|medical record (?:number|no\.?))\s*[:#]?\s*[A-Z0-9-]{5,}/i },
  { label: "date-of-birth", pattern: /\b(?:DOB|date of birth)\s*[:#]?\s*\d/i },
];

export function scanForPhi(text: string): ForbiddenHit[] {
  return PHI_SHAPES.filter(({ pattern }) => pattern.test(text)).map(({ label }) => ({ label }));
}

// ---------------------------------------------------------------- the decision

export type EgressBasis =
  | "public-class"
  | "local-lane"
  | "consent"
  | "phi-refused"
  | "unknown-class"
  | "forbidden-value"
  | "phi-pattern"
  | "no-consent";

export interface EgressDecision {
  allowed: boolean;
  basis: EgressBasis;
  reason: string;
  dataClass: string;
  lane: LaneDescriptor;
  role: string;
  requestHash: string;
  bytes: number;
  consentId?: string;
  /** Labels of forbidden values or identifier shapes found. Never the values. */
  hits?: string[];
}

export interface EgressMode {
  lanes: LaneDescriptor[];
  remoteConfigured: boolean;
  localConfigured: boolean;
  /** False until a local lane has answered on this machine. */
  localLaneVerified: boolean;
  activeConsents: number;
  rules: Record<DataClass, string>;
  summary: string;
}

export interface EgressRequest {
  lane: LaneDescriptor;
  dataClass: string;
  role: string;
  system: string;
  user: string;
  requestHash: string;
  consentToken?: string;
  consentSubject?: string;
}

export class EgressPolicy {
  private readonly lanes = new Map<string, LaneDescriptor>();

  constructor(
    private readonly options: {
      consents: ConsentLedger;
      trace: TraceSink;
      forbidden?: ForbiddenValues;
    },
  ) {}

  get forbidden(): ForbiddenValues {
    return (this.options.forbidden ??= new ForbiddenValues());
  }

  registerLane(lane: LaneDescriptor): void {
    this.lanes.set(lane.id, lane);
  }

  /** Marks a lane as exercised. Called only after a call through it answered and its receipt (if any) verified. */
  markLaneVerified(laneId: string): void {
    const lane = this.lanes.get(laneId);
    if (lane) this.lanes.set(laneId, { ...lane, verified: true });
  }

  /** Decides, logs, and returns. Does not throw; `enforce` is the throwing form. */
  authorize(input: EgressRequest): EgressDecision {
    const decision = this.decide(input);
    this.options.trace.emit("egress.decision", {
      allowed: decision.allowed,
      basis: decision.basis,
      reason: decision.reason,
      dataClass: decision.dataClass,
      laneId: decision.lane.id,
      laneLocation: decision.lane.location,
      destination: decision.lane.destination,
      role: decision.role,
      requestHash: decision.requestHash,
      bytes: decision.bytes,
      ...(decision.consentId ? { consentId: decision.consentId } : {}),
      ...(decision.hits ? { hits: decision.hits } : {}),
    });
    return decision;
  }

  enforce(input: EgressRequest): EgressDecision {
    const decision = this.authorize(input);
    if (!decision.allowed) {
      throw new PortError("REFUSED", `egress refused: ${decision.reason}`, {
        basis: decision.basis,
        dataClass: decision.dataClass,
        lane: decision.lane.id,
        ...(decision.hits ? { hits: decision.hits } : {}),
      });
    }
    return decision;
  }

  /** The active mode, for the UI and for the dossier. */
  mode(): EgressMode {
    const lanes = [...this.lanes.values()];
    const remoteConfigured = lanes.some((l) => l.location === "remote");
    const local = lanes.filter((l) => l.location === "local");
    const activeConsents = this.options.consents.activeCount();
    const vendorRule =
      local.length > 0
        ? "processed in the local lane; sent to a remote lane only under a recorded consent"
        : "refused unless a recorded, unexpired consent names the case and the destination (no local lane is configured)";
    const summary = [
      remoteConfigured ? "remote lane configured" : "no remote lane",
      local.length > 0 ? `local lane configured (${local.every((l) => l.verified) ? "verified" : "NOT VERIFIED"})` : "no local lane",
      `${activeConsents} active consent${activeConsents === 1 ? "" : "s"}`,
      "phi refused",
    ].join("; ");
    return {
      lanes,
      remoteConfigured,
      localConfigured: local.length > 0,
      localLaneVerified: local.length > 0 && local.every((l) => l.verified),
      activeConsents,
      rules: { public: "may be sent to a remote lane", "vendor-confidential": vendorRule, phi: "refused on every lane" },
      summary,
    };
  }

  private decide(input: EgressRequest): EgressDecision {
    const text = `${input.system}\n${input.user}`;
    const base = {
      dataClass: input.dataClass,
      lane: input.lane,
      role: input.role,
      requestHash: input.requestHash,
      bytes: Buffer.byteLength(text, "utf8"),
    };
    const refuse = (basis: EgressBasis, reason: string, hits?: string[]): EgressDecision => ({
      ...base,
      allowed: false,
      basis,
      reason,
      ...(hits && hits.length > 0 ? { hits } : {}),
    });

    if (!(DATA_CLASSES as readonly string[]).includes(input.dataClass)) {
      return refuse("unknown-class", `the data class "${String(input.dataClass)}" is not one of ${DATA_CLASSES.join(", ")}; an undeclared class is treated as the most restricted`);
    }
    if (input.dataClass === "phi") {
      return refuse("phi-refused", "protected health information is never sent to a model, on any lane");
    }
    const forbidden = [...new Set(this.forbidden.scan(text).map((h) => h.label))];
    if (forbidden.length > 0) {
      return refuse("forbidden-value", `the prompt holds a value that must never leave (${forbidden.join(", ")})`, forbidden);
    }
    const phi = scanForPhi(text).map((h) => h.label);
    if (phi.length > 0) {
      return refuse("phi-pattern", `the prompt matches a patient-identifier shape (${phi.join(", ")}) although it was declared ${input.dataClass}`, phi);
    }
    if (input.dataClass === "public") {
      return { ...base, allowed: true, basis: "public-class", reason: "public content may be processed on any lane" };
    }
    // vendor-confidential
    if (input.lane.location === "local") {
      return {
        ...base,
        allowed: true,
        basis: "local-lane",
        reason: input.lane.verified
          ? "vendor-confidential content stays on this machine's local lane"
          : "vendor-confidential content goes to the local lane (the lane has not yet been verified on this machine)",
      };
    }
    const consent = this.options.consents.check(input.consentToken, {
      destination: input.lane.destination,
      ...(input.consentSubject !== undefined ? { subject: input.consentSubject } : {}),
    });
    if (!consent.ok) {
      return refuse("no-consent", `vendor-confidential content may not go to the remote lane ${input.lane.destination}: ${consent.reason}`);
    }
    this.options.consents.recordUse(consent.grant.id, {
      at: this.options.consents.now().toISOString(),
      role: input.role,
      requestHash: input.requestHash,
      destination: input.lane.destination,
    });
    return {
      ...base,
      allowed: true,
      basis: "consent",
      reason: `recorded consent ${consent.grant.id} by ${consent.grant.grantedBy} covers ${consent.grant.subject}`,
      consentId: consent.grant.id,
    };
  }
}

// ---------------------------------------------------------------- prompt log

export interface PromptLogEntry {
  ts: string;
  role: string;
  dataClass: string;
  requestHash: string;
  bytes: number;
  outcome: "sent" | "refused";
  /** Present only for a public prompt that was sent, with forbidden values masked. */
  system?: string;
  user?: string;
}

/**
 * The record of what was put in front of a model. Text is kept only for public prompts that were actually sent, and is
 * masked of forbidden values first; for anything else, and for every refused request, only the hash and size are kept.
 */
export class PromptLog {
  readonly entries: PromptLogEntry[] = [];

  constructor(
    private readonly options: {
      forbidden: ForbiddenValues;
      path?: string;
      now?: () => Date;
    },
  ) {
    if (options.path) mkdirSync(dirname(options.path), { recursive: true });
  }

  record(input: { role: string; dataClass: string; system: string; user: string; requestHash: string; outcome: "sent" | "refused" }): PromptLogEntry {
    const keepText = input.outcome === "sent" && input.dataClass === "public";
    const entry: PromptLogEntry = {
      ts: (this.options.now ?? (() => new Date()))().toISOString(),
      role: input.role,
      dataClass: input.dataClass,
      requestHash: input.requestHash,
      bytes: Buffer.byteLength(`${input.system}\n${input.user}`, "utf8"),
      outcome: input.outcome,
      ...(keepText ? { system: this.options.forbidden.mask(input.system), user: this.options.forbidden.mask(input.user) } : {}),
    };
    this.entries.push(entry);
    if (this.options.path) {
      try {
        appendFileSync(this.options.path, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        /* a full disk must not stop a call; the in-memory entry stands */
      }
    }
    return entry;
  }
}

// ---------------------------------------------------------------- routing between lanes

/**
 * Picks the lane for each request by data class and keeps the rest of the policy in the clients, which refuse on their
 * own. A vendor-confidential request goes to the local lane when there is one and, if that lane is down, to the remote
 * lane where the client then demands a consent. PHI is sent to whichever lane exists so that exactly one client logs the
 * refusal.
 */
export class EgressRouter implements ModelPort {
  constructor(
    private readonly options: {
      policy: EgressPolicy;
      trace: TraceSink;
      remote?: ModelPort;
      local?: ModelPort;
    },
  ) {
    if (!options.remote && !options.local) throw new PortError("INVALID", "an egress router needs at least one lane");
  }

  async complete(request: SakaimeModelRequest) {
    const { remote, local, trace } = this.options;
    const cls = request.dataClass as string;
    const order: { lane: "remote" | "local"; port: ModelPort }[] = [];
    if (cls === "vendor-confidential") {
      if (local) order.push({ lane: "local", port: local });
      if (remote) order.push({ lane: "remote", port: remote });
    } else {
      if (remote) order.push({ lane: "remote", port: remote });
      if (local) order.push({ lane: "local", port: local });
    }
    let last: unknown;
    for (const [index, step] of order.entries()) {
      trace.emit("egress.route", { role: request.role, dataClass: cls, lane: step.lane, attempt: index + 1 });
      try {
        return await step.port.complete(request);
      } catch (error) {
        last = error;
        const retryNextLane = error instanceof PortError && error.failure === "UNAVAILABLE" && error.detail?.["cancelled"] !== true;
        if (!retryNextLane || index === order.length - 1) throw error;
        trace.emit("egress.route.fallback", { role: request.role, dataClass: cls, from: step.lane, reason: (error as PortError).message });
      }
    }
    throw last ?? new PortError("UNAVAILABLE", "no lane is configured for this request");
  }

  mode(): EgressMode {
    return this.options.policy.mode();
  }
}

