// =====================================================================
 // Netlify Scheduled Function entry: bootstrap only (see app.mts).
 // =====================================================================
import type { Config } from "@netlify/functions";
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
    const { runCycle } = await import("../runtime/crawl-handler.mjs");
    await runCycle("scheduled");
    console.log(`[crawl] cycle finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    // Never rethrow: a thrown error marks the scheduled invocation failed
    // and Netlify may back off. The next tick is only 3 minutes away.
    console.error(
      `[crawl] cycle FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`,
      formatErr(err),
    );
  }
};

export const config: Config = {
  schedule: "*/3 * * * *",
};
