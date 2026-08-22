import { getPredictions, type ExtPrediction } from "./predictions.js";
import {
  getSportyFixtures,
  fuzzyTeamsMatch,
  bestOutcome,
  devig,
  CODE_SETS,
  RESULT_CODES,
  DC_CODES,
  type SbEvent,
  type GameType,
} from "./forebet-ai.js";
import { getFormsForMatches, type MatchForm, type TeamForm } from "./form.js";
import { generateMatchValueInsight } from "./bytez.js";
import { analyzeEvent } from "./xg.js";
import {
  intelEnabled,
  getTeamMomentum,
  getMatchIntel,
  analyzeBankerLock,
  analyzeUpsetPotential,
  type MomentumResult,
  type BankerLockResult,
  type GiantKillerResult,
  type TrapGameResult,
  type MatchIntelReport,
} from "./apifootball-intel.js";
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
  // --- Intel features (API-Football powered) ---
  homeMomentum?: MomentumResult;
  awayMomentum?: MomentumResult;
  bankerLock?: BankerLockResult;
  giantKiller?: GiantKillerResult;
  trapGame?: TrapGameResult;
  intelReport?: MatchIntelReport;
}

const PICK_LABEL: Record<string, (h: string, a: string) => string> = {
  "1": (h) => `${h} to Win`,
  X: () => "Draw",
  "2": (_h, a) => `${a} to Win`,
  O05: () => "Over 0.5 Goals",
  O15: () => "Over 1.5 Goals",
  O25: () => "Over 2.5 Goals",
  O35: () => "Over 3.5 Goals",
  U05: () => "Under 0.5 Goals (no goals)",
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

// =====================================================================
// FORM-AWARE REFINEMENT — real recent results, not a blanket home prior
// =====================================================================
// Pure market odds structurally favour "Home or Draw": Double Chance picks
// whichever pair excludes the least-likely single outcome, and across a
// broad set of fixtures that's usually "Away win" (home advantage is a real,
// well-documented effect). Left unchecked, that means the safe-pick engine
// reflexively lands on DC1X ("Home or Draw") on nearly every match — a
// blanket prior, not analysis. A professional scout weighs CURRENT status —
// who's actually won recently — and lets that flip the read when it disagrees
// with the market. This section blends real recent results (already fetched
// and durably cached elsewhere in the app) into the 1X2/Double-Chance choice,
// so the pick can genuinely become "Draw or Away" or a straight result when
// the data supports it. It only ever moves the needle on real, sufficient
// data (3+ games for BOTH teams) — no data, no adjustment, never an invented
// edge from a hunch or a thin sample.
const FORM_WEIGHT = 0.16; // bounded nudge: max ~16pt shift on a maximal form gap

/** Points-per-game from real recent results, 0..1 — null if fewer than 3 games. */
function ppg(f: TeamForm | null | undefined): number | null {
  if (!f || f.matches.length < 3) return null;
  const pts = f.matches.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  return pts / (3 * f.matches.length);
}

interface Triple {
  pHome: number;
  pDraw: number;
  pAway: number;
}

/**
 * Blend real recent-form into the market-implied 1X2 read. Draw is left at
 * the market level (recent form is a weak predictor of draws either way);
 * mass shifts between home/away in proportion to the PPG gap. No-ops
 * (returns the raw market read) when either team lacks 3+ games of form.
 */
export function formAdjustedTriple(ev: SbEvent, form: MatchForm | null): Triple {
  const mH = devig(ev.outcomes, "1");
  const mD = devig(ev.outcomes, "X");
  const mA = devig(ev.outcomes, "2");
  const homePpg = ppg(form?.home);
  const awayPpg = ppg(form?.away);
  if (homePpg === null || awayPpg === null || (!mH && !mD && !mA)) return { pHome: mH, pDraw: mD, pAway: mA };
  const shift = (homePpg - awayPpg) * FORM_WEIGHT; // homePpg, awayPpg ∈ [0,1] → shift ∈ [-0.16, 0.16]
  const pHome = Math.max(0.02, Math.min(0.95, mH + shift));
  const pAway = Math.max(0.02, Math.min(0.95, mA - shift));
  const total = pHome + mD + pAway || 1;
  return { pHome: pHome / total, pDraw: mD / total, pAway: pAway / total };
}

/**
 * Like bestOutcome(), but re-ranks RESULT (1/X/2) and DOUBLE CHANCE
 * (DC1X/DC12/DCX2) candidates using the form-adjusted triple instead of the
 * raw market read — so the "safest cover" reflects actual current team
 * status. Only these six codes are affected; goals/BTTS/team-goals picks are
 * untouched (this isn't the market bias those markets have).
 */
export function formAwareBestOutcome(
  ev: SbEvent,
  codes: readonly string[],
  triple: Triple,
): { code: string; odds: number; implied: number } | null {
  const derived: Partial<Record<string, number>> = {
    "1": triple.pHome,
    X: triple.pDraw,
    "2": triple.pAway,
    DC1X: triple.pHome + triple.pDraw,
    DC12: triple.pHome + triple.pAway,
    DCX2: triple.pDraw + triple.pAway,
  };
  let best: { code: string; odds: number; implied: number } | null = null;
  for (const code of codes) {
    const odds = ev.outcomes[code];
    if (!odds || odds <= 1) continue;
    const implied = derived[code];
    if (implied === undefined) continue; // only the 6 result/DC codes are form-refined
    if (!best || implied > best.implied) best = { code, odds, implied };
  }
  return best;
}

const RESULT_OR_DC_CODES = new Set<string>([...RESULT_CODES, ...DC_CODES]);

/**
 * Refine already-selected picks whose market is 1X2 or Double Chance, using
 * real recent form — mutates `picks` in place. Fetches form only for the
 * fixtures actually being shown (not the full scan), bounded by the same
 * time budget the AI Analysis page uses, so this stays fast on a warm cache
 * and never blocks a page render for long on a cold one.
 */
async function refineWithForm(picks: ExpertPick[], fixtures: SbEvent[]): Promise<void> {
  const targets = picks.filter((p) => p.pickCode && RESULT_OR_DC_CODES.has(p.pickCode) && p.eventId);
  if (!targets.length) return;
  const evById = new Map(fixtures.map((e) => [e.eventId, e]));
  const forms = await getFormsForMatches(
    targets.map((p) => ({ home: p.home, away: p.away })),
    5000,
  ).catch(() => new Map<string, MatchForm>());
  for (const p of targets) {
    const ev = evById.get(p.eventId!);
    if (!ev) continue;
    const mf = forms.get(`${p.home}|${p.away}`.toLowerCase()) ?? null;
    if (!mf || (!ppg(mf.home) && !ppg(mf.away))) continue; // no usable form data — leave the market pick as-is
    const triple = formAdjustedTriple(ev, mf);
    const candidateCodes = [...RESULT_CODES, ...DC_CODES].filter((c) => {
      const o = ev.outcomes[c];
      return o && o > 1;
    });
    const refined = formAwareBestOutcome(ev, candidateCodes, triple);
    if (!refined) continue;
    if (refined.code !== p.pickCode) {
      p.pickCode = refined.code;
      p.pick = (PICK_LABEL[refined.code] ?? (() => refined.code))(p.home, p.away);
      p.market = marketOf(refined.code);
      p.reasons = [
        ...p.reasons,
        `Adjusted from the market favourite using real recent form (${mf.home?.summary ?? "—"} vs ${mf.away?.summary ?? "—"})`,
      ];
    }
    p.odds = refined.odds.toFixed(2);
    p.confidence = round(Math.min(0.95, refined.implied));
  }
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

  // Refine RESULT/DOUBLE-CHANCE picks with real recent form before returning
  // — see the "FORM-AWARE REFINEMENT" section above for why. Only touches
  // the 6 result/DC codes; goals/BTTS/team-goals picks pass through unchanged.
  await refineWithForm(chosen, fixtures).catch(() => {});

  // --- API-Football Intelligence enrichment (when subscription is active) ---
  if (intelEnabled() && chosen.length > 0) {
    const INTEL_BATCH = Math.min(chosen.length, 6); // cap parallel intel lookups
    await Promise.all(
      chosen.slice(0, INTEL_BATCH).map(async (p) => {
        try {
          const homeOdds = p.pickCode === "1" ? Number(p.odds) || 0 : 0;
          const awayOdds = p.pickCode === "2" ? Number(p.odds) || 0 : 0;
          const intel = await getMatchIntel(
            p.home, p.away, p.league,
            p.confidence, homeOdds, awayOdds,
          );
          p.homeMomentum = intel.homeMomentum ?? undefined;
          p.awayMomentum = intel.awayMomentum ?? undefined;
          p.bankerLock = intel.bankerLock ?? undefined;
          p.giantKiller = intel.giantKiller ?? undefined;
          p.trapGame = intel.trapGame ?? undefined;
          p.intelReport = intel;
          // Enrich signals with intel insights
          if (intel.homeMomentum) p.signals.push(`${p.home} ${intel.homeMomentum.label} (${intel.homeMomentum.score}/100)`);
          if (intel.awayMomentum) p.signals.push(`${p.away} ${intel.awayMomentum.label} (${intel.awayMomentum.score}/100)`);
          if (intel.bankerLock && intel.bankerLock.tag !== "none") p.signals.push(`${intel.bankerLock.label} (${intel.bankerLock.criteriaCount}/6)`);
          if (intel.homeStanding) p.signals.push(`${p.home}: ${intel.homeStanding.motivationTier} (${intel.homeStanding.rank}/${intel.homeStanding.totalTeams})`);
          if (intel.awayStanding) p.signals.push(`${p.away}: ${intel.awayStanding.motivationTier} (${intel.awayStanding.rank}/${intel.awayStanding.totalTeams})`);
          if (intel.homeInjuries && intel.homeInjuries.totalOut > 0) p.signals.push(`🏥 ${p.home}: ${intel.homeInjuries.summary}`);
          if (intel.awayInjuries && intel.awayInjuries.totalOut > 0) p.signals.push(`🏥 ${p.away}: ${intel.awayInjuries.summary}`);
          if (intel.trapGame && intel.trapGame.isTrap) p.signals.unshift(intel.trapGame.label); // Put trap alert first
        } catch { /* intel is best-effort */ }
      }),
    ).catch(() => {});
  }

  // Present soonest kick-off first.
  chosen.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
  return { picks: chosen, requested: count, windowDays: days, poolSize: eligible.length };
}

// =====================================================================
// =====================================================================
// VALUE PICKS — multi-market opportunities with genuine mathematical edge
// =====================================================================
// A value bet exists where an INDEPENDENT model (Forebet / API-Football / Poisson xG)
// rates an outcome MORE likely than SportyBet's price implies.
// Edge = model prob − de-vigged market prob; EV = model prob × odds − 1.
// Now evaluates multiple liquid markets (1X2, Double Chance, Over/Under, BTTS, DNB),
// computes quarter-Kelly bankroll sizing, and integrates Bytez AI tactical explanations.

export interface ValuePick extends ExpertPick {
  edge: number; // model prob − market implied (0..1)
  ev: number; // expected value: modelProb × odds − 1
  modelProb: number; // the model's probability for this outcome
  kellyPct?: number; // recommended fractional Kelly bankroll stake % (e.g. 2.5%)
  aiInsight?: string; // Bytez AI-generated value rationale
  marketGroup?: string; // "1X2" | "Goals" | "BTTS" | "Double Chance" | "Draw No Bet"
}

export interface ValueResult {
  picks: ValuePick[];
  requested: number;
  windowDays: number;
  scanned: number; // fixtures with an independent model or statistical analysis
}

export interface ValueOptions {
  count: number;
  days: number;
  minEdge?: number; // default 0.05 (5-point overlay)
  minOdds?: number; // default 1.40 — value needs reasonable price
  maxOdds?: number; // default 8.0 — cap wild longshots
  maxEv?: number; // default 0.45 — reject implausibly high EV (model error, not value)
  marketFilter?: "all" | "1x2" | "goals" | "btts" | "dc" | "safe";
  seed?: number;
}

export async function getValuePicks(opts: ValueOptions): Promise<ValueResult> {
  const count = Math.max(1, Math.min(70, Math.floor(opts.count) || 5));
  const days = Math.max(1, Math.min(30, Math.floor(opts.days) || 7));
  const minEdge = opts.minEdge ?? 0.05;
  const minOdds = opts.minOdds ?? 1.40;
  const maxOdds = opts.maxOdds ?? 8.0;
  const maxEv = opts.maxEv ?? 0.45;
  const marketFilter = opts.marketFilter ?? "all";

  const now = Date.now();
  const maxT = now + days * 86_400_000;
  const [fixtures, preds] = await Promise.all([
    getSportyFixtures().catch(() => [] as SbEvent[]),
    getPredictions().catch(() => [] as ExtPrediction[]),
  ]);

  const scoredVal: ValuePick[] = [];
  let scanned = 0;

  for (const ev of fixtures) {
    if (!ev.kickoff || ev.kickoff <= now || ev.kickoff > maxT) continue;
    const tip = findExternalTip(ev, preds);
    const xg = analyzeEvent(ev);
    if (!tip?.probs && !xg) continue;
    scanned += 1;

    // Build candidate model probabilities across multiple markets
    const candidates: { code: string; modelProb: number; marketGroup: string }[] = [];

    // 1. 1X2 Probabilities
    let pHome = tip?.probs ? (tip.probs[0] ?? 0) / 100 : xg ? xg.pHome : 0;
    let pDraw = tip?.probs ? (tip.probs[1] ?? 0) / 100 : xg ? xg.pDraw : 0;
    let pAway = tip?.probs ? (tip.probs[2] ?? 0) / 100 : xg ? xg.pAway : 0;

    // Normalise if sum deviates slightly
    const pSum = pHome + pDraw + pAway;
    if (pSum > 0) {
      pHome /= pSum;
      pDraw /= pSum;
      pAway /= pSum;
    }

    if (pHome > 0 && pAway > 0) {
      candidates.push({ code: "1", modelProb: pHome, marketGroup: "1X2" });
      if (pDraw <= 0.42) candidates.push({ code: "X", modelProb: pDraw, marketGroup: "1X2" });
      candidates.push({ code: "2", modelProb: pAway, marketGroup: "1X2" });

      // 2. Double Chance
      candidates.push({ code: "DC1X", modelProb: Math.min(0.96, pHome + pDraw), marketGroup: "Double Chance" });
      candidates.push({ code: "DC12", modelProb: Math.min(0.96, pHome + pAway), marketGroup: "Double Chance" });
      candidates.push({ code: "DCX2", modelProb: Math.min(0.96, pDraw + pAway), marketGroup: "Double Chance" });

      // 3. Draw No Bet (DNB)
      const dnbSum = pHome + pAway;
      if (dnbSum > 0) {
        candidates.push({ code: "DNBH", modelProb: Math.min(0.95, pHome / dnbSum), marketGroup: "Draw No Bet" });
        candidates.push({ code: "DNBA", modelProb: Math.min(0.95, pAway / dnbSum), marketGroup: "Draw No Bet" });
      }
    }

    // 4. Over / Under Goals
    const pO25 = xg ? xg.over25 : undefined;
    if (pO25 !== undefined && pO25 > 0.05 && pO25 < 0.95) {
      candidates.push({ code: "O25", modelProb: pO25, marketGroup: "Goals" });
      candidates.push({ code: "U25", modelProb: 1 - pO25, marketGroup: "Goals" });
    }

    // 5. Both Teams To Score (BTTS)
    const pBtts = xg ? xg.btts : undefined;
    if (pBtts !== undefined && pBtts > 0.05 && pBtts < 0.95) {
      candidates.push({ code: "BTTSY", modelProb: pBtts, marketGroup: "BTTS" });
      candidates.push({ code: "BTTSN", modelProb: 1 - pBtts, marketGroup: "BTTS" });
    }

    // Evaluate each candidate outcome against live SportyBet prices
    let best: {
      code: string;
      odds: number;
      edge: number;
      ev: number;
      modelProb: number;
      marketGroup: string;
      kellyPct: number;
    } | null = null;

    for (const c of candidates) {
      // Apply market filter if set
      if (marketFilter === "1x2" && c.marketGroup !== "1X2") continue;
      if (marketFilter === "goals" && c.marketGroup !== "Goals") continue;
      if (marketFilter === "btts" && c.marketGroup !== "BTTS") continue;
      if (marketFilter === "dc" && c.marketGroup !== "Double Chance") continue;
      if (marketFilter === "safe" && c.marketGroup !== "Double Chance" && c.modelProb < 0.65) continue;

      const odds = ev.outcomes[c.code];
      if (!odds || odds < minOdds || odds > maxOdds) continue;
      if (c.modelProb <= 0.15) continue;

      const marketProb = devig(ev.outcomes, c.code);
      if (marketProb <= 0) continue;

      const edge = c.modelProb - marketProb;
      const evv = c.modelProb * odds - 1;
      if (edge < minEdge || evv <= 0 || evv > maxEv) continue;

      // Quarter-Kelly optimal bankroll sizing
      const b = odds - 1;
      const kellyRaw = b > 0 ? (b * c.modelProb - (1 - c.modelProb)) / b : 0;
      const kellyPct = round(Math.max(0, Math.min(0.25, kellyRaw * 0.25)) * 100, 1);

      if (!best || evv > best.ev) {
        best = {
          code: c.code,
          odds,
          edge,
          ev: evv,
          modelProb: c.modelProb,
          marketGroup: c.marketGroup,
          kellyPct,
        };
      }
    }

    if (!best) continue;

    const label = (PICK_LABEL[best.code] ?? (() => best.code))(ev.home, ev.away);
    const reasons = [
      `${tip?.source ? `${tip.source} + ` : ""}Model rates this ${Math.round(best.modelProb * 100)}%`,
      `market prices ${Math.round((1 / best.odds) * 100)}% (odds ${best.odds.toFixed(2)})`,
      `+${Math.round(best.edge * 100)}pt edge · EV +${Math.round(best.ev * 100)}%`,
    ];
    if (best.kellyPct > 0) reasons.push(`Quarter-Kelly stake: ~${best.kellyPct}% bankroll`);
    if (tip?.analysis) reasons.push(String(tip.analysis).slice(0, 120));

    scoredVal.push({
      home: ev.home,
      away: ev.away,
      league: ev.league,
      kickoff: new Date(ev.kickoff).toISOString(),
      pick: label,
      key: `${ev.home}|${ev.away}|${best.code}`.toLowerCase(),
      confidence: round(best.modelProb),
      odds: best.odds.toFixed(2),
      reasons,
      signals: matchInsights(ev, best.code),
      source: tip ? `${tip.source} vs SportyBet` : "Poisson xG vs SportyBet",
      url: tip?.url,
      eventId: ev.eventId,
      pickCode: best.code,
      market: marketOf(best.code),
      marketGroup: best.marketGroup,
      edge: round(best.edge),
      ev: round(best.ev),
      modelProb: round(best.modelProb),
      kellyPct: best.kellyPct,
    });
  }

  scoredVal.sort((a, b) => b.ev - a.ev); // Highest expected value first

  // League diversity cap so a big tournament does not crowd out the entire slate
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
  const band = pool.slice(0, Math.min(pool.length, count + 6));
  const off = band.length ? (((opts.seed ?? 0) % band.length) + band.length) % band.length : 0;
  const picks = band.slice(off).concat(band.slice(0, off)).slice(0, count);

  // --- API-Football Intelligence enrichment for Value Picks ---
  if (intelEnabled() && picks.length > 0) {
    await Promise.all(
      picks.slice(0, 5).map(async (p) => {
        try {
          // Fetch full intel report
          const odds = Number(p.odds) || 0;
          const intel = await getMatchIntel(
            p.home, p.away, p.league,
            p.modelProb,
            p.pickCode === "1" ? odds : 0,
            p.pickCode === "2" ? odds : 0
          );
          
          p.homeMomentum = intel.homeMomentum ?? undefined;
          p.awayMomentum = intel.awayMomentum ?? undefined;
          p.giantKiller = intel.giantKiller ?? undefined;
          p.trapGame = intel.trapGame ?? undefined;
          p.intelReport = intel;

          if (intel.homeMomentum) p.signals.push(`${p.home} ${intel.homeMomentum.label} (${intel.homeMomentum.score}/100)`);
          if (intel.awayMomentum) p.signals.push(`${p.away} ${intel.awayMomentum.label} (${intel.awayMomentum.score}/100)`);
          if (intel.giantKiller && intel.giantKiller.upsetConfidence >= 30) {
            p.signals.push(`${intel.giantKiller.label} (${intel.giantKiller.upsetConfidence}%)`);
          }
          if (intel.trapGame && intel.trapGame.isTrap) {
            p.signals.unshift(intel.trapGame.label);
          }
        } catch { /* best-effort */ }
      }),
    ).catch(() => {});
  }

  // Attach Bytez AI tactical insights to top recommendations (with intel context)
  for (let i = 0; i < Math.min(picks.length, 3); i++) {
    const p = picks[i];
    try {
      if (p.intelReport?.aiInsight) {
        p.aiInsight = p.intelReport.aiInsight;
      } else {
        p.aiInsight = await generateMatchValueInsight({
          home: p.home,
          away: p.away,
          pick: p.pick,
          market: p.market,
          odds: p.odds ?? "1.80",
          modelProb: p.modelProb,
          edge: p.edge,
          ev: p.ev,
          signals: p.signals,
          intelReport: p.intelReport,
        });
      }
    } catch {
      /* continue */
    }
  }

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
  h2h?: any; // H2HDeep
}
export interface Combo {
  id: string;
  title: string;
  emoji: string;
  kind: "value" | "safe" | "big" | "boost";
  note: string;
  legs: ComboLeg[];
  combinedOdds: number;
  avgConfidence: number | null; // mean model/confidence across legs
  totalEv: number | null; // combined EV for value combos (∏(1+ev) − 1)
  winProb?: number | null; // combined win probability (∏ leg confidence) — the honest risk
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
  h2h?: any;
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
  h2h: (p as any).intelReport?.h2h,
});
const comboOdds = (legs: ComboLeg[]) => round(legs.reduce((a, l) => a * (l.odds || 1), 1), 2);
const comboConf = (legs: ComboLeg[]) =>
  legs.length ? round(legs.reduce((a, l) => a + l.confidence, 0) / legs.length) : null;
