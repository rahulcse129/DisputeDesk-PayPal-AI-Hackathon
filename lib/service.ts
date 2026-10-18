// Application logic behind the API routes. Kept out of the route files so it can be
// tested directly and reused if the transport changes.

import { z } from "zod";
import { executeResolution } from "./actions";
import { AgentError, runAgent } from "./agent";
import { RECOMMENDATIONS } from "./agent-schema";
import { aiMode, config } from "./config";
import { getDispute, getOrderDetails, getTracking, invalidateDispute, NotFoundError } from "./disputes";
import { getStore } from "./store";
import type { ActionOutcome, AgentStep, CaseRecord, Dispute } from "./types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function appMeta() {
  return {
    paypalMode: config.useMockPayPal ? ("mock" as const) : ("sandbox" as const),
    aiMode: aiMode(),
    model: aiMode() === "claude" ? config.anthropic.model : undefined,
  };
}

function newCase(d: Dispute, prev?: CaseRecord): CaseRecord {
  const now = new Date().toISOString();
  return {
    disputeId: d.id,
    status: "new",
    reason: d.reason,
    amount: d.amount,
    buyerName: d.buyer.name,
    buyerEmail: d.buyer.email,
    buyerClaim: d.buyerClaim,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function getDisputeDetail(id: string) {
  const dispute = await getDispute(id);
  const [order, tracking] = await Promise.all([getOrderDetails(dispute), getTracking(dispute)]);
  return { dispute, order, tracking, case: getStore().get(id) ?? null, meta: appMeta() };
}

export async function analyzeDispute(id: string, opts: { onStep?: (step: AgentStep) => void } = {}): Promise<CaseRecord> {
  const store = getStore();
  const existing = store.get(id);
  if (existing && (existing.status === "approved" || existing.status === "resolved")) {
    throw new HttpError(409, "This dispute has already been actioned and cannot be re-analyzed.");
  }
  const dispute = await getDispute(id);
  let result;
  try {
    result = await runAgent(id, { onStep: opts.onStep, offlineStepDelayMs: opts.onStep ? 450 : 0 });
  } catch (e) {
    const trace: AgentStep[] = e instanceof AgentError ? e.trace : [];
    throw new HttpError(502, (e as Error).message, { trace });
  }
  const record: CaseRecord = {
    ...newCase(dispute, existing),
    status: "analyzed",
    category: result.resolution.category,
    resolution: result.resolution,
    trace: result.trace,
    agentMode: result.mode,
    model: result.model,
  };
  return store.upsert(record);
}

export const ApproveBody = z.strictObject({
  /** The merchant's edited draft. Defaults to the agent's draft. */
  draft_message: z.string().trim().min(10).max(2000).optional(),
  /** The merchant may choose a different action than the agent recommended. */
  action: z.enum(RECOMMENDATIONS).optional(),
});

export async function approveDispute(id: string, rawBody: unknown): Promise<{ case: CaseRecord; outcome: ActionOutcome }> {
  const parsed = ApproveBody.safeParse(rawBody ?? {});
  if (!parsed.success) throw new HttpError(400, "Invalid request body", { issues: parsed.error.issues });

  const store = getStore();
  const record = store.get(id);
  if (!record?.resolution) throw new HttpError(409, "Analyze this dispute before approving.");
  if (record.status !== "analyzed") {
    throw new HttpError(409, `This dispute is ${record.status}; only analyzed disputes can be approved.`, { outcome: record.outcome });
  }

  // Idempotency guard: only the first approval executes; repeats and double-clicks get 409.
  const claim = store.claimApproval(id);
  if (!claim.ok) {
    throw new HttpError(
      409,
      claim.reason === "in_progress" ? "This approval is already being executed." : "This approval has already been executed.",
      { outcome: claim.outcome },
    );
  }

  const action = parsed.data.action ?? record.resolution.recommendation;
  const message = parsed.data.draft_message ?? record.resolution.draft_message;
  let outcome: ActionOutcome;
  try {
    const dispute = await getDispute(id);
    const tracking = await getTracking(dispute);
    outcome = await executeResolution({ dispute, action, message, evidencePoints: record.resolution.evidence_points, tracking });
  } catch (e) {
    store.failApproval(id, (e as Error).message);
    throw new HttpError(502, `Could not execute the action: ${(e as Error).message}`);
  }

  const now = new Date().toISOString();
  if (!outcome.ok) {
    store.failApproval(id, outcome.error ?? "unknown error");
    store.upsert({ ...record, outcome, updatedAt: now });
    throw new HttpError(502, `PayPal rejected the action: ${outcome.error}`, { outcome });
  }

  store.completeApproval(id, outcome);
  invalidateDispute(id);
  const updated = store.upsert({
    ...record,
    status: action === "contest" ? "approved" : "resolved",
    result: action === "contest" ? "pending" : action === "refund" ? "refunded" : "closed",
    decision: "approved",
    decisionNote: action !== record.resolution.recommendation ? `Merchant chose ${action} instead of ${record.resolution.recommendation}.` : undefined,
    finalMessage: message,
    outcome,
    updatedAt: now,
  });
  return { case: updated, outcome };
}

export const RejectBody = z.strictObject({ note: z.string().trim().max(500).optional() });

export function rejectDispute(id: string, rawBody: unknown): CaseRecord {
  const parsed = RejectBody.safeParse(rawBody ?? {});
  if (!parsed.success) throw new HttpError(400, "Invalid request body", { issues: parsed.error.issues });
  const store = getStore();
  const record = store.get(id);
  if (!record || record.status !== "analyzed") throw new HttpError(409, "Only analyzed disputes can be rejected.");
  return store.upsert({
    ...record,
    status: "rejected",
    decision: "rejected",
    decisionNote: parsed.data.note || "Merchant rejected the recommendation and will handle it manually.",
    updatedAt: new Date().toISOString(),
  });
}

/** Converts thrown errors into JSON responses for the route handlers. */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message, ...e.body }, { status: e.status });
  if (e instanceof NotFoundError) return Response.json({ error: e.message }, { status: 404 });
  console.error(e);
  return Response.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status: 500 });
}
