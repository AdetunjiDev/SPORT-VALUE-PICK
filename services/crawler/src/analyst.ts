import { getPredictions, type ExtPrediction } from "./predictions.js";
import {
  getSportyFixtures,
  fuzzyTeamsMatch,
  bestOutcome,
  devig,
  CODE_SETS,
  type SbEvent,
  type GameType,
} from "./forebet-ai.js";
export type { GameType };

/**
 * "Expert Picks" engine.
 *
 * Scans SportyBet's OWN live fixture + odds feed directly — every league it
 * carries (100+), not just the handful our external prediction sources happen
 * to cover — so every pick returned is guaranteed bookable right now. This
 * matters in practice: external tips (Forebet etc.) often predict a DIFFERENT
 * fixture in the "same" league (e.g. a different regional zone of a lower
 * division) than what SportyBet is actually offering that day, so matching
 * backward from tips to SportyBet routinely comes up empty for anything but
 * the biggest tournaments. Starting from SportyBet's list avoids that entirely.
 *
 * Confidence blends:
 *   1. Market implied probability — SportyBet's own odds for the outcome
 *      (1 / odds). This is the primary, always-available signal.
 *   2. External agreement — if a Forebet / API-Football tip exists for the
 *      SAME fixture and picks the SAME outcome, confidence gets a boost and
 *      the model's win % is cited alongside the market price.
 *
 * A per-league cap keeps one big tournament (World Cup) from dominating every
 * slot — "search every other football game aside World Cup" — while still
 * ranking by confidence within that constraint.
 *
 * These are estimates ranked by confidence — NEVER guarantees. No pick is
 * "sure"; anyone claiming 99–100% guaranteed wins is misleading you.
 */

export interface ExpertPick {
  home: string;
  away: string;
  league?: string;
  kickoff?: string; // ISO
  pick: string; // human label, e.g. "Manchester City to Win"
  key: string; // "home|away" (lowercase) — bookable via /api/predictions/book
  confidence: number; // 0..1
  odds?: string;
  reasons: string[];
  signals: string[]; // extra market insights (goals lean, BTTS, safest cover…)
  source: string;
  url?: string;
  eventId?: string; // SportyBet sr:match: id — for result tracking
  pickCode?: string; // 1 | X | 2 | O15 | … — for settlement
  market?: string; // "1X2" | "Over/Under" | "Double Chance" | …
}

const PICK_LABEL: Record<string, (h: string, a: string) => string> = {
  "1": (h) => `${h} to Win`,
  X: () => "Draw",
  "2": (_h, a) => `${a} to Win`,
  O15: () => "Over 1.5 Goals",
  O25: () => "Over 2.5 Goals",
  O35: () => "Over 3.5 Goals",
  U15: () => "Under 1.5 Goals",
  U25: () => "Under 2.5 Goals",
  U35: () => "Under 3.5 Goals",
  DC1X: (h) => `${h} or Draw (Double Chance)`,
  DC12: (h, a) => `${h} or ${a} (Double Chance)`,
  DCX2: (_h, a) => `Draw or ${a} (Double Chance)`,
  DNBH: (h) => `${h} (Draw No Bet)`,
  DNBA: (_h, a) => `${a} (Draw No Bet)`,
  BTTSY: () => "Both Teams To Score",
  BTTSN: () => "Both Teams NOT To Score",
  HO05: (h) => `${h} Over 0.5 Goals`,
  HO15: (h) => `${h} Over 1.5 Goals`,
  HU15: (h) => `${h} Under 1.5 Goals`,
  AO05: (_h, a) => `${a} Over 0.5 Goals`,
  AO15: (_h, a) => `${a} Over 1.5 Goals`,
  AU15: (_h, a) => `${a} Under 1.5 Goals`,
};

// Market group label for a pick code (shown on the card).
function marketOf(code: string): string {
  if (code === "1" || code === "X" || code === "2") return "1X2";
  if (code.startsWith("DC")) return "Double Chance";
  if (code.startsWith("DNB")) return "Draw No Bet";
  if (code.startsWith("BTTS")) return "BTTS";
  if (code[0] === "H" || code[0] === "A") return "Team Goals";
  return "Over/Under";
}

