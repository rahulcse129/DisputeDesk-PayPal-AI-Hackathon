// Executes a merchant-approved resolution against PayPal (or the mock).
//
// SAFETY: this is the only module that calls money-moving or message-sending PayPal
// operations, and it is only imported by the approve route, after the merchant clicks
// Approve and the idempotency claim succeeds. The agent never imports it.

import { config } from "./config";
import { paypal, type EvidenceInput } from "./paypal";
import type { ActionOutcome, Dispute, DisputeStatus, Recommendation, TrackingInfo } from "./types";

export interface ExecuteInput {
  dispute: Dispute;
  action: Recommendation;
  message: string;
  evidencePoints: string[];
  tracking: TrackingInfo;
}

const KNOWN_CARRIERS = ["UPS", "USPS", "FEDEX", "DHL"];

function carrierFields(carrier: string | undefined): { carrier_name: string; carrier_name_other?: string } {
  const normalized = (carrier ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  const match = KNOWN_CARRIERS.find((c) => normalized.startsWith(c));
  return match ? { carrier_name: match } : { carrier_name: "OTHER", carrier_name_other: carrier || "Unknown" };
}

function evidenceNotes(message: string, points: string[]): string {
  const body = points.length ? `${message}\n\nEvidence:\n${points.map((p) => `- ${p}`).join("\n")}` : message;
  return body.slice(0, 2000);
}

export async function executeResolution(input: ExecuteInput): Promise<ActionOutcome> {
  const { dispute, action, message, evidencePoints, tracking } = input;
  const mode = config.useMockPayPal ? "mock" : "sandbox";
  const calls: ActionOutcome["calls"] = [];
  const canMessage = dispute.stage === "INQUIRY";

  // Wraps each PayPal call so the outcome shows exactly what ran. Mock mode records the
  // same calls without touching the network. A failed required call aborts the action.
  async function step<T>(operation: string, run: () => Promise<T>, describe: (r: T | undefined) => string, required = true) {
    if (mode === "mock") {
      calls.push({ operation, ok: true, detail: `[mock] ${describe(undefined)}` });
      return undefined;
    }
    try {
      const r = await run();
      calls.push({ operation, ok: true, detail: describe(r) });
      return r;
    } catch (e) {
      calls.push({ operation, ok: false, detail: (e as Error).message });
      if (required) throw e;
      return undefined;
    }
  }

  let disputeStatusAfter: DisputeStatus | undefined;
  try {
    if (action === "accept") {
      await step("acceptClaim", () => paypal.acceptClaim(dispute.id, message), () => "Accepted liability; PayPal refunds the buyer and closes the dispute");
      disputeStatusAfter = "RESOLVED";
    } else if (action === "refund") {
      const captureId = dispute.transaction.captureId;
      if (!captureId && mode === "sandbox") throw new Error("Dispute has no seller transaction (capture) ID to refund.");
      const refund = await step(
        "refundCapture",
        // Deterministic request ID: PayPal returns the original refund instead of refunding twice.
        () => paypal.refundCapture(captureId!, { amount: dispute.amount, note: message, requestId: `disputedesk-${dispute.id}-refund` }),
        (r) => `Refunded ${dispute.amount.value} ${dispute.amount.currency} on capture ${captureId}${r ? ` (refund ${r.id}, ${r.status})` : ""}`,
      );
      // After the money moves, follow-up steps are best effort: never fail (and retry) a completed refund.
      const evidence: EvidenceInput[] = [
        {
          evidence_type: "PROOF_OF_REFUND",
          ...(refund ? { evidence_info: { refund_ids: [{ refund_id: refund.id }] } } : {}),
          notes: evidenceNotes(message, evidencePoints),
        },
      ];
      await step("provideEvidence", () => paypal.provideEvidence(dispute.id, evidence), () => "Submitted proof of refund", false);
      if (canMessage) await step("sendMessageToBuyer", () => paypal.sendMessageToBuyer(dispute.id, message), () => "Sent message to buyer", false);
      disputeStatusAfter = "RESOLVED";
    } else {
      const evidence: EvidenceInput[] = [
        tracking.trackingNumber
          ? {
              evidence_type: "PROOF_OF_FULFILLMENT",
              evidence_info: { tracking_info: [{ ...carrierFields(tracking.carrier), tracking_number: tracking.trackingNumber }] },
              notes: evidenceNotes(message, evidencePoints),
            }
          : { evidence_type: "OTHER", notes: evidenceNotes(message, evidencePoints) },
      ];
      await step(
        "provideEvidence",
        () => paypal.provideEvidence(dispute.id, evidence),
        () => `Submitted ${evidence[0].evidence_type} evidence${tracking.trackingNumber ? ` with ${tracking.carrier} ${tracking.trackingNumber}` : ""}`,
      );
      if (canMessage) await step("sendMessageToBuyer", () => paypal.sendMessageToBuyer(dispute.id, message), () => "Sent message to buyer", false);
      disputeStatusAfter = "UNDER_REVIEW";
    }
    return { action, ok: true, mode, calls, disputeStatusAfter, executedAt: new Date().toISOString() };
  } catch (e) {
    return { action, ok: false, mode, calls, error: (e as Error).message, executedAt: new Date().toISOString() };
  }
}
