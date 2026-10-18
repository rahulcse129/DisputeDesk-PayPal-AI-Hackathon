import { beforeEach, describe, expect, it } from "vitest";
import { ResolutionSchema } from "@/lib/agent-schema";
import { AGENT_TOOL_NAMES, TOOL_DEFINITIONS } from "@/lib/agent-tools";
import { AgentError, runAgent, type AgentRunner } from "@/lib/agent";
import { seedDisputes } from "@/lib/seed";
import { createMemoryStore, setStoreForTests } from "@/lib/store";

const valid = {
  category: "item_not_received",
  recommendation: "contest",
  confidence: 0.9,
  reasoning: "Carrier confirms signed delivery to the order address.",
  evidence_points: ["UPS 1Z999: DELIVERED"],
  draft_message: "We respectfully request this dispute be resolved in the seller's favor because...",
};

describe("ResolutionSchema", () => {
  it("accepts a well-formed resolution", () => {
    expect(ResolutionSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["unknown recommendation", { recommendation: "ignore" }],
    ["unknown category", { category: "fraud" }],
    ["confidence above 1", { confidence: 1.4 }],
    ["confidence below 0", { confidence: -0.1 }],
    ["empty draft", { draft_message: "" }],
    ["evidence not an array", { evidence_points: "delivered" }],
    ["extra field", { execute_now: true }],
  ])("rejects %s", (_label, patch) => {
    expect(ResolutionSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rejects missing fields", () => {
    const partial: Partial<typeof valid> = { ...valid };
    delete partial.draft_message;
    expect(ResolutionSchema.safeParse(partial).success).toBe(false);
  });
});

describe("agent tools", () => {
  it("exposes only read-only tools plus propose_resolution", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    const forbidden = /refund|accept|evidence|message|send|capture|approve/i;
    for (const t of TOOL_DEFINITIONS) if (t.name !== "propose_resolution") expect(t.name).not.toMatch(forbidden);
  });

  it("generates object JSON schemas for every tool", () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema).not.toHaveProperty("$schema");
    }
  });
});

describe("runAgent (offline mode)", () => {
  beforeEach(() => setStoreForTests(createMemoryStore()));

  const expected: Record<string, string> = {
    "PP-D-1001": "contest",
    "PP-D-1002": "refund",
    "PP-D-1003": "refund",
    "PP-D-1004": "refund",
    "PP-D-1005": "contest",
    "PP-D-1006": "accept",
    "PP-D-1007": "contest",
    "PP-D-1008": "refund",
    "PP-D-1009": "contest",
    "PP-D-1010": "refund",
  };

  it.each(seedDisputes().map((s) => s.dispute.id))("produces a schema-valid, sensible resolution for %s", async (id) => {
    const result = await runAgent(id);
    expect(ResolutionSchema.safeParse(result.resolution).success).toBe(true);
    expect(result.resolution.recommendation).toBe(expected[id]);
    const tools = result.trace.filter((s) => s.kind === "tool").map((s) => s.tool);
    expect(tools).toEqual(["get_dispute", "get_order_details", "get_tracking", "search_similar_cases", "propose_resolution"]);
  });

  it("refuses tool access to a different dispute", async () => {
    const sneaky: AgentRunner = async ({ callTool }) => {
      await callTool("get_dispute", { dispute_id: "PP-D-1002" });
      throw new Error("unreachable");
    };
    await expect(runAgent("PP-D-1001", { runner: sneaky })).rejects.toThrow(/scoped to dispute PP-D-1001/);
  });

  it("rejects an invalid proposal and records the error in the trace", async () => {
    const bad: AgentRunner = async ({ callTool }) => {
      await callTool("propose_resolution", { ...valid, confidence: 3 });
      throw new Error("unreachable");
    };
    const err = await runAgent("PP-D-1001", { runner: bad }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).trace.some((s) => s.kind === "error" && s.tool === "propose_resolution")).toBe(true);
  });
});
