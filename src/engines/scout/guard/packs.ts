/**
 * Policy packs: named, versioned bundles of guard settings. A request is judged by the composition of the packs
 * the deployment names; where packs disagree the stricter setting wins. An unknown pack name is an error at
 * construction, never at decision time.
 */
import { DEFAULT_PII, type PiiKind, type PiiPolicy } from "./pii.ts";

export interface PolicyPack {
  id: string;
  version: number;
  injection: {
    blockAt: { chat: number; doc: number };
    warnAt: { chat: number; doc: number };
    tight: boolean;
    /** A quoted or reported attack is scored at this fraction of its weight. */
    mentionFactor: number;
  };
  pii: PiiPolicy;
  rate: { capacity: number; refillPerMinute: number; highRiskCapacity: number; highRiskRefillPerMinute: number };
  scope: { recentHighRiskLimit: number; windowMs: number };
}

export class PolicyPackError extends Error {
  constructor(message: string) {
    super(`Scout policy pack: ${message}`);
    this.name = "PolicyPackError";
  }
}

const base: PolicyPack = {
  id: "default",
  version: 1,
  injection: { blockAt: { chat: 0.8, doc: 0.55 }, warnAt: { chat: 0.4, doc: 0.3 }, tight: false, mentionFactor: 0.5 },
  pii: DEFAULT_PII,
  rate: { capacity: 60, refillPerMinute: 60, highRiskCapacity: 8, highRiskRefillPerMinute: 8 },
  scope: { recentHighRiskLimit: 4, windowMs: 10 * 60_000 },
};

export const BUILT_IN_PACKS: Readonly<Record<string, PolicyPack>> = Object.freeze({
  default: base,
  "adversarial-tight": {
    ...base,
    id: "adversarial-tight",
    injection: { blockAt: { chat: 0.7, doc: 0.45 }, warnAt: { chat: 0.3, doc: 0.25 }, tight: true, mentionFactor: 0.7 },
  },
  enterprise: { ...base, id: "enterprise", rate: { capacity: 40, refillPerMinute: 40, highRiskCapacity: 4, highRiskRefillPerMinute: 4 }, scope: { recentHighRiskLimit: 2, windowMs: 10 * 60_000 } },
  regulated: {
    ...base,
    id: "regulated",
    pii: { block: new Set<PiiKind>([...DEFAULT_PII.block, "iban"]), redact: new Set<PiiKind>([...DEFAULT_PII.redact]) },
    scope: { recentHighRiskLimit: 3, windowMs: 10 * 60_000 },
  },
} satisfies Record<string, PolicyPack>);

export interface ComposedPack {
  pack: PolicyPack;
  /** For example "default+adversarial-tight@1", stamped on every contract. */
  version: string;
  ids: string[];
}

export function composePacks(spec: string | readonly (string | PolicyPack)[] | undefined): ComposedPack {
  const list = spec === undefined ? ["default"] : typeof spec === "string" ? [spec] : [...spec];
  if (list.length === 0) throw new PolicyPackError("at least one pack is required");
  const packs = list.map((s) => {
    if (typeof s !== "string") return s;
    const p = BUILT_IN_PACKS[s];
    if (!p) throw new PolicyPackError(`unknown pack ${JSON.stringify(s)}; built-in packs are ${Object.keys(BUILT_IN_PACKS).join(", ")}`);
    return p;
  });
  const first = packs[0] as PolicyPack;
  const merged: PolicyPack = {
    id: packs.map((p) => p.id).join("+"),
    version: Math.max(...packs.map((p) => p.version)),
    injection: {
      blockAt: { chat: Math.min(...packs.map((p) => p.injection.blockAt.chat)), doc: Math.min(...packs.map((p) => p.injection.blockAt.doc)) },
      warnAt: { chat: Math.min(...packs.map((p) => p.injection.warnAt.chat)), doc: Math.min(...packs.map((p) => p.injection.warnAt.doc)) },
      tight: packs.some((p) => p.injection.tight),
      mentionFactor: Math.max(...packs.map((p) => p.injection.mentionFactor)),
    },
    pii: { block: new Set(packs.flatMap((p) => [...p.pii.block])), redact: new Set(packs.flatMap((p) => [...p.pii.redact])) },
    rate: {
      capacity: Math.min(...packs.map((p) => p.rate.capacity)),
      refillPerMinute: Math.min(...packs.map((p) => p.rate.refillPerMinute)),
      highRiskCapacity: Math.min(...packs.map((p) => p.rate.highRiskCapacity)),
      highRiskRefillPerMinute: Math.min(...packs.map((p) => p.rate.highRiskRefillPerMinute)),
    },
    scope: { recentHighRiskLimit: Math.min(...packs.map((p) => p.scope.recentHighRiskLimit)), windowMs: first.scope.windowMs },
  };
  return { pack: merged, version: `${merged.id}@${merged.version}`, ids: packs.map((p) => p.id) };
}
