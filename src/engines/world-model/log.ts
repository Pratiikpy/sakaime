import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { type WorldEvent, WorldModelError } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface IdempotencyRow {
  key: string;
  op: string;
  payloadHash: string;
  result: string;
}

/**
 * The append-only event log, in SQLite. The log is the only durable truth: every other structure
 * is rebuilt by folding it. UPDATE and DELETE on the events table are refused by triggers, so an
 * append-only guarantee holds even against a bug in this codebase, not just by convention.
 */
export class EventLog {
  private db: DatabaseSync;
  private closed = false;
  private inTx = false;

  constructor(opts: { storage: "memory" | "local"; namespace: string; directory?: string }) {
    let location = ":memory:";
    if (opts.storage === "local") {
      const dir = path.resolve(opts.directory ?? process.cwd(), ".world");
      fs.mkdirSync(dir, { recursive: true });
      location = path.join(dir, `${safeName(opts.namespace)}.sqlite`);
    }
    this.db = new DatabaseSync(location);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        summary TEXT NOT NULL,
        run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('namespace', ?)").run(opts.namespace);
    } else if (Number(row.value) > SCHEMA_VERSION) {
      this.db.close();
      throw new WorldModelError("SCHEMA_VERSION", `the store was written with schema ${row.value}, this build reads up to ${SCHEMA_VERSION}`);
    }
  }

  all(): WorldEvent[] {
    this.assertOpen();
    const rows = this.db.prepare("SELECT * FROM events ORDER BY seq").all() as any[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      schemaVersion: r.schema_version,
      at: r.at,
      recordedAt: r.recorded_at,
      actor: r.actor,
      summary: r.summary,
      ...(r.run_id ? { runId: r.run_id } : {}),
    }));
  }

  append(e: WorldEvent): void {
    this.assertOpen();
    this.db
      .prepare("INSERT INTO events (seq, id, kind, payload, schema_version, at, recorded_at, actor, summary, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(e.seq, e.id, e.kind, JSON.stringify(e.payload), e.schemaVersion, e.at, e.recordedAt, e.actor, e.summary, e.runId ?? null);
  }

  /** Runs `fn` inside one transaction. Anything it appended is rolled back if it throws. */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.inTx) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  getIdempotent(key: string): IdempotencyRow | undefined {
    const r = this.db.prepare("SELECT key, op, payload_hash, result FROM idempotency WHERE key = ?").get(key) as any;
    return r ? { key: r.key, op: r.op, payloadHash: r.payload_hash, result: r.result } : undefined;
  }

  putIdempotent(row: IdempotencyRow): void {
    this.db.prepare("INSERT INTO idempotency (key, op, payload_hash, result) VALUES (?,?,?,?)").run(row.key, row.op, row.payloadHash, row.result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new WorldModelError("CLOSED", "the store is closed");
  }
}

function safeName(ns: string): string {
  return ns.replace(/[^A-Za-z0-9._-]/g, "_");
}
