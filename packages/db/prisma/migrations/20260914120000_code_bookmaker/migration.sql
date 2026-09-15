-- Tag every booking code with the bookmaker that issued it.
--
-- A booking code is an opaque reference to a slip inside ONE bookmaker's
-- system; it is not portable between platforms. Without this column the
-- dashboard's bookmaker switcher has nothing to filter on.
--
-- Postgres backfills existing rows from the DEFAULT as part of ADD COLUMN,
-- so every row already in these tables becomes 'sportybet' -- which is
-- accurate, since SportyBet is the only adapter implemented today.

ALTER TABLE "human_codes"     ADD COLUMN "bookmaker" TEXT NOT NULL DEFAULT 'sportybet';
ALTER TABLE "generated_codes" ADD COLUMN "bookmaker" TEXT NOT NULL DEFAULT 'sportybet';

-- The dashboard's default query is "this bookmaker, newest first".
CREATE INDEX "human_codes_bookmaker_foundAt_idx"     ON "human_codes"("bookmaker", "foundAt");
CREATE INDEX "generated_codes_bookmaker_createdAt_idx" ON "generated_codes"("bookmaker", "createdAt");
