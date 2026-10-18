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
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  },
  /** "anthropic" | "gemini" | "offline". Empty = pick the first provider with a key. */
  aiProvider: (process.env.AI_PROVIDER ?? "").toLowerCase(),
  databasePath: process.env.DATABASE_PATH || "./data/disputedesk.db",
};

export type AiMode = "claude" | "gemini" | "offline";

/**
 * Which agent runs. AI_PROVIDER forces a choice; otherwise Claude if ANTHROPIC_API_KEY is set,
 * then Gemini if GEMINI_API_KEY is set. Without any key the app uses a deterministic rules
 * engine so the demo still runs offline.
 */
export function aiMode(): AiMode {
  const p = config.aiProvider;
  if (p === "offline") return "offline";
  if ((p === "anthropic" || p === "claude") && config.anthropic.apiKey) return "claude";
  if ((p === "gemini" || p === "google") && config.gemini.apiKey) return "gemini";
  if (config.anthropic.apiKey) return "claude";
  if (config.gemini.apiKey) return "gemini";
  return "offline";
}

export function aiModel(mode: AiMode = aiMode()): string | undefined {
  return mode === "claude" ? config.anthropic.model : mode === "gemini" ? config.gemini.model : undefined;
}
