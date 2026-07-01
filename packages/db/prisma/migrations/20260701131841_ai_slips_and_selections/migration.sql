-- AlterTable
ALTER TABLE "ai_bet_slips" ADD COLUMN     "legs" JSONB,
ADD COLUMN     "reasoning" TEXT;

-- AlterTable
ALTER TABLE "human_codes" ADD COLUMN     "betType" TEXT,
ADD COLUMN     "selections" JSONB;
