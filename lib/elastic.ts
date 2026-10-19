// Elastic-powered case search. SQLite stays the system of record (and holds the
// approval lock, which needs a real transaction); Elasticsearch mirrors every case and
// answers search(), for both the case history page and the agent's search_similar_cases.
//
// With semantic search on, cases are indexed into a semantic_text field, and queries
// combine keyword relevance (BM25) with semantic similarity, so "package never showed
// up" finds past "item not received" cases even with no shared words.
//
// Enabled by ELASTIC_URL or ELASTIC_CLOUD_ID (+ ELASTIC_API_KEY). If Elastic is
// unreachable, search falls back to SQLite so the app keeps working.

import { Client } from "@elastic/elasticsearch";
import { searchableText } from "./case-text";
import { config } from "./config";
import type { CaseStore, SearchBackend, SearchOptions } from "./store";
import type { CaseRecord } from "./types";

/** The slice of the Elasticsearch client this module uses (lets tests pass a fake). */
export interface EsLike {
  indices: {
    exists(p: { index: string }): Promise<boolean>;
    create(p: { index: string; mappings: unknown }): Promise<unknown>;
    getMapping(p: { index: string }): Promise<Record<string, { mappings?: { properties?: Record<string, unknown> } }>>;
  };
  index(p: { index: string; id: string; document: unknown; refresh?: boolean | "wait_for" }): Promise<unknown>;
  bulk(p: { operations: unknown[]; refresh?: boolean | "wait_for" }): Promise<{ errors: boolean; items: Record<string, { error?: { reason?: string } }>[] }>;
  search(p: Record<string, unknown>): Promise<{ hits: { hits: { _id?: string; _source?: unknown }[] } }>;
}

interface CaseDoc {
  dispute_id: string;
  status: string;
  category?: string;
  recommendation?: string;
  result?: string;
  buyer_claim: string;
  body: string;
  body_semantic?: string;
  updated_at: string;
  record: CaseRecord;
}

export interface ElasticIndexOptions {
  index: string;
  semantic: boolean;
  inferenceId?: string;
}

export class ElasticCaseIndex {
  private ready: Promise<void> | null = null;
  private semanticActive = false;

  constructor(
    private es: EsLike,
    private opts: ElasticIndexOptions,
    private allCases: () => CaseRecord[],
    private log: (msg: string) => void = (m) => console.warn(`[elastic] ${m}`),
  ) {}

  backend(): SearchBackend {
    return this.semanticActive ? "elastic-semantic" : "elastic";
  }

  /** Creates the index if needed and backfills every case from SQLite. Runs once. */
  init(): Promise<void> {
    this.ready ??= this.setup().catch((e) => {
      this.ready = null; // retry on the next call
      throw e;
    });
    return this.ready;
  }

  private async setup(): Promise<void> {
    const { index } = this.opts;
    if (await this.es.indices.exists({ index })) {
      const mapping = await this.es.indices.getMapping({ index });
      this.semanticActive = Boolean(Object.values(mapping)[0]?.mappings?.properties?.body_semantic) && this.opts.semantic;
    } else {
      this.semanticActive = this.opts.semantic && (await this.tryCreate(true));
      if (!this.semanticActive) await this.tryCreate(false, true);
    }
    await this.backfill();
  }

  private async tryCreate(semantic: boolean, required = false): Promise<boolean> {
    try {
      await this.es.indices.create({ index: this.opts.index, mappings: mappings(semantic, this.opts.inferenceId) });
      return true;
    } catch (e) {
      if (required) throw e;
      this.log(`semantic_text mapping unavailable, using keyword search only: ${(e as Error).message}`);
      return false;
    }
  }

  private async backfill(): Promise<void> {
    const cases = this.allCases();
    if (cases.length === 0) return;
    const operations = cases.flatMap((c) => [{ index: { _index: this.opts.index, _id: c.disputeId } }, this.toDoc(c)]);
    const res = await this.es.bulk({ operations, refresh: "wait_for" });
    if (res.errors) {
      const first = res.items.map((i) => Object.values(i)[0]?.error?.reason).find(Boolean);
      this.log(`some cases failed to index: ${first ?? "unknown error"}`);
    }
  }

  async indexCase(c: CaseRecord): Promise<void> {
    await this.init();
    await this.es.index({ index: this.opts.index, id: c.disputeId, document: this.toDoc(c), refresh: "wait_for" });
  }

  async search(query: string, opts: SearchOptions = {}): Promise<{ id: string; record?: CaseRecord }[]> {
    await this.init();
    const res = await this.es.search({
      index: this.opts.index,
      size: opts.limit ?? 20,
      _source: ["dispute_id", "record"],
      ...buildQuery(query, opts, this.semanticActive),
    });
    return res.hits.hits.map((h) => {
      const src = h._source as Partial<CaseDoc> | undefined;
      return { id: src?.dispute_id ?? h._id ?? "", record: src?.record };
    });
  }

