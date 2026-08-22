import { prisma, Prisma } from "@sportybet/db";
import { createBookingCode } from "./booker.js";
import { forebetLegs, legsForTips } from "./forebet-ai.js";
import { getApiFootballPredictions } from "./apifootball.js";
import { generateSlipNarrative } from "./bytez.js";

// Delta booking: recompute slips every cycle, but only mint a NEW SportyBet
// booking code when a slip's selections actually change (a leg drops out of the
// pool) — so we can refresh every 3 min without hammering SportyBet's API.
const MAX_NEW_BOOKINGS_PER_CYCLE = Math.max(1, Number(process.env.AI_MAX_BOOKINGS_PER_CYCLE ?? 5));
// Rotate the pick selection on a slow clock (default 15 min) so fresh slips
// vary over time instead of churning every cycle.
const ROTATE_MS = Math.max(1, Number(process.env.AI_ROTATE_MIN ?? 15)) * 60_000;

/**
 * AI recommendation engine (v1).
 *
 * Analyses the REAL selection odds already collected from verified SportyBet
 * codes and assembles optimised bet slips. It NEVER claims an official code —
 * these are model-generated recommendations for manual entry.
 *
 * Method (transparent, upgradeable to trained ML later):
 *  - implied probability  = 1 / odds  (the market's own probability)
 *  - consensus boost       = small edge when multiple sources back the same pick
 *  - model probability     = implied + consensus boost (capped)
 *  - slip win prob          = product of leg model probs (independence assumption)
 *  - Expected Value (EV)    = totalOdds * slipProb - 1
 *  - Kelly fraction         = (b·p - q) / b, quarter-Kelly capped for safety
 */

export interface Leg {
  eventId: string;
  home?: string;
  away?: string;
  league?: string;
  kickoff?: number;
  market?: string;
  pick?: string;
  odds: number;
  prob: number; // model probability
  consensus: number; // distinct sources backing this pick
  foundAt: number; // newest source-code discovery time (freshness)
  marketId?: string;
  specifier?: string;
  outcomeId?: string;
}

