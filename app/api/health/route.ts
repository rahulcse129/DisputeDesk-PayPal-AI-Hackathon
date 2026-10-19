import { connection } from "next/server";
import { appMeta } from "@/lib/service";
import { getStore } from "@/lib/store";

// GET /api/health: liveness check for Render. Doesn't call PayPal or the AI provider,
// so an upstream outage can't fail a deploy; it only confirms the app and database are up.
export async function GET() {
  await connection();
  try {
    const store = getStore();
    store.list();
    return Response.json({ ok: true, ...appMeta(), search: store.searchBackend() });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
