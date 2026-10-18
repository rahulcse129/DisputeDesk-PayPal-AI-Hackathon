// Typed PayPal REST client (sandbox by default). Server-side only.
//
// Endpoints verified against the Disputes v1 OpenAPI schema
// (developer.paypal.com/api/customer-disputes/v1/schema.json), Orders v2 and Payments v2:
//   GET  /v1/customer/disputes                      list disputes
//   GET  /v1/customer/disputes/{id}                 dispute details
//   POST /v1/customer/disputes/{id}/provide-evidence  multipart/form-data, JSON part "input"
//   POST /v1/customer/disputes/{id}/accept-claim    accept liability (PayPal refunds the buyer)
//   POST /v1/customer/disputes/{id}/send-message    only while dispute_life_cycle_stage is INQUIRY
//   GET  /v2/checkout/orders/{id}
//   GET  /v2/payments/captures/{id}
//   POST /v2/payments/captures/{id}/refund          PayPal-Request-Id makes retries idempotent
//   GET  /v1/shipping/trackers?transaction_id=...   best effort, not every account has tracking

import { config } from "./config";
import type {
  Dispute,
  DisputeMessage,
  DisputeReason,
  DisputeStatus,
  LifecycleStage,
  Money,
  OrderDetails,
  TrackingInfo,
  TrackingStatus,
} from "./types";

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

// ---------------------------------------------------------------------------
// Raw PayPal shapes (only the fields this app reads)

interface PPMoney {
  currency_code: string;
  value: string;
}

export interface PPDispute {
  dispute_id: string;
  create_time: string;
  update_time: string;
  reason: DisputeReason;
  status: DisputeStatus;
  dispute_amount: PPMoney;
  dispute_life_cycle_stage?: LifecycleStage;
  seller_response_due_date?: string;
  disputed_transactions?: {
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    create_time?: string;
    invoice_number?: string;
    custom?: string;
    buyer?: { name?: string; email?: string; payer_id?: string };
    seller?: { email?: string; merchant_id?: string };
  }[];
  messages?: { posted_by: "BUYER" | "SELLER" | "ARBITER"; time_posted: string; content: string }[];
  extensions?: Record<string, unknown>;
  links?: { href: string; rel: string; method: string }[];
}

interface PPDisputeList {
  items?: PPDispute[];
  links?: { href: string; rel: string }[];
}

