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
  // --- API-Football (api-sports.io) premium data feed ---
  // Empty key ⇒ adapter is a no-op, so the app runs fine without paying. Add a
  // key from your api-sports.io (or RapidAPI) dashboard to switch it on.
  apiFootball: {
    key: process.env.APIFOOTBALL_KEY ?? "",
    // "apisports" (direct, header x-apisports-key) or "rapidapi" (header x-rapidapi-key).
    provider: process.env.APIFOOTBALL_PROVIDER === "rapidapi" ? "rapidapi" : "apisports",
    // Stay under the free-tier daily cap (100/day). Leave headroom for retries.
    dailyBudget: Number(process.env.APIFOOTBALL_DAILY_BUDGET ?? 80),
    // How many prediction lookups to spend per refresh (each is 1 request).
    predsPerCycle: Number(process.env.APIFOOTBALL_PREDS_PER_CYCLE ?? 6),
  },
};
