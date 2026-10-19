import type { CaseRecord } from "./types";

/** The text a case is searched by, shared by the SQLite FTS index and Elastic. */
export function searchableText(c: CaseRecord): string {
  return [
    c.disputeId,
    c.reason.replace(/_/g, " "),
    c.category?.replace(/_/g, " "),
    c.buyerName,
    c.buyerEmail,
    c.buyerClaim,
    c.resolution?.recommendation,
    c.resolution?.reasoning,
    ...(c.resolution?.evidence_points ?? []),
    c.result,
    c.decisionNote,
  ]
    .filter(Boolean)
    .join(" ");
}