const comboEv = (legs: ComboLeg[]) =>
  legs.some((l) => l.ev !== undefined)
    ? round(legs.reduce((a, l) => a * (1 + (l.ev ?? 0)), 1) - 1)
    : null;
// Combined win probability = product of leg confidences. This is the honest
// counterweight to a big combined-odds number: an 80× combo may only land ~3%.
const comboWinProb = (legs: ComboLeg[]) =>
  legs.length ? round(legs.reduce((a, l) => a * l.confidence, 1)) : null;

/**
 * Auto-build a menu of ready-made accumulators to choose from. Pulls the
 * current Value Picks (edge-based) and Safe/Result Expert Picks, then composes
 * several combos across odds tiers. Sparse inputs simply yield fewer combos.
 */
export async function getCombos(seed = 0): Promise<Combo[]> {
  const [safe, value, result, boostSafe] = await Promise.all([
    getExpertPicks({ count: 30, days: 21, gameType: "safe", minConfidence: 0.7, seed }),
    getValuePicks({ count: 25, days: 21, seed }),
    getExpertPicks({ count: 40, days: 21, gameType: "result", minConfidence: 0.55, seed }),
    // Large safe pool (Double Chance / Over 0.5 / etc.) — the building blocks
    // for SAFE odds boosters: each leg wins ~75-90% of the time.
    getExpertPicks({ count: 70, days: 21, gameType: "safe", minConfidence: 0.6, seed }),
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
      winProb: comboWinProb(legs),
    });
  };

  // ---- 🛡️ Fort Knox (Safe) ----
  // Built exclusively from the safest picks, prioritizing "Banker Locks".
  const safeP = safe.picks;
  const bankerLocks = safeP.filter((p) => p.bankerLock && p.bankerLock.tag !== "none");
  const fortKnoxLegs = [...bankerLocks, ...safeP.filter((p) => !p.bankerLock)].slice(0, 4).map(asLeg);
  if (fortKnoxLegs.length >= 3)
    push("banker3", "Fort Knox (Safe)", "🛡️", "safe", "The safest possible accumulator. Prioritizes 'Banker Lock' games with no red flags.", fortKnoxLegs);

  // ---- ⚖️ Value Stack (Balanced) ----
  // Mixes solid value edges.
  const vsorted = [...value.picks].sort((a, b) => b.ev - a.ev);
  if (vsorted.length >= 4)
    push("value4", "Value Stack (Balanced)", "⚖️", "value", "Mathematically optimized 4-leg accumulator using only the highest Expected Value (EV) overlays.", vsorted.slice(0, 4).map(asLeg));

  // ---- 🚀 The Moonshot (High Odds) ----
  // Combines Giant Killers and high-priced results.
  const giantKillers = result.picks.filter(p => p.giantKiller && p.giantKiller.upsetConfidence >= 30);
  const bigResults = result.picks.filter(p => Number(p.odds) >= 2.0 && !p.giantKiller);
  const moonshotLegs = [...giantKillers, ...bigResults]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map(asLeg);
  if (moonshotLegs.length >= 3)
    push("moonshot", "The Moonshot", "🚀", "big", "High risk, massive reward. Built from underdogs (Giant Killers) and high-priced value picks.", moonshotLegs);

  // ---- Big-odds combo (bigger payout from higher-priced favourites) ----
  const bigLegs = result.picks
    .filter((p) => Number(p.odds) >= 1.7)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4)
    .map(asLeg);
  if (bigLegs.length >= 4)
    push("big4", "Big-Odds Four", "🚀", "big", "4 confident but higher-priced results — for a bigger payout", bigLegs);

  // ---- Odds Boosters: reach big payout tiers the SAFE way ----
  // Built from the SAFE pool (mostly Double Chance — covers two outcomes, so
  // ~75-90% per leg). For each target payout, greedily stack the highest-
  // confidence safe legs until the combined odds reach it — the most probable
  // accumulator that pays ~N×. Each shows its honest combined win chance;
  // because every leg is a high-probability Double-Chance-style pick, that
  // chance is far better than stacking 1X2 favourites for the same odds.
  const boostPool = boostSafe.picks
    .filter((p) => Number(p.odds) > 1) // any real price
    .sort((a, b) => b.confidence - a.confidence);
  const usedTargets = new Set<string>();
  for (const target of [5, 10, 25, 50, 100]) {
    const legs = buildBoosterLegs(boostPool, target);
    if (!legs) continue;
    const key = legs.length + ":" + legs[legs.length - 1].key; // dedupe identical builds
    if (usedTargets.has(key)) continue;
    usedTargets.add(key);
    const wp = comboWinProb(legs);
    push(
      `boost${target}`,
      `Safe Booster ~${target}×`,
      "🔥",
      "boost",
      `${legs.length} Double-Chance / safe legs to reach ~${target}× — the safest way to that payout (each leg ~75-90%). Win chance ≈ ${wp !== null ? Math.round(wp * 100) : "?"}% — still a long shot; every leg must land.`,
      legs,
    );
  }

  return combos;
}

