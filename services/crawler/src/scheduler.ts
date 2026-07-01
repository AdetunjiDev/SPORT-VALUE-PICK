import { crawlAll } from "./crawler.js";
import { verifyPending } from "./verifier.js";
import { generateAiSlips } from "./ai.js";
import { config } from "./config.js";

let running = false;
let timer: NodeJS.Timeout | null = null;
export let lastRunAt: Date | null = null;
export let nextRunAt: Date | null = null;
export let lastSummary = "";
export const intervalSec = config.defaultIntervalSec;

/** Run one full crawl cycle unless one is already in flight. */
export async function runCycle(trigger: string): Promise<string> {
  if (running) return "A crawl is already running.";
  running = true;
  try {
    const started = Date.now();
    const results = await crawlAll();
    const items = results.reduce((a, r) => a + r.itemsFound, 0);
    const codes = results.reduce((a, r) => a + r.codesNew, 0);
    const failed = results.filter((r) => r.error).length;
    // Verify + enrich codes against SportyBet's official API.
    const { verified, active } = await verifyPending(30);
    // Regenerate AI bet slips from the freshly verified selection odds.
    const aiSlips = await generateAiSlips();
    lastRunAt = new Date();
    lastSummary = `[${trigger}] ${results.length} sources · ${items} items · ${codes} new · ${verified} verified (${active} active) · ${aiSlips} AI slips · ${failed} failed · ${Date.now() - started}ms`;
    console.log(lastSummary);
    for (const r of results.filter((x) => x.error)) {
      console.warn(`  ! ${r.sourceName}: ${r.error}`);
    }
    return lastSummary;
  } finally {
    running = false;
  }
}

export function startScheduler() {
  const intervalMs = config.defaultIntervalSec * 1000;
  console.log(`Scheduler: crawling every ${config.defaultIntervalSec}s.`);
  // Kick off immediately, then on the interval.
  void runCycle("startup");
  nextRunAt = new Date(Date.now() + intervalMs);
  timer = setInterval(() => {
    nextRunAt = new Date(Date.now() + intervalMs);
    void runCycle("scheduled");
  }, intervalMs);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
}
