import { prisma } from "@sportybet/db";
import { getMatchAnalyses } from "./xg.js";
import { legsForFixtureKeys } from "./forebet-ai.js";
import { createBookingCode } from "./booker.js";

/**
 * Auto-Pilot — scheduled auto-generation of a SportyBet booking code.
 *
 * A user sets a rule (how many games, at what WAT hour, an optional target odds,
 * which pick engine). Once a day at that hour the app builds the slip, creates a
 * REAL SportyBet booking code, and drops a notification so the user can open it
 * and stake it themselves.
 *
 * It deliberately stops there. It NEVER logs into SportyBet and NEVER places the
 * bet — no user's betting password is stored or used, and no money moves without
 * the user's own final tap. createBookingCode() only mints a shareable code
 * (SportyBet's own /orders/share), exactly what "generate code" does everywhere
 * else in the app.
 */

/** Current calendar day + hour in Africa/Lagos (WAT, UTC+1, no DST). */
function watNow(): { date: string; hour: number } {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const hour = Number(
    now.toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Lagos" }).slice(0, 2),
  );
  return { date, hour: Number.isFinite(hour) ? hour % 24 : 0 };
}

export interface AutopilotOutcome {
  userId: string;
  ok: boolean;
  code?: string;
  games?: number;
  totalOdds?: number;
  reason?: string;
}

/**
 * Build one user's auto-slip: pick the safest games from their chosen engine,
 * honour the game-count and optional target-odds, and mint a booking code.
 * Pure enough to unit-test — it does no DB writes itself.
 */
export interface AutoSlipResult {
  code?: string;
  url?: string;
  games?: number;
  totalOdds?: number;
  reason?: string;
}

export async function buildAutoSlip(opts: {
  games: number;
  targetOdds: number;
  engine: string;
}): Promise<AutoSlipResult> {
  const want = Math.max(1, Math.min(40, Math.floor(opts.games) || 20));
  const target = Math.max(0, Number(opts.targetOdds) || 0);

  // Pull a generous pool of analysed fixtures for the next two days, then take
  // the single safest market per match (highest model probability).
  const pool = await getMatchAnalyses(Math.max(want * 3, 40), 2).catch(() => null);
  if (!pool || !pool.matches.length) return { reason: "no fixtures available to analyse right now" };

  type Cand = { key: string; odds: number; prob: number };
  const safest: Cand[] = [];
  for (const m of pool.matches) {
    // Safest = highest model probability among this match's options that have a price.
    const best = m.options
      .filter((o) => o.odds && Number(o.odds) > 1)
      .sort((a, b) => b.prob - a.prob)[0];
    if (best) safest.push({ key: best.key, odds: Number(best.odds), prob: best.prob });
  }
  // Safest overall first, so a target-odds slip is built from the most likely legs.
  safest.sort((a, b) => b.prob - a.prob);

  // Accumulate until we hit the game count, or (if set) the target odds — whichever
  // comes first — never exceeding the game cap.
  const chosen: Cand[] = [];
  let acc = 1;
  for (const c of safest) {
    if (chosen.length >= want) break;
    chosen.push(c);
    acc *= c.odds;
    if (target > 0 && acc >= target) break;
  }
  if (!chosen.length) return { reason: "no priced markets to build a slip" };

  // Resolve the picks to bookable selections and mint the SportyBet code.
  const { legs } = await legsForFixtureKeys(chosen.map((c) => c.key)).catch(() => ({ legs: [] }));
  if (!legs.length) return { reason: "picks were no longer bookable at build time" };
  const booking = await createBookingCode(legs);
  if (!booking.code) return { reason: `booking failed (${booking.error ?? "unknown"})` };

  const totalOdds = Math.round(legs.reduce((a, l) => a * (l.odds || 1), 1) * 100) / 100;
  return {
    code: booking.code,
    url: booking.url,
    games: booking.games ?? legs.length,
    totalOdds,
  };
}

/**
 * Fire every Auto-Pilot rule that is due now (enabled, this WAT hour, not yet run
 * today). Best-effort and self-capping; safe to call every scheduler cycle.
 */
export async function runDueAutopilots(limit = 20): Promise<AutopilotOutcome[]> {
  const { date, hour } = watNow();
  const due = await prisma.userPreference
    .findMany({
      where: {
        autoEnabled: true,
        autoHourWat: hour,
        // "not run today" — must include rules that have NEVER run (null), which
        // a plain `NOT: { autoLastRunDate: date }` would wrongly exclude because
        // SQL `NOT (NULL = date)` is NULL, not true.
        OR: [{ autoLastRunDate: null }, { autoLastRunDate: { not: date } }],
      },
      take: limit,
    })
    .catch(() => []);
  const out: AutopilotOutcome[] = [];
  for (const pref of due) {
    // Claim the run first so a slow build can't double-fire on the next cycle.
    await prisma.userPreference
      .update({ where: { id: pref.id }, data: { autoLastRunDate: date } })
      .catch(() => null);

    const slip: AutoSlipResult = await buildAutoSlip({
      games: pref.autoGames,
      targetOdds: pref.autoTargetOdds,
      engine: pref.autoEngine,
    }).catch((e): AutoSlipResult => ({ reason: `error: ${e?.message ?? e}` }));

    if (!slip.code) {
      out.push({ userId: pref.userId, ok: false, reason: slip.reason });
      // Tell the user it couldn't build one today rather than fail silently.
      await prisma.notification
        .create({
          data: {
            userId: pref.userId,
            type: "SYSTEM",
            title: "Auto-Pilot: no slip today",
            body: `Couldn't build your ${pref.autoGames}-game auto-slip — ${slip.reason ?? "no games available"}. It will try again tomorrow.`,
          },
        })
        .catch(() => null);
      continue;
    }

    // Success: ledger the code and notify. The user opens it and stakes it.
    await prisma.generatedCode
      .create({
        data: {
          code: slip.code,
          url: slip.url,
          games: slip.games ?? 0,
          totalOdds: slip.totalOdds ?? 0,
          generatorName: "Auto-Pilot",
          origin: "autopilot",
        },
      })
      .catch(() => null);
    await prisma.notification
      .create({
        data: {
          userId: pref.userId,
          type: "NEW_AI_SLIP",
          title: `Auto-Pilot slip ready — ${slip.games} games @ ${slip.totalOdds}`,
          body: `Your scheduled booking code is ${slip.code}. Open it on SportyBet to review and place it yourself.`,
          data: { code: slip.code, url: slip.url, games: slip.games, totalOdds: slip.totalOdds },
        },
      })
      .catch(() => null);
    out.push({
      userId: pref.userId,
      ok: true,
      code: slip.code,
      games: slip.games,
      totalOdds: slip.totalOdds,
    });
  }
  return out;
}
