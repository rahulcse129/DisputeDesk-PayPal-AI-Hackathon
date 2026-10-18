import { TOOL_LABEL } from "@/lib/format";
import type { AgentStep } from "@/lib/types";
import { Spinner, cx } from "@/app/components/ui";

const ICON: Record<string, string> = {
  get_dispute: "📄",
  get_order_details: "🧾",
  get_tracking: "🚚",
  search_similar_cases: "🔎",
  propose_resolution: "✅",
};

export function AgentTrace({ steps, running }: { steps: AgentStep[]; running: boolean }) {
  if (steps.length === 0 && !running) return null;
  return (
    <ol className="relative space-y-1">
      {steps.map((s) => (
        <li key={s.index} className="relative pl-9">
          <span
            className={cx(
              "absolute left-0 top-1.5 grid h-6 w-6 place-items-center rounded-full text-xs",
              s.kind === "error" ? "bg-rose-100 text-rose-700" : s.kind === "note" ? "bg-slate-100 text-slate-500" : "bg-blue-50",
            )}
            aria-hidden
          >
            {s.kind === "error" ? "!" : s.kind === "note" ? "💭" : (ICON[s.tool ?? ""] ?? "•")}
          </span>
          {s.kind === "note" ? (
            <p className="py-1.5 text-sm italic text-slate-500">{s.summary}</p>
          ) : (
            <details className="group rounded-md py-1.5">
              <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className={cx("text-sm font-medium", s.kind === "error" ? "text-rose-700" : "text-slate-900")}>
                    {s.tool ? (TOOL_LABEL[s.tool] ?? s.tool) : "Error"}
                  </span>
                  <span className="block text-sm text-slate-600">{s.summary}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-slate-400">
                  {s.durationMs !== undefined && `${s.durationMs}ms`} <span className="group-open:hidden">▸</span>
                  <span className="hidden group-open:inline">▾</span>
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {s.input !== undefined && <JsonBlock label={`${s.tool}(input)`} value={s.input} />}
                {s.output !== undefined && <JsonBlock label="result" value={s.output} />}
              </div>
            </details>
          )}
        </li>
      ))}
      {running && (
        <li className="relative flex items-center gap-2 py-1.5 pl-9 text-sm text-slate-500">
          <span className="absolute left-0 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-blue-50 text-[#0070e0]">
            <Spinner className="h-3.5 w-3.5" />
          </span>
          Agent is working…
        </li>
      )}
    </ol>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
