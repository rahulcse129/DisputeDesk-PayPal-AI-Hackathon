"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AgentTrace } from "./agent-trace";
import {
  Card,
  CategoryBadge,
  ConfidenceMeter,
  ErrorBanner,
  ModeBadges,
  RecommendationBadge,
  Skeleton,
  Spinner,
  StatusChip,
  cx,
} from "@/app/components/ui";
import { dueLabel, formatDate, formatMoney, RECOMMENDATION_LABEL, REASON_LABEL } from "@/lib/format";
import type { AgentStep, CaseRecord, Dispute, OrderDetails, Recommendation, TrackingInfo } from "@/lib/types";

type Meta = { paypalMode: "mock" | "sandbox"; aiMode: "claude" | "offline"; model?: string };
interface Detail {
  dispute: Dispute;
  order: OrderDetails;
  tracking: TrackingInfo;
  case: CaseRecord | null;
  meta: Meta;
}

export function DisputeView({ id }: { id: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const apply = useCallback((body: Detail) => {
    setLoadError(null);
    setData(body);
    setSteps(body.case?.trace ?? []);
  }, []);

  const load = useCallback(() => {
    fetchDetail(id).then(apply, (e: Error) => setLoadError(e.message));
  }, [id, apply]);

  useEffect(() => {
    let cancelled = false;
    fetchDetail(id).then(
      (body) => !cancelled && apply(body),
      (e: Error) => !cancelled && setLoadError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [id, apply]);

  const setCase = (c: CaseRecord) => setData((d) => (d ? { ...d, case: c } : d));

  async function analyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    setSteps([]);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
        headers: { Accept: "application/x-ndjson" },
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      // Read the NDJSON stream: one event per line, steps arrive as the agent works.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "step") setSteps((s) => [...s, event.step]);
          else if (event.type === "done") {
            setCase(event.case);
            setSteps(event.case.trace ?? []);
          } else if (event.type === "error") throw new Error(event.error);
        }
      }
    } catch (e) {
      setAnalyzeError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBanner message={loadError} onRetry={load} />
      </div>
    );
  }
  if (!data) return <DetailSkeleton />;

  const { dispute, order, tracking, meta } = data;
  const c = data.case;
  const status = c?.status ?? (dispute.status === "RESOLVED" ? "resolved" : "new");
  const actioned = status === "approved" || status === "resolved";

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{dispute.buyer.name}</h1>
            <StatusChip status={status} />
            {c?.category && <CategoryBadge category={c.category} />}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            <span className="font-mono">{dispute.id}</span> · {REASON_LABEL[dispute.reason]} · {dispute.stage.replace(/_/g, " ").toLowerCase()} stage · opened{" "}
            {formatDate(dispute.createTime)}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-xs text-slate-500">Disputed amount</div>
            <div className="text-2xl font-semibold tabular-nums">{formatMoney(dispute.amount)}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Respond by</div>
            <div className="text-sm font-medium">{actioned ? "—" : dueLabel(dispute.sellerResponseDue)}</div>
            <div className="text-xs text-slate-400">{formatDate(dispute.sellerResponseDue)}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Left: facts */}
        <div className="space-y-6 lg:col-span-2">
          <Card title="Buyer's claim">
            <blockquote className="border-l-4 border-[#0070e0]/30 pl-4 text-[15px] leading-relaxed text-slate-800">“{dispute.buyerClaim}”</blockquote>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Buyer</dt>
              <dd className="truncate text-right">{dispute.buyer.email ?? dispute.buyer.name}</dd>
              <dt className="text-slate-500">PayPal status</dt>
              <dd className="text-right">{dispute.status.replace(/_/g, " ").toLowerCase()}</dd>
              <dt className="text-slate-500">Invoice</dt>
              <dd className="text-right font-mono text-xs">{dispute.transaction.invoiceId ?? "—"}</dd>
            </dl>
          </Card>

          <OrderCard order={order} />
          <TimelineCard dispute={dispute} order={order} tracking={tracking} outcome={c?.outcome} />
        </div>

        {/* Right: AI */}
        <div className="space-y-6 lg:col-span-3">
          <Card
            title={
              <span className="flex items-center gap-2">
                <span className="grid h-5 w-5 place-items-center rounded bg-violet-100 text-[11px]">✦</span> AI analysis
              </span>
            }
            action={<ModeBadges meta={meta} />}
          >
            {!c?.resolution && steps.length === 0 && !analyzing && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="max-w-sm text-sm text-slate-600">
                  The agent reads the dispute, order and tracking, checks similar past cases, then recommends how to respond. Nothing is sent
                  until you approve.
                </p>
                <AnalyzeButton onClick={analyze} busy={analyzing} />
              </div>
            )}

            {(steps.length > 0 || analyzing) && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Agent steps</h3>
                  {c?.agentMode && !analyzing && (
                    <span className="text-xs text-slate-400">
                      {c.agentMode === "claude" ? c.model : "offline rules engine"} · {formatDate(c.updatedAt, true)}
                    </span>
                  )}
                </div>
                <AgentTrace steps={steps} running={analyzing} />
              </div>
            )}

            {analyzeError && (
              <div className="mt-4">
                <ErrorBanner message={`Analysis failed: ${analyzeError}`} onRetry={analyze} />
              </div>
            )}

            {c?.resolution && !analyzing && !actioned && (
              <div className="mt-4 flex justify-end">
                <button onClick={analyze} className="text-sm font-medium text-slate-500 hover:text-slate-800">
                  ↻ Re-run analysis
                </button>
              </div>
            )}
          </Card>

          {c?.resolution && !analyzing && <RecommendationCard key={c.updatedAt} record={c} onCase={setCase} amount={formatMoney(dispute.amount)} stage={dispute.stage} />}
        </div>
      </div>
    </div>
  );
}

