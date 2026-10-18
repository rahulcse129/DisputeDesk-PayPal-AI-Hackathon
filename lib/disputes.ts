// Read-side data source. Returns the same domain types whether data comes from the
// seeded mock or the PayPal sandbox, so the agent and UI never branch on mode.

import { config } from "./config";
import { normalizeDispute, normalizeOrder, normalizeTracker, paypal, PayPalError, type PPCapture, type PPOrder } from "./paypal";
import { seedDisputes, type SeedDispute } from "./seed";
import { getStore } from "./store";
import type { BuyerHistory, Dispute, DisputeListItem, OrderDetails, TrackingInfo } from "./types";

export class NotFoundError extends Error {
  name = "NotFoundError";
}

let seedCache: SeedDispute[] | null = null;
function seeds(): SeedDispute[] {
  seedCache ??= seedDisputes();
  return seedCache;
}

// Short-lived cache for sandbox detail calls, so a page load does not refetch the same dispute.
const detailCache = new Map<string, { at: number; value: Dispute }>();
const DETAIL_TTL_MS = 60_000;

/** Applies the status the last executed action produced (mock mode has no PayPal to ask). */
function withLocalStatus(d: Dispute): Dispute {
  const after = getStore().get(d.id)?.outcome?.disputeStatusAfter;
  return after && config.useMockPayPal ? { ...d, status: after } : d;
}

export async function getDispute(id: string): Promise<Dispute> {
  if (config.useMockPayPal) {
    const s = seeds().find((x) => x.dispute.id === id);
    if (!s) throw new NotFoundError(`Dispute ${id} not found`);
    return withLocalStatus(s.dispute);
  }
  const cached = detailCache.get(id);
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.value;
  try {
    const d = normalizeDispute(await paypal.getDispute(id));
    detailCache.set(id, { at: Date.now(), value: d });
    return d;
  } catch (e) {
    if (e instanceof PayPalError && e.status === 404) throw new NotFoundError(`Dispute ${id} not found`);
    throw e;
  }
}

export function invalidateDispute(id: string): void {
  detailCache.delete(id);
}

export async function listDisputes(): Promise<DisputeListItem[]> {
  let disputes: Dispute[];
  if (config.useMockPayPal) {
    disputes = seeds().map((s) => withLocalStatus(s.dispute));
  } else {
    const summaries = await paypal.listDisputes();
    // Summaries omit buyer and transaction details; fetch details in small batches.
    disputes = [];
    const ids = summaries.slice(0, 30).map((s) => s.dispute_id);
    for (let i = 0; i < ids.length; i += 5) {
      const batch = await Promise.allSettled(ids.slice(i, i + 5).map((id) => getDispute(id)));
      batch.forEach((r, j) => {
        if (r.status === "fulfilled") disputes.push(r.value);
        else disputes.push(normalizeDispute(summaries[i + j]));
      });
    }
  }
  const store = getStore();
  return disputes
    .map((dispute) => {
      const c = store.get(dispute.id);
      return {
        dispute,
        caseStatus:
          dispute.status === "RESOLVED" && (!c || c.status === "approved") ? "resolved" : (c?.status ?? "new"),
        category: c?.category,
        recommendation: c?.resolution?.recommendation,
        confidence: c?.resolution?.confidence,
      } satisfies DisputeListItem;
    })
    .sort((a, b) => (a.dispute.sellerResponseDue ?? "z").localeCompare(b.dispute.sellerResponseDue ?? "z"));
}

function buyerHistoryFromStore(dispute: Dispute): BuyerHistory {
  const email = dispute.buyer.email?.toLowerCase();
  const prior = email ? getStore().list().filter((c) => c.disputeId !== dispute.id && c.buyerEmail?.toLowerCase() === email) : [];
  return { previousOrders: 0, previousDisputes: prior.length, notes: prior.length ? `Prior cases: ${prior.map((c) => c.disputeId).join(", ")}` : undefined };
}

export async function getOrderDetails(dispute: Dispute): Promise<OrderDetails> {
  if (config.useMockPayPal) {
    const s = seeds().find((x) => x.dispute.id === dispute.id);
    if (!s) throw new NotFoundError(`No order for dispute ${dispute.id}`);
    return s.order;
  }
  let capture: PPCapture | undefined;
  let order: PPOrder | undefined;
  const notes: string[] = [];
  if (dispute.transaction.captureId) {
    try {
      capture = await paypal.getCapture(dispute.transaction.captureId);
    } catch (e) {
      notes.push(`Capture lookup failed: ${(e as Error).message}`);
    }
  }
  const orderId = dispute.transaction.orderId ?? capture?.supplementary_data?.related_ids?.order_id;
  if (orderId) {
    try {
      order = await paypal.getOrder(orderId);
    } catch (e) {
      notes.push(`Order lookup failed: ${(e as Error).message}`);
    }
  }
  const history = buyerHistoryFromStore(dispute);
  if (notes.length) history.notes = [history.notes, ...notes].filter(Boolean).join(" ");
  return { ...normalizeOrder(order, capture, dispute.amount), buyerHistory: history };
}

export async function getTracking(dispute: Dispute): Promise<TrackingInfo> {
  if (config.useMockPayPal) {
    return seeds().find((x) => x.dispute.id === dispute.id)?.tracking ?? { status: "NO_TRACKING", events: [] };
  }
  if (!dispute.transaction.captureId) return { status: "NO_TRACKING", events: [] };
  try {
    const trackers = await paypal.listTrackers(dispute.transaction.captureId);
    return normalizeTracker(trackers[0]);
  } catch {
    // Not every sandbox account has tracking enabled; treat as "no tracking on file".
    return { status: "NO_TRACKING", events: [] };
  }
}
