import { createHash } from "node:crypto";
import type { Conflicts } from "./conflicts.ts";
import { cosine } from "./lexical.ts";
import { scopeKey } from "./scope.ts";
import type { MemoryStore } from "./store.ts";
import { DAY_MS, DEFAULTS, HMemError, type LedgerAction, type MemoryRecord } from "./types.ts";

export interface Guardrail {
  name: string;
  status: "clear" | "protected";
  detail: string;
}

export interface PreviewAction {
  action: "consolidate" | "archive" | "synthesize";
  ids: string[];
  reason: string;
  /** What each affected record's ledger entry will say if this action runs. */
  expectedLedger: LedgerAction;
  ageDays: number;
  guardrails: Guardrail[];
}

export interface SleepPreview {
  previewId: string;
  generatedAt: number;
  toConsolidate: string[];
  toArchive: string[];
  toSynthesize: string[][];
  actions: PreviewAction[];
  /** Records that met the archive age and access rule but a guardrail kept: shown so an operator sees why they stay. */
  protectedFromArchive: { id: string; guardrail: string }[];
}

export interface SleepReport {
  backupId: string;
  consolidated: number;
  archived: number;
  synthesized: number;
  /** Planned actions that were not run because they were no longer in a fresh preview. */
  skipped: { action: string; ids: string[]; reason: string }[];
  actionLog: string[];
  ledgerIds: string[];
}

/**
 * Sleep: preview first, then execute exactly what the preview showed.
 *
 * Differences from the reference, each tested: `execute` recomputes the preview and runs only what
 * is in both, so "execution never discovers new work" is enforced and a stale or forged plan cannot
 * archive something that is no longer eligible; backups are written to the database and survive a
 * restart; consolidation covers working as well as short-term records (the specification's prose);
 * the archive guardrails include records with open conflicts, records pending review and records at
 * or above a confidence threshold, besides superseding, derived and hub records; synthesis never
 * combines records of different organizations or cases, different types, superseded, derived or
 * review-tagged records; and synthesis by default keeps its sources, marked as superseded, instead
 * of deleting them.
 */
export class Sleep {
  constructor(
    private store: MemoryStore,
    private conflicts: Conflicts,
    private opts: { protectConfidence: number; sourceDisposition: "supersede" | "delete" },
  ) {}

  preview(): SleepPreview {
    const now = this.store.clock();
    const all = this.store.all();
    const referenced = new Set<string>();
    for (const m of all) {
      for (const r of m.relatedTo) referenced.add(r);
      if (m.supersedes) referenced.add(m.supersedes);
      for (const d of m.derivedFrom ?? []) referenced.add(d);
    }
    const inConflict = new Set<string>();
    for (const c of this.conflicts.queue()) {
      inConflict.add(c.memoryA);
      inConflict.add(c.memoryB);
    }
    const isReview = (m: MemoryRecord) => m.tags.includes("review") || m.tags.includes("wrong");
    const ageDays = (m: MemoryRecord) => Math.floor((now - m.timestamp) / DAY_MS);

    const archive: PreviewAction[] = [];
    const protectedFromArchive: SleepPreview["protectedFromArchive"] = [];
    for (const m of all) {
      const old = now - m.timestamp >= DEFAULTS.archiveMinDays * DAY_MS;
      if (!(old && m.accessCount <= DEFAULTS.archiveMaxAccess && !referenced.has(m.id))) continue;
      const checks: Guardrail[] = [
        { name: "superseding-or-current", status: m.supersedes ? "protected" : "clear", detail: m.supersedes ? `replaces ${m.supersedes}` : "replaces nothing" },
        { name: "derived-or-synthesized", status: (m.derivedFrom ?? []).length > 0 ? "protected" : "clear", detail: `derivedFrom has ${(m.derivedFrom ?? []).length} entries` },
        { name: "relationship-hub", status: m.relatedTo.length >= DEFAULTS.hubThreshold ? "protected" : "clear", detail: `${m.relatedTo.length} related records` },
        { name: "unresolved-conflict", status: inConflict.has(m.id) ? "protected" : "clear", detail: inConflict.has(m.id) ? "in an open conflict" : "no open conflict" },
        { name: "pending-review", status: isReview(m) ? "protected" : "clear", detail: isReview(m) ? "tagged review" : "not tagged review" },
        { name: "high-confidence", status: m.confidence >= this.opts.protectConfidence ? "protected" : "clear", detail: `confidence ${m.confidence} against threshold ${this.opts.protectConfidence}` },
      ];
      const blocking = checks.find((c) => c.status === "protected");
      if (blocking) {
        protectedFromArchive.push({ id: m.id, guardrail: blocking.name });
        continue;
      }
      archive.push({ action: "archive", ids: [m.id], reason: `${ageDays(m)} days old, ${m.accessCount} accesses, nothing references it`, expectedLedger: "sleep_archive", ageDays: ageDays(m), guardrails: checks });
    }
    const archiveIds = new Set(archive.flatMap((a) => a.ids));

    // Synthesis groups: seed-and-sweep on cosine, inside one scope and one type.
    const pool = all.filter((m) => !m.supersededBy && !(m.derivedFrom?.length) && !isReview(m) && !inConflict.has(m.id) && !archiveIds.has(m.id));
    const synth: PreviewAction[] = [];
    const used = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
      const seed = pool[i]!;
      if (used.has(seed.id)) continue;
      const group = [seed];
      for (let j = i + 1; j < pool.length; j++) {
        const other = pool[j]!;
        if (used.has(other.id) || other.type !== seed.type || scopeKey(other) !== scopeKey(seed)) continue;
        if (cosine(seed.embedding, other.embedding) >= DEFAULTS.synthesisCosine) group.push(other);
      }
      if (group.length < 2) continue;
      for (const g of group) used.add(g.id);
      synth.push({
        action: "synthesize",
        ids: group.map((g) => g.id),
        reason: `${group.length} records at cosine ${DEFAULTS.synthesisCosine} or above with ${seed.id}`,
        expectedLedger: "sleep_synthesize",
        ageDays: Math.max(...group.map(ageDays)),
        guardrails: [{ name: "same-scope-and-type", status: "clear", detail: `scope ${seed.organizationId ?? "none"}/${seed.caseId ?? "none"}, type ${seed.type}` }],
      });
    }

