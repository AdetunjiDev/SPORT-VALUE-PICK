import { crawlAll } from "./crawler.js";
import { verifyPending } from "./verifier.js";
import { generateAiSlips } from "./ai.js";
import { config } from "./config.js";

let running = false;
let timer: NodeJS.Timeout | null = null;
let cycleCount = 0;
export let lastRunAt: Date | null = null;
export let nextRunAt: Date | null = null;
export let lastSummary = "";
export const intervalSec = config.defaultIntervalSec;

// Regenerate AI slips (which create booking codes on SportyBet) only every N
// cycles — this keeps human-code scanning at 3 min while easing our call volume
// on SportyBet's booking API to avoid rate-limits.
const AI_EVERY = Math.max(1, Number(process.env.AI_REGEN_EVERY_CYCLES ?? 5));

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
    // Verify + enrich codes against SportyBet's official API (gentler cap).
    const { verified, active } = await verifyPending(15);
    // Regenerate AI bet slips + booking codes only every AI_EVERY cycles, or
    // immediately on a manual scan / when there are none yet.
    const regenAi = trigger === "manual" || cycleCount % AI_EVERY === 0;
    const aiSlips = regenAi ? await generateAiSlips() : -1;
    cycleCount += 1;
    lastRunAt = new Date();
    const aiPart = aiSlips < 0 ? "AI kept" : `${aiSlips} AI slips`;
    lastSummary = `[${trigger}] ${results.length} sources · ${items} items · ${codes} new · ${verified} verified (${active} active) · ${aiPart} · ${failed} failed · ${Date.now() - started}ms`;
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
