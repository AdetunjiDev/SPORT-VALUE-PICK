import { crawlAll } from "./crawler.js";
import { verifyPending } from "./verifier.js";
import { generateAiSlips } from "./ai.js";
import { getPredictions } from "./predictions.js";
import { logExpertPicks, settleExpertPicks } from "./analyst.js";
import { settleDemoBets, pruneOldDemoBets } from "./demo.js";
import { getSportyFixtures } from "./forebet-ai.js";
import { runDueAutopilots } from "./autopilot.js";
import { config } from "./config.js";
import { writeDashboardSnapshot } from "./snapshot.js";

let running = false;
let runningSince = 0; // when the in-flight cycle started (for the stuck-cycle watchdog)
let timer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;
let cycleCount = 0;

// A cycle normally takes ~60–120s. If `running` has been true far longer than
// that, the process was almost certainly frozen mid-cycle (host sleep/
// hibernate) and the flag is stuck — force-clear it so scanning can resume.
const STUCK_MS = 5 * 60 * 1000;
export let lastRunAt: Date | null = null;
export let nextRunAt: Date | null = null;
export let lastSummary = "";
export const intervalSec = config.defaultIntervalSec;

// Recompute AI slips every cycle (default). This is cheap — delta booking in
// generateAiSlips() reuses existing codes when a slip's selections are
// unchanged and only mints a new SportyBet code when the picks actually change
// (capped per cycle), so refreshing every 3 min doesn't hammer the booking API.
const AI_EVERY = Math.max(1, Number(process.env.AI_REGEN_EVERY_CYCLES ?? 1));

/** Run one full crawl cycle unless one is already in flight. */
export async function runCycle(trigger: string): Promise<string> {
  if (running) {
    // Watchdog: a normal cycle never runs this long — if it has, the previous
    // cycle is stuck (e.g. host slept mid-scan) so reset and proceed.
    if (Date.now() - runningSince < STUCK_MS) return "A crawl is already running.";
    console.warn(
      `Stuck cycle detected (${Math.round((Date.now() - runningSince) / 1000)}s) — resetting and resuming.`,
    );
  }
  running = true;
  runningSince = Date.now();
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
    // Refresh the manual-prediction feed every cycle (cached ~2.5 min; a failed
    // fetch keeps the last data). Never let it break the crawl cycle.
    let predCount = -1;
    try {
      predCount = (await getPredictions()).length;
    } catch {
      /* keep going */
    }
    // Expert Picks track record: log current recommendations + settle finished
    // ones against SportyBet's own final scores. Both are best-effort and must
    // never break the crawl cycle.
    let logged = 0;
    let settled = { settled: 0, won: 0 };
    try {
      logged = await logExpertPicks();
    } catch {
      /* keep going */
    }
    try {
      settled = await settleExpertPicks(12);
    } catch {
      /* keep going */
    }
    // Demo-bet simulator: settle finished virtual bets against real scores,
    // then prune games older than the 3-month retention window.
    try {
      await settleDemoBets(8);
      await pruneOldDemoBets();
    } catch {
      /* keep going */
    }
    // Auto-Pilot: for any user whose scheduled hour has arrived, build their
    // booking code and notify them. Never logs in or places the bet. Best-effort.
    try {
      const fired = await runDueAutopilots(20);
      if (fired.length) {
        const ok = fired.filter((f) => f.ok).length;
        console.log(`Auto-Pilot: ${ok}/${fired.length} slips built.`);
      }
    } catch {
      /* keep going */
    }
    // Keep SportyBet fixtures + odds warm so AI Analysis is always fresh in the
    // background (the feed self-caches ~10 min, so this refreshes on that clock)
    // — the analysis "auto-scans every 10 minutes" without anyone loading it.
    try {
      await getSportyFixtures();
    } catch {
      /* keep going */
    }
    cycleCount += 1;
    lastRunAt = new Date();
    const aiPart = aiSlips < 0 ? "AI kept" : `${aiSlips} AI slips`;
    lastSummary = `[${trigger}] ${results.length} sources · ${items} items · ${codes} new · ${verified} verified (${active} active) · ${aiPart} · ${predCount} predictions · ${logged} picks logged · ${settled.settled} settled · ${failed} failed · ${Date.now() - started}ms`;
    console.log(lastSummary);
    for (const r of results.filter((x) => x.error)) {
      console.warn(`  ! ${r.sourceName}: ${r.error}`);
    }
    // Refresh the serverless dashboard snapshot. Best-effort — never fail the cycle.
    try {
      await writeDashboardSnapshot({ lastRunAt, lastSummary });
      console.log("[snapshot] dashboard-human updated");
    } catch (err) {
      console.warn(
        "[snapshot] write failed:",
        err instanceof Error ? err.message : err,
      );
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

  // Catch-up watchdog: setInterval timers pause while the host is asleep, so
  // after a long sleep the main tick can be badly overdue. This lightweight
  // 60s check notices when we've missed the schedule (or a cycle got stuck)
  // and kicks a scan immediately on wake — no manual restart needed.
  watchdog = setInterval(() => {
    if (running) return; // a healthy cycle is in flight
    const overdue = !lastRunAt || Date.now() - lastRunAt.getTime() > intervalMs * 1.5;
    if (overdue) {
      console.warn("Watchdog: scan overdue (likely resumed from sleep) — running catch-up cycle.");
      nextRunAt = new Date(Date.now() + intervalMs);
      void runCycle("watchdog");
    }
  }, 60 * 1000);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  if (watchdog) clearInterval(watchdog);
}
