import type { NextRequest } from "next/server";
import { errorResponse, getDisputeDetail } from "@/lib/service";

// GET /api/disputes/:id: dispute, order, tracking and the stored case.
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/disputes/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await getDisputeDetail(id));
  } catch (e) {
    return errorResponse(e);
  }
}
