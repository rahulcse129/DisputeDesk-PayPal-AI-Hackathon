import type { NextRequest } from "next/server";
import { analyzeDispute, errorResponse, HttpError } from "@/lib/service";
import type { AgentStep } from "@/lib/types";

// The agent makes several model calls; give it room on hosts that enforce timeouts.
export const maxDuration = 120;

// POST /api/disputes/:id/analyze: run the agent and store its recommendation.
// With "Accept: application/x-ndjson" the response streams one JSON event per line:
//   {"type":"step","step":{...}}  as each tool call happens
//   {"type":"done","case":{...}}  or  {"type":"error","error":"...","status":502}
export async function POST(req: NextRequest, ctx: RouteContext<"/api/disputes/[id]/analyze">) {
  const { id } = await ctx.params;

  if (!req.headers.get("accept")?.includes("application/x-ndjson")) {
    try {
      return Response.json({ case: await analyzeDispute(id) });
    } catch (e) {
      return errorResponse(e);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        const record = await analyzeDispute(id, { onStep: (step: AgentStep) => send({ type: "step", step }) });
        send({ type: "done", case: record });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : (e as Error).name === "NotFoundError" ? 404 : 500;
        send({ type: "error", error: (e as Error).message, status });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
