"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CategoryBadge, ErrorBanner, RecommendationBadge, Skeleton, Spinner, StatusChip, cx } from "@/app/components/ui";
import { CATEGORY_LABEL, formatDate, formatMoney } from "@/lib/format";
import type { CaseRecord, Category } from "@/lib/types";

const RESULT_STYLE: Record<string, string> = {
  won: "bg-emerald-50 text-emerald-700",
  lost: "bg-rose-50 text-rose-700",
  refunded: "bg-amber-50 text-amber-800",
  closed: "bg-slate-100 text-slate-700",
  pending: "bg-blue-50 text-blue-700",
};

export default function CasesPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [cases, setCases] = useState<CaseRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Debounce typing so each keystroke doesn't hit the API.
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q, ...(category ? { category } : {}) });
        const res = await fetch(`/api/cases/search?${params}`, { signal: controller.signal, cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setCases(body.cases);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, category]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Case history</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every dispute, recommendation, decision and outcome. The agent searches these same cases for precedent.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search claims, reasoning, buyers, outcomes… e.g. “signature” or “tracking”"
            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-3 pr-9 text-sm shadow-sm focus:border-[#0070e0] focus:outline-none focus:ring-2 focus:ring-[#0070e0]/20"
            aria-label="Search cases"
          />
          {loading && <Spinner className="absolute right-3 top-3 text-slate-400" />}
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category | "")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-[#0070e0] focus:outline-none"
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={`Search failed: ${error}`} />}

      <div className="space-y-3">
        {!cases && !error && [0, 1, 2].map((k) => <Skeleton key={k} className="h-28" />)}
        {cases?.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-12 text-center text-sm text-slate-500">
            No cases match your search.
          </div>
        )}
        {cases?.map((c) => {
          const isLive = !c.disputeId.startsWith("HIST-");
          const body = (
            <article className={cx("rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5", isLive && "transition hover:border-slate-300 hover:shadow")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">{c.disputeId}</span>
                    <StatusChip status={c.status} />
                    <CategoryBadge category={c.category} />
                    {c.result && (
                      <span className={cx("rounded-md px-2 py-0.5 text-xs font-semibold capitalize", RESULT_STYLE[c.result])}>{c.result}</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-slate-800">“{c.buyerClaim}”</p>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{formatMoney(c.amount)}</div>
                  <div className="text-xs text-slate-400">{formatDate(c.updatedAt)}</div>
                </div>
              </div>
              {c.resolution && (
                <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-start">
                  <div className="flex shrink-0 items-center gap-2">
                    <RecommendationBadge value={c.resolution.recommendation} />
                    <span className="text-xs tabular-nums text-slate-500">{Math.round(c.resolution.confidence * 100)}%</span>
                  </div>
                  <p className="text-sm text-slate-600">{c.resolution.reasoning}</p>
                </div>
              )}
              {c.decisionNote && <p className="mt-2 text-xs text-slate-500">Merchant note: {c.decisionNote}</p>}
            </article>
          );
          return isLive ? (
            <Link key={c.disputeId} href={`/disputes/${c.disputeId}`} className="block">
              {body}
            </Link>
          ) : (
            <div key={c.disputeId}>{body}</div>
          );
        })}
      </div>
    </div>
  );
}
