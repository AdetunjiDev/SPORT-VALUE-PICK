import { prisma } from "@sportybet/db";
import { PICKS, planForTips, legsForFixtureKeys, type GameType } from "./forebet-ai.js";
import { getPredictions } from "./predictions.js";
import { settlePick, fetchEventScore, getOddsBoosters } from "./analyst.js";
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

export const DEMO_START_BALANCE = 100_000; // virtual ₦ — a fresh bank each day
export const DEMO_MIN_STAKE = 100;
// Live window: bets from the last 7 days stay in the active table and show as
// grouped slip cards. Anything older is moved to the PERMANENT archive (kept
// forever, browsable in the archive modal) so the active store stays lean.
export const DEMO_RETENTION_DAYS = 7;

/** Current WAT calendar day (YYYY-MM-DD) — the daily-refresh boundary. */
function watDay(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}

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

/** Reverse booking-id lookup, shared with the dashboard's code-edit flow. */
export const pickCodeForBooking = (
  marketId: string,
  specifier: string,
  outcomeId: string,
): string | null => CODE_BY_BOOKING.get(`${marketId}|${specifier}|${outcomeId}`) ?? null;

/**
 * Refresh the spendable balance to the full daily bank once per WAT day. Bet
 * HISTORY and the lifetime staked/returned analytics are untouched — only the
 * amount you have to bet with resets, so each day is a clean slate to study
 * while the everyday results archive keeps growing.
 */
async function ensureDailyRefresh<T extends { id: string; resetDay: string }>(wallet: T): Promise<T> {
  const today = watDay();
  if (wallet.resetDay === today) return wallet;
  const updated = await prisma.demoWallet.update({
    where: { id: wallet.id },
    data: { balance: DEMO_START_BALANCE, resetDay: today },
  });
  return updated as unknown as T;
}

async function getWallet(owner: string) {
  const wallet = await prisma.demoWallet.upsert({
    where: { owner },
    create: { owner, balance: DEMO_START_BALANCE, resetDay: watDay() },
    update: {},
  });
  return ensureDailyRefresh(wallet);
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
  if (keys.length > 50) return { ok: false, error: "Maximum 50 matches per demo bet." };
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

  return commitBet(owner, demoLegs, stake, origin, skipped);
}

