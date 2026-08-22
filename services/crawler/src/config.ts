export const config = {
  port: Number(process.env.CRAWLER_PORT ?? 4200),
  defaultIntervalSec: Number(process.env.DEFAULT_CRAWL_INTERVAL_SEC ?? 180),
  // Polite crawler identity — Reddit requires a descriptive User-Agent.
  userAgent:
    process.env.CRAWLER_USER_AGENT ??
    "sportybet-ai-crawler/0.1 (+compliant research; contact admin@sportybet-ai.local)",
  // Per-source fetch timeout.
  fetchTimeoutMs: Number(process.env.CRAWLER_FETCH_TIMEOUT_MS ?? 15000),
  // TheSportsDB API key for real past-results/form lookups. "3" is the public
  // free test key (rate-limited); set SPORTSDB_KEY for a paid key if needed.
  sportsDbKey: process.env.SPORTSDB_KEY ?? "3",
  // Cache for expensive per-request computations (dashboard's recommended
  // picks, expert picks). Empty ⇒ caching module falls back to computing
  // fresh every time — slower, but the app still works without Redis.
  redisUrl: process.env.REDIS_URL ?? "",
  // --- App access gate ---
  // When set, the WHOLE dashboard requires this password to load — external
  // viewers can't see any page (or its source) without it. Empty ⇒ open (local
  // dev). Set APP_PASSWORD in .env before exposing the app anywhere.
  appPassword: process.env.APP_PASSWORD ?? "",
  // Admin unlock: only admins see source-revealing info (which Telegram channel
  // a code came from, crawl activity). Regular signed-in users don't. Visit
  // /admin?key=<ADMIN_KEY> to become admin on this browser.
  adminKey: process.env.ADMIN_KEY ?? "",
  // --- Monetization ---
  premiumKey: process.env.PREMIUM_ACCESS_KEY ?? "vip2026", // demo/testing unlock only
  freeDelayMin: Number(process.env.FREE_CODE_DELAY_MIN ?? 20), // free tier sees codes this many min late
  // Default tier when no premium cookie is present. Set to "premium" locally so
  // the owner isn't paywalled while developing; leave unset (→ free) in prod.
  defaultTier: process.env.DEFAULT_TIER === "premium" ? "premium" : "free",
  // --- User accounts ---
  // Secret for signing session cookies. Set a long random SESSION_SECRET in
  // prod; when empty, one is derived from APP_PASSWORD+ADMIN_KEY (or random per
  // boot when those are empty too — sessions then reset on restart).
  sessionSecret: process.env.SESSION_SECRET ?? "",
  // Public self-registration. On by default (needed to sell subscriptions);
  // set ALLOW_SIGNUP=0 to run invite/owner-only.
  allowSignup: process.env.ALLOW_SIGNUP !== "0",
  // Absolute origin used for payment callback URLs when behind a proxy/domain,
  // e.g. https://app.example.com — empty ⇒ derived from the request Host.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  // --- Paystack (NGN billing) ---
  // Empty secret key ⇒ checkout disabled; the /upgrade page explains and the
  // demo unlock stays available for previewing Premium.
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? "",
    // One-off pass prices in naira (not kobo). Short cycles sell best in NG.
    planNgn: {
      daily: Number(process.env.PLAN_DAILY_NGN ?? 500),
      weekly: Number(process.env.PLAN_WEEKLY_NGN ?? 1500),
      monthly: Number(process.env.PLAN_MONTHLY_NGN ?? 5000),
    },
  },
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
  // --- API-Football Intelligence Features (momentum, standings, H2H, injuries) ---
  // Separate budget from predictions so intel lookups never starve the existing flow.
  // On the Pro plan (7,500/day) this is very conservative; raise it freely.
  intelBudget: Number(process.env.APIFOOTBALL_INTEL_BUDGET ?? 500),
  // --- Email delivery (transactional, via Resend HTTP API) ---
  // Empty apiKey ⇒ mailer is a no-op, so the app runs fine without it (users
  // still get the in-app notification). Set RESEND_API_KEY + EMAIL_FROM to make
  // Auto-Pilot email each user their booking code. Resend's free tier is 3k/mo;
  // EMAIL_FROM must be an address on a domain you've verified in Resend (or use
  // their onboarding sender "onboarding@resend.dev" for testing).
  email: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "Sporty Value Pick AI <onboarding@resend.dev>",
  },
  // --- Bytez AI (LLM Reasoning & Match Commentary) ---
  // Connects open-source models (Llama 3.3 70B, DeepSeek-R1, Qwen 2.5) via Bytez.
  // When blank or offline, gracefully falls back to deterministic Poisson stats.
  bytez: {
    apiKey: process.env.BYTEZ_API_KEY ?? "",
    model: process.env.BYTEZ_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct",
    fallbackModel: process.env.BYTEZ_FALLBACK_MODEL ?? "Qwen/Qwen2.5-72B-Instruct",
    timeoutMs: Number(process.env.BYTEZ_TIMEOUT_MS ?? 12000),
  },
};

