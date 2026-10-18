// Domain types shared by the server and the UI. They are normalized from PayPal's
// API shapes so the mock and sandbox data sources look identical to the rest of the app.

export type DisputeReason =
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "CREDIT_NOT_PROCESSED"
  | "DUPLICATE_TRANSACTION"
  | "INCORRECT_AMOUNT"
  | "PAYMENT_BY_OTHER_MEANS"
  | "CANCELED_RECURRING_BILLING"
  | "PROBLEM_WITH_REMITTANCE"
  | "OTHER";

export type DisputeStatus =
  | "OPEN"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER";

export type LifecycleStage = "INQUIRY" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";

export interface Money {
  value: string;
  currency: string;
}

export interface DisputeMessage {
  postedBy: "BUYER" | "SELLER" | "ARBITER";
  time: string;
  content: string;
}

export interface Dispute {
  id: string;
  reason: DisputeReason;
  status: DisputeStatus;
  stage: LifecycleStage;
  amount: Money;
  createTime: string;
  updateTime: string;
  sellerResponseDue?: string;
  buyer: { name: string; email?: string; payerId?: string };
  transaction: { captureId?: string; orderId?: string; invoiceId?: string; createTime?: string };
  /** The buyer's own words, taken from the first buyer message. */
  buyerClaim: string;
  messages: DisputeMessage[];
}

export interface OrderItem {
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: Money;
  description?: string;
}

export interface BuyerHistory {
  previousOrders: number;
  previousDisputes: number;
  accountAgeDays?: number;
  notes?: string;
}

export interface OrderDetails {
  orderId?: string;
  captureId?: string;
  status?: string;
  createTime?: string;
  total: Money;
  items: OrderItem[];
  shippingAddress?: string;
  shippingName?: string;
  payerEmail?: string;
  /** Digital goods and services have no shipment to track. */
  fulfillment: "physical" | "digital" | "service" | "unknown";
  ipCountry?: string;
  billingCountry?: string;
  buyerHistory: BuyerHistory;
  /** Captures for the same buyer and amount, used for duplicate checks. */
  relatedCaptures?: { captureId: string; amount: Money; createTime: string }[];
}

export type TrackingStatus = "DELIVERED" | "IN_TRANSIT" | "EXCEPTION" | "SHIPPED" | "NO_TRACKING";

export interface TrackingEvent {
  time: string;
  location?: string;
  description: string;
}

export interface TrackingInfo {
  status: TrackingStatus;
  carrier?: string;
  trackingNumber?: string;
  deliveredAt?: string;
  signedBy?: string;
  deliveredTo?: string;
  events: TrackingEvent[];
}

export type Category = "item_not_received" | "not_as_described" | "unauthorized" | "duplicate" | "other";
export type Recommendation = "accept" | "refund" | "contest";
export type CaseStatus = "new" | "analyzed" | "approved" | "resolved" | "rejected";

export interface Resolution {
  category: Category;
  recommendation: Recommendation;
  confidence: number;
  reasoning: string;
  evidence_points: string[];
  draft_message: string;
}

export interface AgentStep {
  index: number;
  kind: "tool" | "note" | "error";
  tool?: string;
  input?: unknown;
  output?: unknown;
  summary: string;
  durationMs?: number;
  at: string;
}

export interface ActionOutcome {
  action: Recommendation;
  ok: boolean;
  mode: "mock" | "sandbox";
  calls: { operation: string; ok: boolean; detail: string }[];
  disputeStatusAfter?: DisputeStatus;
  error?: string;
  executedAt: string;
}

export interface CaseRecord {
  disputeId: string;
  status: CaseStatus;
  reason: DisputeReason;
  amount: Money;
  buyerName: string;
  buyerEmail?: string;
  buyerClaim: string;
  category?: Category;
  resolution?: Resolution;
  trace?: AgentStep[];
  agentMode?: "claude" | "offline";
  model?: string;
  finalMessage?: string;
  decision?: "approved" | "rejected";
  decisionNote?: string;
  outcome?: ActionOutcome;
  /** Final dispute result once PayPal closes it. */
  result?: "won" | "lost" | "refunded" | "closed" | "pending";
  createdAt: string;
  updatedAt: string;
}

export interface DisputeListItem {
  dispute: Dispute;
  caseStatus: CaseStatus;
  category?: Category;
  recommendation?: Recommendation;
  confidence?: number;
}
