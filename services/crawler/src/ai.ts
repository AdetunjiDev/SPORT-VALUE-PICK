import { prisma, Prisma } from "@sportybet/db";
import { createBookingCode } from "./booker.js";

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

interface Leg {
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

interface Profile {
  title: string;
  codeType: "SAFE" | "COMBO" | "HIGH_ODDS";
  minOdds: number;
  maxOdds: number;
  legs: number;
  sort: (a: Leg, b: Leg) => number;
}

function buildSlip(pool: Leg[], p: Profile, seed: number) {
  const now = Date.now();
  const inBand = pool.filter((l) => l.odds >= p.minOdds && l.odds <= p.maxOdds);

  // Prefer the SOONEST matches so slips reflect the current slate and refresh
  // as matches kick off. Widen the window only if we can't fill the slip.
  const windows = [24, 48, 96, Number.MAX_SAFE_INTEGER];
  let distinct: Leg[] = [];
  for (const w of windows) {
    const seen = new Set<string>();
    distinct = [];
    for (const l of inBand
      .filter((leg) => !leg.kickoff || (leg.kickoff - now) / 3_600_000 <= w)
      .sort(p.sort)) {
      if (seen.has(l.eventId)) continue; // one selection per match
      seen.add(l.eventId);
      distinct.push(l);
    }
    if (distinct.length >= p.legs) break;
  }
  if (distinct.length < 2) return null;

  // Rotate among the top-quality candidates so slips evolve each cycle (fresh
  // booking codes) without dropping to low-quality picks.
  const topPool = distinct.slice(0, Math.min(distinct.length, p.legs + 5));
  const offset = ((seed % topPool.length) + topPool.length) % topPool.length;
  const picks = topPool.slice(offset).concat(topPool.slice(0, offset)).slice(0, p.legs);
  if (picks.length < 2) return null;

  const totalOdds = picks.reduce((a, l) => a * l.odds, 1);
  const slipProb = picks.reduce((a, l) => a * l.prob, 1);
  const ev = totalOdds * slipProb - 1;
  const b = totalOdds - 1;
  const kelly = b > 0 ? (b * slipProb - (1 - slipProb)) / b : 0;
  const kellyCapped = Math.max(0, Math.min(0.25, kelly)); // quarter-Kelly cap

  return {
    title: p.title,
    codeType: p.codeType,
    totalOdds: round(totalOdds),
    confidence: round(slipProb, 4),
    riskScore: round(1 - slipProb, 4),
    expectedValue: round(ev, 4),
    kellyStakePct: round(kellyCapped * 100, 2),
    reasoning:
      `${picks.length} legs from ${new Set(picks.flatMap((l) => l.eventId)).size} matches. ` +
      `Combined odds ${round(totalOdds)}, model win probability ${round(slipProb * 100)}%. ` +
      `Consensus-weighted, one pick per match. Estimates only — not a guarantee.`,
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
  if (pool.length < 2) return 0;

  const profiles: Profile[] = [
    {
      title: "AI Safe Slip",
      codeType: "SAFE",
      minOdds: 1.2,
      maxOdds: 1.75,
      legs: 4,
      sort: (a, b) => b.prob - a.prob || b.consensus - a.consensus || b.foundAt - a.foundAt,
    },
    {
      title: "AI Value Slip",
      codeType: "COMBO",
      minOdds: 1.6,
      maxOdds: 2.8,
      legs: 4,
      sort: (a, b) =>
        b.prob - 1 / b.odds - (a.prob - 1 / a.odds) ||
        b.consensus - a.consensus ||
        b.foundAt - a.foundAt,
    },
    {
      title: "AI High-Odds Slip",
      codeType: "HIGH_ODDS",
      minOdds: 1.8,
      maxOdds: 6,
      legs: 5,
      sort: (a, b) => b.odds * b.prob - a.odds * a.prob || b.foundAt - a.foundAt,
    },
  ];

  generation += 1; // advance rotation each cycle
  const slips = profiles.map((p) => buildSlip(pool, p, generation)).filter(Boolean) as NonNullable<
    ReturnType<typeof buildSlip>
  >[];
  if (!slips.length) return 0;

  // Replace the current auto-generated set.
  await prisma.aiBetSlip.deleteMany({});
  for (const s of slips) {
    // Auto-generate a REAL SportyBet booking code for this slip (no bet placed).
    const booking = await createBookingCode(
      s.legs.map((l) => ({
        eventId: l.eventId,
        marketId: l.marketId,
        specifier: l.specifier,
        outcomeId: l.outcomeId,
      })),
    );
    const note = booking.code
      ? `Real SportyBet booking code — load it on SportyBet, review & stake yourself.${
          booking.unavailable ? ` (${booking.unavailable} selection(s) dropped as unavailable)` : ""
        }`
      : "Auto-booking unavailable right now — enter selections manually on SportyBet.";

    await prisma.aiBetSlip.create({
      data: {
        title: s.title,
        codeType: s.codeType,
        status: "ACTIVE",
        totalOdds: s.totalOdds,
        confidence: s.confidence,
        riskScore: s.riskScore,
        expectedValue: s.expectedValue,
        kellyStakePct: s.kellyStakePct,
        bookingCode: booking.code,
        bookingCodeNote: note,
        reasoning: s.reasoning,
        legs: s.legs as any,
      },
    });
  }
  return slips.length;
}