/** Shared wallet-check + write for every way of placing a demo bet. */
async function commitBet(
  owner: string,
  demoLegs: DemoLeg[],
  stake: number,
  origin: string,
  skipped: string[],
): Promise<PlaceResult> {
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

/**
 * Place a demo bet directly from a verified booking code's stored selections
 * (the dashboard's "🎮 Demo" action) — simulating the EXACT code, market by
 * market, with virtual money. Legs that already kicked off, or use markets the
 * settler can't score, are skipped honestly and reported back.
 */
export async function placeDemoBetFromSelections(
  owner: string,
  sels: Record<string, unknown>[],
  stakeRaw: number,
  origin: string,
): Promise<PlaceResult> {
  const stake = Math.round(Number(stakeRaw) || 0);
  if (stake < DEMO_MIN_STAKE) return { ok: false, error: `Minimum demo stake is ₦${DEMO_MIN_STAKE}.` };
  const now = Date.now();
  const demoLegs: DemoLeg[] = [];
  const skipped: string[] = [];
  for (const s of sels.slice(0, 50)) {
    const title = `${String(s.home ?? "?")} v ${String(s.away ?? "?")}`;
    const pickCode = pickCodeForBooking(
      String(s.marketId ?? ""),
      String(s.specifier ?? ""),
      String(s.outcomeId ?? ""),
    );
    const kickoff = Number(s.kickoff) || 0;
    const odds = Number(s.odds) || 0;
    if (!s.eventId || !pickCode || !kickoff || odds <= 1 || kickoff <= now) {
      skipped.push(title);
      continue;
    }
    demoLegs.push({
      eventId: String(s.eventId),
      home: String(s.home ?? "?"),
      away: String(s.away ?? "?"),
      league: s.league ? String(s.league) : undefined,
      kickoff,
      market: s.market ? String(s.market) : undefined,
      pick: s.pick ? String(s.pick) : undefined,
      pickCode,
      odds,
    });
  }
  if (!demoLegs.length)
    return {
      ok: false,
      error: "None of this code's games can be simulated — they've kicked off already or use markets the simulator can't settle.",
    };
  return commitBet(owner, demoLegs, stake, origin, skipped);
}

// Odds tiers the auto-generator tries, in one run — spans the classic 2 to
// 50+ range and explicitly includes 5×/10×/30×/40×.
export const AUTO_SLIP_TARGETS = [2, 3, 5, 7, 10, 15, 20, 30, 40, 50];

export interface AutoSlipEntry {
  id: string;
  title: string;
  target: number;
  ok: boolean;
  error?: string;
  betId?: string;
  legs?: number;
  totalOdds?: number;
  stake?: number;
  potential?: number;
  winProb: number | null; // REAL combined chance every leg lands (∏ leg confidence)
}

/**
 * Auto-generate several demo accumulators in one call, one per odds tier
 * (2× up to 50×), each greedily built from the app's safest available legs —
 * the same "Safe Booster" engine behind the Value Combos tab — then placed
 * with a RANDOMIZED demo stake (the AI "fixes" the amount so nothing needs
 * typing in). Lets the user watch several strategies play out at once and
 * compare which odds band actually performs.
 *
 * Honesty note: `winProb` is the true combined probability (product of every
 * leg's model confidence), reported as-is. No accumulator of genuinely
 * confident legs can multiply to 30-50× odds while staying near 90%
 * combined — that would need every leg near a lock, and there aren't 20-30
 * such legs live at once. This never fabricates that number; higher odds
 * tiers will honestly show a lower combined chance, by arithmetic.
 */
export async function autoGenerateDemoSlips(
  owner: string,
  targets: number[] = AUTO_SLIP_TARGETS,
): Promise<AutoSlipEntry[]> {
  const seed = Math.floor(Date.now() / (8 * 60_000));
  const attempts = await getOddsBoosters({ targets, seed, days: 21, minConfidence: 0.6 }).catch(
    () => [] as Awaited<ReturnType<typeof getOddsBoosters>>,
  );
  const results: AutoSlipEntry[] = [];
  for (const a of attempts) {
    if (!a.ok || !a.combo) {
      results.push({
        id: `boost${a.target}`,
        title: `Safe Booster ~${a.target}×`,
        target: a.target,
        ok: false,
        error: `Not enough qualifying matches right now to reach ${a.target}× (best reachable ≈ ${a.reached}× with ${a.legsAvailable} legs).`,
        winProb: null,
      });
      continue;
    }
    const combo = a.combo;
    const keys = combo.legs.map((l) => l.key);
    const stake = Math.round((200 + Math.random() * 1800) / 50) * 50; // ₦200–₦2,000
    const placed = await placeDemoBet(owner, keys, stake, "both", `auto-${a.target}x`);
    if (!placed.ok) {
      results.push({ id: combo.id, title: combo.title, target: a.target, ok: false, error: placed.error, winProb: combo.winProb ?? null });
      continue;
    }
    results.push({
      id: combo.id,
      title: combo.title,
      target: a.target,
      ok: true,
      betId: placed.betId,
      legs: placed.legs,
      totalOdds: placed.totalOdds,
      stake,
      potential: placed.potential,
      winProb: combo.winProb ?? null,
    });
  }
  return results;
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
    cancellable: boolean; // nothing kicked off yet ⇒ deleting refunds the stake
  }[];
  stats: { pending: number; won: number; lost: number; voided: number; hitRate: number | null };
}

export async function getDemoWallet(owner: string): Promise<WalletView | null> {
  const found = await prisma.demoWallet.findUnique({ where: { owner } });
  if (!found) return null;
  // Refresh to the fresh daily bank on the first view of a new WAT day.
  const wallet = await ensureDailyRefresh(found);
  const bets = await prisma.demoBet.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const by = (o: string) => bets.filter((b) => b.outcome === o).length;
  const won = by("WON");
  const lost = by("LOST");
  return {
    balance: Math.round(wallet.balance * 100) / 100,
    staked: Math.round(wallet.staked * 100) / 100,
    returned: Math.round(wallet.returned * 100) / 100,
    profit: Math.round((wallet.returned - wallet.staked) * 100) / 100,
    bets: bets.map((b) => {
      const legs = (b.legs as unknown as DemoLeg[]) ?? [];
      return {
        id: b.id,
        stake: b.stake,
        totalOdds: b.totalOdds,
        potential: b.potential,
        outcome: b.outcome,
        payout: b.payout,
        origin: b.origin,
        createdAt: b.createdAt.toISOString(),
        settledAt: b.settledAt ? b.settledAt.toISOString() : null,
        legs,
        cancellable: b.outcome === "PENDING" && !legs.some((l) => l.kickoff <= Date.now()),
      };
    }),
    stats: { pending: by("PENDING"), won, lost, voided: by("VOID"), hitRate: won + lost ? won / (won + lost) : null },
  };
}

