export const config = {
  port: Number(process.env.CRAWLER_PORT ?? 4100),
  defaultIntervalSec: Number(process.env.DEFAULT_CRAWL_INTERVAL_SEC ?? 180),
  // Polite crawler identity — Reddit requires a descriptive User-Agent.
  userAgent:
    process.env.CRAWLER_USER_AGENT ??
    "sportybet-ai-crawler/0.1 (+compliant research; contact admin@sportybet-ai.local)",
  // Per-source fetch timeout.
  fetchTimeoutMs: Number(process.env.CRAWLER_FETCH_TIMEOUT_MS ?? 15000),
  // --- Monetization (demo gate; real billing = Stripe/Paystack later) ---
  premiumKey: process.env.PREMIUM_ACCESS_KEY ?? "vip2026",
  freeDelayMin: Number(process.env.FREE_CODE_DELAY_MIN ?? 20), // free tier sees codes this many min late
  // Default tier when no premium cookie is present. Set to "premium" locally so
  // the owner isn't paywalled while developing; leave unset (→ free) in prod.
  defaultTier: process.env.DEFAULT_TIER === "premium" ? "premium" : "free",
};