  private toDoc(c: CaseRecord): CaseDoc {
    const body = searchableText(c);
    return {
      dispute_id: c.disputeId,
      status: c.status,
      category: c.category,
      recommendation: c.resolution?.recommendation,
      result: c.result,
      buyer_claim: c.buyerClaim,
      body,
      ...(this.semanticActive ? { body_semantic: body } : {}),
      updated_at: c.updatedAt,
      record: c,
    };
  }
}

export function mappings(semantic: boolean, inferenceId?: string) {
  return {
    properties: {
      dispute_id: { type: "keyword" },
      status: { type: "keyword" },
      category: { type: "keyword" },
      recommendation: { type: "keyword" },
      result: { type: "keyword" },
      buyer_claim: { type: "text", analyzer: "english" },
      body: { type: "text", analyzer: "english" },
      ...(semantic ? { body_semantic: { type: "semantic_text", ...(inferenceId ? { inference_id: inferenceId } : {}) } } : {}),
      updated_at: { type: "date" },
      // Kept for display; not searchable.
      record: { type: "object", enabled: false },
    },
  };
}

/** Hybrid query: BM25 keyword match OR semantic similarity, with category/exclusion filters. */
export function buildQuery(query: string, opts: SearchOptions, semantic: boolean): Record<string, unknown> {
  const filter = opts.category ? [{ term: { category: opts.category } }] : [];
  const must_not = opts.excludeId ? [{ ids: { values: [opts.excludeId] } }] : [];
  const q = query.trim();
  if (!q) {
    return { query: { bool: { filter, must_not, must: [{ match_all: {} }] } }, sort: [{ updated_at: "desc" }] };
  }
  const should: unknown[] = [
    { multi_match: { query: q, fields: ["dispute_id^3", "buyer_claim^2", "body"], fuzziness: "AUTO" } },
  ];
  if (semantic) should.push({ match: { body_semantic: { query: q } } });
  return { query: { bool: { filter, must_not, should, minimum_should_match: 1 } } };
}

/** Wraps the SQLite store: reads and approvals go to SQLite, search goes to Elastic. */
export class ElasticBackedStore implements CaseStore {
  private lastSearchFailed = false;

  constructor(
    private base: CaseStore,
    private index: ElasticCaseIndex,
    private log: (msg: string) => void = (m) => console.warn(`[elastic] ${m}`),
  ) {
    // Start index setup and backfill early; errors are reported on first search.
    this.index.init().catch((e) => this.log(`setup failed: ${(e as Error).message}`));
  }

  get = (id: string) => this.base.get(id);
  list = () => this.base.list();
  claimApproval = (id: string) => this.base.claimApproval(id);
  completeApproval: CaseStore["completeApproval"] = (id, outcome) => this.base.completeApproval(id, outcome);
  failApproval: CaseStore["failApproval"] = (id, error) => this.base.failApproval(id, error);

  upsert(record: CaseRecord): CaseRecord {
    const saved = this.base.upsert(record);
    // Mirror to Elastic in the background; SQLite already has the record.
    this.index.indexCase(saved).catch((e) => this.log(`could not index ${saved.disputeId}: ${(e as Error).message}`));
    return saved;
  }

  searchBackend(): SearchBackend {
    return this.lastSearchFailed ? "sqlite" : this.index.backend();
  }

  async search(query: string, opts: SearchOptions = {}): Promise<CaseRecord[]> {
    try {
      const hits = await this.index.search(query, opts);
      this.lastSearchFailed = false;
      return hits.map((h) => this.base.get(h.id) ?? h.record).filter((c): c is CaseRecord => Boolean(c));
    } catch (e) {
      this.lastSearchFailed = true;
      this.log(`search failed, falling back to SQLite: ${(e as Error).message}`);
      return this.base.search(query, opts);
    }
  }
}

/** Returns an Elastic-backed store when Elastic is configured, otherwise undefined. */
export function createElasticStore(base: CaseStore): CaseStore | undefined {
  const { url, cloudId, apiKey, index, semantic, inferenceId } = config.elastic;
  if (!url && !cloudId) return undefined;
  const client = new Client({
    ...(cloudId ? { cloud: { id: cloudId } } : { node: url }),
    ...(apiKey ? { auth: { apiKey } } : {}),
    requestTimeout: 15_000,
  });
  const es = client as unknown as EsLike;
  return new ElasticBackedStore(base, new ElasticCaseIndex(es, { index, semantic, inferenceId: inferenceId || undefined }, () => base.list()));
}
