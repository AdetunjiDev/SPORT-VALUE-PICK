// =====================================================
// @sportybet/shared — cross-cutting constants & types.
// Enum string values MUST match the Prisma schema.
// =====================================================

export const SEARCH_KEYWORDS = [
  "SportyBet Booking Code Today",
  "Free Booking Code",
  "Weekend Booking Code",
  "Daily Booking Code",
  "VIP Booking Code",
  "Winning Booking Code",
  "Accumulator Code",
  "Football Booking Code",
] as const;

export const CODE_TYPES = [
  "DAILY",
  "WEEKEND",
  "WEEKLY",
  "MONTHLY",
  "VIP",
  "SAFE",
  "HIGH_ODDS",
  "CORRECT_SCORE",
  "OVER_UNDER",
  "BTTS",
  "DOUBLE_CHANCE",
  "DRAW_NO_BET",
  "COMBO",
  "UNKNOWN",
] as const;
export type CodeType = (typeof CODE_TYPES)[number];

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Keyword → CodeType hints used when classifying discovered codes. */
export const CODE_TYPE_HINTS: Record<string, CodeType> = {
  weekend: "WEEKEND",
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  vip: "VIP",
  safe: "SAFE",
  "high odd": "HIGH_ODDS",
  "correct score": "CORRECT_SCORE",
  "over/under": "OVER_UNDER",
  "over 2.5": "OVER_UNDER",
  btts: "BTTS",
  "both teams to score": "BTTS",
  "double chance": "DOUBLE_CHANCE",
  "draw no bet": "DRAW_NO_BET",
  accumulator: "COMBO",
  acca: "COMBO",
};

/**
 * IMPORTANT COMPLIANCE NOTE:
 * AI slips are model ESTIMATES, never guarantees, and the platform
 * must never fabricate or claim an official SportyBet booking code.
 */
export const RESPONSIBLE_GAMBLING_DISCLAIMER =
  "Predictions and scores are statistical estimates, not guarantees. " +
  "18+ only. Bet responsibly. Never stake more than you can afford to lose.";

// ---- Shared DTOs (transport shape between services) ----

export interface DiscoveredCode {
  code: string;
  codeType: CodeType;
  title?: string;
  author?: string;
  originalUrl?: string;
  league?: string;
  country?: string;
  numberOfGames?: number;
  totalOdds?: number;
  rawContent?: string;
  datePublished?: string; // ISO
  sourceId?: string;
  contentHash: string;
}

export interface PredictionResult {
  matchId: string;
  model: string;
  winProb: number;
  drawProb: number;
  awayProb: number;
  confidence: number;
  riskScore: number;
  expectedValue: number;
  recommendedMarket: string;
  reasoning?: string;
  summary?: string;
  altMarkets?: { market: string; selection: string; prob: number; ev: number }[];
}

export interface ApiResult<T> {
  data: T;
  meta?: { total?: number; page?: number; pageSize?: number };
}