/**
 * Greedily stack the highest-confidence legs from `pool` (sorted descending)
 * until the combined odds clear `target`, capped at 50 legs. Returns null if
 * the pool can't genuinely reach ~85% of the target — never pads a fake
 * result. Shared by getCombos()'s fixed tiers and getOddsBoosters()'s custom
 * ones, so both build accumulators the exact same honest way.
 */
interface BoosterAttempt {
  legs: ComboLeg[];
  reached: number; // combined odds actually stacked, even on failure
  ok: boolean; // true only if it genuinely reached ~85% of target
}
function buildBoosterAttempt(pool: ExpertPick[], target: number): BoosterAttempt {
  const legs: ComboLeg[] = [];
  let prod = 1;
  for (const p of pool) {
    if (prod >= target) break;
    if (legs.length >= 50) break; // safe legs are short-priced → allow more
    legs.push(asLeg(p));
    prod *= Number(p.odds) || 1;
  }
  return { legs, reached: round(prod, 2), ok: prod >= target * 0.85 && legs.length >= 2 };
}
function buildBoosterLegs(pool: ExpertPick[], target: number): ComboLeg[] | null {
  const a = buildBoosterAttempt(pool, target);
  return a.ok ? a.legs : null;
}

export interface OddsBoosterOptions {
  targets?: number[]; // combined-odds tiers to attempt, e.g. [5, 10, 30, 40]
  days?: number;
  minConfidence?: number; // per-leg floor on the safe pool; default 0.6
  seed?: number;
}

