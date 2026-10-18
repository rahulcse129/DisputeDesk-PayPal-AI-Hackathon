import { z } from "zod";

export const CATEGORIES = ["item_not_received", "not_as_described", "unauthorized", "duplicate", "other"] as const;
export const RECOMMENDATIONS = ["accept", "refund", "contest"] as const;

export const DisputeIdInput = z.strictObject({
  dispute_id: z.string().min(1).describe("The PayPal dispute ID being analyzed."),
});

export const SearchSimilarInput = z.strictObject({
  query: z.string().min(1).max(300).describe("Keywords describing the dispute, e.g. 'not received signed delivery'."),
  category: z.enum(CATEGORIES).optional().describe("Restrict results to one category."),
});

export const ResolutionSchema = z.strictObject({
  category: z.enum(CATEGORIES).describe("Dispute category."),
  recommendation: z
    .enum(RECOMMENDATIONS)
    .describe("accept = accept the claim (PayPal refunds the buyer and closes the case); refund = merchant refunds the capture; contest = submit evidence to fight the dispute."),
  confidence: z.number().min(0).max(1).describe("Confidence in the recommendation, 0 to 1."),
  reasoning: z.string().min(20).max(1200).describe("2-4 sentence summary of why, for the merchant."),
  evidence_points: z
    .array(z.string().min(3).max(300))
    .max(10)
    .describe("Concrete, verifiable facts from the tools that support the recommendation."),
  draft_message: z
    .string()
    .min(40)
    .max(2000)
    .describe("Professional message from the merchant: to the buyer for accept/refund, or the evidence statement to PayPal for contest."),
});

export type ResolutionOutput = z.infer<typeof ResolutionSchema>;

/** Converts a Zod schema into the JSON Schema object the Messages API expects for input_schema. */
export function toInputSchema(schema: z.ZodType): { type: "object"; [k: string]: unknown } {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: "object" };
}