/**
 * Extra per-match research: since we now pull every fixture's Double Chance,
 * BTTS, Over/Under and team-goal prices, we can surface supporting signals that
 * a seasoned analyst would check before backing a pick — e.g. "goals expected"
 * or "safest cover: Home or Draw". Derived from the same de-vigged odds, so
 * they're real market reads, not invented. Corner/card markets are NOT offered
 * by SportyBet's feed, so those are honestly not shown.
 */
function matchInsights(ev: SbEvent, pickCode: string): string[] {
  const out: string[] = [];
  const p = (code: string) => {
    const o = ev.outcomes[code];
    return o && o > 1 ? Math.round(devig(ev.outcomes, code) * 100) : 0;
  };
  // Goals lean (Over/Under 2.5)
  const o25 = p("O25");
  const u25 = p("U25");
  if (o25 || u25) {
    out.push(o25 >= u25 ? `Goals likely — Over 2.5 ${o25}%` : `Tight game — Under 2.5 ${u25}%`);
  }
  // Both teams to score
  const by = p("BTTSY");
  const bn = p("BTTSN");
  if (by || bn) out.push(by >= bn ? `Both to score ${by}%` : `A clean sheet likely (BTTS No ${bn}%)`);
  // Safest cover for a straight win pick = the matching double chance
  if (pickCode === "1" && p("DC1X")) out.push(`Safer cover: ${ev.home} or Draw ${p("DC1X")}%`);
  if (pickCode === "2" && p("DCX2")) out.push(`Safer cover: Draw or ${ev.away} ${p("DCX2")}%`);
  // Each team to score at least once (supports over/BTTS picks)
  const ho = p("HO05");
  const ao = p("AO05");
  if ((pickCode.startsWith("O") || pickCode.startsWith("BTTS")) && ho && ao) {
    out.push(`${ev.home} score ${ho}% · ${ev.away} score ${ao}%`);
  }
  return out.slice(0, 3);
}

export interface ExpertOptions {
  count: number; // how many picks the user wants (1..50)
  days: number; // window: fixtures within the next N days (1..30 — "a month")
  gameType?: GameType; // "result" (1X2, default) | "goals" (O/U) | "both"
  minConfidence?: number; // 0..1 floor on the (de-vigged) confidence %; default 0
  maxPerLeague?: number; // diversity cap; default scales with count
  seed?: number; // rotation for variety across refreshes
}

export interface ExpertResult {
  picks: ExpertPick[];
  requested: number;
  windowDays: number;
  // Fixtures that qualified (in-window, has an odds-based pick) before the
  // per-league diversity cap and the final count slice — lets the UI explain
  // honestly why fewer than requested came back.
  poolSize: number;
}

