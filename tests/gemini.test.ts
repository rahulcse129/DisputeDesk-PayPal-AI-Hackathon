import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Content, GenerateContentParameters } from "@google/genai";

// Scripted Gemini responses: each call to generateContent returns the next one.
const script: { parts: Record<string, unknown>[]; finishReason?: string }[] = [];
const requests: GenerateContentParameters[] = [];

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = {
      generateContent: async (req: GenerateContentParameters) => {
        // Snapshot: the loop keeps appending to the same contents array.
        requests.push({ ...req, contents: structuredClone(req.contents) });
        const next = script.shift();
        if (!next) throw new Error("script exhausted");
        const content = { role: "model", parts: next.parts };
        return {
          candidates: [{ content, finishReason: next.finishReason ?? "STOP" }],
          functionCalls: next.parts.filter((p) => p.functionCall).map((p) => p.functionCall),
        };
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const { config, aiMode } = await import("@/lib/config");
const { runAgent } = await import("@/lib/agent");
const { createMemoryStore, setStoreForTests } = await import("@/lib/store");

const id = "PP-D-1001";
const proposal = {
  category: "item_not_received",
  recommendation: "contest",
  confidence: 0.88,
  reasoning: "UPS shows signed delivery to the order address, so the claim is unlikely to hold.",
  evidence_points: ["UPS 1Z999AA10123456784 delivered, signed J. ELLIS"],
  draft_message: "We respectfully request this dispute be resolved in the seller's favor. Proof of delivery is attached.",
};
const call = (name: string, args: unknown, callId: string) => ({ functionCall: { id: callId, name, args } });

describe("Gemini agent loop", () => {
  beforeEach(() => {
    setStoreForTests(createMemoryStore());
    script.length = 0;
    requests.length = 0;
    config.gemini.apiKey = "test-key";
    config.aiProvider = "gemini";
  });
  afterEach(() => {
    config.gemini.apiKey = "";
    config.aiProvider = "";
  });

  it("is selected by AI_PROVIDER=gemini", () => {
    expect(aiMode()).toBe("gemini");
  });

  it("runs parallel tools, recovers from an invalid proposal, and returns a valid resolution", async () => {
    script.push(
      {
        parts: [
          { text: "Gathering the dispute, order and tracking first.", thought: true },
          { ...call("get_dispute", { dispute_id: id }, "c1"), thoughtSignature: "sig-1" },
          call("get_order_details", { dispute_id: id }, "c2"),
          call("get_tracking", { dispute_id: id }, "c3"),
        ],
      },
      { parts: [call("search_similar_cases", { query: "not received signed delivery", category: "item_not_received" }, "c4")] },
      { parts: [call("propose_resolution", { ...proposal, confidence: 7 }, "c5")] },
      { parts: [call("propose_resolution", proposal, "c6")] },
    );

    const result = await runAgent(id);
    expect(result.mode).toBe("gemini");
    expect(result.model).toBe(config.gemini.model);
    expect(result.resolution).toEqual(proposal);

    const tools = result.trace.filter((s) => s.kind === "tool").map((s) => s.tool);
    expect(tools).toEqual(["get_dispute", "get_order_details", "get_tracking", "search_similar_cases", "propose_resolution"]);
    expect(result.trace.some((s) => s.kind === "note" && s.summary.startsWith("Gathering"))).toBe(true);
    expect(result.trace.some((s) => s.kind === "error" && s.tool === "propose_resolution")).toBe(true);

    // Turn 2 must echo the model turn (with its thought signature) and answer all three calls by id.
    const turn2 = requests[1].contents as Content[];
    expect(turn2[1].parts?.[1]).toMatchObject({ thoughtSignature: "sig-1" });
    const responses = turn2[2].parts?.map((p) => p.functionResponse);
    expect(responses?.map((r) => r?.id)).toEqual(["c1", "c2", "c3"]);
    expect(responses?.[2]?.response).toHaveProperty("result.status", "DELIVERED");

    // The invalid proposal went back as an error the model could fix.
    const turn4 = requests[3].contents as Content[];
    expect(turn4.at(-1)?.parts?.[0].functionResponse?.response).toHaveProperty("error");
  });

  it("refuses tool access to another dispute", async () => {
    script.push({ parts: [call("get_dispute", { dispute_id: "PP-D-1002" }, "x1")] }, { parts: [call("propose_resolution", proposal, "x2")] });
    await runAgent(id);
    const turn2 = requests[1].contents as Content[];
    expect(String(turn2.at(-1)?.parts?.[0].functionResponse?.response?.error)).toMatch(/scoped to dispute PP-D-1001/);
  });

  it("fails cleanly when the model never proposes", async () => {
    script.push({ parts: [{ text: "I think you should contest." }] }, { parts: [{ text: "Still thinking." }] });
    await expect(runAgent(id)).rejects.toThrow(/did not produce a recommendation/);
  });
});
