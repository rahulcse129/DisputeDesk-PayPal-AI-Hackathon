import { connection } from "next/server";
import { listDisputes } from "@/lib/disputes";
import { appMeta, errorResponse } from "@/lib/service";

// GET /api/disputes: the dispute queue with each dispute's case status.
export async function GET() {
  await connection(); // always run at request time; never prerender queue data
  try {
    return Response.json({ disputes: await listDisputes(), meta: appMeta() });
  } catch (e) {
    return errorResponse(e);
  }
}
