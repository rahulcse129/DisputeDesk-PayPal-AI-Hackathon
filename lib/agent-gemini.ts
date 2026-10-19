// Gemini version of the agent loop. Same read-only tools, same system prompt, same
// propose_resolution contract and trace as the Claude loop in agent.ts.
// Selected with AI_PROVIDER=gemini (or automatically when only GEMINI_API_KEY is set).

import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { ResolutionOutput } from "./agent-schema";
import { MAX_TURNS, SYSTEM_PROMPT } from "./agent-prompt";
import { TOOL_DEFINITIONS } from "./agent-tools";
import type { ToolExecutor } from "./agent";
import { config } from "./config";

// The tool JSON schemas come from the same Zod schemas the Claude tools use.
const FUNCTION_DECLARATIONS: FunctionDeclaration[] = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

/** Retry settings for overloaded or rate-limited responses (exported so tests can shorten them). */
export const retryPolicy = { attempts: 3, baseDelayMs: 1000 };
const TRANSIENT = new Set([429, 500, 503, 504]);

export const isTransient = (e: unknown) => e instanceof ApiError && TRANSIENT.has(e.status);

async function generate(ai: GoogleGenAI, params: GenerateContentParameters): Promise<GenerateContentResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e) {
      if (!isTransient(e) || attempt >= retryPolicy.attempts) throw e;
      // Exponential backoff with jitter: ~1s, ~2s, ...
      const delay = retryPolicy.baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Runs the agent on the configured Gemini model. If that model stays overloaded after
 * retries (Gemini returns 503 "high demand" during spikes), the run restarts on the
 * fallback model so the merchant still gets an answer. Returns the model that answered.
 */
export async function runGeminiAgent(disputeId: string, exec: ToolExecutor): Promise<{ resolution: ResolutionOutput; model: string }> {
  const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  const { model, fallbackModel } = config.gemini;
  const models = fallbackModel && fallbackModel !== "none" && fallbackModel !== model ? [model, fallbackModel] : [model];

  for (let i = 0; ; i++) {
    try {
      return { resolution: await converse(ai, models[i], disputeId, exec), model: models[i] };
    } catch (e) {
      if (!isTransient(e) || i + 1 >= models.length) throw e;
      exec.record({ kind: "note", summary: `${models[i]} is overloaded right now (${(e as ApiError).status}); retrying the analysis on ${models[i + 1]}.` });
    }
  }
}

async function converse(ai: GoogleGenAI, model: string, disputeId: string, exec: ToolExecutor): Promise<ResolutionOutput> {
  const contents: Content[] = [
    { role: "user", parts: [{ text: `Analyze PayPal dispute ${disputeId} and propose a resolution for the merchant.` }] },
  ];
  let nudged = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await generate(ai, {
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        // Thought summaries show up in the UI trace as the agent's notes.
        thinkingConfig: { includeThoughts: true },
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      const blocked = response.promptFeedback?.blockReason ?? candidate?.finishReason;
      throw new Error(`Gemini returned no answer${blocked ? ` (${blocked})` : ""}. Review this dispute manually.`);
    }
    // Append the model turn unchanged: it carries thought signatures Gemini needs on the next turn.
    contents.push(candidate.content);

    for (const part of candidate.content.parts ?? []) {
      const text = part.text?.trim();
      if (text && !part.functionCall) exec.record({ kind: "note", summary: text });
    }

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      if (candidate.finishReason === "MAX_TOKENS") throw new Error("The model ran out of output tokens before finishing.");
      if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") {
        throw new Error("The model declined to analyze this dispute. Review it manually.");
      }
      if (nudged) break;
      nudged = true;
      contents.push({ role: "user", parts: [{ text: "Please call propose_resolution now with your recommendation." }] });
      continue;
    }

    // Run parallel calls concurrently and return every response in one turn, matched by id.
    const parts: Part[] = await Promise.all(
      calls.map(async (fc): Promise<Part> => {
        const name = fc.name ?? "";
        try {
          const output = await exec.callTool(name, fc.args ?? {});
          return { functionResponse: { id: fc.id, name, response: { result: output } } };
        } catch (e) {
          return { functionResponse: { id: fc.id, name, response: { error: (e as Error).message } } };
        }
      }),
    );
    contents.push({ role: "user", parts });

    const proposal = exec.getProposal();
    if (proposal) return proposal;
  }
  throw new Error("The agent did not produce a recommendation. Try again.");
}

/** Plain-language messages for Gemini API errors; undefined for anything else. */
export function geminiFriendlyError(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  if (e.status === 400 && /api key/i.test(e.message)) return "Gemini API key was rejected. Check GEMINI_API_KEY.";
  if (e.status === 401 || e.status === 403) return "Gemini API key was rejected or lacks access. Check GEMINI_API_KEY.";
  if (e.status === 404) return `Gemini model was not found (${e.message.slice(0, 120)}). Check GEMINI_MODEL and GEMINI_FALLBACK_MODEL.`;
  if (e.status === 429) return "Gemini rate limit or quota reached. Wait a moment and try again.";
  if (e.status >= 500) return `Gemini is overloaded or unavailable right now (${e.status}), even after retrying. Try again shortly.`;
  return `Gemini API error (${e.status}): ${e.message}`;
}