/**
 * Odds-boosted accumulators at CUSTOM target tiers (used by the Demo Wallet's
 * auto-generator, which wants specific odds like 5×/10×/30×/40×, not the
 * fixed tiers getCombos() shows on the Value Combos tab). Same safe-pool +
 * greedy-stack logic as getCombos()'s boosters — just its own fetch so it can
 * run independently (e.g. from a button click) without disturbing that tab's
 * cadence. Each combo's `winProb` is the REAL combined chance every leg
 * lands — at big odds tiers this is honestly low; no combo of confident legs
 * can multiply to 30-50× while staying near 90% combined, and this never
 * pretends otherwise.
 */
export interface OddsBoosterAttempt {
  target: number;
  ok: boolean; // false = couldn't genuinely reach ~85% of this target today
  combo: Combo | null;
  reached: number; // combined odds actually stacked, reported even on failure
  legsAvailable: number;
}

/**
 * Attempts EVERY requested target and reports back on all of them — including
 * ones that couldn't be reached — so a caller (the Demo Wallet auto-generator)
 * can tell the user honestly "why" a tier was skipped instead of it silently
 * vanishing.
 */
export async function getOddsBoosters(opts: OddsBoosterOptions = {}): Promise<OddsBoosterAttempt[]> {
  const targets = opts.targets ?? [5, 10, 25, 50, 100];
  const days = opts.days ?? 21;
  const minConfidence = opts.minConfidence ?? 0.6;
  const seed = opts.seed ?? 0;
  const boostSafe = await getExpertPicks({ count: 70, days, gameType: "safe", minConfidence, seed });
  const pool = boostSafe.picks.filter((p) => Number(p.odds) > 1).sort((a, b) => b.confidence - a.confidence);
  const usedTargets = new Set<string>();
  const attempts: OddsBoosterAttempt[] = [];
  for (const target of [...targets].sort((a, b) => a - b)) {
    const built = buildBoosterAttempt(pool, target);
    const dedupeKey = built.legs.length ? `${built.legs.length}:${built.legs[built.legs.length - 1].key}` : "";
    if (!built.ok || (dedupeKey && usedTargets.has(dedupeKey))) {
      attempts.push({ target, ok: false, combo: null, reached: built.reached, legsAvailable: built.legs.length });
      continue;
    }
    usedTargets.add(dedupeKey);
    const wp = comboWinProb(built.legs);
    attempts.push({
      target,
      ok: true,
      reached: built.reached,
      legsAvailable: built.legs.length,
      combo: {
        id: `boost${target}`,
        title: `Safe Booster ~${target}×`,
        emoji: "🔥",
        kind: "boost",
        note: `${built.legs.length} Double-Chance / safe legs to reach ~${target}× — each leg ~75-90%. Win chance ≈ ${wp !== null ? Math.round(wp * 100) : "?"}% — still a long shot; every leg must land.`,
        legs: built.legs,
        combinedOdds: comboOdds(built.legs),
        avgConfidence: comboConf(built.legs),
        totalEv: null,
        winProb: wp,
      },
    });
  }
  return attempts;
}