/** A same-fixture external tip (Forebet / API-Football), if one exists. */
function findExternalTip(ev: SbEvent, preds: ExtPrediction[]): ExtPrediction | undefined {
  return preds.find(
    (p) => p.home && p.away && fuzzyTeamsMatch(p.home, ev.home) && fuzzyTeamsMatch(p.away, ev.away),
  );
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** The N highest-confidence, GUARANTEED-BOOKABLE picks within the window. */
export async function getExpertPicks(opts: ExpertOptions): Promise<ExpertResult> {
  const count = Math.max(1, Math.min(70, Math.floor(opts.count) || 5));
  const days = Math.max(1, Math.min(30, Math.floor(opts.days) || 5)); // up to a month out
  const gameType = opts.gameType ?? "result";
  const codes = CODE_SETS[gameType] ?? CODE_SETS.result;
  const minConf = opts.minConfidence ?? 0;
  // Diversity cap: scales with how many picks were asked for, floor of 3, so a
  // big request still spreads across leagues instead of one tournament
  // filling every slot. (count=5 → cap 3; count=20 → cap 5; count=50 → cap 15)
  const maxPerLeague = opts.maxPerLeague ?? Math.max(3, Math.ceil(count / 4) + 2);

  const now = Date.now();
  const maxT = now + days * 86_400_000;

  const [fixtures, preds] = await Promise.all([
    getSportyFixtures().catch(() => [] as SbEvent[]),
    getPredictions().catch(() => [] as ExtPrediction[]),
  ]);

  const scored: ExpertPick[] = [];
  for (const ev of fixtures) {
    if (!ev.kickoff || ev.kickoff <= now || ev.kickoff > maxT) continue; // in window only
    const fav = bestOutcome(ev, codes);
    if (!fav) continue; // no usable price for this fixture/game-type right now

    const reasons: string[] = [
      `market odds ${fav.odds.toFixed(2)} (${Math.round(fav.implied * 100)}% fair probability, bookmaker margin removed)`,
    ];
    let confidence = fav.implied;

    const tip = findExternalTip(ev, preds);
    if (tip?.predCode === fav.code) {
      // External model agrees with SportyBet's own favourite — real signal
      // agreement, not just one source's opinion. Model win % is only
      // meaningful for 1X2 picks (Forebet's probs array is home/draw/away).
      const modelPct =
        fav.code === "1"
          ? tip.probs?.[0]
          : fav.code === "X"
            ? tip.probs?.[1]
            : fav.code === "2"
              ? tip.probs?.[2]
              : undefined;
      if (modelPct) {
        confidence = confidence * 0.6 + (modelPct / 100) * 0.4;
        reasons.push(`${modelPct}% model win probability (${tip.source})`);
      }
      confidence = Math.min(0.95, confidence + 0.05);
      reasons.push(`confirmed by ${tip.source}`);
    }

    const label = (PICK_LABEL[fav.code] ?? (() => fav.code))(ev.home, ev.away);
    scored.push({
      home: ev.home,
      away: ev.away,
      league: ev.league,
      kickoff: new Date(ev.kickoff).toISOString(),
      pick: label,
      key: `${ev.home}|${ev.away}`.toLowerCase(),
      confidence: round(Math.min(0.95, confidence)),
      odds: fav.odds.toFixed(2),
      reasons,
      signals: matchInsights(ev, fav.code),
      source: tip ? `SportyBet + ${tip.source}` : "SportyBet odds",
      eventId: ev.eventId,
      pickCode: fav.code,
      market: marketOf(fav.code),
    });
  }

  const eligible = scored.filter((p) => p.confidence >= minConf);
  eligible.sort((a, b) => b.confidence - a.confidence);

  // Greedy selection with a per-league cap so one tournament (World Cup, the
  // biggest thing on the board right now) can't fill every slot — spreads
  // across whatever other leagues SportyBet is carrying today.
  const leagueCount = new Map<string, number>();
  const diversified: ExpertPick[] = [];
  for (const p of eligible) {
    const lg = p.league ?? "—";
    const n = leagueCount.get(lg) ?? 0;
    if (n >= maxPerLeague) continue;
    leagueCount.set(lg, n + 1);
    diversified.push(p);
  }
  // If the cap left slots unfilled (few leagues in total), backfill from the
  // remainder ignoring the cap rather than under-deliver on the count.
  if (diversified.length < Math.min(count, eligible.length)) {
    const used = new Set(diversified.map((p) => p.key));
    for (const p of eligible) {
      if (diversified.length >= Math.min(count + 6, eligible.length)) break;
      if (!used.has(p.key)) {
        used.add(p.key);
        diversified.push(p);
      }
    }
    diversified.sort((a, b) => b.confidence - a.confidence);
  }

  // Rotate within a slightly wider top band for variety across refreshes.
  const band = diversified.slice(0, Math.min(diversified.length, count + 6));
  const off = band.length ? (((opts.seed ?? 0) % band.length) + band.length) % band.length : 0;
  const chosen = band.slice(off).concat(band.slice(0, off)).slice(0, count);

  // Present soonest kick-off first.
  chosen.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
  return { picks: chosen, requested: count, windowDays: days, poolSize: eligible.length };
}

// =====================================================================
// VALUE PICKS — higher-odds opportunities with a genuine model edge
// =====================================================================
// A value bet = where an INDEPENDENT model (Forebet / API-Football) rates an
// outcome MORE likely than SportyBet's price implies. Edge = model prob −
// de-vigged market prob; EV = model prob × odds − 1. We only surface positive-
// edge picks at meaningful odds — real overlays, not invented ones. Coverage
// is limited to fixtures an external model actually covers (honest constraint).

export interface ValuePick extends ExpertPick {
  edge: number; // model prob − market implied (0..1)
  ev: number; // expected value: modelProb × odds − 1
  modelProb: number; // the external model's probability for this outcome
}

export interface ValueResult {
  picks: ValuePick[];
  requested: number;
  windowDays: number;
  scanned: number; // fixtures with an external model opinion we could compare
}

export interface ValueOptions {
  count: number;
  days: number;
  minEdge?: number; // default 0.06 (6-point overlay)
  minOdds?: number; // default 1.7 — value needs some price
  maxOdds?: number; // default 6 — cap wild longshots
  maxEv?: number; // default 0.45 — reject implausibly high EV (model error, not value)
  seed?: number;
}

export async function getValuePicks(opts: ValueOptions): Promise<ValueResult> {
  const count = Math.max(1, Math.min(70, Math.floor(opts.count) || 5));
  const days = Math.max(1, Math.min(30, Math.floor(opts.days) || 7));
  const minEdge = opts.minEdge ?? 0.06;
  const minOdds = opts.minOdds ?? 1.7;
  const maxOdds = opts.maxOdds ?? 6;
  // Genuine value edges are modest (5–25% EV). Anything much higher means the
  // model disagrees with the market so wildly that the MODEL is almost
  // certainly wrong (common in low-data leagues) — that's noise, not value, so
  // we reject it rather than headline a fake "+100% EV" pick.
  const maxEv = opts.maxEv ?? 0.45;

  const now = Date.now();
  const maxT = now + days * 86_400_000;
  const [fixtures, preds] = await Promise.all([
    getSportyFixtures().catch(() => [] as SbEvent[]),
    getPredictions().catch(() => [] as ExtPrediction[]),
  ]);

  const RESULT = ["1", "X", "2"] as const;
  const scoredVal: ValuePick[] = [];
  let scanned = 0;
  for (const ev of fixtures) {
    if (!ev.kickoff || ev.kickoff <= now || ev.kickoff > maxT) continue;
    const tip = findExternalTip(ev, preds);
    if (!tip?.probs) continue; // need an independent model probability
    scanned += 1;

    // Evaluate each 1X2 outcome for a positive edge; keep the best EV.
    let best: { code: string; odds: number; edge: number; ev: number; modelProb: number } | null = null;
    for (const code of RESULT) {
      const odds = ev.outcomes[code];
      if (!odds || odds < minOdds || odds > maxOdds) continue;
      const idx = code === "1" ? 0 : code === "X" ? 1 : 2;
      const modelProb = (tip.probs[idx] ?? 0) / 100;
      if (modelProb <= 0) continue;
      // Domain sanity: a true draw probability rarely exceeds ~42%. A model
      // claiming more is unreliable for this fixture — skip (kills draw-spam
      // from low-data leagues).
      if (code === "X" && modelProb > 0.42) continue;
      const marketProb = devig(ev.outcomes, code);
      const edge = modelProb - marketProb;
      const evv = modelProb * odds - 1;
      if (edge < minEdge || evv <= 0 || evv > maxEv) continue;
      if (!best || evv > best.ev) best = { code, odds, edge, ev: evv, modelProb };
    }
    if (!best) continue;

    const label = (PICK_LABEL[best.code] ?? (() => best.code))(ev.home, ev.away);
    const reasons = [
      `${tip.source} model rates this ${Math.round(best.modelProb * 100)}%`,
      `market prices ${Math.round((1 / best.odds) * 100)}% (odds ${best.odds.toFixed(2)})`,
      `+${Math.round(best.edge * 100)}pt edge · EV +${Math.round(best.ev * 100)}%`,
    ];
    if (tip.analysis) reasons.push(String(tip.analysis).slice(0, 120));
    scoredVal.push({
      home: ev.home,
      away: ev.away,
      league: ev.league,
      kickoff: new Date(ev.kickoff).toISOString(),
      pick: label,
      // Explicit outcome code in the key so booking books THIS pick (the value
      // outcome), not the market favourite.
      key: `${ev.home}|${ev.away}|${best.code}`.toLowerCase(),
      confidence: round(best.modelProb),
      odds: best.odds.toFixed(2),
      reasons,
      signals: matchInsights(ev, best.code),
      source: `${tip.source} vs SportyBet`,
      url: tip.url, // link to the model's own match analysis page
      eventId: ev.eventId,
      pickCode: best.code,
      market: "1X2",
      edge: round(best.edge),
      ev: round(best.ev),
      modelProb: round(best.modelProb),
    });
  }

  scoredVal.sort((a, b) => b.ev - a.ev); // best expected value first
  // Light league diversity so it isn't all one competition.
  const perLeague = new Map<string, number>();
  const cap = Math.max(3, Math.ceil(count / 3));
  const diversified = scoredVal.filter((p) => {
    const lg = p.league ?? "—";
    const n = perLeague.get(lg) ?? 0;
    if (n >= cap) return false;
    perLeague.set(lg, n + 1);
    return true;
  });
  const pool = diversified.length >= count ? diversified : scoredVal;
  const band = pool.slice(0, Math.min(pool.length, count + 5));
  const off = band.length ? (((opts.seed ?? 0) % band.length) + band.length) % band.length : 0;
  const picks = band.slice(off).concat(band.slice(0, off)).slice(0, count);
  picks.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
  return { picks, requested: count, windowDays: days, scanned };
}

// =====================================================================
// COMBOS — ready-made accumulators auto-assembled from the best picks
// =====================================================================
// Combines multiple picks into one slip at different risk/odds tiers, so the
// user can book a whole "combined game" in one click. Value combos are built
// from the model-edge Value Picks (football — the only sport we can model);
// banker/big-odds combos from the confidence engine. Combined odds = product
// of the legs. Refreshed every cycle (rotation seed), all legs bookable.

export interface ComboLeg {
  home: string;
  away: string;
  league?: string;
  kickoff?: string;
  pick: string;
  odds: number;
  key: string; // bookable key (carries the explicit outcome code)
  confidence: number; // 0..1 for this leg
  ev?: number; // value legs only
}
export interface Combo {
  id: string;
  title: string;
  emoji: string;
  kind: "value" | "safe" | "big";
  note: string;
  legs: ComboLeg[];
  combinedOdds: number;
  avgConfidence: number | null; // mean model/confidence across legs
  totalEv: number | null; // combined EV for value combos (∏(1+ev) − 1)
}

const asLeg = (p: {
  home: string;
  away: string;
  league?: string;
  kickoff?: string;
  pick: string;
  odds?: string;
  key: string;
  pickCode?: string;
  confidence: number;
  ev?: number;
}): ComboLeg => ({
  home: p.home,
  away: p.away,
  league: p.league,
  kickoff: p.kickoff,
  pick: p.pick,
  odds: Number(p.odds) || 0,
  // Always carry the EXACT pick code in the key so booking reproduces the
  // displayed selection (e.g. a Double Chance safe pick), not the re-derived
  // 1X2 favourite. Value keys are already home|away|code; this makes all combo
  // legs consistent.
  key: p.pickCode ? `${p.home}|${p.away}|${p.pickCode}`.toLowerCase() : p.key,
  confidence: p.confidence,
  ev: p.ev,
});
const comboOdds = (legs: ComboLeg[]) => round(legs.reduce((a, l) => a * (l.odds || 1), 1), 2);
const comboConf = (legs: ComboLeg[]) =>
  legs.length ? round(legs.reduce((a, l) => a + l.confidence, 0) / legs.length) : null;
const comboEv = (legs: ComboLeg[]) =>
  legs.some((l) => l.ev !== undefined)
    ? round(legs.reduce((a, l) => a * (1 + (l.ev ?? 0)), 1) - 1)
    : null;

/**
 * Auto-build a menu of ready-made accumulators to choose from. Pulls the
 * current Value Picks (edge-based) and Safe/Result Expert Picks, then composes
 * several combos across odds tiers. Sparse inputs simply yield fewer combos.
 */
export async function getCombos(seed = 0): Promise<Combo[]> {
  const [safe, value, result] = await Promise.all([
    getExpertPicks({ count: 30, days: 21, gameType: "safe", minConfidence: 0.7, seed }),
    getValuePicks({ count: 25, days: 21, seed }),
    getExpertPicks({ count: 40, days: 21, gameType: "result", minConfidence: 0.55, seed }),
  ]);
  const combos: Combo[] = [];
  const push = (
    id: string,
    title: string,
    emoji: string,
    kind: Combo["kind"],
    note: string,
    legs: ComboLeg[],
  ) => {
    combos.push({
      id,
      title,
      emoji,
      kind,
      note,
      legs,
      combinedOdds: comboOdds(legs),
      avgConfidence: comboConf(legs),
      totalEv: comboEv(legs),
    });
  };

  // ---- Banker / safe combos (high hit-rate, short combined odds) ----
  const safeP = safe.picks;
  if (safeP.length >= 3)
    push("banker3", "Banker Treble", "🏦", "safe", "3 highest-confidence safe picks — the steady one", safeP.slice(0, 3).map(asLeg));
  if (safeP.length >= 5)
    push("safe5", "Five-Fold Banker", "🎯", "safe", "5 short-priced picks — bigger combined odds, still high hit-rate", safeP.slice(0, 5).map(asLeg));

  // ---- Value combos (model edge; combined EV compounds) ----
  const vsorted = [...value.picks].sort((a, b) => b.ev - a.ev);
  if (vsorted.length >= 2)
    push("value2", "Value Double", "💎", "value", "The 2 strongest overlays combined", vsorted.slice(0, 2).map(asLeg));
  if (vsorted.length >= 3)
    push("value3", "Value Treble", "💎", "value", "Top 3 model-edge picks — higher odds", vsorted.slice(0, 3).map(asLeg));
  if (vsorted.length >= 5)
    push("value5", "Value Accumulator", "💎", "value", "5 overlays — high odds, higher variance", vsorted.slice(0, 5).map(asLeg));

  // ---- Big-odds combo (bigger payout from higher-priced favourites) ----
  const bigLegs = result.picks
    .filter((p) => Number(p.odds) >= 1.7)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4)
    .map(asLeg);
  if (bigLegs.length >= 4)
    push("big4", "Big-Odds Four", "🚀", "big", "4 confident but higher-priced results — for a bigger payout", bigLegs);

  return combos;
}

