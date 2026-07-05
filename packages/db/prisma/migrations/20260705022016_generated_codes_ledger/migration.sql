-- CreateTable
CREATE TABLE "generated_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "url" TEXT,
    "generatorName" TEXT NOT NULL DEFAULT 'Anonymous',
    "origin" TEXT NOT NULL DEFAULT 'expert',
    "games" INTEGER NOT NULL DEFAULT 0,
    "totalOdds" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "legs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generated_codes_generatorName_createdAt_idx" ON "generated_codes"("generatorName", "createdAt");

-- CreateIndex
CREATE INDEX "generated_codes_createdAt_idx" ON "generated_codes"("createdAt");
