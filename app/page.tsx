"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CategoryBadge, ErrorBanner, ModeBadges, RecommendationBadge, Skeleton, StatusChip, cx } from "./components/ui";
import { daysUntil, dueLabel, formatDate, formatMoney, REASON_LABEL, STATUS_LABEL } from "@/lib/format";
import type { CaseStatus, DisputeListItem } from "@/lib/types";

type Meta = { paypalMode: "mock" | "sandbox"; aiMode: "claude" | "gemini" | "offline"; model?: string };
const FILTERS: ("all" | CaseStatus)[] = ["all", "new", "analyzed", "approved", "resolved", "rejected"];

export default function Dashboard() {
  const router = useRouter();
  const [items, setItems] = useState<DisputeListItem[] | null>(null);
  const [meta, setMeta] = useState<Meta>();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | CaseStatus>("all");

  const apply = useCallback((body: { disputes: DisputeListItem[]; meta: Meta }) => {
    setError(null);
    setItems(body.disputes);
    setMeta(body.meta);
  }, []);

  const load = useCallback(() => {
    fetchQueue().then(apply, (e: Error) => setError(e.message));
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    fetchQueue().then(
      (body) => !cancelled && apply(body),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const stats = useMemo(() => {
    if (!items) return null;
    const open = items.filter((i) => i.caseStatus !== "resolved");
    const atRisk = open.reduce((sum, i) => sum + Number(i.dispute.amount.value), 0);
    const dueSoon = open.filter((i) => (daysUntil(i.dispute.sellerResponseDue) ?? 99) <= 5).length;
    const needsDecision = items.filter((i) => i.caseStatus === "analyzed").length;
    return { open: open.length, atRisk, dueSoon, needsDecision };
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items?.length ?? 0 };
    items?.forEach((i) => (c[i.caseStatus] = (c[i.caseStatus] ?? 0) + 1));
    return c;
  }, [items]);

  const visible = items?.filter((i) => filter === "all" || i.caseStatus === filter) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dispute queue</h1>
          <p className="mt-1 text-sm text-slate-600">Open PayPal disputes, sorted by response deadline.</p>
        </div>
        <ModeBadges meta={meta} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open disputes" value={stats?.open} />
        <Stat label="Amount at risk" value={stats ? formatMoney({ value: stats.atRisk.toFixed(2), currency: "USD" }) : undefined} />
        <Stat label="Due within 5 days" value={stats?.dueSoon} tone={stats && stats.dueSoon > 0 ? "warn" : undefined} />
        <Stat label="Awaiting your decision" value={stats?.needsDecision} tone={stats && stats.needsDecision > 0 ? "info" : undefined} />
      </div>

      {error && <ErrorBanner message={`Could not load disputes: ${error}`} onRetry={load} />}

      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              "shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
              filter === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50",
            )}
          >
            {f === "all" ? "All" : STATUS_LABEL[f]}
            <span className={cx("ml-1.5 tabular-nums", filter === f ? "text-slate-300" : "text-slate-400")}>{counts[f] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {/* Desktop table */}
        <table className="hidden w-full text-sm md:table">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-3">Dispute</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">Category</th>
              <th className="px-3 py-3">AI recommendation</th>
              <th className="px-3 py-3 text-right">Amount</th>
              <th className="px-5 py-3 text-right">Deadline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!items && !error && <SkeletonRows />}
            {visible.map((i) => (
              <tr key={i.dispute.id} onClick={() => router.push(`/disputes/${i.dispute.id}`)} className="group cursor-pointer hover:bg-slate-50">
                <td className="px-5 py-3.5">
                  <Link href={`/disputes/${i.dispute.id}`} className="block">
                    <div className="font-medium text-slate-900 group-hover:text-[#0070e0]">{i.dispute.buyer.name}</div>
                    <div className="mt-0.5 font-mono text-xs text-slate-500">
                      {i.dispute.id} · {REASON_LABEL[i.dispute.reason]}
                    </div>
                  </Link>
                </td>
                <td className="px-3 py-3.5">
                  <StatusChip status={i.caseStatus} />
                </td>
                <td className="px-3 py-3.5">
                  <CategoryBadge category={i.category} />
                </td>
                <td className="px-3 py-3.5">
                  {i.recommendation ? (
                    <div className="flex flex-col gap-1.5">
                      <RecommendationBadge value={i.recommendation} />
                      {i.confidence !== undefined && <span className="text-xs text-slate-500">{Math.round(i.confidence * 100)}% confidence</span>}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">Not analyzed</span>
                  )}
                </td>
                <td className="px-3 py-3.5 text-right font-medium tabular-nums">{formatMoney(i.dispute.amount)}</td>
                <td className="px-5 py-3.5 text-right">
                  <Deadline iso={i.dispute.sellerResponseDue} resolved={i.caseStatus === "resolved"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Mobile cards */}
        <ul className="divide-y divide-slate-100 md:hidden">
          {!items && !error && [0, 1, 2].map((k) => <li key={k} className="p-4"><Skeleton className="h-14" /></li>)}
          {visible.map((i) => (
            <li key={i.dispute.id}>
              <Link href={`/disputes/${i.dispute.id}`} className="block p-4 active:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{i.dispute.buyer.name}</div>
                    <div className="mt-0.5 font-mono text-xs text-slate-500">{i.dispute.id}</div>
                  </div>
                  <div className="text-right font-semibold tabular-nums">{formatMoney(i.dispute.amount)}</div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <StatusChip status={i.caseStatus} />
                  <CategoryBadge category={i.category} />
                  {i.recommendation && <RecommendationBadge value={i.recommendation} />}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {REASON_LABEL[i.dispute.reason]} · <Deadline iso={i.dispute.sellerResponseDue} resolved={i.caseStatus === "resolved"} inline />
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {items && visible.length === 0 && (
          <div className="px-5 py-12 text-center text-sm text-slate-500">No disputes in this view.</div>
        )}
      </div>

      {items && items.some((i) => i.confidence !== undefined) && (
        <p className="text-xs text-slate-500">
          Tip: open an analyzed dispute to review the agent&apos;s reasoning and edit the draft before approving.
        </p>
      )}
    </div>
  );
}

async function fetchQueue(): Promise<{ disputes: DisputeListItem[]; meta: Meta }> {
  const res = await fetch("/api/disputes", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function Stat({ label, value, tone }: { label: string; value?: string | number; tone?: "warn" | "info" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <div className={cx("mt-1 text-2xl font-semibold tabular-nums", tone === "warn" && "text-amber-600", tone === "info" && "text-violet-700")}>{value}</div>
      )}
    </div>
  );
}

function Deadline({ iso, resolved, inline }: { iso?: string; resolved: boolean; inline?: boolean }) {
  if (resolved) return <span className="text-xs text-slate-400">Closed</span>;
  const d = daysUntil(iso);
  const urgent = d !== undefined && d <= 5;
  return (
    <span className={cx(inline ? "" : "flex flex-col items-end")}>
      <span className={cx("text-sm font-medium", urgent ? "text-amber-700" : "text-slate-700")}>{dueLabel(iso)}</span>
      {!inline && <span className="text-xs text-slate-400">{formatDate(iso)}</span>}
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3].map((k) => (
        <tr key={k}>
          <td className="px-5 py-4" colSpan={6}>
            <Skeleton className="h-9" />
          </td>
        </tr>
      ))}
    </>
  );
}