// =====================================================================
// ANALYST SLIP — a genuine cross-market read, not a Double-Chance reflex
// =====================================================================
// The old auto-generator only ever drew from the "safe" Double-Chance pool,
// so its slips were structurally "Home or Draw" on nearly every leg — a
// mechanical stack, not analysis. This builds each leg from WHICHEVER market
// (result, Double Chance, Over/Under, BTTS, or a genuine value overlay) is
// actually strongest for THAT fixture — the same judgment call a scout makes
// match-by-match — and carries the real reasoning (market price, recent-form
// read, signal agreement) into the leg so the user can see WHY, not just what.

export interface AnalystLeg {
  home: string;
  away: string;
  league?: string;
  kickoff?: string;
  market?: string;
  pick: string;
  odds: number;
  confidence: number; // 0..1, form-aware where data allows
  key: string; // bookable "home|away|CODE"
  eventId?: string;
  reasons: string[]; // the analyst's actual reasoning for this leg
}

export interface AnalystSlipOptions {
  numGames?: number; // desired leg count, 2..50
  minOdds?: number; // desired combined-odds floor
  maxOdds?: number; // desired combined-odds ceiling
  days?: number;
  seed?: number;
}

export interface AnalystSlipResult {
  legs: AnalystLeg[];
  totalOdds: number;
  combinedChance: number | null; // real ∏ of each leg's confidence
  requested: { numGames?: number; minOdds?: number; maxOdds?: number };
  note: string; // honest summary of how well the request was met
}

