import { prisma } from "@sportybet/db";
import { PICKS, planForTips, legsForFixtureKeys, type GameType } from "./forebet-ai.js";
import { getPredictions } from "./predictions.js";
import { settlePick, fetchEventScore } from "./analyst.js";
import type { Leg } from "./ai.js";

/**
 * Demo Bet Simulator — practice betting with VIRTUAL money, settled against
 * REAL final scores. No real money ever moves: users test whether the app's
 * picks hold up in real life before committing a kobo, and the settled history
 * doubles as honest performance data for improving the models.
 *
 * Legs are resolved through the SAME pipeline as real booking codes
 * (planForTips / legsForFixtureKeys), so a demo bet is exactly what the user
 * would have booked — same fixtures, markets and live odds.
 */

export const DEMO_START_BALANCE = 10_000; // virtual ₦
export const DEMO_MIN_STAKE = 100;

/**
 * A bet is only settled once EVERY leg kicked off at least this long ago, so a
 * match still in play can never settle early. Exported so the wallet can show
 * an honest "final result by" time from the same number the settler uses —
 * if this changes, the promise shown to users changes with it.
 */
export const SETTLE_AFTER_MS = 2.5 * 60 * 60 * 1000;

/** When a bet's results are expected: last kickoff + the settle buffer. */
export function resultsExpectedAt(legs: { kickoff: number }[]): number | null {
  const kicks = legs.map((l) => l.kickoff).filter((k) => Number.isFinite(k) && k > 0);
  return kicks.length ? Math.max(...kicks) + SETTLE_AFTER_MS : null;
}

export interface DemoLeg {
  eventId: string;
  home: string;
  away: string;
  league?: string;
  kickoff: number; // ms epoch
  market?: string;
  pick?: string;
  pickCode: string; // PICKS code for settlement ("1" | "O25" | …)
  odds: number;
  outcome?: "WON" | "LOST" | "VOID"; // set at settlement
  finalScore?: string; // "H:A" once known
}

// Reverse map: marketId|specifier|outcomeId → pick code, for settling legs
// that come back from the booking pipeline (which speaks SportyBet ids).
const CODE_BY_BOOKING = new Map<string, string>();
for (const [code, meta] of Object.entries(PICKS)) {
  CODE_BY_BOOKING.set(`${meta.marketId}|${meta.specifier}|${meta.outcomeId}`, code);
}
const codeForLeg = (l: Leg): string | null =>
  CODE_BY_BOOKING.get(`${l.marketId ?? ""}|${l.specifier ?? ""}|${l.outcomeId ?? ""}`) ?? null;

async function getWallet(owner: string) {
  return prisma.demoWallet.upsert({
    where: { owner },
    create: { owner, balance: DEMO_START_BALANCE },
    update: {},
  });
}

export interface PlaceResult {
  ok: boolean;
  error?: string;
  balance?: number;
  betId?: string;
  legs?: number;
  totalOdds?: number;
  potential?: number;
  skipped?: string[];
  resultsBy?: number; // ms epoch: when every leg has ended and settling runs
}