export interface PPCapture {
  id: string;
  status: string;
  amount: PPMoney;
  create_time?: string;
  invoice_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface PPOrder {
  id: string;
  status: string;
  create_time?: string;
  payer?: { email_address?: string; name?: { given_name?: string; surname?: string }; address?: { country_code?: string } };
  purchase_units?: {
    amount?: PPMoney;
    items?: { name: string; sku?: string; quantity: string; unit_amount: PPMoney; description?: string; category?: string }[];
    shipping?: {
      name?: { full_name?: string };
      address?: { address_line_1?: string; admin_area_2?: string; admin_area_1?: string; postal_code?: string; country_code?: string };
    };
    payments?: { captures?: PPCapture[] };
  }[];
}

export interface PPRefund {
  id: string;
  status: string;
  amount?: PPMoney;
}

export interface PPTracker {
  transaction_id: string;
  tracking_number?: string;
  status?: string;
  carrier?: string;
  carrier_name_other?: string;
  last_updated_time?: string;
}

export type EvidenceInput = {
  evidence_type: string;
  evidence_info?: {
    tracking_info?: { carrier_name: string; carrier_name_other?: string; tracking_number: string }[];
    refund_ids?: { refund_id: string }[];
  };
  notes?: string;
};

// ---------------------------------------------------------------------------
// Client

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

let cachedToken: { value: string; expiresAt: number } | null = null;
let inflightToken: Promise<string> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchToken(): Promise<string> {
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) {
    throw new PayPalError("PayPal credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).", 401);
  }
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new PayPalError(`PayPal OAuth failed (${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so a token never expires mid-request.
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  // Share one token request between concurrent callers.
  inflightToken ??= fetchToken().finally(() => {
    inflightToken = null;
  });
  return inflightToken;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  json?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined>;
  requestId?: string;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, config.paypal.baseUrl);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      cache: "no-store",
    });

    if (res.status === 401 && attempt === 0) {
      // Token revoked or expired early; fetch a fresh one once.
      cachedToken = null;
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    const body = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const b = body as { message?: string; name?: string; debug_id?: string; details?: unknown } | undefined;
      throw new PayPalError(
        `PayPal ${opts.method ?? "GET"} ${url.pathname} failed (${res.status}): ${b?.message ?? b?.name ?? text.slice(0, 200)}`,
        res.status,
        b?.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
        b?.details,
      );
    }
    return body as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Operations

export const paypal = {
  async listDisputes(params: { dispute_state?: string; page_size?: number } = {}): Promise<PPDispute[]> {
    const out: PPDispute[] = [];
    let nextPageToken: string | undefined;
    // The list endpoint returns summaries and paginates with next_page_token; cap at 5 pages.
    for (let page = 0; page < 5; page++) {
      const res = await request<PPDisputeList>("/v1/customer/disputes", {
        query: { page_size: params.page_size ?? 50, dispute_state: params.dispute_state, next_page_token: nextPageToken },
      });
      out.push(...(res.items ?? []));
      const next = res.links?.find((l) => l.rel === "next")?.href;
      nextPageToken = next ? (new URL(next).searchParams.get("next_page_token") ?? undefined) : undefined;
      if (!nextPageToken) break;
    }
    return out;
  },

  getDispute(id: string): Promise<PPDispute> {
    return request<PPDispute>(`/v1/customer/disputes/${encodeURIComponent(id)}`);
  },

  /** Disputes v1 takes evidence as multipart/form-data with the JSON payload in an "input" part. */
  provideEvidence(id: string, evidences: EvidenceInput[]): Promise<unknown> {
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ evidences })], { type: "application/json" }));
    return request(`/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { method: "POST", form });
  },

  acceptClaim(id: string, note: string, acceptClaimType: "REFUND" | "PARTIAL_REFUND" = "REFUND"): Promise<unknown> {
    return request(`/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, {
      method: "POST",
      json: { note: note.slice(0, 2000), accept_claim_type: acceptClaimType },
    });
  },

  sendMessageToBuyer(id: string, message: string): Promise<unknown> {
    return request(`/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, {
      method: "POST",
      json: { message: message.slice(0, 2000) },
    });
  },

  getOrder(orderId: string): Promise<PPOrder> {
    return request<PPOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  },

  getCapture(captureId: string): Promise<PPCapture> {
    return request<PPCapture>(`/v2/payments/captures/${encodeURIComponent(captureId)}`);
  },

  refundCapture(captureId: string, opts: { amount?: Money; note?: string; requestId: string }): Promise<PPRefund> {
    return request<PPRefund>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: "POST",
      requestId: opts.requestId,
      json: {
        ...(opts.amount ? { amount: { value: opts.amount.value, currency_code: opts.amount.currency } } : {}),
        ...(opts.note ? { note_to_payer: opts.note.slice(0, 255) } : {}),
      },
    });
  },

  async listTrackers(transactionId: string): Promise<PPTracker[]> {
    const res = await request<{ trackers?: PPTracker[] }>("/v1/shipping/trackers", {
      query: { transaction_id: transactionId },
    });
    return res.trackers ?? [];
  },
};

// ---------------------------------------------------------------------------
// Normalizers: PayPal shapes -> app domain types

export function toMoney(m: PPMoney | undefined): Money {
  return { value: m?.value ?? "0.00", currency: m?.currency_code ?? "USD" };
}

