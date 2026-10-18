import type { ReactNode } from "react";
import { CATEGORY_LABEL, RECOMMENDATION_LABEL, STATUS_LABEL } from "@/lib/format";
import type { CaseStatus, Category, Recommendation } from "@/lib/types";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const STATUS_STYLE: Record<CaseStatus, string> = {
  new: "bg-sky-50 text-sky-700 ring-sky-600/20",
  analyzed: "bg-violet-50 text-violet-700 ring-violet-600/20",
  approved: "bg-amber-50 text-amber-800 ring-amber-600/20",
  resolved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  rejected: "bg-slate-100 text-slate-700 ring-slate-500/20",
};

export function StatusChip({ status }: { status: CaseStatus }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_STYLE[status])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CategoryBadge({ category }: { category?: Category }) {
  if (!category) return <span className="text-xs text-slate-400">Not classified</span>;
  return <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{CATEGORY_LABEL[category]}</span>;
}

const REC_STYLE: Record<Recommendation, string> = {
  accept: "bg-slate-800 text-white",
  refund: "bg-amber-500 text-white",
  contest: "bg-[#0070e0] text-white",
};

export function RecommendationBadge({ value, size = "sm" }: { value: Recommendation; size?: "sm" | "lg" }) {
  return (
    <span className={cx("inline-flex items-center rounded-md font-semibold", REC_STYLE[value], size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs")}>
      {RECOMMENDATION_LABEL[value]}
    </span>
  );
}

export function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  const label = pct >= 80 ? "High" : pct >= 60 ? "Medium" : "Low";
  return (
    <div className="flex items-center gap-3" aria-label={`Confidence ${pct}%`}>
      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200">
        <div className={cx("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-medium tabular-nums text-slate-700">
        {pct}% <span className="font-normal text-slate-500">· {label}</span>
      </span>
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2 hover:text-rose-900">
          Retry
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-slate-200/70", className)} />;
}

export function ModeBadges({ meta }: { meta?: { paypalMode: "mock" | "sandbox"; aiMode: "claude" | "offline"; model?: string } }) {
  if (!meta) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span
        className={cx(
          "rounded-full px-2.5 py-1 font-medium ring-1 ring-inset",
          meta.paypalMode === "sandbox" ? "bg-blue-50 text-blue-700 ring-blue-600/20" : "bg-slate-100 text-slate-600 ring-slate-500/20",
        )}
        title={meta.paypalMode === "sandbox" ? "Connected to the PayPal sandbox" : "Seeded demo data, no PayPal calls"}
      >
        PayPal: {meta.paypalMode === "sandbox" ? "Sandbox" : "Mock data"}
      </span>
      <span
        className={cx(
          "rounded-full px-2.5 py-1 font-medium ring-1 ring-inset",
          meta.aiMode === "claude" ? "bg-violet-50 text-violet-700 ring-violet-600/20" : "bg-slate-100 text-slate-600 ring-slate-500/20",
        )}
        title={meta.aiMode === "claude" ? "Claude agent" : "No ANTHROPIC_API_KEY: offline rules engine"}
      >
        AI: {meta.aiMode === "claude" ? meta.model : "Offline rules"}
      </span>
    </div>
  );
}

export { cx };
