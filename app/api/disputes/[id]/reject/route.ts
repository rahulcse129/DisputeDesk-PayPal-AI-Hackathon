import type { NextRequest } from "next/server";
import { errorResponse, rejectDispute } from "@/lib/service";

// POST /api/disputes/:id/reject  body: { note?: string }
export async function POST(req: NextRequest, ctx: RouteContext<"/api/disputes/[id]/reject">) {
  const { id } = await ctx.params;
  try {
    const body = await req.json().catch(() => ({}));
    return Response.json({ case: rejectDispute(id, body) });
  } catch (e) {
    return errorResponse(e);
  }
}