export interface DeleteResult {
  ok: boolean;
  error?: string;
  refunded?: number;
  balance?: number;
}

/**
 * Remove one demo bet.
 *
 * The stake is refunded ONLY when nothing has kicked off yet — that is a real
 * cancellation. Once a match is under way the stake stays spent, because
 * refunding an in-play bet would let anyone drop their losers and walk away
 * with a fake profit, which would make the wallet's numbers worthless as proof
 * the model works. Deleting a played bet is therefore just tidying the list:
 * the wallet's lifetime staked/returned totals (and so the profit KPI) are
 * left exactly as they were.
 */
export async function deleteDemoBet(owner: string, betId: string): Promise<DeleteResult> {
  const wallet = await prisma.demoWallet.findUnique({ where: { owner } });
  if (!wallet) return { ok: false, error: "No demo wallet yet." };
  const bet = await prisma.demoBet.findFirst({ where: { id: betId, walletId: wallet.id } });
  if (!bet) return { ok: false, error: "That bet isn't in your wallet." };

  const legs = (bet.legs as unknown as DemoLeg[]) ?? [];
  const started = legs.some((l) => l.kickoff <= Date.now());
  const refund = bet.outcome === "PENDING" && !started ? bet.stake : 0;

  const writes: any[] = [prisma.demoBet.delete({ where: { id: bet.id } })];
  if (refund > 0)
    writes.push(
      prisma.demoWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: refund }, staked: { decrement: refund } },
      }),
    );
  await prisma.$transaction(writes);

  const after = await prisma.demoWallet.findUnique({ where: { id: wallet.id } });
  return {
    ok: true,
    refunded: refund,
    balance: after ? Math.round(after.balance * 100) / 100 : undefined,
  };
}

// Unified settled-bet shape spanning the live table AND the permanent archive,
// so every study view (daily stats, games log, export, modal) sees the FULL
// history even after old live bets are pruned.
interface ResultBet {
  id: string;
  createdAt: Date;
  settledAt: Date | null;
  outcome: string;
  stake: number;
  totalOdds: number;
  potential: number;
  payout: number | null;
  origin: string;
  legs: DemoLeg[];
}

