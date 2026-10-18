import type { NextRequest } from "next/server";
import { approveDispute, errorResponse } from "@/lib/service";

// POST /api/disputes/:id/approve  body: { draft_message?: string, action?: "accept" | "refund" | "contest" }
// The only route that moves money or messages the buyer, and only once per dispute.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/disputes/[id]/approve">) {
  const { id } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    return Response.json(await approveDispute(id, body));
  } catch (e) {
    return errorResponse(e);
  }
}