/** One candidate per fixture: whichever market genuinely reads strongest —
 *  not a fixed market family — built from a wide, form-aware cross-market
 *  scan (result / goals / BTTS / safe / value), each already refined against
 *  real recent form where the data supports it. */
async function analystCandidatePool(days: number, seed: number): Promise<ExpertPick[]> {
  const [result, goals, btts, safe, value] = await Promise.all([
    getExpertPicks({ count: 70, days, gameType: "result", minConfidence: 0.5, seed }).catch(() => ({ picks: [] as ExpertPick[] })),
    getExpertPicks({ count: 70, days, gameType: "goals", minConfidence: 0.5, seed }).catch(() => ({ picks: [] as ExpertPick[] })),
    getExpertPicks({ count: 70, days, gameType: "btts", minConfidence: 0.5, seed }).catch(() => ({ picks: [] as ExpertPick[] })),
    getExpertPicks({ count: 70, days, gameType: "safe", minConfidence: 0.5, seed }).catch(() => ({ picks: [] as ExpertPick[] })),
    getValuePicks({ count: 30, days: Math.max(days, 7), seed }).catch(() => ({ picks: [] as ValuePick[] })),
  ]);
  const byFixture = new Map<string, ExpertPick>();
  for (const p of [...result.picks, ...goals.picks, ...btts.picks, ...safe.picks, ...value.picks]) {
    const cur = byFixture.get(p.key);
    // Whichever market has the higher (form-aware) confidence wins the
    // fixture — the genuine "which cover is safest here" judgment call,
    // rather than always defaulting to one market family.
    if (!cur || p.confidence > cur.confidence) byFixture.set(p.key, p);
  }
  return [...byFixture.values()].sort((a, b) => b.confidence - a.confidence);
}