async function getResultBets(owner: string): Promise<ResultBet[]> {
  const wallet = await prisma.demoWallet.findUnique({ where: { owner } });
  const [active, archived] = await Promise.all([
    wallet
      ? prisma.demoBet.findMany({
          where: { walletId: wallet.id, outcome: { in: ["WON", "LOST", "VOID"] } },
          orderBy: { settledAt: "desc" },
          take: 3000,
        })
      : Promise.resolve([]),
    prisma.demoArchive.findMany({
      where: { owner, outcome: { in: ["WON", "LOST", "VOID"] } },
      orderBy: { settledAt: "desc" },
      take: 3000,
    }),
  ]);
  const map = (b: {
    id?: string;
    origBetId?: string;
    createdAt: Date;
    settledAt: Date | null;
    outcome: string;
    stake: number;
    totalOdds: number;
    potential: number;
    payout: number | null;
    origin: string;
    legs: unknown;
  }): ResultBet => ({
    id: b.origBetId ?? b.id ?? "",
    createdAt: b.createdAt,
    settledAt: b.settledAt,
    outcome: b.outcome,
    stake: b.stake,
    totalOdds: b.totalOdds,
    potential: b.potential,
    payout: b.payout,
    origin: b.origin,
    legs: (b.legs as unknown as DemoLeg[]) ?? [],
  });
  const seen = new Set<string>();
  const out: ResultBet[] = [];
  for (const b of [...active.map(map), ...archived.map(map)]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  out.sort((a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0));
  return out;
}

export interface DailyStat {
  day: string; // "2026-07-18" (WAT calendar day the games settled)
  label: string; // "Fri 18 Jul"
  bets: number;
  staked: number;
  returned: number;
  profit: number; // returned − staked for that day
  won: number;
  lost: number;
  voided: number;
  hitRate: number | null; // won / (won+lost)
  roi: number | null; // profit / staked
}

/**
 * Per-day simulation results — the study tool. Groups EVERY settled demo bet
 * by the WAT calendar day its games finished, so the user can review how the
 * app's picks actually performed each day (hit rate, ROI, profit). Covers the
 * full saved history, not just the recent bets shown as cards.
 */
export async function getDemoDailyStats(owner: string): Promise<DailyStat[]> {
  const bets = await getResultBets(owner);
  const byDay = new Map<string, DailyStat>();
  for (const b of bets) {
    const when = b.settledAt ?? b.createdAt;
    const day = when.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }); // YYYY-MM-DD
    let d = byDay.get(day);
    if (!d) {
      d = {
        day,
        label: when.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "Africa/Lagos",
        }),
        bets: 0,
        staked: 0,
        returned: 0,
        profit: 0,
        won: 0,
        lost: 0,
        voided: 0,
        hitRate: null,
        roi: null,
      };
      byDay.set(day, d);
    }
    d.bets += 1;
    d.staked += b.stake;
    d.returned += b.payout ?? 0;
    if (b.outcome === "WON") d.won += 1;
    else if (b.outcome === "LOST") d.lost += 1;
    else d.voided += 1;
  }
  const days = [...byDay.values()];
  for (const d of days) {
    d.staked = Math.round(d.staked * 100) / 100;
    d.returned = Math.round(d.returned * 100) / 100;
    d.profit = Math.round((d.returned - d.staked) * 100) / 100;
    const decided = d.won + d.lost;
    d.hitRate = decided ? d.won / decided : null;
    d.roi = d.staked ? d.profit / d.staked : null;
  }
  return days.sort((a, b) => (a.day < b.day ? 1 : -1)); // newest day first
}

export interface GameLogRow {
  betId: string;
  settledAt: string | null;
  createdAt: string;
  betOutcome: string; // the parent slip's outcome
  stake: number;
  legsInBet: number;
  home: string;
  away: string;
  league?: string;
  pick: string;
  odds: number;
  outcome: string; // this leg: WON | LOST | VOID | PENDING
  finalScore?: string;
}

/**
 * Complete game-level log — EVERY game from EVERY settled bet in the saved
 * history (within the 3-month window), flattened one row per game with its
 * real result and final score. This is the full "all past games" archive for
 * study, not a capped slice.
 */