async function fetchDetail(id: string): Promise<Detail> {
  const res = await fetch(`/api/disputes/${encodeURIComponent(id)}`, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function AnalyzeButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-lg bg-[#0070e0] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#005ea6] disabled:opacity-60"
    >
      {busy ? <Spinner /> : <span aria-hidden>✦</span>} Analyze with AI
    </button>
  );
}

function RecommendationCard({ record, onCase, amount, stage }: { record: CaseRecord; onCase: (c: CaseRecord) => void; amount: string; stage: string }) {
  const r = record.resolution!;
  const actioned = record.status === "approved" || record.status === "resolved";
  const [draft, setDraft] = useState(record.finalMessage ?? r.draft_message);
  const [action, setAction] = useState<Recommendation>(record.outcome?.action ?? r.recommendation);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edited = draft !== r.draft_message;

  async function submit(kind: "approve" | "reject") {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(record.disputeId)}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "approve" ? { draft_message: draft, action } : {}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onCase(body.case);
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const consequence: Record<Recommendation, string> = {
    accept: `PayPal will refund ${amount} to the buyer and close the dispute in their favor.`,
    refund: `${amount} will be refunded to the buyer now, and proof of refund submitted to PayPal.`,
    contest: `Your evidence and statement will be submitted to PayPal for review.${stage === "INQUIRY" ? " The message is also sent to the buyer." : ""}`,
  };

  return (
    <Card title="Recommendation" action={<span className="text-xs text-slate-500">{r.category.replace(/_/g, " ")}</span>}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <RecommendationBadge value={r.recommendation} size="lg" />
        <ConfidenceMeter value={r.confidence} />
      </div>

      <p className="mt-4 text-[15px] leading-relaxed text-slate-800">{r.reasoning}</p>

      {r.evidence_points.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence</h3>
          <ul className="mt-2 space-y-1.5">
            {r.evidence_points.map((p, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-700">
                <span className="mt-0.5 text-emerald-600" aria-hidden>
                  ✓
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 border-t border-slate-100 pt-5">
        <div className="flex items-center justify-between">
          <label htmlFor="draft" className="text-sm font-semibold text-slate-900">
            {action === "contest" ? "Statement to PayPal" : "Message to buyer"}
          </label>
          {edited && !actioned && (
            <button onClick={() => setDraft(r.draft_message)} className="text-xs font-medium text-slate-500 hover:text-slate-800">
              Reset to AI draft
            </button>
          )}
        </div>
        <textarea
          id="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={actioned || record.status === "rejected"}
          rows={8}
          maxLength={2000}
          className="mt-2 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 shadow-sm focus:border-[#0070e0] focus:outline-none focus:ring-2 focus:ring-[#0070e0]/20 read-only:bg-slate-50"
        />
        <div className="mt-1 flex justify-between text-xs text-slate-400">
          <span>{edited ? "Edited by you" : "AI draft"}</span>
          <span className="tabular-nums">{draft.length}/2000</span>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {record.status === "analyzed" && (
        <div className="mt-5 space-y-4">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">Action</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {(["contest", "refund", "accept"] as Recommendation[]).map((a) => (
                <label
                  key={a}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    action === a ? "border-[#0070e0] bg-blue-50/60 ring-1 ring-[#0070e0]" : "border-slate-200 hover:bg-slate-50",
                  )}
                >
                  <input type="radio" name="action" value={a} checked={action === a} onChange={() => { setAction(a); setConfirming(false); }} className="accent-[#0070e0]" />
                  <span className="font-medium">{RECOMMENDATION_LABEL[a]}</span>
                  {a === r.recommendation && <span className="ml-auto text-[10px] font-semibold uppercase text-violet-600">AI</span>}
                </label>
              ))}
            </div>
          </fieldset>

          {confirming ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">Confirm: {RECOMMENDATION_LABEL[action]}</p>
              <p className="mt-1 text-sm text-amber-800">{consequence[action]} This cannot be undone.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => submit("approve")}
                  disabled={busy !== null || draft.trim().length < 10}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                >
                  {busy === "approve" && <Spinner />} Yes, execute
                </button>
                <button onClick={() => setConfirming(false)} disabled={busy !== null} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-amber-100">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setConfirming(true)}
                disabled={busy !== null || draft.trim().length < 10}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
              >
                Approve
              </button>
              <button
                onClick={() => submit("reject")}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
              >
                {busy === "reject" && <Spinner />} Reject
              </button>
            </div>
          )}
        </div>
      )}

      {record.status === "rejected" && (
        <div className="mt-5 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
          You rejected this recommendation. {record.decisionNote} You can re-run the analysis from the panel above.
        </div>
      )}

      {record.outcome && <OutcomePanel record={record} />}
    </Card>
  );
}