function toAnalystLeg(p: ExpertPick): AnalystLeg {
  return {
    home: p.home,
    away: p.away,
    league: p.league,
    kickoff: p.kickoff,
    market: p.market,
    pick: p.pick,
    odds: Number(p.odds) || 0,
    confidence: p.confidence,
    key: p.pickCode ? `${p.home}|${p.away}|${p.pickCode}`.toLowerCase() : p.key,
    eventId: p.eventId,
    // Full analyst commentary: the market/form reasoning PLUS the supporting
    // market-read signals (goals lean, safest cover) — real analysis, not
    // just the one-line "market odds X%" that made every leg read the same.
    reasons: [...p.reasons, ...p.signals],
  };
}

const combinedOddsOf = (legs: AnalystLeg[]) => round(legs.reduce((a, l) => a * (l.odds || 1), 1), 2);
const combinedChanceOf = (legs: AnalystLeg[]) =>
  legs.length ? round(legs.reduce((a, l) => a * l.confidence, 1)) : null;

/**
 * Build ONE tailored accumulator to the user's actual brief — a leg count
 * and/or an odds range — from the cross-market, form-aware candidate pool.
 * Never pads with weak legs to hit a number, and never fabricates a target
 * it can't reach: `note` says plainly when the brief couldn't be fully met
 * and what was achieved instead.
 */
