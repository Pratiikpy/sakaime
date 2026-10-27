import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { HMemError, type LedgerEntry, type MemoryRecord } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface IdempotencyRow {
  key: string;
  op: string;
  payloadHash: string;
  result: string;
}

/**
 * SQLite plumbing for H-MEM. Everything is synchronous because the conformance runner calls the
 * public API without `await`. The ledger table refuses UPDATE and DELETE by trigger, so the
 * append-only guarantee holds against our own bugs too.
 */
export class HMemDb {
  private db: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(persistDir?: string) {
    let location = ":memory:";
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true });
      location = path.join(persistDir, "hmem.sqlite");
    }
    this.db = new DatabaseSync(location);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        previous TEXT,
        new_state TEXT,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS ledger_memory ON ledger (memory_id);
      CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, op TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (memory_id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY (memory_id, model));
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
        BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
        BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
    `);
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!v) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    else if (Number(v.value) > SCHEMA_VERSION) {
      this.db.close();
      throw new HMemError("INVALID_INPUT", `the store was written with schema ${v.value}, this build reads up to ${SCHEMA_VERSION}`);
    }
  }

  tx<T>(fn: () => T): T {
    this.assertOpen();
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  /* ---------------------------------------------------------------- counters */

  next(counter: string): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`counter:${counter}`) as { value: string } | undefined;
    const n = (row ? Number(row.value) : 0) + 1;
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`counter:${counter}`, String(n));
    return n;
  }

  counter(counter: string): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`counter:${counter}`) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /* ---------------------------------------------------------------- records */

  loadRecords(): MemoryRecord[] {
    return (this.db.prepare("SELECT json FROM records ORDER BY rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  saveRecord(rec: MemoryRecord): string {
    const json = JSON.stringify(rec);
    this.db.prepare("INSERT INTO records (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(rec.id, json);
    return json;
  }

  deleteRecord(id: string): void {
    this.db.prepare("DELETE FROM records WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(id);
  }

  /* ---------------------------------------------------------------- ledger */

  appendLedger(e: Omit<LedgerEntry, "id" | "seq">): LedgerEntry {
    const id = `led_${this.next("ledger")}`;
    const r = this.db
      .prepare("INSERT INTO ledger (id, memory_id, action, actor, timestamp, previous, new_state, details) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, e.memoryId, e.action, e.actor, e.timestamp, e.previousState ? JSON.stringify(e.previousState) : null, e.newState ? JSON.stringify(e.newState) : null, e.details ? JSON.stringify(e.details) : null);
    return { ...e, id, seq: Number(r.lastInsertRowid) };
  }

  lastLedgerSeq(): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM ledger").get() as { m: number | null };
    return r.m ?? 0;
  }

  ledgerSince(seq: number): LedgerEntry[] {
    return this.ledger().filter((e) => e.seq > seq);
  }

  ledger(where?: { memoryId?: string }): LedgerEntry[] {
    const rows = (where?.memoryId
      ? this.db.prepare("SELECT * FROM ledger WHERE memory_id = ? ORDER BY seq").all(where.memoryId)
      : this.db.prepare("SELECT * FROM ledger ORDER BY seq").all()) as any[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      memoryId: r.memory_id,
      action: r.action,
      actor: r.actor,
      timestamp: r.timestamp,
      ...(r.previous ? { previousState: JSON.parse(r.previous) } : {}),
      ...(r.new_state ? { newState: JSON.parse(r.new_state) } : {}),
      ...(r.details ? { details: JSON.parse(r.details) } : {}),
    }));
  }

  /* ---------------------------------------------------------------- json tables */

  loadAll<T>(table: "conflicts" | "proposals"): T[] {
    return (this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  save(table: "conflicts" | "proposals", id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table} (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(id, JSON.stringify(value));
  }

  /* ---------------------------------------------------------------- backups */

  saveBackup(id: string, createdAt: number, snapshot: unknown): void {
    this.db.prepare("INSERT INTO backups (id, created_at, json) VALUES (?,?,?)").run(id, createdAt, JSON.stringify(snapshot));
  }

  loadBackup<T>(id: string): T | undefined {
    const r = this.db.prepare("SELECT json FROM backups WHERE id = ?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  listBackups(): { id: string; createdAt: number }[] {
    return (this.db.prepare("SELECT id, created_at FROM backups ORDER BY rowid").all() as any[]).map((r) => ({ id: r.id, createdAt: r.created_at }));
  }

  /* ---------------------------------------------------------------- idempotency */

  getIdempotent(key: string): IdempotencyRow | undefined {
    const r = this.db.prepare("SELECT key, op, payload_hash, result FROM idempotency WHERE key = ?").get(key) as any;
    return r ? { key: r.key, op: r.op, payloadHash: r.payload_hash, result: r.result } : undefined;
  }

  putIdempotent(row: IdempotencyRow): void {
    this.db.prepare("INSERT INTO idempotency (key, op, payload_hash, result) VALUES (?,?,?,?)").run(row.key, row.op, row.payloadHash, row.result);
  }

  /* ---------------------------------------------------------------- embeddings */

  getVector(memoryId: string, model: string): { hash: string; vector: number[] } | undefined {
    const r = this.db.prepare("SELECT vector FROM embeddings WHERE memory_id = ? AND model = ?").get(memoryId, model) as { vector: string } | undefined;
    return r ? JSON.parse(r.vector) : undefined;
  }

  /** `hash` is the hash of the text that was embedded, so a record edited later is re-embedded. */
  putVector(memoryId: string, model: string, hash: string, vector: number[]): void {
    this.db
      .prepare("INSERT INTO embeddings (memory_id, model, vector) VALUES (?,?,?) ON CONFLICT(memory_id, model) DO UPDATE SET vector = excluded.vector")
      .run(memoryId, model, JSON.stringify({ hash, vector }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new HMemError("CLOSED", "the store is closed");
  }
}
