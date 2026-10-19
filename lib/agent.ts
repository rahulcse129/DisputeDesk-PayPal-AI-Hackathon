// The DisputeDesk agent: a tool-use loop over read-only tools, run by Claude (default)
// or Gemini, with an offline rules engine as the no-key fallback.
//
// SAFETY: the agent's tool list contains no money-moving or message-sending
// operation. It can only *propose* a resolution; lib/actions.ts executes it, and only
// from the approve route after the merchant clicks Approve.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ResolutionSchema, type ResolutionOutput } from "./agent-schema";
import { runGeminiAgent, geminiFriendlyError } from "./agent-gemini";
import { runOfflineAgent } from "./agent-offline";
import { MAX_TURNS, SYSTEM_PROMPT } from "./agent-prompt";
import { runReadTool, TOOL_DEFINITIONS, ToolInputError } from "./agent-tools";
import { aiMode, aiModel, config, type AiMode } from "./config";
import type { AgentStep } from "./types";

export class AgentError extends Error {
  constructor(
    message: string,
    public trace: AgentStep[],
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentContext {
  disputeId: string;
  /** Runs a tool and records it in the trace. propose_resolution is validated and recorded, never executed. */
  callTool: (name: string, input: unknown) => Promise<unknown>;
}
export type AgentRunner = (ctx: AgentContext) => Promise<ResolutionOutput>;

export interface AgentResult {
  resolution: ResolutionOutput;
  trace: AgentStep[];
  mode: AiMode;
  model?: string;
}

function summarize(name: string, output: unknown): string {
  const o = output as Record<string, unknown>;
  switch (name) {
    case "get_dispute":
      return `Dispute ${o.id}: ${String(o.reason).replace(/_/g, " ").toLowerCase()}, ${(o.amount as { value: string })?.value} ${(o.amount as { currency: string })?.currency}, stage ${o.stage}`;
    case "get_order_details": {
      const items = (o.items as { name: string }[] | undefined)?.map((i) => i.name).join(", ") || "no line items";
      const h = o.buyerHistory as { previousOrders: number; previousDisputes: number } | undefined;
      return `Order ${o.orderId ?? "?"}: ${items} (${o.fulfillment}); buyer has ${h?.previousOrders ?? 0} prior orders, ${h?.previousDisputes ?? 0} prior disputes`;
    }
    case "get_tracking":
      return o.status === "NO_TRACKING" ? "No tracking on file" : `${o.carrier} ${o.trackingNumber}: ${o.status}${o.signedBy ? `, signed by ${o.signedBy}` : ""}`;
    case "search_similar_cases":
      return `Found ${o.count} similar past case${o.count === 1 ? "" : "s"}`;
    default:
      return "Done";
  }
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;

/** Creates the tool executor shared by the model loops and the offline runner. */
function createToolExecutor(disputeId: string, trace: AgentStep[], onStep?: (step: AgentStep) => void) {
  const scope: { disputeId: string } = { disputeId };
  const record = (step: Omit<AgentStep, "index" | "at">) => {
    const full: AgentStep = { ...step, index: trace.length + 1, at: new Date().toISOString() };
    trace.push(full);
    onStep?.(full);
  };
  let proposed: ResolutionOutput | undefined;

  async function callTool(name: string, input: unknown): Promise<unknown> {
    const started = Date.now();
    if (name === "propose_resolution") {
      const parsed = ResolutionSchema.safeParse(input);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        record({ kind: "error", tool: name, input, summary: `Invalid proposal: ${msg}`, durationMs: Date.now() - started });
        throw new ToolInputError(`Invalid proposal, fix and call propose_resolution again: ${msg}`);
      }
      proposed = parsed.data;
      record({
        kind: "tool",
        tool: name,
        input: parsed.data,
        summary: `Proposed ${parsed.data.recommendation.toUpperCase()} (${Math.round(parsed.data.confidence * 100)}% confidence)`,
        durationMs: Date.now() - started,
      });
      return { status: "recorded", note: "Proposal saved for merchant review. Nothing has been executed." };
    }
    try {
      const output = await runReadTool(name, input, scope);
      record({ kind: "tool", tool: name, input, output, summary: summarize(name, output), durationMs: Date.now() - started });
      return output;
    } catch (e) {
      record({ kind: "error", tool: name, input, summary: (e as Error).message, durationMs: Date.now() - started });
      throw e;
    }
  }

  return { callTool, record, getProposal: () => proposed };
}

// Model features used below are only sent to models known to support them.
const supportsNewFeatures = (model: string) => /claude-(sonnet-5-5|opus-5-5|fable-5)/.test(model);

const runClaudeAgent = async (
  disputeId: string,
  exec: ToolExecutor,
): Promise<ResolutionOutput> => {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = config.anthropic.model;
  const modern = supportsNewFeatures(model);
  const betas: string[] = [];
  if (modern) betas.push("thinking-display-updates-2026-08-18");
  if (modern && config.anthropic.serverFallback) betas.push("server-side-fallback-2026-07-01");

  const messages: BetaMessageParam[] = [
    { role: "user", content: `Analyze PayPal dispute ${disputeId} and propose a resolution for the merchant.` },
  ];
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
      ...(modern
        ? {
            // "updates" returns short progress notes between tool calls, which the UI shows in the trace.
            thinking: { type: "adaptive" as const, display: "updates" as const },
            output_config: { effort: "medium" as const },
          }
        : {}),
      ...(betas.length ? { betas } : {}),
      ...(modern && config.anthropic.serverFallback ? { fallbacks: "default" as const } : {}),
    });

    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to analyze this dispute. Review it manually.");
    }

    // Append the full content (including thinking blocks) unchanged so the next turn stays valid.
    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      const note = noteText(block);
      if (note) exec.record({ kind: "note", summary: note });
    }

    const toolUses = response.content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens before finishing.");
      if (nudged) break;
      nudged = true;
      messages.push({ role: "user", content: "Please call propose_resolution now with your recommendation." });
      continue;
    }

    // Run parallel tool calls concurrently and return every result in one user message.
    const results: BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu): Promise<BetaToolResultBlockParam> => {
        try {
          const output = await exec.callTool(tu.name, tu.input);
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: tu.id, content: (e as Error).message, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });

    const proposal = exec.getProposal();
    if (proposal) return proposal;
  }
  throw new Error("The agent did not produce a recommendation. Try again.");
};