export function normalizeDispute(d: PPDispute): Dispute {
  const tx = d.disputed_transactions?.[0];
  const messages: DisputeMessage[] = (d.messages ?? []).map((m) => ({
    postedBy: m.posted_by,
    time: m.time_posted,
    content: m.content,
  }));
  return {
    id: d.dispute_id,
    reason: d.reason,
    status: d.status,
    stage: d.dispute_life_cycle_stage ?? "INQUIRY",
    amount: toMoney(d.dispute_amount),
    createTime: d.create_time,
    updateTime: d.update_time,
    sellerResponseDue: d.seller_response_due_date,
    buyer: { name: tx?.buyer?.name ?? "PayPal buyer", email: tx?.buyer?.email, payerId: tx?.buyer?.payer_id },
    transaction: { captureId: tx?.seller_transaction_id, invoiceId: tx?.invoice_number, createTime: tx?.create_time },
    buyerClaim: messages.find((m) => m.postedBy === "BUYER")?.content ?? describeReason(d.reason),
    messages,
  };
}

export function normalizeOrder(order: PPOrder | undefined, capture: PPCapture | undefined, fallbackAmount: Money): Omit<OrderDetails, "buyerHistory"> {
  const unit = order?.purchase_units?.[0];
  const addr = unit?.shipping?.address;
  const items = (unit?.items ?? []).map((i) => ({
    name: i.name,
    sku: i.sku,
    quantity: Number(i.quantity) || 1,
    unitPrice: toMoney(i.unit_amount),
    description: i.description,
  }));
  const categories = new Set((unit?.items ?? []).map((i) => i.category));
  return {
    orderId: order?.id ?? capture?.supplementary_data?.related_ids?.order_id,
    captureId: capture?.id,
    status: capture?.status ?? order?.status,
    createTime: capture?.create_time ?? order?.create_time,
    total: unit?.amount ? toMoney(unit.amount) : capture ? toMoney(capture.amount) : fallbackAmount,
    items,
    shippingName: unit?.shipping?.name?.full_name,
    shippingAddress: addr
      ? [addr.address_line_1, addr.admin_area_2, addr.admin_area_1, addr.postal_code, addr.country_code].filter(Boolean).join(", ")
      : undefined,
    payerEmail: order?.payer?.email_address,
    billingCountry: order?.payer?.address?.country_code,
    fulfillment: categories.has("DIGITAL_GOODS") ? "digital" : addr ? "physical" : "unknown",
  };
}

export function normalizeTracker(t: PPTracker | undefined): TrackingInfo {
  if (!t?.tracking_number) return { status: "NO_TRACKING", events: [] };
  const map: Record<string, TrackingStatus> = { SHIPPED: "SHIPPED", DELIVERED: "DELIVERED", ON_HOLD: "EXCEPTION", CANCELLED: "EXCEPTION" };
  return {
    status: map[t.status ?? ""] ?? "SHIPPED",
    carrier: t.carrier === "OTHER" ? t.carrier_name_other : t.carrier,
    trackingNumber: t.tracking_number,
    events: t.last_updated_time ? [{ time: t.last_updated_time, description: `Tracker status: ${t.status}` }] : [],
  };
}

export function describeReason(reason: DisputeReason): string {
  const labels: Record<DisputeReason, string> = {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Buyer says the item was not received.",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Buyer says the item is not as described.",
    UNAUTHORISED: "Buyer says they did not authorize this payment.",
    CREDIT_NOT_PROCESSED: "Buyer says a promised refund or credit was not processed.",
    DUPLICATE_TRANSACTION: "Buyer says they were charged more than once.",
    INCORRECT_AMOUNT: "Buyer says they were charged the wrong amount.",
    PAYMENT_BY_OTHER_MEANS: "Buyer says they paid by another method.",
    CANCELED_RECURRING_BILLING: "Buyer says a cancelled subscription was charged.",
    PROBLEM_WITH_REMITTANCE: "Buyer reports a problem with remittance.",
    OTHER: "Buyer opened a dispute for another reason.",
  };
  return labels[reason];
}