/** Place a demo bet from slip keys (same keys the real booking flow uses). */
export async function placeDemoBet(
  owner: string,
  keys: string[],
  stakeRaw: number,
  gameType: GameType,
  origin: string,
): Promise<PlaceResult> {
  const stake = Math.round(Number(stakeRaw) || 0);
  if (!keys.length) return { ok: false, error: "Select at least 1 match first." };
  if (keys.length > 40) return { ok: false, error: "Maximum 40 matches per demo bet." };
  if (stake < DEMO_MIN_STAKE) return { ok: false, error: `Minimum demo stake is ₦${DEMO_MIN_STAKE}.` };

  // Resolve legs exactly like the real booking endpoint: external-tip keys
  // first, everything else straight against SportyBet's live fixtures.
  const preds = await getPredictions().catch(() => []);
  const wanted = preds.filter(
    (p) => p.home && p.away && keys.includes(`${p.home}|${p.away}`.toLowerCase()),
  );
  const { legs: tipLegs, matchedKeys: tipMatched } = wanted.length
    ? await planForTips(wanted)
    : { legs: [] as Leg[], matchedKeys: [] as string[] };
  const remaining = keys.filter((k) => !tipMatched.includes(k));
  const { legs: directLegs, matchedKeys: directMatched } = await legsForFixtureKeys(remaining, gameType);
  const legs = [...tipLegs, ...directLegs];
  const matched = new Set([...tipMatched, ...directMatched]);
  const skipped = keys
    .filter((k) => !matched.has(k))
    .map((k) => k.split("|").slice(0, 2).join(" v "));

  const demoLegs: DemoLeg[] = [];
  for (const l of legs) {
    const pickCode = codeForLeg(l);
    if (!pickCode || !l.kickoff) continue; // unsettleable leg — skip honestly
    demoLegs.push({
      eventId: l.eventId,
      home: l.home ?? "?",
      away: l.away ?? "?",
      league: l.league,
      kickoff: l.kickoff,
      market: l.market,
      pick: l.pick,
      pickCode,
      odds: l.odds,
    });
  }
  if (!demoLegs.length)
    return { ok: false, error: "None of those matches are bookable right now — try others." };

  const wallet = await getWallet(owner);
  if (wallet.balance < stake)
    return {
      ok: false,
      error: `Demo balance too low (₦${Math.round(wallet.balance).toLocaleString()}). Reset the wallet to start over.`,
    };

  const totalOdds = Math.round(demoLegs.reduce((a, l) => a * l.odds, 1) * 100) / 100;
  const potential = Math.round(stake * totalOdds);
  const [, bet] = await prisma.$transaction([
    prisma.demoWallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: stake }, staked: { increment: stake } },
    }),
    prisma.demoBet.create({
      data: {
        walletId: wallet.id,
        stake,
        totalOdds,
        potential,
        origin,
        legs: demoLegs as unknown as object[],
      },
    }),
  ]);
  return {
    ok: true,
    betId: bet.id,
    balance: Math.round((wallet.balance - stake) * 100) / 100,
    legs: demoLegs.length,
    totalOdds,
    potential,
    skipped,
    resultsBy: resultsExpectedAt(demoLegs) ?? undefined,
  };
}

export interface WalletView {
  balance: number;
  staked: number;
  returned: number;
  profit: number; // returned − staked (settled economics)
  bets: {
    id: string;
    stake: number;
    totalOdds: number;
    potential: number;
    outcome: string;
    payout: number | null;
    origin: string;
    createdAt: string;
    settledAt: string | null;
    legs: DemoLeg[];
  }[];
  stats: { pending: number; won: number; lost: number; voided: number; hitRate: number | null };
}

export async function getDemoWallet(owner: string): Promise<WalletView | null> {
  const wallet = await prisma.demoWallet.findUnique({ where: { owner } });
  if (!wallet) return null;
  const bets = await prisma.demoBet.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const by = (o: string) => bets.filter((b) => b.outcome === o).length;
  const won = by("WON");
  const lost = by("LOST");
  return {
    balance: Math.round(wallet.balance * 100) / 100,
    staked: Math.round(wallet.staked * 100) / 100,
    returned: Math.round(wallet.returned * 100) / 100,
    profit: Math.round((wallet.returned - wallet.staked) * 100) / 100,
    bets: bets.map((b) => ({
      id: b.id,
      stake: b.stake,
      totalOdds: b.totalOdds,
      potential: b.potential,
      outcome: b.outcome,
      payout: b.payout,
      origin: b.origin,
      createdAt: b.createdAt.toISOString(),
      settledAt: b.settledAt ? b.settledAt.toISOString() : null,
      legs: (b.legs as unknown as DemoLeg[]) ?? [],
    })),
    stats: { pending: by("PENDING"), won, lost, voided: by("VOID"), hitRate: won + lost ? won / (won + lost) : null },
  };
}

