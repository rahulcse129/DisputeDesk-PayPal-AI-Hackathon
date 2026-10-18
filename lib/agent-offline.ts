// Deterministic fallback used when ANTHROPIC_API_KEY is not set. It calls the same
// read-only tools in the same order Claude typically does, so the step trace and the
// output schema are identical. It is a demo safety net, not a replacement for the model.

import { ResolutionSchema, type ResolutionOutput } from "./agent-schema";
import type { AgentRunner } from "./agent";
import type { Category, Dispute, DisputeReason, OrderDetails, TrackingInfo } from "./types";

const CATEGORY_BY_REASON: Partial<Record<DisputeReason, Category>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item_not_received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "not_as_described",
  UNAUTHORISED: "unauthorized",
  DUPLICATE_TRANSACTION: "duplicate",
};

interface SimilarCase {
  dispute_id: string;
  recommendation?: string;
  result?: string;
}

const money = (d: Dispute) => `${d.amount.currency === "USD" ? "$" : ""}${d.amount.value}${d.amount.currency === "USD" ? "" : ` ${d.amount.currency}`}`;
const day = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "unknown date");

export const runOfflineAgent: AgentRunner = async ({ disputeId, callTool }) => {
  const dispute = (await callTool("get_dispute", { dispute_id: disputeId })) as Dispute;
  const order = (await callTool("get_order_details", { dispute_id: disputeId })) as OrderDetails;
  const tracking = (await callTool("get_tracking", { dispute_id: disputeId })) as TrackingInfo;
  const category = CATEGORY_BY_REASON[dispute.reason] ?? "other";
  const similar = (await callTool("search_similar_cases", {
    query: `${dispute.reason.replace(/_/g, " ")} ${tracking.status.replace(/_/g, " ")}`.toLowerCase(),
    category,
  })) as { cases: SimilarCase[] };

  const r = decide(dispute, order, tracking, category);
  const precedent = similar.cases.find((c) => c.recommendation === r.recommendation && c.result);
  if (precedent) r.reasoning += ` A similar past case (${precedent.dispute_id}) with the same approach ended as "${precedent.result}".`;

  const resolution = ResolutionSchema.parse(r);
  await callTool("propose_resolution", resolution);
  return resolution;
};

