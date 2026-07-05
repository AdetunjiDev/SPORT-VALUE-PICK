-- CreateTable
CREATE TABLE "expert_pick_logs" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "home" TEXT NOT NULL,
    "away" TEXT NOT NULL,
    "league" TEXT,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "market" TEXT NOT NULL,
    "pickCode" TEXT NOT NULL,
    "pickLabel" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "odds" DOUBLE PRECISION NOT NULL,
    "outcome" "BetOutcome" NOT NULL DEFAULT 'PENDING',
    "finalScore" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_pick_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expert_pick_logs_outcome_kickoff_idx" ON "expert_pick_logs"("outcome", "kickoff");

-- CreateIndex
CREATE UNIQUE INDEX "expert_pick_logs_eventId_pickCode_key" ON "expert_pick_logs"("eventId", "pickCode");
