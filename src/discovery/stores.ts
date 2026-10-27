/**
 * Durable state of the onboarding pipeline: the ledger of what happened to each request, and the queue of mappings
 * waiting for a person. Both have an in-memory form for tests and a JSON-file form that survives a restart, so a run
 * that stopped halfway can be resumed without registering anything twice.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OnboardingResult } from "../api/contract.ts";
import type { RecordKind } from "./canonical.ts";
import type { Fingerprint } from "./fingerprint.ts";
import type { Proposal } from "./lexical.ts";
import type { Conversion } from "./normalise.ts";
import type { ProbeTable } from "./tabular.ts";
import type { OnboardRequest, OnboardingStage } from "./types.ts";
import type { ValidationReport } from "./validate.ts";

export interface StoredFieldMapping {
  sourceField: string;
  canonicalField: string;
  unit?: string;
  conversions: Conversion[];
  /** Hold signatures a reviewer accepted for this column. */
  signatures: string[];
  representation?: "percent" | "fraction";
  dateFamily?: string;
}

export interface StoredMapping {
  schemaHash: string;
  recordKind: RecordKind;
  fields: StoredFieldMapping[];
  tableSignatures: string[];
  basis: "validators" | "reviewer";
  acceptedBy: string;
  acceptedAt: string;
}

export interface LedgerEntry {
  id: string;
  sourceKey: string;
  orgId: string;
  state: "registered" | "held" | "declined";
  /** A declined entry that failed for a reason that may pass (a source or Zetaris was unavailable). */
  retryable: boolean;
  result: OnboardingResult;
  recordKind?: RecordKind;
  schemaHash?: string;
  shape?: Record<string, string>;
  mapping?: StoredMapping;
  /** Set once the snapshot has been landed and the table registered. */
  table?: { database: string; name: string; uri: string; rows: number; snapshotSha256: string };
  sourceId?: string;
  /** The source URL, kept for the drift check. */
  url?: string;
  description?: string;
  updatedAt: string;
}

export interface OnboardingLedger {
  get(id: string): LedgerEntry | undefined;
  /** The registered entry for a source, whatever request registered it. */
  registeredBySource(sourceKey: string): LedgerEntry | undefined;
  put(entry: LedgerEntry): void;
  list(): LedgerEntry[];
}

export class MemoryLedger implements OnboardingLedger {
  protected readonly entries = new Map<string, LedgerEntry>();
  get(id: string): LedgerEntry | undefined {
    const e = this.entries.get(id);
    return e ? structuredClone(e) : undefined;
  }
  registeredBySource(sourceKey: string): LedgerEntry | undefined {
    const hit = [...this.entries.values()].filter((e) => e.sourceKey === sourceKey && e.state === "registered").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return hit ? structuredClone(hit) : undefined;
  }
  put(entry: LedgerEntry): void {
    this.entries.set(entry.id, structuredClone(entry));
  }
  list(): LedgerEntry[] {
    return [...this.entries.values()].map((e) => structuredClone(e));
  }
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

/** One JSON file per entry under a directory. Writes are atomic: a crash leaves the old entry or the new one. */
export class JsonFileLedger extends MemoryLedger {
  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const entry = JSON.parse(readFileSync(join(dir, f), "utf8")) as LedgerEntry;
      this.entries.set(entry.id, entry);
    }
  }
  override put(entry: LedgerEntry): void {
    atomicWrite(join(this.dir, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
    super.put(entry);
  }
}

// ---------------------------------------------------------------- review

export interface ReviewTicket {
  id: string;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
  request: Omit<OnboardRequest, "contract">;
  /** The probe the validators ran on, so an accepted mapping is registered from exactly what was reviewed. */
  table: ProbeTable;
  fingerprint: Fingerprint;
  proposals: Proposal[];
  proposer: "model" | "lexical-fallback" | "memory";
  recorded: boolean;
  sourceId: string;
  /** The source card that granted the host, when there is one. */
  cardId?: string;
  sourceKind: string;
  dataClass: string;
  license: string;
  /** Columns whose text tried to instruct the mapper, and columns where the model and the name matcher disagree. */
  flagged: [string, string][];
  disagreements: [string, string][];
  descriptionFlag?: string;
  /** Stages 1 to 4 as they ran, and the validator's report, so the run can continue from here. */
  stages: OnboardingStage[];
  report: ValidationReport;
  fetched: { finalUrl: string; status: number; sha256: string; at: string };
  /** The result shown to the reviewer while the ticket is pending. */
  result: OnboardingResult;
  /** Per column, the hold signatures that need acceptance; and the table-level ones. */
  holds: { sourceField: string; canonicalField: string; signatures: string[] }[];
  tableHolds: string[];
  /** Columns with an ambiguous day/month order that need a chosen order. */
  needsDateChoice: string[];
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ReviewQueue {
  get(id: string): ReviewTicket | undefined;
  put(ticket: ReviewTicket): void;
  list(status?: ReviewTicket["status"]): ReviewTicket[];
}

export class MemoryReviewQueue implements ReviewQueue {
  protected readonly tickets = new Map<string, ReviewTicket>();
  get(id: string): ReviewTicket | undefined {
    const t = this.tickets.get(id);
    return t ? structuredClone(t) : undefined;
  }
  put(ticket: ReviewTicket): void {
    this.tickets.set(ticket.id, structuredClone(ticket));
  }
  list(status?: ReviewTicket["status"]): ReviewTicket[] {
    return [...this.tickets.values()].filter((t) => !status || t.status === status).map((t) => structuredClone(t));
  }
}

export class JsonFileReviewQueue extends MemoryReviewQueue {
  constructor(private readonly dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as ReviewTicket;
      this.tickets.set(t.id, t);
    }
  }
  override put(ticket: ReviewTicket): void {
    atomicWrite(join(this.dir, `${ticket.id}.json`), `${JSON.stringify(ticket)}\n`);
    super.put(ticket);
  }
}