interface Agg {
  eventId: string;
  home?: string;
  away?: string;
  league?: string;
  kickoff?: number;
  market?: string;
  pick?: string;
  odds: number;
  codes: Set<string>;
  foundAt: number;
  marketId?: string;
  specifier?: string;
  outcomeId?: string;
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Advances each cycle so slips rotate through the top picks instead of freezing.
let generation = 0;

/** Build the candidate pool of unique, future selections from active codes. */
async function candidatePool(): Promise<Leg[]> {
  const codes = await prisma.humanCode.findMany({
    where: { status: "ACTIVE", selections: { not: Prisma.DbNull } },
    select: { id: true, selections: true, foundAt: true },
  });

  const now = Date.now();
  const byKey = new Map<string, Agg>();

  for (const c of codes) {
    const legs = (c.selections as unknown as Leg[]) ?? [];
    const foundAt = new Date(c.foundAt).getTime();
    for (const l of legs) {
      if (!l?.odds || l.odds <= 1) continue;
      if (!l.pick || !l.market) continue;
      if (l.kickoff && l.kickoff < now) continue; // only upcoming matches
      const key = `${l.eventId}|${l.market}|${l.pick}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.codes.add(c.id);
        existing.odds = Math.max(existing.odds, l.odds);
        existing.foundAt = Math.max(existing.foundAt, foundAt);
      } else {
        byKey.set(key, {
          eventId: l.eventId,
          home: l.home,
          away: l.away,
          league: l.league,
          kickoff: l.kickoff,
          market: l.market,
          pick: l.pick,
          odds: l.odds,
          codes: new Set([c.id]),
          foundAt,
          marketId: l.marketId,
          specifier: l.specifier,
          outcomeId: l.outcomeId,
        });
      }
    }
  }

  return [...byKey.values()].map((a) => {
    const implied = 1 / a.odds;
    const consensus = a.codes.size;
    const boost = Math.min(0.1, 0.03 * (consensus - 1));
    const prob = Math.min(0.95, implied + boost);
    return {
      eventId: a.eventId,
      home: a.home,
      away: a.away,
      league: a.league,
      kickoff: a.kickoff,
      market: a.market,
      pick: a.pick,
      odds: round(a.odds),
      prob: round(prob, 4),
      consensus,
      foundAt: a.foundAt,
      marketId: a.marketId,
      specifier: a.specifier,
      outcomeId: a.outcomeId,
    };
  });
}

// ---- Value Score engine ----
// Every pick is scored by valueScore = odds × prob (expected return per unit).
// Picks with valueScore > 1.0 have positive expected value. We enforce quality
// floors so customers get meaningful odds with solid win rates.

// Quality floors — every individual pick must clear these.
const MIN_ODDS = 1.40;  // No tiny odds — the customer wants real returns
const MIN_PROB = 0.40;  // No blind longshots — at least 40% model probability
const MAX_ODDS = 8;     // Cap wild outliers

// Minimum combined odds per slip size — ensures the slip is worth staking.
const MIN_COMBINED: Record<number, number> = { 2: 3, 3: 5, 4: 8, 5: 12 };

interface ValueProfile {
  title: string;
  codeType: "SAFE" | "COMBO" | "HIGH_ODDS";
  legs: number;
  minCombined: number;
}

/**
 * Build a value-optimised slip of N games from the pool.
 *
 * 1. Filter: odds ∈ [MIN_ODDS, MAX_ODDS], prob ≥ MIN_PROB
 * 2. Rank by valueScore (odds × prob) DESC, then consensus, then freshness
 * 3. Take top N unique matches (one pick per match)
 * 4. Verify combined odds ≥ target minimum; if not, try swapping in the next-
 *    best picks from lower in the pool (higher odds, slightly lower value)
 */
function buildValueSlip(
  pool: Leg[],
  p: ValueProfile,
  seed: number,
): ReturnType<typeof _assembleSlip> {
  const now = Date.now();

  // Quality gate: individual picks must have decent odds AND win probability.
  const qualified = pool.filter(
    (l) => l.odds >= MIN_ODDS && l.odds <= MAX_ODDS && l.prob >= MIN_PROB,
  );

  // Prefer the SOONEST matches so slips reflect the current slate and refresh
  // as matches kick off. Widen the window only if we can't fill the slip.
  const windows = [24, 48, 96, Number.MAX_SAFE_INTEGER];
  let distinct: Leg[] = [];
  for (const w of windows) {
    const seen = new Set<string>();
    distinct = [];
    // Sort by VALUE SCORE descending: best risk/reward ratio first.
    const sorted = qualified
      .filter((leg) => !leg.kickoff || (leg.kickoff - now) / 3_600_000 <= w)
      .sort(
        (a, b) =>
          b.odds * b.prob - a.odds * a.prob ||
          b.consensus - a.consensus ||
          b.foundAt - a.foundAt,
      );
    for (const l of sorted) {
      if (seen.has(l.eventId)) continue; // one selection per match
      seen.add(l.eventId);
      distinct.push(l);
    }
    if (distinct.length >= p.legs) break;
  }
  if (distinct.length < 2) return null;

  // Rotate among the top-quality candidates so slips evolve each cycle.
  const topPool = distinct.slice(0, Math.min(distinct.length, p.legs + 6));
  const offset = ((seed % topPool.length) + topPool.length) % topPool.length;
  let picks = topPool.slice(offset).concat(topPool.slice(0, offset)).slice(0, p.legs);
  if (picks.length < 2) return null;

  // If combined odds fall short of the minimum target, try promoting higher-
  // odds picks from deeper in the ranked pool (they still passed the quality
  // floor). This ensures customers always get meaningful combined odds.
  let totalOdds = picks.reduce((a, l) => a * l.odds, 1);
  if (totalOdds < p.minCombined && distinct.length > picks.length) {
    const usedEvents = new Set(picks.map((l) => l.eventId));
    const extras = distinct.filter((l) => !usedEvents.has(l.eventId));
    // Sort extras by odds descending so we swap in higher-paying picks first.
    extras.sort((a, b) => b.odds - a.odds);
    // Replace the LOWEST-odds pick with a higher-odds one until target met.
    for (const ex of extras) {
      if (totalOdds >= p.minCombined) break;
      const weakest = picks.reduce((lo, l, i) =>
        l.odds < picks[lo].odds ? i : lo, 0,
      );
      const old = picks[weakest];
      if (ex.odds <= old.odds) continue; // only upgrade
      picks = [...picks.slice(0, weakest), ...picks.slice(weakest + 1), ex];
      totalOdds = picks.reduce((a, l) => a * l.odds, 1);
    }
  }

  return _assembleSlip(picks, p);
}

/** Compute metrics and package a finished slip. */
function _assembleSlip(picks: Leg[], p: ValueProfile) {
  if (picks.length < 2) return null;
  const totalOdds = picks.reduce((a, l) => a * l.odds, 1);
  const slipProb = picks.reduce((a, l) => a * l.prob, 1);
  const ev = totalOdds * slipProb - 1;
  const b = totalOdds - 1;
  const kelly = b > 0 ? (b * slipProb - (1 - slipProb)) / b : 0;
  const kellyCapped = Math.max(0, Math.min(0.25, kelly)); // quarter-Kelly cap

  // Sort picks by kickoff so the slip reads chronologically.
  picks.sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0));

  const avgOdds = round(totalOdds ** (1 / picks.length), 2);

  return {
    title: p.title,
    codeType: p.codeType,
    totalOdds: round(totalOdds),
    confidence: round(slipProb, 4),
    riskScore: round(1 - slipProb, 4),
    expectedValue: round(ev, 4),
    kellyStakePct: round(kellyCapped * 100, 2),
    reasoning:
      `${picks.length} best-value games for today. ` +
      `Combined odds ${round(totalOdds)} (avg ${avgOdds}/game), ` +
      `model win probability ${round(slipProb * 100)}%. ` +
      `Value-ranked: best odds × win rate. One pick per match. Estimates only — not a guarantee.`,
    legs: picks,
  };
}

/** Regenerate the current AI bet slips. Returns how many were created. */
export async function generateAiSlips(): Promise<number> {
  const now = Date.now();
  // Prune STALE slips (any leg already kicked off) so we never show a slip whose
  // matches have finished — even if the pool is too thin to build a replacement.
  const existing = await prisma.aiBetSlip.findMany({ select: { id: true, legs: true } });
  for (const s of existing) {
    const legs = (s.legs as unknown as { kickoff?: number }[]) ?? [];
    if (legs.some((l) => l?.kickoff && l.kickoff < now)) {
      await prisma.aiBetSlip.delete({ where: { id: s.id } });
    }
  }

  const pool = await candidatePool();

  // Forebet model tips matched to live SportyBet fixtures — never let a
  // Forebet/SportyBet hiccup break the main AI generation.
  let fbPool: Leg[] = [];
  try {
    fbPool = await forebetLegs();
  } catch {
    /* keep going */
  }

  // API-Football (premium, if a key is set) model predictions matched to live
  // SportyBet fixtures. Empty when the adapter is off — costs nothing then.
  let afPool: Leg[] = [];
  try {
    afPool = await legsForTips(await getApiFootballPredictions());
  } catch {
    /* keep going */
  }

  // Merge external legs into the shared pool (dedupe: the same event+market+pick
  // from another source counts as extra consensus, not a duplicate entry).
  const poolKeys = new Set(pool.map((l) => `${l.eventId}|${l.market}|${l.pick}`));
  const mergeIn = (legs: Leg[]) => {
    for (const l of legs) {
      const key = `${l.eventId}|${l.market}|${l.pick}`;
      if (poolKeys.has(key)) {
        const ex = pool.find((p) => `${p.eventId}|${p.market}|${p.pick}` === key)!;
        ex.consensus += 1;
        ex.prob = Math.min(0.95, Math.max(ex.prob, l.prob));
      } else {
        pool.push(l);
        poolKeys.add(key);
      }
    }
  };
  mergeIn(fbPool);
  mergeIn(afPool);

  if (pool.length < 2 && fbPool.length < 2 && afPool.length < 2) return 0;

  // ---- Upgraded Value Picks Slips ----
  // Distinct profiles optimized for positive expected return and disciplined risk.
  const valueProfiles: ValueProfile[] = [
    { title: "🎯 Value 2-Game (Banker)", codeType: "SAFE",      legs: 2, minCombined: MIN_COMBINED[2] },
    { title: "💎 AI Super Value 3-Game", codeType: "COMBO",     legs: 3, minCombined: MIN_COMBINED[3] },
    { title: "🎯 Value 4-Game Combo",     codeType: "COMBO",     legs: 4, minCombined: MIN_COMBINED[4] },
    { title: "🚀 High Multiplier 5-Game", codeType: "HIGH_ODDS", legs: 5, minCombined: MIN_COMBINED[5] },
  ];

  // Rotate on a slow clock, not every cycle, so an unchanged pool yields the
  // SAME picks (and thus keeps the same booking code) between rotation windows.
  generation = Math.floor(Date.now() / ROTATE_MS);
  const slips = valueProfiles
    .map((p) => buildValueSlip(pool, p, generation))
    .filter(Boolean) as NonNullable<ReturnType<typeof buildValueSlip>>[];

  // Dedicated Forebet slip: built purely from Forebet's model predictions
  // matched to live SportyBet 1X2 prices. Capped at 4 games with value logic.
  if (fbPool.length >= 2) {
    const fbSlip = buildValueSlip(
      fbPool,
      { title: "🔮 Forebet Value Slip", codeType: "COMBO", legs: 4, minCombined: 3 },
      generation,
    );
    if (fbSlip) {
      fbSlip.reasoning += " Legs sourced from Forebet's 1X2 statistical model.";
      slips.push(fbSlip);
    }
  }

  // Dedicated API-Football slip: built purely from the premium model's picks.
  if (afPool.length >= 2) {
    const afSlip = buildValueSlip(
      afPool,
      { title: "⭐ Premium Value Slip", codeType: "COMBO", legs: 4, minCombined: 3 },
      generation,
    );
    if (afSlip) {
      afSlip.reasoning += " Legs sourced from API-Football's premium prediction model.";
      slips.push(afSlip);
    }
  }

  // Enrich slips with Bytez AI tactical narrative
  for (const s of slips) {
    try {
      const narrative = await generateSlipNarrative({
        title: s.title,
        totalOdds: s.totalOdds,
        confidence: s.confidence,
        expectedValue: s.expectedValue,
        legs: s.legs,
      });
      if (narrative) s.reasoning = narrative;
    } catch {
      /* continue with standard reasoning */
    }
  }

  if (!slips.length) return 0;

  // ---- Delta booking ----
  // Recompute every cycle, but reuse an existing booking code when a slip's
  // selections are unchanged (compare a hash of the current legs to the stored
  // legs). Only mint a NEW code when the picks actually change, capped per
  // cycle so a big fixture drop can't burst SportyBet's booking API.
  const priorSlips = await prisma.aiBetSlip.findMany();
  const priorByTitle = new Map(priorSlips.map((p) => [p.title, p]));

  let booked = 0; // SportyBet booking calls spent this cycle (capped)
  let kept = 0; // slips whose code was reused unchanged
  let deferred = 0; // changed slips left for a later cycle (cap reached)
  const keepIds: string[] = [];

  // Fresh metrics for a slip (everything derived from the legs; not the code).
  const metricsOf = (s: (typeof slips)[number]) => ({
    codeType: s.codeType,
    status: "ACTIVE" as const,
    totalOdds: s.totalOdds,
    confidence: s.confidence,
    riskScore: s.riskScore,
    expectedValue: s.expectedValue,
    kellyStakePct: s.kellyStakePct,
    reasoning: s.reasoning,
    legs: s.legs as any,
  });

  // Sticky reuse: a booked slip is kept EXACTLY as-is (legs + code) as long as
  // every one of its legs is still a live, upcoming selection in the pool. This
  // stops needless rebooking when the candidate pool merely jitters (external
  // feeds refetch and add/drop a marginal leg). We only rebuild + rebook when a
  // leg actually drops out of the pool (or a match kicks off).
  const nowMs = Date.now();
  const keyOfLeg = (l: Leg) =>
    `${l.eventId}:${l.marketId ?? ""}:${l.specifier ?? ""}:${l.outcomeId ?? ""}`;
  const liveKeys = new Set(
    pool.filter((l) => !l.kickoff || l.kickoff > nowMs).map(keyOfLeg),
  );

  for (const s of slips) {
    const prior = priorByTitle.get(s.title);

    // Sticky: keep the prior slip intact if it has a code and all legs live.
    if (prior?.bookingCode) {
      const priorLegs = (prior.legs as unknown as Leg[]) ?? [];
      const allLive = priorLegs.length >= 2 && priorLegs.every((l) => liveKeys.has(keyOfLeg(l)));
      if (allLive) {
        kept += 1;
        keepIds.push(prior.id); // leave legs + code + metrics exactly as booked
        continue;
      }
    }

    // A leg dropped out (or no code yet). Mint a fresh one within the cap.
    if (booked < MAX_NEW_BOOKINGS_PER_CYCLE) {
      booked += 1; // count the call whether or not it succeeds
      const booking = await createBookingCode(
        s.legs.map((l) => ({
          eventId: l.eventId,
          marketId: l.marketId,
          specifier: l.specifier,
          outcomeId: l.outcomeId,
        })),
      );
      await new Promise((r) => setTimeout(r, 400)); // polite spacing
      const bookingCode = booking.code ?? null;
      const bookingCodeNote = booking.code
        ? `Real SportyBet booking code — load it on SportyBet, review & stake yourself.${
            booking.unavailable ? ` (${booking.unavailable} selection(s) dropped as unavailable)` : ""
          }`
        : "Auto-booking unavailable right now — enter selections manually on SportyBet.";
      const data = { title: s.title, ...metricsOf(s), bookingCode, bookingCodeNote };
      if (prior) {
        await prisma.aiBetSlip.update({ where: { id: prior.id }, data });
        keepIds.push(prior.id);
      } else {
        const created = await prisma.aiBetSlip.create({ data });
        keepIds.push(created.id);
      }
      continue;
    }

    // Cap reached this cycle. Keep the prior slip fully intact (its legs and
    // code still match) and defer the change to a later cycle — never show new
    // legs against an old code.
    if (prior) {
      deferred += 1;
      keepIds.push(prior.id);
    } else {
      // Brand-new profile with no prior row: show its legs, code pending.
      const created = await prisma.aiBetSlip.create({
        data: {
          title: s.title,
          ...metricsOf(s),
          bookingCode: null,
          bookingCodeNote: "Booking code updating shortly — refreshes next cycle.",
        },
      });
      keepIds.push(created.id);
    }
  }

  // Drop any slip whose profile is no longer produced this cycle.
  await prisma.aiBetSlip.deleteMany({ where: { id: { notIn: keepIds } } });

  console.log(
    `  AI: ${slips.length} slips · ${booked} booked · ${kept} unchanged · ${deferred} deferred`,
  );
  return slips.length;
}