function OutcomePanel({ record }: { record: CaseRecord }) {
  const o = record.outcome!;
  return (
    <div className={cx("mt-5 rounded-lg border p-4", o.ok ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50")}>
      <p className={cx("text-sm font-semibold", o.ok ? "text-emerald-900" : "text-rose-900")}>
        {o.ok ? `✓ ${RECOMMENDATION_LABEL[o.action]} executed` : `${RECOMMENDATION_LABEL[o.action]} failed`}
        <span className="ml-2 font-normal opacity-70">
          {o.mode === "mock" ? "mock PayPal" : "PayPal sandbox"} · {formatDate(o.executedAt, true)}
        </span>
      </p>
      {record.decisionNote && o.ok && <p className="mt-1 text-sm text-emerald-800">{record.decisionNote}</p>}
      {o.error && <p className="mt-1 text-sm text-rose-800">{o.error}</p>}
      <ul className="mt-3 space-y-1">
        {o.calls.map((call, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className={call.ok ? "text-emerald-700" : "text-rose-700"}>{call.ok ? "✓" : "✗"}</span>
            <span className="font-mono text-xs leading-5 text-slate-700">{call.operation}</span>
            <span className="text-slate-600">{call.detail}</span>
          </li>
        ))}
      </ul>
      {o.ok && o.action === "contest" && <p className="mt-3 text-xs text-slate-600">PayPal will review the evidence. The case moves to Resolved when PayPal closes it.</p>}
    </div>
  );
}

function OrderCard({ order }: { order: OrderDetails }) {
  const h = order.buyerHistory;
  return (
    <Card title="Order" action={<span className="font-mono text-xs text-slate-500">{order.orderId ?? "—"}</span>}>
      <ul className="divide-y divide-slate-100">
        {order.items.length === 0 && <li className="py-2 text-sm text-slate-500">No line items on the order.</li>}
        {order.items.map((it, i) => (
          <li key={i} className="flex justify-between gap-4 py-2 text-sm">
            <span>
              <span className="text-slate-900">
                {it.quantity > 1 && `${it.quantity} × `}
                {it.name}
              </span>
              {it.description && <span className="mt-0.5 block text-xs text-slate-500">{it.description}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-slate-700">{formatMoney(it.unitPrice)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-sm">
        <dt className="text-slate-500">Placed</dt>
        <dd className="text-right">{formatDate(order.createTime, true)}</dd>
        <dt className="text-slate-500">Fulfillment</dt>
        <dd className="text-right capitalize">{order.fulfillment}</dd>
        {order.shippingAddress && (
          <>
            <dt className="text-slate-500">Ship to</dt>
            <dd className="text-right">{order.shippingAddress}</dd>
          </>
        )}
        {order.ipCountry && order.billingCountry && (
          <>
            <dt className="text-slate-500">IP / billing</dt>
            <dd className={cx("text-right", order.ipCountry !== order.billingCountry && "font-medium text-rose-700")}>
              {order.ipCountry} / {order.billingCountry}
            </dd>
          </>
        )}
      </dl>
      <div className={cx("mt-4 rounded-lg px-3 py-2.5 text-sm", h.previousDisputes >= 3 ? "bg-rose-50 text-rose-900" : "bg-slate-50 text-slate-700")}>
        <span className="font-medium">Buyer history:</span> {h.previousOrders} prior orders · {h.previousDisputes} prior disputes
        {h.accountAgeDays !== undefined && ` · customer for ${h.accountAgeDays} days`}
        {h.notes && <p className="mt-1 text-xs opacity-80">{h.notes}</p>}
      </div>
    </Card>
  );
}

function TimelineCard({ dispute, order, tracking, outcome }: { dispute: Dispute; order: OrderDetails; tracking: TrackingInfo; outcome?: CaseRecord["outcome"] }) {
  const events = [
    order.createTime && { time: order.createTime, label: "Order paid", detail: formatMoney(order.total), tone: "slate" },
    ...(order.relatedCaptures ?? []).map((c) => ({ time: c.createTime, label: "Related capture", detail: `${c.captureId} · ${formatMoney(c.amount)}`, tone: "amber" })),
    ...tracking.events.map((e) => ({ time: e.time, label: e.description, detail: e.location, tone: /deliver/i.test(e.description) ? "green" : /delay|exception|unable/i.test(e.description) ? "red" : "blue" })),
    ...dispute.messages.map((m) => ({ time: m.time, label: m.postedBy === "BUYER" ? "Dispute opened by buyer" : `Message from ${m.postedBy.toLowerCase()}`, detail: undefined, tone: "violet" })),
    outcome?.ok && { time: outcome.executedAt, label: `${RECOMMENDATION_LABEL[outcome.action]} executed`, detail: undefined, tone: "green" },
  ]
    .filter((e): e is { time: string; label: string; detail: string | undefined; tone: string } => Boolean(e))
    .sort((a, b) => a.time.localeCompare(b.time));

  const dot: Record<string, string> = {
    slate: "bg-slate-400",
    blue: "bg-[#0070e0]",
    green: "bg-emerald-500",
    red: "bg-rose-500",
    amber: "bg-amber-500",
    violet: "bg-violet-500",
  };

  return (
    <Card
      title="Order & tracking timeline"
      action={
        tracking.status === "NO_TRACKING" ? (
          <span className="rounded bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">No tracking</span>
        ) : (
          <span className="text-xs text-slate-500">
            {tracking.carrier} · <span className="font-mono">{tracking.trackingNumber}</span>
          </span>
        )
      }
    >
      <ol className="relative ml-1.5 space-y-4 border-l border-slate-200">
        {events.map((e, i) => (
          <li key={i} className="relative pl-5">
            <span className={cx("absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white", dot[e.tone])} />
            <div className="text-sm text-slate-900">{e.label}</div>
            <div className="text-xs text-slate-500">
              {formatDate(e.time, true)}
              {e.detail && ` · ${e.detail}`}
            </div>
          </li>
        ))}
      </ol>
      {tracking.signedBy && (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Signed for by <span className="font-semibold">{tracking.signedBy}</span>
          {tracking.deliveredTo && ` at ${tracking.deliveredTo}`}
        </p>
      )}
    </Card>
  );
}

function BackLink() {
  return (
    <Link href="/" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
      ← All disputes
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-10 w-80" />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </div>
        <Skeleton className="h-72 lg:col-span-3" />
      </div>
    </div>
  );
}
