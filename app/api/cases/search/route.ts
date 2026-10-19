import { connection, type NextRequest } from "next/server";
import { CATEGORIES } from "@/lib/agent-schema";
import { errorResponse } from "@/lib/service";
import { getStore } from "@/lib/store";
import type { Category } from "@/lib/types";

// GET /api/cases/search?q=&category=: full-text search over past and current cases.
export async function GET(req: NextRequest) {
  await connection();
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const cat = req.nextUrl.searchParams.get("category");
    const category = (CATEGORIES as readonly string[]).includes(cat ?? "") ? (cat as Category) : undefined;
    const store = getStore();
    return Response.json({ cases: await store.search(q, { category, limit: 100 }), backend: store.searchBackend() });
  } catch (e) {
    return errorResponse(e);
  }
}
