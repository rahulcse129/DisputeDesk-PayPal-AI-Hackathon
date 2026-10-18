function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const hasPayPalCreds = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

export const config = {
  /** Mock mode is on when explicitly requested, or when no PayPal credentials are configured. */
  useMockPayPal: bool(process.env.USE_MOCK_PAYPAL) ?? !hasPayPalCreds,
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    baseUrl: process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    /** Server-side refusal fallback (beta). Disable with ANTHROPIC_SERVER_FALLBACK=false. */
    serverFallback: bool(process.env.ANTHROPIC_SERVER_FALLBACK) ?? true,
  },
  databasePath: process.env.DATABASE_PATH || "./data/disputedesk.db",
};

/** Without an API key the app uses a deterministic rules engine so the demo still runs offline. */
export function aiMode(): "claude" | "offline" {
  return config.anthropic.apiKey ? "claude" : "offline";
}