function noteText(block: BetaContentBlock): string | undefined {
  if (block.type === "text") return block.text.trim() || undefined;
  if (block.type === "thinking") return block.thinking.trim() || undefined;
  return undefined;
}

function friendlyError(e: unknown): string {
  const gemini = geminiFriendlyError(e);
  if (gemini) return gemini;
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached. Wait a moment and try again.";
  if (e instanceof Anthropic.NotFoundError) return `Model "${config.anthropic.model}" was not found. Check ANTHROPIC_MODEL.`;
  if (e instanceof Anthropic.BadRequestError) return `The model request was rejected: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your network connection.";
  if (e instanceof Anthropic.APIError) return `Anthropic API error (${e.status ?? "unknown"}): ${e.message}`;
  return (e as Error).message;
}

export interface RunAgentOptions {
  /** Override the runner (tests). */
  runner?: AgentRunner;
  /** Called as each step happens, for live streaming to the UI. */
  onStep?: (step: AgentStep) => void;
  /** Offline mode finishes instantly; a small per-tool delay makes a streamed trace readable. */
  offlineStepDelayMs?: number;
}

export async function runAgent(disputeId: string, opts: RunAgentOptions = {}): Promise<AgentResult> {
  const trace: AgentStep[] = [];
  const exec = createToolExecutor(disputeId, trace, opts.onStep);
  const mode: AiMode = opts.runner ? "offline" : aiMode();
  // The model that actually answered (Gemini may fall back to a second model).
  let model = aiModel(mode);
  try {
    const resolution =
      opts.runner || mode === "offline"
        ? await (opts.runner ?? runOfflineAgent)({
            disputeId,
            callTool: async (name, input) => {
              if (opts.offlineStepDelayMs) await new Promise((r) => setTimeout(r, opts.offlineStepDelayMs));
              return exec.callTool(name, input);
            },
          })
        : mode === "gemini"
          ? await runGeminiAgent(disputeId, exec).then((r) => ((model = r.model), r.resolution))
          : await runClaudeAgent(disputeId, exec);
    return { resolution, trace, mode, model };
  } catch (e) {
    const message = friendlyError(e);
    exec.record({ kind: "error", summary: message });
    throw new AgentError(message, trace);
  }
}
