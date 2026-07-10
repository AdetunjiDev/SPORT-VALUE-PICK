export const config = {
  port: Number(process.env.CRAWLER_PORT ?? 4200),
  defaultIntervalSec: Number(process.env.DEFAULT_CRAWL_INTERVAL_SEC ?? 180),
  // Polite crawler identity — Reddit requires a descriptive User-Agent.
  userAgent:
    process.env.CRAWLER_USER_AGENT ??
    "sportybet-ai-crawler/0.1 (+compliant research; contact admin@sportybet-ai.local)",
  // Per-source fetch timeout.
  fetchTimeoutMs: Number(process.env.CRAWLER_FETCH_TIMEOUT_MS ?? 15000),
  // --- App access gate ---
  // When set, the WHOLE dashboard requires this password to load — external
  // viewers can't see any page (or its source) without it. Empty ⇒ open (local
  // dev). Set APP_PASSWORD in .env before exposing the app anywhere.
  appPassword: process.env.APP_PASSWORD ?? "",
  // Admin unlock: only admins see source-revealing info (which Telegram channel
  // a code came from, crawl activity). Regular signed-in users don't. Visit
  // /admin?key=<ADMIN_KEY> to become admin on this browser.
  adminKey: process.env.ADMIN_KEY ?? "",
  // --- Monetization (demo gate; real billing = Stripe/Paystack later) ---
  premiumKey: process.env.PREMIUM_ACCESS_KEY ?? "vip2026",
  freeDelayMin: Number(process.env.FREE_CODE_DELAY_MIN ?? 20), // free tier sees codes this many min late
  // Default tier when no premium cookie is present. Set to "premium" locally so
  // the owner isn't paywalled while developing; leave unset (→ free) in prod.
  defaultTier: process.env.DEFAULT_TIER === "premium" ? "premium" : "free",
  // --- Telegram official API (MTProto via GramJS) ---
  // When apiId/apiHash/session are all set, TELEGRAM sources read messages
  // through Telegram's official API (real-time, hidden channels, media for OCR)
  // instead of the public web-preview scrape. Empty ⇒ web-preview fallback.
  telegram: {
    apiId: Number(process.env.TELEGRAM_API_ID ?? 0),
    apiHash: process.env.TELEGRAM_API_HASH ?? "",
    session: process.env.TELEGRAM_SESSION ?? "",
    // Recent messages to pull per channel per cycle.
    messageLimit: Number(process.env.TELEGRAM_MSG_LIMIT ?? 25),
    // Max images to download + OCR per channel per cycle (bounded cost).
    ocrPerChannel: Number(process.env.TELEGRAM_OCR_PER_CHANNEL ?? 4),
  },
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
