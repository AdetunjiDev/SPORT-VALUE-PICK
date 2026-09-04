// =====================================================================
// Netlify Scheduled Function: the crawl cycle.
//
// Sets Prisma engine path, then runs one crawl. Never rethrows — a thrown
// error marks the scheduled invocation failed and Netlify may back off.
 // =====================================================================
import type { Config } from "@netlify/functions";
import { runCycle } from "../../services/crawler/src/scheduler.js";
import { preparePrismaEnv, missingDatabaseUrlMessage, formatErr } from "./prisma-env.mts";

export default async () => {
  const startedAt = Date.now();
  try {
    preparePrismaEnv();
    const dbMsg = missingDatabaseUrlMessage();
    if (dbMsg) {
      console.error("[crawl]", dbMsg);
      return;
    }
    await runCycle("scheduled");
    console.log(`[crawl] cycle finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(
      `[crawl] cycle FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`,
      formatErr(err),
    );
  }
};

export const config: Config = {
  schedule: "*/3 * * * *",
};