// =====================================================================
// TRACK RECORD — honest, auditable hit-rate for Expert Picks
// =====================================================================
// Each cycle we log the engine's current top recommendations, then settle
// finished ones against SportyBet's OWN final score (factsCenter/event, keyed
// by the SportyBet event id we already store) — no external API, no
// cross-matching. Over time this proves whether the confidence % is real.

import { prisma } from "@sportybet/db";
import { config } from "./config.js";

const EVENT_API = "https://www.sportybet.com/api/ng/factsCenter/event?eventId=";

/**
 * Snapshot the engine's current top result-market picks into the log (deduped
 * by event+pickCode). Logs a broad, confidence-diverse set — not just the very
 * top — so the record can show calibration across confidence bands.
 */
export async function logExpertPicks(): Promise<number> {
  // A wide, 7-day result-market sweep with no confidence floor and a generous
  // per-league cap gives a representative sample of what the engine recommends.
  const { picks } = await getExpertPicks({
    count: 40,
    days: 7,
    gameType: "result",
    minConfidence: 0,
    maxPerLeague: 8,
  });
  let logged = 0;
  for (const p of picks) {
    if (!p.eventId || !p.pickCode || !p.kickoff) continue;
    try {
      await prisma.expertPickLog.upsert({
        where: { eventId_pickCode: { eventId: p.eventId, pickCode: p.pickCode } },
        // Never overwrite a settled/confidence record; keep the first read.
        update: {},
        create: {
          eventId: p.eventId,
          home: p.home,
          away: p.away,
          league: p.league,
          kickoff: new Date(p.kickoff),
          market: p.market ?? "1X2",
          pickCode: p.pickCode,
          pickLabel: p.pick,
          confidence: p.confidence,
          odds: Number(p.odds) || 0,
        },
      });
      logged += 1;
    } catch {
      /* dupe race / transient — skip */
    }
  }
  return logged;
}

