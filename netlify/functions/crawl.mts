// =====================================================================
// Netlify Scheduled Function: the crawl cycle.
//
// Replaces the setInterval in scheduler.ts, which cannot survive in a
// serverless runtime. Cron "*/3 * * * *" fires every 3 minutes, matching
// the 180s DEFAULT_CRAWL_INTERVAL_SEC the app has always used.
//
// Sizing, measured from 3,794 real runs in crawl_runs over 2 days:
//   avg 3.9s · p95 13.6s · max 206.9s
// The p95 already exceeds Netlify's 10s synchronous limit, which is why
// this must be a SCHEDULED function (background execution, 15 min ceiling)
// and not an HTTP-triggered one. The 207s worst case fits with room spare.
// =====================================================================
import type { Config } from "@netlify/functions";
import { runCycle } from "../../services/crawler/src/scheduler.js";

export default async () => {
  const startedAt = Date.now();
  try {
    await runCycle();
    console.log(`[crawl] cycle finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    // Never rethrow: a thrown error marks the scheduled invocation failed
    // and Netlify may back off. The next tick is only 3 minutes away, and
    // a transient upstream outage should not pause crawling.
    console.error(
      `[crawl] cycle FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`,
      err instanceof Error ? err.message : err,
    );
  }
};

export const config: Config = {
  schedule: "*/3 * * * *",
};
