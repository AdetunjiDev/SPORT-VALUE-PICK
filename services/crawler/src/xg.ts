import { getSportyFixtures, devig, type SbEvent } from "./forebet-ai.js";

/**
 * AI Score Predictor — a Poisson goals model calibrated to live SportyBet odds.
 *
 * Honest scope: this is NOT shot-based xG (that needs event data we don't have).
 * It's the standard statistical approach used across football-prediction sites:
 *   1. The bookmaker's de-vigged prices already encode expected goals and team
 *      strength (they price with their own models + real money).
 *   2. We fit a Poisson model to those prices — solving for each team's expected
 *      goals (λ) from the Over/Under total and the 1X2 supremacy.
 *   3. From the two λ's we build the full correct-score probability matrix, and
 *      derive everything else exactly: 1X2, BTTS, Over/Under, most likely score.
 *
 * Output is genuinely data-driven (statistics over intuition) and internally
 * consistent — the same framework real "xG-lite" predictors use.
 */

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Poisson pmf: P(X = k) for rate λ. */
function pois(k: number, lambda: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
/** Poisson cdf: P(X ≤ k). */
function poisCdf(k: number, lambda: number): number {
  let s = 0;
  for (let i = 0; i <= k; i++) s += pois(i, lambda);
  return s;
}

/** De-vigged probability for one outcome code (null if the price is missing). */
function P(ev: SbEvent, code: string): number | null {
  const o = ev.outcomes[code];
  return o && o > 1 ? devig(ev.outcomes, code) : null;
}

/** Home-win probability under independent Poisson(λh), Poisson(λa). */
function homeWin(lh: number, la: number): number {
  let p = 0;
  for (let i = 0; i <= 12; i++) for (let j = 0; j < i; j++) p += pois(i, lh) * pois(j, la);
  return p;
}

/**
 * Solve for each team's expected goals from the market:
 *  - total expected goals λ_total from the de-vigged Under-2.5 price, and
 *  - the home/away split from the de-vigged 1X2 win probabilities.
 */
function calibrate(ev: SbEvent): { lh: number; la: number } | null {
  const pH = P(ev, "1");
  const pA = P(ev, "2");
  if (pH == null || pA == null) return null;
  const pU25 = P(ev, "U25");

  // λ_total: match P(total goals ≤ 2). poisCdf(2, L) decreases as L grows.
  let L = 2.6; // sensible fallback if no O/U price
  if (pU25 != null && pU25 > 0.02 && pU25 < 0.98) {
    let lo = 0.2;
    let hi = 6.5;
    for (let it = 0; it < 45; it++) {
      const mid = (lo + hi) / 2;
      if (poisCdf(2, mid) > pU25) lo = mid;
      else hi = mid;
    }
    L = (lo + hi) / 2;
  }

  // Split so the model's home-win prob matches the market's. Monotonic: more
  // share to home → higher home-win prob.
  let lo = 0.12;
  let hi = 0.88;
  for (let it = 0; it < 45; it++) {
    const s = (lo + hi) / 2;
    if (homeWin(s * L, (1 - s) * L) < pH) lo = s;
    else hi = s;
  }
  const s = (lo + hi) / 2;
  return { lh: round(s * L, 3), la: round((1 - s) * L, 3) };
}

export interface ScoreProb {
  score: string; // "2-1"
  prob: number; // 0..1
}
export interface MatchAnalysis {
  eventId: string;
  home: string;
  away: string;
  league?: string;
  kickoff: string; // ISO
  xgHome: number; // model expected goals
  xgAway: number;
  pHome: number; // 1X2 probabilities (model)
  pDraw: number;
  pAway: number;
  btts: number; // both teams to score
  over25: number; // total goals over 2.5
  over15: number;
  topScores: ScoreProb[]; // most likely correct scores
  likeliest: string; // headline scoreline
  verdict: string; // "Home win", "Draw", "Away win"
  pickCode: "1" | "X" | "2"; // model's result pick (for the slip)
  pickOdds?: string; // SportyBet odds for that result
  confidence: number; // model prob for the pick (0..1)
  options: BetOption[]; // selectable markets from the analysis (result, O/U, BTTS, DC)
}

export interface BetOption {
  code: string; // PICKS code (bookable)
  label: string; // e.g. "Over 2.5 Goals"
  market: string; // "Result" | "Goals" | "BTTS" | "Double Chance"
  prob: number; // model probability 0..1
  odds?: string; // SportyBet odds
  key: string; // home|away|CODE (bookable key)
}

/** Full statistical analysis for one fixture, or null if not enough prices. */
export function analyzeEvent(ev: SbEvent): MatchAnalysis | null {
  const cal = calibrate(ev);
  if (!cal) return null;
  const { lh, la } = cal;
  const N = 8;
  const cells: { i: number; j: number; p: number }[] = [];
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let btts = 0;
  let over25 = 0;
  let over15 = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = pois(i, lh) * pois(j, la);
      cells.push({ i, j, p });
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i >= 1 && j >= 1) btts += p;
      if (i + j >= 3) over25 += p;
      if (i + j >= 2) over15 += p;
    }
  }
  cells.sort((a, b) => b.p - a.p);
  const topScores = cells.slice(0, 6).map((c) => ({ score: `${c.i}-${c.j}`, prob: round(c.p, 4) }));

  const pickCode: "1" | "X" | "2" = pHome >= pDraw && pHome >= pAway ? "1" : pAway >= pDraw ? "2" : "X";
  const verdict = pickCode === "1" ? `${ev.home} win` : pickCode === "2" ? `${ev.away} win` : "Draw";
  const conf = Math.max(pHome, pDraw, pAway);
  const pickOdds = ev.outcomes[pickCode];

  // Selectable bet options from the analysis: the result, the model-favoured
  // Over/Under line, the model-favoured BTTS side, and the safest Double
  // Chance. Each only included if SportyBet actually prices it.
  const opt = (code: string, label: string, market: string, prob: number): BetOption | null => {
    const o = ev.outcomes[code];
    if (!o || o <= 1) return null;
    return {
      code,
      label,
      market,
      prob: round(prob, 4),
      odds: o.toFixed(2),
      key: `${ev.home}|${ev.away}|${code}`.toLowerCase(),
    };
  };
  const resultLabel = pickCode === "1" ? `${ev.home} Win` : pickCode === "2" ? `${ev.away} Win` : "Draw";
  const dcs: [string, number, string][] = [
    ["DC1X", pHome + pDraw, `${ev.home} or Draw`],
    ["DC12", pHome + pAway, `${ev.home} or ${ev.away}`],
    ["DCX2", pDraw + pAway, `Draw or ${ev.away}`],
  ].sort((a, b) => (b[1] as number) - (a[1] as number)) as [string, number, string][];
  const options = [
    opt(pickCode, resultLabel, "Result", conf),
    over25 >= 0.5 ? opt("O25", "Over 2.5 Goals", "Goals", over25) : opt("U25", "Under 2.5 Goals", "Goals", 1 - over25),
    btts >= 0.5 ? opt("BTTSY", "Both Teams To Score", "BTTS", btts) : opt("BTTSN", "Both NOT To Score", "BTTS", 1 - btts),
    opt(dcs[0][0], `${dcs[0][2]} (DC)`, "Double Chance", dcs[0][1]),
  ].filter((o): o is BetOption => o !== null);

  return {
    eventId: ev.eventId,
    home: ev.home,
    away: ev.away,
    league: ev.league,
    kickoff: new Date(ev.kickoff).toISOString(),
    xgHome: round(lh, 2),
    xgAway: round(la, 2),
    pHome: round(pHome, 4),
    pDraw: round(pDraw, 4),
    pAway: round(pAway, 4),
    btts: round(btts, 4),
    over25: round(over25, 4),
    over15: round(over15, 4),
    topScores,
    likeliest: topScores[0]?.score ?? "—",
    verdict,
    pickCode,
    pickOdds: pickOdds ? pickOdds.toFixed(2) : undefined,
    confidence: round(conf, 4),
    options,
  };
}

export interface AnalysisResult {
  matches: MatchAnalysis[];
  requested: number;
  windowDays: number;
  scanned: number;
}

/** Analyse the soonest upcoming fixtures (that have usable prices). */
export async function getMatchAnalyses(count = 12, days = 5): Promise<AnalysisResult> {
  const n = Math.max(1, Math.min(60, Math.floor(count) || 12));
  const d = Math.max(1, Math.min(14, Math.floor(days) || 5));
  const now = Date.now();
  const maxT = now + d * 86_400_000;

  const fixtures = await getSportyFixtures().catch(() => [] as SbEvent[]);
  const inWindow = fixtures
    .filter((e) => e.kickoff > now && e.kickoff <= maxT)
    .sort((a, b) => a.kickoff - b.kickoff);

  const out: MatchAnalysis[] = [];
  let scanned = 0;
  for (const ev of inWindow) {
    const a = analyzeEvent(ev);
    if (!a) continue;
    scanned += 1;
    out.push(a);
    if (out.length >= n) break;
  }
  return { matches: out, requested: n, windowDays: d, scanned };
}
