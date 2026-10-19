// Read-only tools the agent can call. None of them move money or contact the buyer:
// those operations live in lib/actions.ts and run only from the approve route.

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DisputeIdInput, ResolutionSchema, SearchSimilarInput, toInputSchema } from "./agent-schema";
import { getDispute, getOrderDetails, getTracking } from "./disputes";
import { getStore } from "./store";
import type { Dispute } from "./types";

export const AGENT_TOOL_NAMES = ["get_dispute", "get_order_details", "get_tracking", "search_similar_cases", "propose_resolution"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const TOOL_DEFINITIONS: BetaTool[] = [
  {
    name: "get_dispute",
    description:
      "Fetch the PayPal dispute: reason code, lifecycle stage, amount, deadline, buyer and the buyer's messages. Call this first.",
    input_schema: toInputSchema(DisputeIdInput),
  },
  {
    name: "get_order_details",
    description:
      "Fetch the order and capture behind the dispute: items and descriptions, shipping address, fulfillment type (physical/digital), checkout IP vs billing country, related captures for the same buyer, and the buyer's order and dispute history.",
    input_schema: toInputSchema(DisputeIdInput),
  },
  {
    name: "get_tracking",
    description:
      "Fetch shipment tracking for the order: carrier, tracking number, status (DELIVERED, IN_TRANSIT, EXCEPTION, SHIPPED, NO_TRACKING), delivery signature and the event timeline.",
    input_schema: toInputSchema(DisputeIdInput),
  },
  {
    name: "search_similar_cases",
    description:
      "Search this merchant's past dispute cases (including recommendations, merchant decisions and final results) for precedent. Use it to learn what worked before.",
    input_schema: toInputSchema(SearchSimilarInput),
  },
  {
    name: "propose_resolution",
    description:
      "Submit your final recommendation for the merchant to review. This does NOT execute anything; the merchant must approve it. Call exactly once, after gathering evidence.",
    input_schema: toInputSchema(ResolutionSchema),
  },
];

export class ToolInputError extends Error {}

/** Runs a read-only tool, scoped to the dispute being analyzed. Returns JSON-serializable data. */
export async function runReadTool(name: string, rawInput: unknown, scope: { disputeId: string; dispute?: Dispute }): Promise<unknown> {
  const scoped = async () => {
    const parsed = DisputeIdInput.safeParse(rawInput);
    if (!parsed.success) throw new ToolInputError(parsed.error.issues.map((i) => i.message).join("; "));
    // The agent may only look at the dispute it was asked about, whatever the buyer's text says.
    if (parsed.data.dispute_id !== scope.disputeId) {
      throw new ToolInputError(`This session is scoped to dispute ${scope.disputeId}; access to ${parsed.data.dispute_id} is not allowed.`);
    }
    scope.dispute ??= await getDispute(scope.disputeId);
    return scope.dispute;
  };

  switch (name) {
    case "get_dispute":
      return await scoped();
    case "get_order_details":
      return await getOrderDetails(await scoped());
    case "get_tracking":
      return await getTracking(await scoped());
    case "search_similar_cases": {
      const parsed = SearchSimilarInput.safeParse(rawInput);
      if (!parsed.success) throw new ToolInputError(parsed.error.issues.map((i) => i.message).join("; "));
      const results = await getStore().search(parsed.data.query, { category: parsed.data.category, excludeId: scope.disputeId, limit: 5 });
      return {
        count: results.length,
        cases: results.map((c) => ({
          dispute_id: c.disputeId,
          category: c.category,
          amount: `${c.amount.value} ${c.amount.currency}`,
          buyer_claim: c.buyerClaim,
          recommendation: c.resolution?.recommendation,
          confidence: c.resolution?.confidence,
          reasoning: c.resolution?.reasoning,
          merchant_decision: c.decision,
          result: c.result ?? (c.status === "resolved" ? "closed" : "open"),
          note: c.decisionNote,
        })),
      };
    }
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}