export async function getDemoGamesLog(owner: string, limit = 4000): Promise<GameLogRow[]> {
  const bets = await getResultBets(owner);
  const rows: GameLogRow[] = [];
  for (const b of bets) {
    const legs = b.legs ?? [];
    for (const l of legs) {
      rows.push({
        betId: b.id,
        settledAt: b.settledAt ? b.settledAt.toISOString() : null,
        createdAt: b.createdAt.toISOString(),
        betOutcome: b.outcome,
        stake: b.stake,
        legsInBet: legs.length,
        home: l.home,
        away: l.away,
        league: l.league,
        pick: l.pick ?? l.pickCode,
        odds: l.odds,
        outcome: l.outcome ?? "PENDING",
        finalScore: l.finalScore,
      });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

export interface ArchiveBet {
  id: string;
  createdAt: string;
  settledAt: string | null;
  outcome: string;
  stake: number;
  totalOdds: number;
  potential: number;
  payout: number | null;
  origin: string;
  legs: DemoLeg[];
}

/**
 * Every past bet as a GROUPED slip (live + permanent archive), newest first —
 * the same ticket shape the wallet renders as cards. Powers the "all past
 * grouped bets together" archive view.
 */
export async function getDemoAllBets(owner: string): Promise<ArchiveBet[]> {
  const bets = await getResultBets(owner);
  return bets.map((b) => ({
    id: b.id,
    createdAt: b.createdAt.toISOString(),
    settledAt: b.settledAt ? b.settledAt.toISOString() : null,
    outcome: b.outcome,
    stake: b.stake,
    totalOdds: b.totalOdds,
    potential: b.potential,
    payout: b.payout,
    origin: b.origin,
    legs: b.legs,
  }));
}

export interface LeaderboardEntry {
  rank: number;
  label: string; // anonymized "Player-XXXX" — never the real owner id
  isYou: boolean;
  bets: number;
  won: number;
  lost: number;
  voided: number;
  hitRate: number | null;
  profit: number;
  roi: number | null;
  badges: string[];
}

/** Stable pseudonymous label from an owner string — no reversible identity. */
function anonLabel(owner: string): string {
  let h = 0;
  for (let i = 0; i < owner.length; i++) h = (h * 31 + owner.charCodeAt(i)) >>> 0;
  return `Player-${(h % 9000) + 1000}`;
}

/**
 * Cross-user leaderboard: every demo player's settled results (live + the
 * permanent archive), ranked by ROI. Virtual money only, so this is safe to
 * show across users — but owners are ANONYMIZED (hashed label), never a real
 * id/email. Requires a minimum sample size so one lucky bet can't top the
 * board on noise.
 */
export async function getDemoLeaderboard(
  viewerOwner: string | null,
  minBets = 5,
  limit = 20,
): Promise<LeaderboardEntry[]> {
  type Agg = { bets: number; won: number; lost: number; voided: number; staked: number; returned: number; streak: number };
  const byOwner = new Map<string, Agg>();
  const ensure = (owner: string): Agg => {
    let a = byOwner.get(owner);
    if (!a) {
      a = { bets: 0, won: 0, lost: 0, voided: 0, staked: 0, returned: 0, streak: 0 };
      byOwner.set(owner, a);
    }
    return a;
  };

  const wallets = await prisma.demoWallet.findMany({ select: { id: true, owner: true } });
  const ownerByWalletId = new Map(wallets.map((w) => [w.id, w.owner]));

  const [liveBets, archiveBets] = await Promise.all([
    prisma.demoBet.findMany({
      where: { outcome: { in: ["WON", "LOST", "VOID"] } },
      select: { walletId: true, outcome: true, stake: true, payout: true, settledAt: true, createdAt: true },
    }),
    prisma.demoArchive.findMany({
      where: { outcome: { in: ["WON", "LOST", "VOID"] } },
      select: { owner: true, outcome: true, stake: true, payout: true, settledAt: true, createdAt: true },
    }),
  ]);

  // Recency-ordered per owner (oldest→newest) to compute a genuine win streak.
  const chrono = new Map<string, { at: number; outcome: string }[]>();
  const push = (owner: string, outcome: string, stake: number, payout: number | null, at: Date) => {
    const a = ensure(owner);
    a.bets += 1;
    a.staked += stake;
    a.returned += payout ?? 0;
    if (outcome === "WON") a.won += 1;
    else if (outcome === "LOST") a.lost += 1;
    else a.voided += 1;
    if (!chrono.has(owner)) chrono.set(owner, []);
    chrono.get(owner)!.push({ at: at.getTime(), outcome });
  };
  for (const b of liveBets) {
    const owner = ownerByWalletId.get(b.walletId);
    if (owner) push(owner, b.outcome, b.stake, b.payout, b.settledAt ?? b.createdAt);
  }
  for (const b of archiveBets) {
    push(b.owner, b.outcome, b.stake, b.payout, b.settledAt ?? b.createdAt);
  }

  const entries: LeaderboardEntry[] = [];
  for (const [owner, a] of byOwner) {
    if (a.bets < minBets) continue;
    const decided = a.won + a.lost;
    const profit = Math.round((a.returned - a.staked) * 100) / 100;
    const roi = a.staked ? Math.round((profit / a.staked) * 1000) / 1000 : null;
    const hitRate = decided ? a.won / decided : null;
    // Current streak: consecutive WON from the most recent decided bet back.
    const chron = (chrono.get(owner) ?? []).filter((x) => x.outcome !== "VOID").sort((x, y) => y.at - x.at);
    let streak = 0;
    for (const x of chron) {
      if (x.outcome === "WON") streak += 1;
      else break;
    }
    const badges: string[] = [];
    if (streak >= 3) badges.push(`🔥 ${streak}-win streak`);
    if (hitRate !== null && decided >= 10 && hitRate >= 0.6) badges.push("🎯 Sharpshooter");
    if (roi !== null && roi >= 0.2 && a.bets >= 10) badges.push("💰 Profitable");
    entries.push({
      rank: 0,
      label: anonLabel(owner),
      isYou: viewerOwner === owner,
      bets: a.bets,
      won: a.won,
      lost: a.lost,
      voided: a.voided,
      hitRate,
      profit,
      roi,
      badges,
    });
  }
  entries.sort((x, y) => (y.roi ?? -Infinity) - (x.roi ?? -Infinity));
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries.slice(0, limit);
}

/** Fresh start: balance back to the starting bank (history is kept). */
export async function resetDemoWallet(owner: string): Promise<number> {
  const wallet = await getWallet(owner);
  await prisma.demoWallet.update({
    where: { id: wallet.id },
    data: { balance: DEMO_START_BALANCE, staked: 0, returned: 0, resetDay: watDay() },
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

/**
 * Retention: delete demo bets older than DEMO_RETENTION_DAYS so the archive
 * stays a rolling ~3 months and new games always have room. Runs each crawl
 * cycle (cheap, indexed). Wallet balances/analytics are untouched.
 */
export async function pruneOldDemoBets(): Promise<number> {
  const cutoff = new Date(Date.now() - DEMO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  // Copy each settled result into the PERMANENT archive BEFORE deleting the
  // live bet, so the study history is never lost. Bounded batch per cycle.
  const old = await prisma.demoBet.findMany({
    where: { createdAt: { lt: cutoff } },
    take: 500,
    include: { wallet: { select: { owner: true } } },
  });
  if (!old.length) return 0;
  for (const b of old) {
    if (b.outcome === "PENDING") continue; // never-settled stale bet — nothing to archive
    const legs = (b.legs as unknown as DemoLeg[]) ?? [];
    const compact = legs.map((l) => ({
      home: l.home,
      away: l.away,
      league: l.league,
      pick: l.pick ?? l.pickCode,
      odds: l.odds,
      outcome: l.outcome ?? "PENDING",
      finalScore: l.finalScore,
    }));
    await prisma.demoArchive
      .upsert({
        where: { origBetId: b.id },
        create: {
          owner: b.wallet.owner,
          origBetId: b.id,
          createdAt: b.createdAt,
          settledAt: b.settledAt,
          outcome: b.outcome,
          stake: b.stake,
          totalOdds: b.totalOdds,
          potential: b.potential,
          payout: b.payout,
          origin: b.origin,
          legs: compact as unknown as object[],
        },
        update: {},
      })
      .catch(() => {});
  }
  const { count } = await prisma.demoBet.deleteMany({ where: { id: { in: old.map((b) => b.id) } } });
  return count;
}

/** CSV of a wallet's full saved history (live + archived), one row per leg —
 *  opens in Excel. */
export async function exportDemoCsv(owner: string): Promise<string> {
  const bets = await getResultBets(owner);
  const watStr = (d: Date) =>
    d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Lagos",
    });
  const q = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = [
    "Bet ID",
    "Placed (WAT)",
    "Settled (WAT)",
    "Origin",
    "Bet outcome",
    "Stake (₦)",
    "Total odds",
    "Potential (₦)",
    "Payout (₦)",
    "Bet profit (₦)",
    "Match",
    "League",
    "Pick",
    "Leg odds",
    "Leg result",
    "Final score",
  ];
  const rows: string[] = [headers.join(",")];
  for (const b of bets) {
    const legs = (b.legs as unknown as DemoLeg[]) ?? [];
    const profit = b.outcome === "PENDING" ? "" : Math.round(((b.payout ?? 0) - b.stake) * 100) / 100;
    const base = [
      b.id,
      watStr(b.createdAt),
      b.settledAt ? watStr(b.settledAt) : "",
      b.origin,
      b.outcome,
      b.stake,
      b.totalOdds,
      b.potential,
      b.payout ?? "",
      profit,
    ];
    if (!legs.length) {
      rows.push([...base, "", "", "", "", "", ""].map(q).join(","));
      continue;
    }
    for (const l of legs) {
      rows.push(
        [
          ...base,
          `${l.home} v ${l.away}`,
          l.league ?? "",
          l.pick ?? l.pickCode,
          l.odds,
          l.outcome ?? "PENDING",
          l.finalScore ?? "",
        ]
          .map(q)
          .join(","),
      );
    }
  }
  // BOM so Excel reads UTF-8 team names correctly.
  return "﻿" + rows.join("\r\n");
}