/** Fresh start: balance back to the starting bank (history is kept). */
export async function resetDemoWallet(owner: string): Promise<number> {
  const wallet = await getWallet(owner);
  await prisma.demoWallet.update({
    where: { id: wallet.id },
    data: { balance: DEMO_START_BALANCE, staked: 0, returned: 0 },
  });
  return DEMO_START_BALANCE;
}

/**
 * Settle pending demo bets whose matches have all finished, against REAL
 * final scores (same source that settles Expert Picks). Runs each crawl
 * cycle, capped to stay polite to the score API.
 */
export async function settleDemoBets(limit = 8): Promise<{ settled: number; won: number }> {
  const cutoff = Date.now() - SETTLE_AFTER_MS; // let matches finish
  const staleCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // give up → VOID leg
  const candidates = await prisma.demoBet.findMany({
    where: { outcome: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  let settled = 0;
  let won = 0;
  for (const bet of candidates) {
    if (settled >= limit) break;
    const legs = (bet.legs as unknown as DemoLeg[]) ?? [];
    if (!legs.length || legs.some((l) => l.kickoff > cutoff)) continue; // still playing

    let anyLost = false;
    let unresolved = false;
    const settledLegs: DemoLeg[] = [];
    for (const leg of legs) {
      if (leg.outcome) {
        settledLegs.push(leg);
        if (leg.outcome === "LOST") anyLost = true;
        continue;
      }
      const r = await fetchEventScore(leg.eventId);
      if (r === null) {
        // API hiccup — retry next cycle unless the match is ancient.
        if (leg.kickoff < staleCutoff) settledLegs.push({ ...leg, outcome: "VOID" });
        else {
          unresolved = true;
          settledLegs.push(leg);
        }
        continue;
      }
      if (!r.ended || !r.score) {
        if (leg.kickoff < staleCutoff) settledLegs.push({ ...leg, outcome: "VOID" });
        else {
          unresolved = true;
          settledLegs.push(leg);
        }
        continue;
      }
      const win = settlePick(leg.pickCode, r.score);
      const outcome: DemoLeg["outcome"] = win === null ? "VOID" : win ? "WON" : "LOST";
      if (outcome === "LOST") anyLost = true;
      settledLegs.push({ ...leg, outcome, finalScore: r.score });
    }

    if (unresolved && !anyLost) {
      // Persist partial leg results so we don't refetch them, stay PENDING.
      await prisma.demoBet.update({
        where: { id: bet.id },
        data: { legs: settledLegs as unknown as object[] },
      });
      continue;
    }

    // Final outcome: any lost leg loses the bet; otherwise VOID legs drop out
    // of the odds (stake-refund semantics, like real bookmakers).
    let outcome: "WON" | "LOST" | "VOID";
    let payout = 0;
    if (anyLost) {
      outcome = "LOST";
    } else {
      const active = settledLegs.filter((l) => l.outcome === "WON");
      if (!active.length) {
        outcome = "VOID";
        payout = bet.stake;
      } else {
        outcome = "WON";
        const odds = active.reduce((a, l) => a * l.odds, 1);
        payout = Math.round(bet.stake * odds * 100) / 100;
      }
    }
    const writes: any[] = [
      prisma.demoBet.update({
        where: { id: bet.id },
        data: { outcome, payout, settledAt: new Date(), legs: settledLegs as unknown as object[] },
      }),
    ];
    if (payout > 0)
      writes.push(
        prisma.demoWallet.update({
          where: { id: bet.walletId },
          data: { balance: { increment: payout }, returned: { increment: payout } },
        }),
      );
    await prisma.$transaction(writes);
    settled += 1;
    if (outcome === "WON") won += 1;
  }
  return { settled, won };
}