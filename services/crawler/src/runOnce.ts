import { crawlAll } from "./crawler.js";
import { prisma } from "@sportybet/db";

// One-shot crawl for CLI use / cron / debugging.
(async () => {
  console.log("Running a single crawl cycle across all active sources…\n");
  const results = await crawlAll();
  let items = 0;
  let codes = 0;
  for (const r of results) {
    const line = `${r.error ? "✗" : "✓"} ${r.sourceName.padEnd(42)} items:${String(r.itemsFound).padStart(3)}  codes:${String(r.codesFound).padStart(3)}  new:${String(r.codesNew).padStart(3)}${r.error ? `  ERROR: ${r.error}` : ""}`;
    console.log(line);
    items += r.itemsFound;
    codes += r.codesNew;
  }
  console.log(`\nTotal: ${items} items scanned · ${codes} new codes stored.`);
  await prisma.$disconnect();
})();