function decide(d: Dispute, o: OrderDetails, t: TrackingInfo, category: Category): ResolutionOutput {
  const name = d.buyer.name.split(" ")[0];
  const item = o.items[0]?.name ?? "your order";
  const h = o.buyerHistory;
  const points: string[] = [];
  const delivered = t.status === "DELIVERED";
  if (t.trackingNumber) points.push(`${t.carrier} tracking ${t.trackingNumber}: ${t.status}${delivered ? ` on ${day(t.deliveredAt)}` : ""}`);
  if (t.signedBy) points.push(`Delivery signed by "${t.signedBy}"`);

  const refundMsg = (why: string) =>
    `Hi ${name},\n\nThank you for reaching out, and I'm sorry about the trouble with ${item}. ${why} I've issued a full refund of ${money(d)} to your original payment method; you should see it within 3-5 business days.\n\nThanks for your patience,\nThe team`;
  const contestMsg = (summary: string) =>
    `We respectfully request this dispute be resolved in the seller's favor. ${summary}\n\nOrder ${o.orderId ?? ""} (invoice ${d.transaction.invoiceId ?? "n/a"}) for ${money(d)} was placed on ${day(o.createTime)}.`;

  switch (category) {
    case "item_not_received": {
      if (delivered) {
        const addressMatch = t.deliveredTo && o.shippingAddress && o.shippingAddress.startsWith(t.deliveredTo.split(",")[0]);
        if (addressMatch) points.push("Delivery address matches the PayPal shipping address");
        return {
          category,
          recommendation: "contest",
          confidence: t.signedBy ? 0.9 : 0.78,
          reasoning: `The carrier confirms delivery on ${day(t.deliveredAt)}${t.signedBy ? ` with a signature (${t.signedBy})` : ""}, to the shipping address on the order. Proof of delivery is strong evidence for an item-not-received claim.`,
          evidence_points: points,
          draft_message: contestMsg(
            `The item was delivered by ${t.carrier} (tracking ${t.trackingNumber}) on ${day(t.deliveredAt)} to the buyer's shipping address${t.signedBy ? `, signed for by "${t.signedBy}"` : ""}. Proof of delivery is attached.`,
          ),
        };
      }
      const why =
        t.status === "NO_TRACKING"
          ? "The order shipped without tracking, so there is no proof of delivery."
          : `Tracking shows "${t.events.at(-1)?.description ?? t.status}" with no movement since ${day(t.events.at(-1)?.time)}.`;
      points.push(why);
      if (h.previousDisputes === 0) points.push("Buyer has no prior disputes");
      return {
        category,
        recommendation: "refund",
        confidence: 0.84,
        reasoning: `${why} Without proof of delivery a contest is very likely to lose, and a refund avoids the dispute fee and protects the seller's record.`,
        evidence_points: points,
        draft_message: refundMsg("It looks like your package was lost in transit."),
      };
    }
    case "not_as_described": {
      const strongListing = o.items.some((i) => /authenticat|certificate|photos of the exact/i.test(i.description ?? ""));
      if (h.previousDisputes >= 3 && strongListing) {
        points.push(`Buyer has ${h.previousDisputes} prior disputes in ${h.accountAgeDays ?? "?"} days`);
        o.items.forEach((i) => i.description && points.push(`Listing: ${i.description}`));
        return {
          category,
          recommendation: "contest",
          confidence: 0.72,
          reasoning: `The listing documents third-party authentication and shows the exact item, and the buyer has a pattern of ${h.previousDisputes} similar disputes. The claim gives no specific proof. Contesting with the authentication certificate is reasonable, though not-as-described cases are less predictable.`,
          evidence_points: points,
          draft_message: contestMsg(
            `The item matches the listing exactly. It was authenticated by a third-party service before shipping (certificate included in the box) and the listing showed photos of the exact pair. Delivery was confirmed${t.signedBy ? ` and signed for by "${t.signedBy}"` : ""}. The buyer has not offered to return the item for inspection.`,
          ),
        };
      }
      if (h.notes) points.push(h.notes);
      points.push(`Buyer: ${h.previousOrders} prior orders, ${h.previousDisputes} prior disputes`);
      return {
        category,
        recommendation: "refund",
        confidence: 0.8,
        reasoning: `The buyer's claim is specific and plausible${h.notes?.includes("pick error") ? ", and the warehouse log points to a likely picking error" : ""}. They are a good-standing customer offering to return the item. A refund keeps the customer and avoids a likely loss.`,
        evidence_points: points,
        draft_message: refundMsg("It looks like we sent the wrong item, and that's on us. You're welcome to keep or donate it."),
      };
    }
    case "unauthorized": {
      if (o.fulfillment === "digital" && o.ipCountry && o.billingCountry && o.ipCountry !== o.billingCountry) {
        points.push(`Checkout IP country ${o.ipCountry} does not match billing country ${o.billingCountry}`);
        if (h.notes) points.push(h.notes);
        return {
          category,
          recommendation: "accept",
          confidence: 0.86,
          reasoning: `This looks like genuine account takeover: digital goods, checkout from ${o.ipCountry} while the billing address is in ${o.billingCountry}, and no prior relationship with the buyer. Digital goods give no proof of delivery to a verified address, so contesting would very likely lose and add a fee.`,
          evidence_points: points,
          draft_message: `Hi ${d.buyer.name.split(" ")[0]},\n\nWe're sorry your account was used without permission. We've accepted your claim and your ${money(d)} will be returned. The license for this purchase has been deactivated.\n\nIf you didn't already, we recommend changing your PayPal password.\n\nThe team`,
        };
      }
      if (delivered && h.previousOrders >= 3) {
        points.push(`${h.previousOrders} prior orders from this account to the same address`);
        if (h.notes) points.push(h.notes);
        return {
          category,
          recommendation: "contest",
          confidence: 0.82,
          reasoning: `The account has ${h.previousOrders} prior orders to the same verified address, and this order was delivered there${t.signedBy ? ` and signed for by "${t.signedBy}"` : ""}. That pattern points to an unrecognized charge rather than fraud.`,
          evidence_points: points,
          draft_message: contestMsg(
            `The order was shipped to the account holder's verified address, the same address as ${h.previousOrders} previous undisputed orders, and delivered on ${day(t.deliveredAt)}${t.signedBy ? ` with signature "${t.signedBy}"` : ""}. The charge appears on statements as our store name.`,
          ),
        };
      }
      return {
        category,
        recommendation: "accept",
        confidence: 0.6,
        reasoning: "There is no strong evidence tying the account holder to the purchase, so contesting is unlikely to succeed.",
        evidence_points: points,
        draft_message: `Hi ${name},\n\nWe've accepted your claim and the ${money(d)} will be returned to you.\n\nThe team`,
      };
    }
    case "duplicate": {
      const twin = o.relatedCaptures?.find(
        (c) => c.amount.value === d.amount.value && Math.abs(new Date(c.createTime).getTime() - new Date(o.createTime ?? 0).getTime()) < 10 * 60_000,
      );
      if (twin) {
        points.push(`Capture ${twin.captureId} for the same amount ${Math.round(Math.abs(new Date(o.createTime!).getTime() - new Date(twin.createTime).getTime()) / 1000)}s earlier`);
        points.push("Only one shipment was created for the order");
        return {
          category,
          recommendation: "refund",
          confidence: 0.94,
          reasoning: `Two identical captures were made within minutes for one order, and only one package shipped. This is a genuine double charge, so refund the disputed capture.`,
          evidence_points: points,
          draft_message: refundMsg("You were right: our checkout charged you twice."),
        };
      }
      if (h.notes) points.push(h.notes);
      return {
        category,
        recommendation: "contest",
        confidence: 0.8,
        reasoning: "The two charges belong to two separate orders for different items, placed days apart, and both were delivered. It is not a duplicate.",
        evidence_points: points,
        draft_message: contestMsg(`The charges are for two distinct orders with different items (${h.notes ?? "see order history"}). Each order was fulfilled and delivered separately.`),
      };
    }
    default: {
      const returned = delivered && /return|merchant/i.test(`${t.carrier} ${t.deliveredTo}`);
      if (returned) {
        points.push(`Return delivered to merchant on ${day(t.deliveredAt)} (${t.carrier} ${t.trackingNumber})`);
        if (h.notes) points.push(h.notes);
        return {
          category,
          recommendation: "refund",
          confidence: 0.9,
          reasoning: `Tracking shows the authorized return arrived at the warehouse on ${day(t.deliveredAt)}, but no refund was issued. The buyer is entitled to the refund; issuing it now closes the dispute.`,
          evidence_points: points,
          draft_message: refundMsg("Your return reached us, and the refund should have gone out already."),
        };
      }
      return {
        category,
        recommendation: "contest",
        confidence: 0.5,
        reasoning: "The claim does not match a standard pattern and the evidence is mixed. Review it manually before responding.",
        evidence_points: points,
        draft_message: contestMsg("Please see the attached order and fulfillment details."),
      };
    }
  }
}