export async function buildAnalystSlip(opts: AnalystSlipOptions = {}): Promise<AnalystSlipResult> {
  const days = opts.days ?? 7;
  const seed = opts.seed ?? Math.floor(Date.now() / (8 * 60_000));
  const numGames = opts.numGames ? Math.max(2, Math.min(50, Math.floor(opts.numGames))) : undefined;
  const minOdds = opts.minOdds && opts.minOdds > 1 ? opts.minOdds : undefined;
  const maxOdds = opts.maxOdds && opts.maxOdds > 1 ? opts.maxOdds : undefined;
  const requested = { numGames, minOdds, maxOdds };

  const pool = await analystCandidatePool(days, seed);
  if (!pool.length) return { legs: [], totalOdds: 1, combinedChance: null, requested, note: "No qualifying matches are live right now — try again shortly." };

  let legs: AnalystLeg[];
  let note: string;

  if (numGames) {
    // Start with the numGames strongest reads, then nudge toward the odds
    // range (if given) by swapping the marginal leg for a pool candidate that
    // moves total odds the right direction — never changing the leg COUNT
    // the user asked for.
    legs = pool.slice(0, numGames).map(toAnalystLeg);
    const used = new Set(legs.map((l) => l.key));
    if ((minOdds || maxOdds) && pool.length > numGames) {
      const rest = pool.slice(numGames).map(toAnalystLeg);
      let guard = 0;
      while (guard++ < 200) {
        const total = combinedOddsOf(legs);
        const tooLow = minOdds !== undefined && total < minOdds;
        const tooHigh = maxOdds !== undefined && total > maxOdds;
        if (!tooLow && !tooHigh) break;
        // Swap the leg contributing least toward the needed direction for the
        // best available replacement that helps, keeping confidence as high
        // as possible among candidates that actually move things the right way.
        let swapped = false;
        for (let i = legs.length - 1; i >= 0 && !swapped; i--) {
          const candidate = rest.find((r) => {
            if (used.has(r.key)) return false;
            const projected = (total / (legs[i].odds || 1)) * (r.odds || 1);
            return tooLow ? projected > total : projected < total;
          });
          if (!candidate) continue;
          used.delete(legs[i].key);
          used.add(candidate.key);
          legs[i] = candidate;
          swapped = true;
        }
        if (!swapped) break; // pool exhausted — report honestly below
      }
    }
    const total = combinedOddsOf(legs);
    const metRange = (!minOdds || total >= minOdds * 0.9) && (!maxOdds || total <= maxOdds * 1.15);
    note = metRange
      ? `${legs.length} legs, exactly as requested.`
      : `${legs.length} legs as requested, but today's live matches land the combined odds at ${total} — ${
          minOdds && total < minOdds
            ? `not enough strong candidates to reach ${minOdds}× at this leg count. Try more games or a lower target.`
            : `couldn't trim below ${maxOdds}× at this leg count without weak legs. Try fewer games or a higher target.`
        }`;
  } else if (minOdds || maxOdds) {
    // No fixed leg count — stack the strongest reads until inside the range.
    const target = maxOdds ?? minOdds!;
    const built: AnalystLeg[] = [];
    let total = 1;
    for (const p of pool) {
      if (minOdds === undefined && total >= target) break;
      if (maxOdds !== undefined && total * (Number(p.odds) || 1) > maxOdds && built.length >= 2) continue;
      built.push(toAnalystLeg(p));
      total *= Number(p.odds) || 1;
      if (built.length >= 50) break;
      if (minOdds !== undefined && total >= minOdds) break;
    }
    legs = built;
    const reachedMin = minOdds === undefined || total >= minOdds * 0.85;
    note = reachedMin
      ? `${legs.length} legs to hit your odds target.`
      : `Best reachable today is ${round(total, 2)}× with ${legs.length} legs (fewer strong matches than usual) — short of your ${minOdds}× target.`;
  } else {
    // No brief given — a sensible, genuinely analyst-picked default.
    legs = pool.slice(0, 5).map(toAnalystLeg);
    note = `5 of today's strongest cross-market reads (no target given).`;
  }

  return { legs, totalOdds: combinedOddsOf(legs), combinedChance: combinedChanceOf(legs), requested, note };
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

/** Did this pick win, given a "H:A" final score? null = void/unknown.
 *  Exported for the demo-bet simulator, which settles the same pick codes. */
export function settlePick(pickCode: string, score: string): boolean | null {
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
    case "O05":
      return total >= 1;
    case "U05":
      return total === 0;
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

export async function fetchEventScore(
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
