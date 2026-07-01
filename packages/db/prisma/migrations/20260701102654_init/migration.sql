-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('LOCAL', 'GOOGLE', 'APPLE');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'BASIC', 'PRO', 'VIP');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYSTACK', 'FLUTTERWAVE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('RSS', 'GOOGLE_NEWS', 'BING_NEWS', 'REDDIT', 'YOUTUBE', 'TELEGRAM', 'WEBSITE', 'API');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'BLACKLISTED');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "CodeType" AS ENUM ('DAILY', 'WEEKEND', 'WEEKLY', 'MONTHLY', 'VIP', 'SAFE', 'HIGH_ODDS', 'CORRECT_SCORE', 'OVER_UNDER', 'BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'COMBO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CodeStatus" AS ENUM ('UNVERIFIED', 'ACTIVE', 'EXPIRED', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELED');

-- CreateEnum
CREATE TYPE "Side" AS ENUM ('HOME', 'AWAY');

-- CreateEnum
CREATE TYPE "BetOutcome" AS ENUM ('PENDING', 'WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST');

-- CreateEnum
CREATE TYPE "SlipSource" AS ENUM ('HUMAN', 'AI');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_HUMAN_CODE', 'NEW_AI_SLIP', 'HIGH_CONFIDENCE', 'ODDS_CHANGE', 'MATCH_STARTING', 'CODE_EXPIRED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('DASHBOARD_TOP', 'SIDEBAR', 'BETWEEN_CARDS', 'FOOTER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "provider" "AuthProvider" NOT NULL DEFAULT 'LOCAL',
    "providerId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider" "PaymentProvider",
    "providerCustomerId" TEXT,
    "providerSubId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "plan" "SubscriptionPlan",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "trustScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "crawlIntervalSec" INTEGER NOT NULL DEFAULT 180,
    "lastCrawledAt" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_runs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "itemsNew" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "crawl_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeType" "CodeType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "CodeStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceId" TEXT,
    "originalUrl" TEXT,
    "author" TEXT,
    "title" TEXT,
    "rawContent" TEXT,
    "league" TEXT,
    "country" TEXT,
    "numberOfGames" INTEGER,
    "totalOdds" DOUBLE PRECISION,
    "datePublished" TIMESTAMP(3),
    "matchDate" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "human_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_scores" (
    "id" TEXT NOT NULL,
    "humanCodeId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "confidencePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "oddsStability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceReliability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "historicalPerformance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedProfitability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_verifications" (
    "id" TEXT NOT NULL,
    "humanCodeId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leagues" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "tier" INTEGER,
    "season" TEXT,
    "logoUrl" TEXT,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "country" TEXT,
    "leagueId" TEXT,
    "logoUrl" TEXT,
    "eloRating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "marketValue" DOUBLE PRECISION,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "leagueId" TEXT,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "venue" TEXT,
    "referee" TEXT,
    "weather" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_stats" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "side" "Side" NOT NULL,
    "xg" DOUBLE PRECISION,
    "xa" DOUBLE PRECISION,
    "shots" INTEGER,
    "shotsOnTarget" INTEGER,
    "possession" DOUBLE PRECISION,
    "bigChances" INTEGER,
    "corners" INTEGER,
    "fouls" INTEGER,
    "yellowCards" INTEGER,
    "redCards" INTEGER,

    CONSTRAINT "match_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL DEFAULT 'sportybet',
    "market" TEXT NOT NULL,
    "homeOdds" DOUBLE PRECISION,
    "drawOdds" DOUBLE PRECISION,
    "awayOdds" DOUBLE PRECISION,
    "extra" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "predictions" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'poisson-v1',
    "market" TEXT NOT NULL DEFAULT '1X2',
    "winProb" DOUBLE PRECISION NOT NULL,
    "drawProb" DOUBLE PRECISION NOT NULL,
    "awayProb" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "recommendedMarket" TEXT NOT NULL,
    "reasoning" TEXT,
    "summary" TEXT,
    "altMarkets" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_bet_slips" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "codeType" "CodeType" NOT NULL DEFAULT 'COMBO',
    "status" "CodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "totalOdds" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kellyStakePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bookingCode" TEXT,
    "bookingCodeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_bet_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_selections" (
    "id" TEXT NOT NULL,
    "betSlipId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "predictionId" TEXT,
    "market" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "odds" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bet_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "humanCodeId" TEXT,
    "betSlipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_results" (
    "id" TEXT NOT NULL,
    "humanCodeId" TEXT,
    "betSlipId" TEXT,
    "slipSource" "SlipSource" NOT NULL,
    "outcome" "BetOutcome" NOT NULL DEFAULT 'PENDING',
    "stake" DOUBLE PRECISION,
    "profit" DOUBLE PRECISION,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "targetUrl" TEXT NOT NULL,
    "placement" "AdPlacement" NOT NULL DEFAULT 'DASHBOARD_TOP',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertisements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_provider_providerId_idx" ON "users"("provider", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerRef_key" ON "payments"("providerRef");

-- CreateIndex
CREATE INDEX "payments_userId_idx" ON "payments"("userId");

-- CreateIndex
CREATE INDEX "sources_status_enabled_idx" ON "sources"("status", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "sources_type_url_key" ON "sources"("type", "url");

-- CreateIndex
CREATE INDEX "crawl_runs_sourceId_startedAt_idx" ON "crawl_runs"("sourceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "human_codes_contentHash_key" ON "human_codes"("contentHash");

-- CreateIndex
CREATE INDEX "human_codes_code_idx" ON "human_codes"("code");

-- CreateIndex
CREATE INDEX "human_codes_status_foundAt_idx" ON "human_codes"("status", "foundAt");

-- CreateIndex
CREATE INDEX "human_codes_codeType_idx" ON "human_codes"("codeType");

-- CreateIndex
CREATE UNIQUE INDEX "code_scores_humanCodeId_key" ON "code_scores"("humanCodeId");

-- CreateIndex
CREATE INDEX "code_verifications_humanCodeId_checkType_idx" ON "code_verifications"("humanCodeId", "checkType");

-- CreateIndex
CREATE UNIQUE INDEX "leagues_externalId_key" ON "leagues"("externalId");

-- CreateIndex
CREATE INDEX "leagues_country_idx" ON "leagues"("country");

-- CreateIndex
CREATE UNIQUE INDEX "teams_externalId_key" ON "teams"("externalId");

-- CreateIndex
CREATE INDEX "teams_name_idx" ON "teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "matches_externalId_key" ON "matches"("externalId");

-- CreateIndex
CREATE INDEX "matches_kickoff_status_idx" ON "matches"("kickoff", "status");

-- CreateIndex
CREATE INDEX "matches_leagueId_idx" ON "matches"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "match_stats_matchId_teamId_key" ON "match_stats"("matchId", "teamId");

-- CreateIndex
CREATE INDEX "odds_snapshots_matchId_market_capturedAt_idx" ON "odds_snapshots"("matchId", "market", "capturedAt");

-- CreateIndex
CREATE INDEX "predictions_matchId_model_createdAt_idx" ON "predictions"("matchId", "model", "createdAt");

-- CreateIndex
CREATE INDEX "ai_bet_slips_status_createdAt_idx" ON "ai_bet_slips"("status", "createdAt");

-- CreateIndex
CREATE INDEX "bet_selections_betSlipId_idx" ON "bet_selections"("betSlipId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_humanCodeId_key" ON "favorites"("userId", "humanCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_userId_betSlipId_key" ON "favorites"("userId", "betSlipId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_createdAt_idx" ON "notifications"("userId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "historical_results_slipSource_outcome_idx" ON "historical_results"("slipSource", "outcome");

-- CreateIndex
CREATE INDEX "advertisements_active_placement_idx" ON "advertisements"("active", "placement");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_codes" ADD CONSTRAINT "human_codes_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_scores" ADD CONSTRAINT "code_scores_humanCodeId_fkey" FOREIGN KEY ("humanCodeId") REFERENCES "human_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_verifications" ADD CONSTRAINT "code_verifications_humanCodeId_fkey" FOREIGN KEY ("humanCodeId") REFERENCES "human_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_stats" ADD CONSTRAINT "match_stats_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_stats" ADD CONSTRAINT "match_stats_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_betSlipId_fkey" FOREIGN KEY ("betSlipId") REFERENCES "ai_bet_slips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_selections" ADD CONSTRAINT "bet_selections_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_humanCodeId_fkey" FOREIGN KEY ("humanCodeId") REFERENCES "human_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_betSlipId_fkey" FOREIGN KEY ("betSlipId") REFERENCES "ai_bet_slips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_results" ADD CONSTRAINT "historical_results_humanCodeId_fkey" FOREIGN KEY ("humanCodeId") REFERENCES "human_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_results" ADD CONSTRAINT "historical_results_betSlipId_fkey" FOREIGN KEY ("betSlipId") REFERENCES "ai_bet_slips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