    const consolidate: PreviewAction[] = all
      .filter((m) => (m.layer === "short_term" || m.layer === "working") && now - m.lastAccessed >= DEFAULTS.consolidationDays * DAY_MS)
      .filter((m) => !archiveIds.has(m.id) && !used.has(m.id) && !m.supersededBy && !isReview(m))
      .map((m) => ({
        action: "consolidate" as const,
        ids: [m.id],
        reason: `${m.layer} record not accessed for ${Math.floor((now - m.lastAccessed) / DAY_MS)} days`,
        expectedLedger: "sleep_consolidate" as const,
        ageDays: ageDays(m),
        guardrails: [{ name: "not-superseded-or-under-review", status: "clear" as const, detail: "current and not flagged" }],
      }));

    const actions = [...consolidate, ...archive, ...synth];
    return {
      previewId: `preview_${createHash("sha256").update(JSON.stringify([now, actions.map((a) => [a.action, a.ids])])).digest("hex").slice(0, 12)}`,
      generatedAt: now,
      toConsolidate: consolidate.flatMap((a) => a.ids),
      toArchive: archive.flatMap((a) => a.ids),
      toSynthesize: synth.map((a) => a.ids),
      actions,
      protectedFromArchive,
    };
  }

  /**
   * Runs the plan, but only the parts of it that a preview taken now would also contain. A part that
   * is no longer eligible (a record was accessed, referenced or reviewed since the preview) is
   * reported in `skipped` and left alone.
   */
  execute(plan?: SleepPreview, opts: { idempotencyKey?: string; by?: string } = {}): SleepReport {
    return this.store.run(() =>
      this.store.once(
        opts.idempotencyKey,
        "sleep.execute",
        plan ? { previewId: plan.previewId, toConsolidate: plan.toConsolidate, toArchive: plan.toArchive, toSynthesize: plan.toSynthesize } : null,
        () => this.executeInner(plan, opts.by),
        (r) => r,
        (saved) => saved as SleepReport,
      ),
    );
  }

  private executeInner(plan: SleepPreview | undefined, by?: string): SleepReport {
    const fresh = this.preview();
    const wanted = plan ?? fresh;
    const skipped: SleepReport["skipped"] = [];
    const keep = (action: string, ids: string[], ok: Set<string>): string[] => {
      const run = ids.filter((id) => ok.has(id));
      const dropped = ids.filter((id) => !ok.has(id));
      if (dropped.length) skipped.push({ action, ids: dropped, reason: "not in a fresh preview: no longer eligible" });
      return run;
    };
    const consolidate = keep("consolidate", wanted.toConsolidate, new Set(fresh.toConsolidate));
    const archive = keep("archive", wanted.toArchive, new Set(fresh.toArchive));
    const freshGroups = new Set(fresh.toSynthesize.map((g) => [...g].sort().join("|")));
    const synthesize = wanted.toSynthesize.filter((g) => {
      const ok = freshGroups.has([...g].sort().join("|"));
      if (!ok) skipped.push({ action: "synthesize", ids: g, reason: "not in a fresh preview: the group has changed" });
      return ok;
    });

    const now = this.store.clock();
    const ledgerFrom = this.store.db.lastLedgerSeq();
    const backupId = `backup-${this.store.db.next("backup")}`;
    this.store.db.saveBackup(backupId, now, { takenAt: now, records: this.store.all().map((r) => structuredClone(r)) });
    const actionLog = [`backup ${backupId} created`];
    const actor = by;

    for (const id of consolidate) {
      const m = this.store.must(id);
      const from = m.layer;
      this.store.update(id, { layer: "long_term" }, { from, to: "long_term" }, "sleep_consolidate", actor);
      actionLog.push(`consolidated ${id}`);
    }
    for (const id of archive) {
      const m = this.store.must(id);
      this.store.remove(id, "sleep_archive", { ageMs: now - m.timestamp, accessCount: m.accessCount, backupId }, actor);
      actionLog.push(`archived ${id}`);
    }
    let synthesized = 0;
    for (const group of synthesize) {
      const members = group.map((id) => this.store.must(id));
      const distinct = [...new Set(members.map((m) => m.content.trim().replace(/\s+/g, " ").toLowerCase()))];
      const content = distinct.length === 1 ? members[0]!.content : `Synthesis of ${members.length} records: ${members.map((m) => m.content).join(" | ")}`;
      const first = members[0]!;
      const merged = this.store.add({
        content,
        source: "sleep:synthesis",
        type: first.type,
        layer: "long_term",
        tags: [...new Set(members.flatMap((m) => m.tags))],
        confidence: Math.min(...members.map((m) => m.confidence)),
        provenance: { origin: "sleep_synthesis", learnedAt: now, label: `synthesized from ${members.length} records`, refs: group },
        derivedFrom: group,
        entities: [...new Set(members.flatMap((m) => m.entities))],
        ...(first.organizationId ? { organizationId: first.organizationId } : {}),
        ...(first.caseId ? { caseId: first.caseId } : {}),
        ...(first.kind ? { kind: first.kind } : {}),
        ...(actor ? { actor } : {}),
      });
      this.store.log(merged.id, "sleep_synthesize", { details: { sources: group, disposition: this.opts.sourceDisposition } }, actor);
      for (const m of members) {
        if (this.opts.sourceDisposition === "delete") this.store.remove(m.id, "merge", { into: merged.id }, actor);
        else this.store.update(m.id, { supersededBy: merged.id }, { reason: "synthesized into a derived record", into: merged.id }, "merge", actor);
      }
      synthesized++;
      actionLog.push(`synthesized ${merged.id} from ${group.join(", ")}`);
    }
    return { backupId, consolidated: consolidate.length, archived: archive.length, synthesized, skipped, actionLog, ledgerIds: this.store.db.ledgerSince(ledgerFrom).map((e) => e.id) };
  }

  backups(): { id: string; createdAt: number }[] {
    return this.store.db.listBackups();
  }

  /** Puts the record set back as it was when the backup was taken. The ledger keeps everything, including this restore. */
  restore(backupId: string, opts: { by?: string; idempotencyKey?: string } = {}): void {
    this.store.run(() =>
      this.store.once(
        opts.idempotencyKey,
        "sleep.restore",
        { backupId },
        () => {
          const backup = this.store.db.loadBackup<{ records: MemoryRecord[] }>(backupId);
          if (!backup) throw new HMemError("NOT_FOUND", `unknown backup ${backupId}`);
          const before = new Set(this.store.all().map((m) => m.id));
          const restored = new Set(backup.records.map((r) => r.id));
          this.store.replaceAll(backup.records);
          this.store.log("*", "restore", {
            details: {
              backupId,
              restored: backup.records.length,
              removedAfterBackup: [...before].filter((id) => !restored.has(id)),
              recreated: [...restored].filter((id) => !before.has(id)),
            },
          }, opts.by);
        },
        () => ({}),
        () => undefined,
      ),
    );
  }
}
