import { beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "@/lib/agent";
import { buildQuery, ElasticBackedStore, ElasticCaseIndex, mappings, type EsLike } from "@/lib/elastic";
import { createMemoryStore, setStoreForTests, type CaseStore } from "@/lib/store";

/** In-memory stand-in for Elasticsearch: stores docs, records requests, matches on body text. */
class FakeEs implements EsLike {
  docs = new Map<string, Record<string, unknown>>();
  created: unknown[] = [];
  searches: Record<string, unknown>[] = [];
  rejectSemantic = false;
  failSearch = false;
  private exists = false;

  indices = {
    exists: async () => this.exists,
    create: async (p: { index: string; mappings: unknown }) => {
      if (this.rejectSemantic && JSON.stringify(p.mappings).includes("semantic_text")) throw new Error("no inference endpoint");
      this.created.push(p.mappings);
      this.exists = true;
      return {};
    },
    getMapping: async () => ({ idx: { mappings: this.created.at(-1) as { properties?: Record<string, unknown> } } }),
  };

  index = async (p: { id: string; document: unknown }) => {
    this.docs.set(p.id, p.document as Record<string, unknown>);
    return {};
  };

  bulk = async (p: { operations: unknown[] }) => {
    for (let i = 0; i < p.operations.length; i += 2) {
      const meta = p.operations[i] as { index: { _id: string } };
      this.docs.set(meta.index._id, p.operations[i + 1] as Record<string, unknown>);
    }
    return { errors: false, items: [] };
  };

  search = async (p: Record<string, unknown>) => {
    this.searches.push(p);
    if (this.failSearch) throw new Error("cluster unavailable");
    const bool = (p.query as { bool: { should?: { multi_match?: { query: string } }[]; filter: { term: { category: string } }[]; must_not: { ids: { values: string[] } }[] } }).bool;
    const words = (bool.should?.[0]?.multi_match?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const category = bool.filter[0]?.term.category;
    const excluded = new Set(bool.must_not.flatMap((m) => m.ids.values));
    const hits = [...this.docs.entries()]
      .filter(([id, d]) => !excluded.has(id) && (!category || d.category === category))
      .filter(([, d]) => words.length === 0 || words.some((w) => String(d.body).toLowerCase().includes(w)))
      .map(([id, d]) => ({ _id: id, _source: { dispute_id: d.dispute_id, record: d.record } }));
    return { hits: { hits: hits.slice(0, (p.size as number) ?? 20) } };
  };
}

const quiet = () => {};
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { semantic?: boolean; es?: FakeEs } = {}) {
  const base = createMemoryStore();
  const es = opts.es ?? new FakeEs();
  const index = new ElasticCaseIndex(es, { index: "idx", semantic: opts.semantic ?? true }, () => base.list(), quiet);
  const store = new ElasticBackedStore(base, index, quiet);
  return { base, es, index, store };
}

describe("Elastic case search", () => {
  beforeEach(() => setStoreForTests(undefined));

  it("creates a semantic index and backfills existing cases from SQLite", async () => {
    const { es, base, store } = setup();
    await store.search("");
    expect(JSON.stringify(es.created[0])).toContain("semantic_text");
    expect(es.docs.size).toBe(base.list().length);
    expect(es.docs.get("HIST-0801")).toHaveProperty("body_semantic");
    expect(store.searchBackend()).toBe("elastic-semantic");
  });

  it("falls back to a keyword-only index when the cluster has no inference endpoint", async () => {
    const es = new FakeEs();
    es.rejectSemantic = true;
    const { store } = setup({ es });
    await store.search("signature");
    expect(JSON.stringify(es.created[0])).not.toContain("semantic_text");
    expect(store.searchBackend()).toBe("elastic");
    expect(es.searches[0]).not.toHaveProperty("query.bool.should.1");
  });

  it("returns SQLite records for Elastic hits, honoring category and exclusion", async () => {
    const { es, store } = setup();
    const results = await store.search("signature", { category: "unauthorized", excludeId: "HIST-0801" });
    expect(results.map((c) => c.disputeId)).toEqual(["HIST-0806"]);
    expect(es.searches[0]).toMatchObject({
      query: { bool: { filter: [{ term: { category: "unauthorized" } }], must_not: [{ ids: { values: ["HIST-0801"] } }] } },
    });
  });

  it("mirrors new and updated cases into the index", async () => {
    const { es, base, store } = setup();
    await store.search("");
    const c = { ...base.get("HIST-0802")!, disputeId: "PP-NEW-1", buyerClaim: "Parcel vanished from my porch" };
    store.upsert(c);
    await flush();
    await flush();
    expect(es.docs.get("PP-NEW-1")).toMatchObject({ dispute_id: "PP-NEW-1", buyer_claim: "Parcel vanished from my porch" });
    expect(base.get("PP-NEW-1")).toBeDefined();
  });

  it("falls back to SQLite search when Elastic is down", async () => {
    const es = new FakeEs();
    es.failSearch = true;
    const { store } = setup({ es });
    const results = await store.search("signature");
    expect(results.length).toBeGreaterThan(0);
    expect(store.searchBackend()).toBe("sqlite");
  });

  it("feeds the agent's search_similar_cases tool", async () => {
    const { es, store } = setup();
    setStoreForTests(store as CaseStore);
    const result = await runAgent("PP-D-1001");
    expect(es.searches.length).toBeGreaterThan(0);
    expect(result.resolution.reasoning).toMatch(/HIST-0801/);
  });
});

describe("buildQuery", () => {
  it("combines keyword and semantic clauses when semantic search is on", () => {
    const q = buildQuery("package never showed up", {}, true) as { query: { bool: { should: unknown[] } } };
    expect(q.query.bool.should).toHaveLength(2);
    expect(q.query.bool.should[1]).toEqual({ match: { body_semantic: { query: "package never showed up" } } });
  });

  it("lists newest cases first for an empty query", () => {
    expect(buildQuery("  ", {}, true)).toMatchObject({ sort: [{ updated_at: "desc" }] });
  });

  it("uses an explicit inference endpoint when configured", () => {
    expect(mappings(true, "my-e5").properties).toHaveProperty("body_semantic", { type: "semantic_text", inference_id: "my-e5" });
  });
});