/** Did this pick win, given a "H:A" final score? null = void/unknown. */
function settlePick(pickCode: string, score: string): boolean | null {
  const m = score.match(/(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  const h = Number(m[1]);
  const a = Number(m[2]);
  const total = h + a;
  switch (pickCode) {
    case "1":
      return h > a;
    case "X":
      return h === a;
    case "2":
      return h < a;
    case "O15":
      return total >= 2;
    case "O25":
      return total >= 3;
    case "O35":
      return total >= 4;
    case "U15":
      return total <= 1;
    case "U25":
      return total <= 2;
    case "U35":
      return total <= 3;
    // Double Chance
    case "DC1X":
      return h >= a;
    case "DC12":
      return h !== a;
    case "DCX2":
      return h <= a;
    // Draw No Bet (a draw → null = VOID / stake refunded)
    case "DNBH":
      return h === a ? null : h > a;
    case "DNBA":
      return h === a ? null : h < a;
    // Both Teams To Score
    case "BTTSY":
      return h > 0 && a > 0;
    case "BTTSN":
      return h === 0 || a === 0;
    // Per-team goals
    case "HO05":
      return h >= 1;
    case "HO15":
      return h >= 2;
    case "HU15":
      return h <= 1;
    case "AO05":
      return a >= 1;
    case "AO15":
      return a >= 2;
    case "AU15":
      return a <= 1;
    default:
      return null;
  }
}

async function fetchEventScore(
  eventId: string,
): Promise<{ ended: boolean; score?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(`${EVENT_API}${encodeURIComponent(eventId)}`, {
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        Referer: "https://www.sportybet.com/",
        ClientId: "web",
      },
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => null);
    const d = json?.data;
    if (!d) return null;
    // status 4 / matchStatus "Ended" = finished; setScore is "H:A".
    const ended = Number(d.status) === 4 || d.matchStatus === "Ended";
    return { ended, score: d.setScore ?? undefined };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle logged picks whose match has finished (kickoff older than ~2.5h),
 * against SportyBet's own final score. Capped per cycle to stay polite.
 */
export async function settleExpertPicks(limit = 12): Promise<{ settled: number; won: number }> {
  const cutoff = new Date(Date.now() - 2.5 * 60 * 60 * 1000); // give matches time to finish
  const pending = await prisma.expertPickLog.findMany({
    where: { outcome: "PENDING", kickoff: { lt: cutoff } },
    orderBy: { kickoff: "asc" },
    take: limit,
  });
  let settled = 0;
  let won = 0;
  for (const p of pending) {
    const r = await fetchEventScore(p.eventId);
    if (!r) continue;
    if (!r.ended || !r.score) {
      // Not finished after this long (postponed/abandoned) — void after 24h.
      if (Date.now() - p.kickoff.getTime() > 24 * 60 * 60 * 1000) {
        await prisma.expertPickLog.update({
          where: { id: p.id },
          data: { outcome: "VOID", settledAt: new Date() },
        });
      }
      continue;
    }
    const win = settlePick(p.pickCode, r.score);
    if (win === null) {
      await prisma.expertPickLog.update({
        where: { id: p.id },
        data: { outcome: "VOID", finalScore: r.score, settledAt: new Date() },
      });
      continue;
    }
    await prisma.expertPickLog.update({
      where: { id: p.id },
      data: { outcome: win ? "WON" : "LOST", finalScore: r.score, settledAt: new Date() },
    });
    settled += 1;
    if (win) won += 1;
    await new Promise((res) => setTimeout(res, 300)); // polite pacing
  }
  return { settled, won };
}

export interface RecordBand {
  label: string;
  lo: number;
  hi: number;
  won: number;
  lost: number;
  total: number;
  hitRate: number | null; // null until any settled
}

export interface ExpertRecord {
  totalSettled: number;
  won: number;
  lost: number;
  hitRate: number | null;
  pending: number;
  bands: RecordBand[];
  recent: {
    home: string;
    away: string;
    pickLabel: string;
    confidence: number;
    outcome: string;
    finalScore: string | null;
    kickoff: Date;
  }[];
}

/** Aggregate the settled log into an overall + per-confidence-band hit rate. */
export async function getExpertRecord(): Promise<ExpertRecord> {
  const [settledRows, pendingCount, recent] = await Promise.all([
    prisma.expertPickLog.findMany({
      where: { outcome: { in: ["WON", "LOST"] } },
      select: { confidence: true, outcome: true },
    }),
    prisma.expertPickLog.count({ where: { outcome: "PENDING" } }),
    prisma.expertPickLog.findMany({
      where: { outcome: { in: ["WON", "LOST", "VOID"] } },
      orderBy: { settledAt: "desc" },
      take: 12,
      select: {
        home: true,
        away: true,
        pickLabel: true,
        confidence: true,
        outcome: true,
        finalScore: true,
        kickoff: true,
      },
    }),
  ]);

  const bandDefs: [string, number, number][] = [
    ["50–59%", 0.5, 0.6],
    ["60–69%", 0.6, 0.7],
    ["70–79%", 0.7, 0.8],
    ["80–89%", 0.8, 0.9],
    ["90%+", 0.9, 1.01],
  ];
  const bands: RecordBand[] = bandDefs.map(([label, lo, hi]) => {
    const inBand = settledRows.filter((r) => r.confidence >= lo && r.confidence < hi);
    const won = inBand.filter((r) => r.outcome === "WON").length;
    const total = inBand.length;
    return {
      label,
      lo,
      hi,
      won,
      lost: total - won,
      total,
      hitRate: total ? won / total : null,
    };
  });

  const won = settledRows.filter((r) => r.outcome === "WON").length;
  const total = settledRows.length;
  return {
    totalSettled: total,
    won,
    lost: total - won,
    hitRate: total ? won / total : null,
    pending: pendingCount,
    bands,
    recent,
  };
}

// =====================================================================
// ROI / PROFIT — does flat-staking the picks actually make money?
// =====================================================================
// The honest test of a tipster: not hit-rate, but return on investment.
// Flat stake = 1 unit per settled pick. WON → +(odds−1), LOST → −1, VOID → 0
// (stake refunded, so it doesn't count toward staked). ROI = profit / staked.

export interface RoiBand {
  label: string;
  settled: number;
  won: number;
  profit: number;
  roi: number | null;
}
export interface ExpertRoi {
  settled: number; // WON + LOST (void excluded — stake refunded)
  won: number;
  lost: number;
  voided: number;
  staked: number; // = settled (1 unit each)
  profit: number; // units
  roi: number | null; // profit / staked
  avgOdds: number | null;
  bands: RoiBand[];
  markets: RoiBand[]; // reuse shape, label = market
  curve: number[]; // cumulative profit after each settled pick, in time order
}

const profitOf = (outcome: string, odds: number): number =>
  outcome === "WON" ? odds - 1 : outcome === "LOST" ? -1 : 0;

export async function getExpertRoi(): Promise<ExpertRoi> {
  const rows = await prisma.expertPickLog.findMany({
    where: { outcome: { in: ["WON", "LOST", "VOID"] } },
    orderBy: { settledAt: "asc" },
    select: { confidence: true, odds: true, outcome: true, market: true },
  });

  const nonVoid = rows.filter((r) => r.outcome !== "VOID");
  const won = nonVoid.filter((r) => r.outcome === "WON").length;
  const staked = nonVoid.length;
  const profit = nonVoid.reduce((a, r) => a + profitOf(r.outcome, r.odds), 0);
  const avgOdds = staked ? nonVoid.reduce((a, r) => a + r.odds, 0) / staked : null;

  // Cumulative profit curve (settled non-void picks, in settle order).
  let run = 0;
  const curve = nonVoid.map((r) => {
    run += profitOf(r.outcome, r.odds);
    return round(run, 2);
  });

  // By confidence band.
  const bandDefs: [string, number, number][] = [
    ["50–59%", 0.5, 0.6],
    ["60–69%", 0.6, 0.7],
    ["70–79%", 0.7, 0.8],
    ["80–89%", 0.8, 0.9],
    ["90%+", 0.9, 1.01],
  ];
  const bands: RoiBand[] = bandDefs.map(([label, lo, hi]) => {
    const inb = nonVoid.filter((r) => r.confidence >= lo && r.confidence < hi);
    const p = inb.reduce((a, r) => a + profitOf(r.outcome, r.odds), 0);
    return {
      label,
      settled: inb.length,
      won: inb.filter((r) => r.outcome === "WON").length,
      profit: round(p, 2),
      roi: inb.length ? round(p / inb.length, 4) : null,
    };
  });

  // By market.
  const marketNames = [...new Set(nonVoid.map((r) => r.market))];
  const markets: RoiBand[] = marketNames
    .map((mk) => {
      const inm = nonVoid.filter((r) => r.market === mk);
      const p = inm.reduce((a, r) => a + profitOf(r.outcome, r.odds), 0);
      return {
        label: mk,
        settled: inm.length,
        won: inm.filter((r) => r.outcome === "WON").length,
        profit: round(p, 2),
        roi: inm.length ? round(p / inm.length, 4) : null,
      };
    })
    .sort((a, b) => b.settled - a.settled);

  return {
    settled: staked,
    won,
    lost: staked - won,
    voided: rows.length - staked,
    staked,
    profit: round(profit, 2),
    roi: staked ? round(profit / staked, 4) : null,
    avgOdds: avgOdds ? round(avgOdds, 2) : null,
    bands,
    markets,
    curve,
  };
}
