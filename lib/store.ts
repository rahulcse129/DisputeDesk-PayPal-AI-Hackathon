// Case storage. Everything outside this file talks to the CaseStore interface, so
// SQLite can be swapped for Postgres or Elasticsearch without touching routes or the agent.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { createElasticStore } from "./elastic";
import { searchableText } from "./case-text";
import { seedHistoricalCases } from "./seed";
import type { ActionOutcome, CaseRecord, Category } from "./types";

export interface SearchOptions {
  category?: Category;
  excludeId?: string;
  limit?: number;
}

export type SearchBackend = "sqlite" | "elastic" | "elastic-semantic";

export type ApprovalClaim =
  | { ok: true }
  | { ok: false; reason: "in_progress" | "already_executed"; outcome?: ActionOutcome };

export interface CaseStore {
  get(disputeId: string): CaseRecord | undefined;
  list(): CaseRecord[];
  upsert(record: CaseRecord): CaseRecord;
  search(query: string, opts?: SearchOptions): Promise<CaseRecord[]>;
  /** Which engine answers search(), shown in the UI. */
  searchBackend(): SearchBackend;
  /** Atomically claims the right to execute an approval. Only one caller ever gets ok: true per dispute (unless a prior attempt failed). */
  claimApproval(disputeId: string): ApprovalClaim;
  completeApproval(disputeId: string, outcome: ActionOutcome): void;
  failApproval(disputeId: string, error: string): void;
}

class SqliteCaseStore implements CaseStore {
  private db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        dispute_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        category TEXT,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(dispute_id UNINDEXED, body);
      CREATE TABLE IF NOT EXISTS approvals (
        dispute_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('executing', 'succeeded', 'failed')),
        outcome TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM cases").get() as { n: number };
    if (count.n === 0) for (const c of seedHistoricalCases()) this.upsert(c);
  }

  get(disputeId: string): CaseRecord | undefined {
    const row = this.db.prepare("SELECT data FROM cases WHERE dispute_id = ?").get(disputeId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as CaseRecord) : undefined;
  }

  list(): CaseRecord[] {
    const rows = this.db.prepare("SELECT data FROM cases ORDER BY updated_at DESC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as CaseRecord);
  }

  upsert(record: CaseRecord): CaseRecord {
    const tx = this.db.transaction((r: CaseRecord) => {
      this.db
        .prepare(
          `INSERT INTO cases (dispute_id, status, category, data, updated_at) VALUES (@id, @status, @category, @data, @updated)
           ON CONFLICT(dispute_id) DO UPDATE SET status = excluded.status, category = excluded.category, data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run({ id: r.disputeId, status: r.status, category: r.category ?? null, data: JSON.stringify(r), updated: r.updatedAt });
      this.db.prepare("DELETE FROM cases_fts WHERE dispute_id = ?").run(r.disputeId);
      this.db.prepare("INSERT INTO cases_fts (dispute_id, body) VALUES (?, ?)").run(r.disputeId, searchableText(r));
    });
    tx(record);
    return record;
  }

  searchBackend(): SearchBackend {
    return "sqlite";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<CaseRecord[]> {
    const limit = opts.limit ?? 20;
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"*`);

    let ids: string[];
    if (terms.length === 0) {
      ids = (this.db.prepare("SELECT dispute_id FROM cases ORDER BY updated_at DESC").all() as { dispute_id: string }[]).map((r) => r.dispute_id);
    } else {
      // OR the terms so partial matches still surface; bm25 ranks the best ones first.
      const rows = this.db
        .prepare("SELECT dispute_id FROM cases_fts WHERE cases_fts MATCH ? ORDER BY bm25(cases_fts) LIMIT 200")
        .all(terms.join(" OR ")) as { dispute_id: string }[];
      ids = rows.map((r) => r.dispute_id);
    }

    const out: CaseRecord[] = [];
    for (const id of ids) {
      if (id === opts.excludeId) continue;
      const c = this.get(id);
      if (!c || (opts.category && c.category !== opts.category)) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  claimApproval(disputeId: string): ApprovalClaim {
    const now = new Date().toISOString();
    // IMMEDIATE takes the write lock up front so two concurrent approvals cannot both read "no row".
    const claim = this.db.transaction((): ApprovalClaim => {
      const row = this.db.prepare("SELECT state, outcome FROM approvals WHERE dispute_id = ?").get(disputeId) as
        | { state: string; outcome: string | null }
        | undefined;
      if (!row) {
        this.db.prepare("INSERT INTO approvals (dispute_id, state, updated_at) VALUES (?, 'executing', ?)").run(disputeId, now);
        return { ok: true };
      }
      if (row.state === "failed") {
        this.db.prepare("UPDATE approvals SET state = 'executing', error = NULL, updated_at = ? WHERE dispute_id = ?").run(now, disputeId);
        return { ok: true };
      }
      if (row.state === "executing") return { ok: false, reason: "in_progress" };
      return { ok: false, reason: "already_executed", outcome: row.outcome ? (JSON.parse(row.outcome) as ActionOutcome) : undefined };
    });
    return claim.immediate();
  }

  completeApproval(disputeId: string, outcome: ActionOutcome): void {
    this.db
      .prepare("UPDATE approvals SET state = 'succeeded', outcome = ?, updated_at = ? WHERE dispute_id = ?")
      .run(JSON.stringify(outcome), new Date().toISOString(), disputeId);
  }

  failApproval(disputeId: string, error: string): void {
    this.db
      .prepare("UPDATE approvals SET state = 'failed', error = ?, updated_at = ? WHERE dispute_id = ?")
      .run(error, new Date().toISOString(), disputeId);
  }
}

// One store per server process. Cached on globalThis so dev-server hot reloads reuse the connection.
const g = globalThis as unknown as { __disputeDeskStore?: CaseStore };

export function getStore(): CaseStore {
  // SQLite is the system of record; when Elastic is configured it also powers search.
  if (!g.__disputeDeskStore) {
    const sqlite = new SqliteCaseStore(config.databasePath);
    g.__disputeDeskStore = createElasticStore(sqlite) ?? sqlite;
  }
  return g.__disputeDeskStore;
}

/** For tests: a fresh, isolated in-memory store. */
export function createMemoryStore(): CaseStore {
  return new SqliteCaseStore(":memory:");
}

export function setStoreForTests(store: CaseStore | undefined): void {
  g.__disputeDeskStore = store;
}
