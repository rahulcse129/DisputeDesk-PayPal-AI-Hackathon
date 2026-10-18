import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as analyze } from "@/app/api/disputes/[id]/analyze/route";
import { POST as approve } from "@/app/api/disputes/[id]/approve/route";
import { POST as reject } from "@/app/api/disputes/[id]/reject/route";
import * as actions from "@/lib/actions";
import { createMemoryStore, getStore, setStoreForTests } from "@/lib/store";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const post = (body?: unknown) =>
  new NextRequest("http://localhost/api", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

async function analyzed(id: string) {
  const res = await analyze(post(), ctx(id));
  expect(res.status).toBe(200);
}

describe("POST /api/disputes/[id]/approve", () => {
  beforeEach(() => {
    setStoreForTests(createMemoryStore());
    vi.restoreAllMocks();
  });

  it("refuses to approve a dispute that has not been analyzed", async () => {
    const spy = vi.spyOn(actions, "executeResolution");
    const res = await approve(post({}), ctx("PP-D-1001"));
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it("executes the recommended action once and records the outcome", async () => {
    await analyzed("PP-D-1001");
    const res = await approve(post({}), ctx("PP-D-1001"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.ok).toBe(true);
    expect(body.outcome.action).toBe("contest");
    expect(body.outcome.calls.map((c: { operation: string }) => c.operation)).toContain("provideEvidence");
    const stored = getStore().get("PP-D-1001")!;
    expect(stored.status).toBe("approved");
    expect(stored.decision).toBe("approved");
    expect(stored.outcome?.ok).toBe(true);
  });

  it("cannot execute twice (idempotency guard)", async () => {
    await analyzed("PP-D-1002");
    const spy = vi.spyOn(actions, "executeResolution");
    const first = await approve(post({}), ctx("PP-D-1002"));
    const second = await approve(post({}), ctx("PP-D-1002"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("only one of two concurrent approvals executes", async () => {
    await analyzed("PP-D-1008");
    const spy = vi.spyOn(actions, "executeResolution");
    const [a, b] = await Promise.all([approve(post({}), ctx("PP-D-1008")), approve(post({}), ctx("PP-D-1008"))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses the merchant's edited draft and action override", async () => {
    await analyzed("PP-D-1004");
    const spy = vi.spyOn(actions, "executeResolution");
    const draft = "Hi Mei, sorry about the size mix-up. A full refund is on its way.";
    const res = await approve(post({ draft_message: draft, action: "accept" }), ctx("PP-D-1004"));
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][0]).toMatchObject({ action: "accept", message: draft });
    const stored = getStore().get("PP-D-1004")!;
    expect(stored.finalMessage).toBe(draft);
    expect(stored.status).toBe("resolved");
    expect(stored.decisionNote).toMatch(/accept instead of refund/);
  });

  it("validates the request body", async () => {
    await analyzed("PP-D-1003");
    const spy = vi.spyOn(actions, "executeResolution");
    for (const bad of [{ action: "wire_money" }, { draft_message: "" }, { draft_message: "x".repeat(2001) }, { extra: 1 }]) {
      const res = await approve(post(bad), ctx("PP-D-1003"));
      expect(res.status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows a retry after a failed execution, without marking the case approved", async () => {
    await analyzed("PP-D-1010");
    const spy = vi.spyOn(actions, "executeResolution").mockResolvedValueOnce({
      action: "refund",
      ok: false,
      mode: "sandbox",
      calls: [{ operation: "refundCapture", ok: false, detail: "PayPal 422" }],
      error: "PayPal 422",
      executedAt: new Date().toISOString(),
    });
    const failed = await approve(post({}), ctx("PP-D-1010"));
    expect(failed.status).toBe(502);
    expect(getStore().get("PP-D-1010")!.status).toBe("analyzed");
    const retry = await approve(post({}), ctx("PP-D-1010"));
    expect(retry.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns 404 for an unknown dispute", async () => {
    const res = await analyze(post(), ctx("PP-D-9999"));
    expect(res.status).toBe(404);
  });

  it("blocks approval after the merchant rejects the recommendation", async () => {
    await analyzed("PP-D-1005");
    expect((await reject(post({ note: "Will call the buyer" }), ctx("PP-D-1005"))).status).toBe(200);
    expect((await approve(post({}), ctx("PP-D-1005"))).status).toBe(409);
    expect(getStore().get("PP-D-1005")!.status).toBe("rejected");
  });

  it("does not let an actioned dispute be re-analyzed", async () => {
    await analyzed("PP-D-1006");
    await approve(post({}), ctx("PP-D-1006"));
    expect((await analyze(post(), ctx("PP-D-1006"))).status).toBe(409);
  });
});
