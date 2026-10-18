// Client-safe formatting helpers and display labels.

import type { CaseStatus, Category, DisputeReason, Money, Recommendation } from "./types";

export function formatMoney(m: Money): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(Number(m.value));
  } catch {
    return `${m.value} ${m.currency}`;
  }
}

export function formatDate(iso?: string, withTime = false): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export function daysUntil(iso?: string): number | undefined {
  if (!iso) return undefined;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function dueLabel(iso?: string): string {
  const d = daysUntil(iso);
  if (d === undefined) return "No deadline";
  if (d < 0) return `Overdue by ${-d}d`;
  if (d === 0) return "Due today";
  return `Due in ${d}d`;
}

export const STATUS_LABEL: Record<CaseStatus, string> = {
  new: "New",
  analyzed: "Analyzed",
  approved: "Approved",
  resolved: "Resolved",
  rejected: "Manual review",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  item_not_received: "Item not received",
  not_as_described: "Not as described",
  unauthorized: "Unauthorized",
  duplicate: "Duplicate charge",
  other: "Other",
};

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  accept: "Accept claim",
  refund: "Issue refund",
  contest: "Contest with evidence",
};

export const REASON_LABEL: Record<DisputeReason, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Cancelled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  OTHER: "Other",
};

export const TOOL_LABEL: Record<string, string> = {
  get_dispute: "Read dispute",
  get_order_details: "Fetched order & buyer history",
  get_tracking: "Checked shipment tracking",
  search_similar_cases: "Searched similar past cases",
  propose_resolution: "Proposed resolution",
};
