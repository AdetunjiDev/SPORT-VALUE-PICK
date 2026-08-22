import { getSportyFixtures, devig, type SbEvent } from "./forebet-ai.js";
import { getH2HDeep } from "./apifootball-intel.js";

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

// Selectable markets per match: Result, Double Chance, both sides of the goal
// lines (Over 0.5 → Over 3.5 / Under 1.5 → Under 3.5), BTTS both ways, DNB and
// team goals — filtered to whatever SportyBet actually prices. The user picks
// which one to add to their slip (one per match).
const OPTIONS_TARGET = 4; // min priced markets for a "full" card (backfill quality gate)
const OPTIONS_MAX = 12; // max markets offered per card (the choose-your-market menu)

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
  over35: number;
  over25: number; // total goals over 2.5
  over15: number;
  over05: number; // at least one goal in the match
  topScores: ScoreProb[]; // most likely correct scores
  likeliest: string; // headline scoreline
  verdict: string; // "Home win", "Draw", "Away win"
  pickCode: "1" | "X" | "2"; // model's result pick (for the slip)
  pickOdds?: string; // SportyBet odds for that result
  h2h?: any; // H2HDeep
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
  let over35 = 0;
  let over25 = 0;
  let over15 = 0;
  let over05 = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = pois(i, lh) * pois(j, la);
      cells.push({ i, j, p });
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i >= 1 && j >= 1) btts += p;
      if (i + j >= 4) over35 += p;
      if (i + j >= 3) over25 += p;
      if (i + j >= 2) over15 += p;
      if (i + j >= 1) over05 += p;
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
  const pHomeScore = 1 - Math.exp(-lh); // P(home scores ≥ 1)
  const pAwayScore = 1 - Math.exp(-la);
  const dnbH = pHome / (pHome + pAway || 1);

  // Full market menu so the user can CHOOSE the direction they want — both the
  // Over and Under side of each goal line (Over 0.5 … Over 3.5, Under 1.5 …
  // Under 3.5), BTTS both ways, the result, best double chance, draw-no-bet and
  // team goals. Ordered by usefulness; only the ones SportyBet actually prices
  // survive (opt() → null otherwise), capped at OPTIONS_MAX.
  const candidates: (BetOption | null)[] = [
    // Result & double chance
    opt(pickCode, resultLabel, "Result", conf),
    opt(dcs[0][0], `${dcs[0][2]} (DC)`, "Double Chance", dcs[0][1]),
    // Over goal lines (safest → longest)
    opt("O05", "Over 0.5 Goals", "Goals", over05),
    opt("O15", "Over 1.5 Goals", "Goals", over15),
    opt("O25", "Over 2.5 Goals", "Goals", over25),
    opt("O35", "Over 3.5 Goals", "Goals", over35),
    // Under goal lines (safest → tightest)
    opt("U35", "Under 3.5 Goals", "Goals", 1 - over35),
    opt("U25", "Under 2.5 Goals", "Goals", 1 - over25),
    opt("U15", "Under 1.5 Goals", "Goals", 1 - over15),
    // Both teams to score, both ways
    opt("BTTSY", "Both Teams To Score", "BTTS", btts),
    opt("BTTSN", "Both Teams NOT To Score", "BTTS", 1 - btts),
    // Draw no bet (favoured side), team goals, second double chance, 0-0
    dnbH >= 0.5
      ? opt("DNBH", `${ev.home} (Draw No Bet)`, "Draw No Bet", dnbH)
      : opt("DNBA", `${ev.away} (Draw No Bet)`, "Draw No Bet", 1 - dnbH),
    opt("HO05", `${ev.home} Over 0.5`, "Team Goals", pHomeScore),
    opt("AO05", `${ev.away} Over 0.5`, "Team Goals", pAwayScore),
    opt("DC12", `${ev.home} or ${ev.away}`, "Double Chance", pHome + pAway),
    opt("U05", "Under 0.5 Goals (0-0)", "Goals", 1 - over05),
  ];
  const seen = new Set<string>();
  const options: BetOption[] = [];
  for (const o of candidates) {
    if (!o || seen.has(o.code)) continue;
    seen.add(o.code);
    options.push(o);
    if (options.length >= OPTIONS_MAX) break;
  }

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
    over35: round(over35, 4),
    over25: round(over25, 4),
    over15: round(over15, 4),
    over05: round(over05, 4),
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
  onDate?: string; // set when a specific calendar day was requested (YYYY-MM-DD)
  onEnd?: string; // set when a date RANGE was requested (e.g. a weekend); inclusive
}

/**
 * Analyse upcoming fixtures (that have usable prices). By default scans the
 * rolling "next `days`" window; when `onDate` (YYYY-MM-DD) is given, scans only
 * that Africa/Lagos calendar day — or the inclusive `onDate`..`onEnd` range
 * (used by the "This weekend" shortcut) — the calendar view.
 */
export async function getMatchAnalyses(
  count = 12,
  days = 5,
  onDate?: string,
  onEnd?: string,
): Promise<AnalysisResult> {
  const n = Math.max(1, Math.min(70, Math.floor(count) || 12));
  const d = Math.max(1, Math.min(30, Math.floor(days) || 5));
  const now = Date.now();
  // Calendar mode: restrict to the picked Lagos day(s) (WAT = UTC+1, no DST).
  // Never show kickoffs already in the past, so today starts from now.
  const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const onValid = isDate(onDate) ? onDate : undefined;
  const endValid = isDate(onEnd) && (onEnd as string) >= (onValid as string) ? onEnd : undefined;
  let minT = now;
  let maxT = now + d * 86_400_000;
  if (onValid) {
    const dayStart = Date.parse(`${onValid}T00:00:00+01:00`);
    const lastDay = endValid ?? onValid;
    const dayEnd = Date.parse(`${lastDay}T00:00:00+01:00`) + 86_400_000;
    if (Number.isFinite(dayStart) && Number.isFinite(dayEnd)) {
      minT = Math.max(now, dayStart);
      maxT = dayEnd;
    }
  }

  const fixtures = await getSportyFixtures().catch(() => [] as SbEvent[]);
  const inWindow = fixtures
    .filter((e) => e.kickoff > minT && e.kickoff <= maxT)
    .sort((a, b) => a.kickoff - b.kickoff);

  const out: MatchAnalysis[] = [];
  const spare: MatchAnalysis[] = []; // fixtures with < 4 options, used only to backfill
  let scanned = 0;
  for (const ev of inWindow) {
    const a = analyzeEvent(ev);
    if (!a) continue;
    scanned += 1;
    // Prefer matches with a full set of options so the UI is consistent;
    // there are hundreds of fixtures, so we can afford to skip thin ones.
    if (a.options.length >= OPTIONS_TARGET) {
      out.push(a);
      if (out.length >= n) break;
    } else if (spare.length < n) {
      spare.push(a);
    }
  }
  // If we couldn't find enough 4-option matches, backfill with the best of the
  // rest rather than under-deliver on the requested count.
  for (const a of spare) {
    if (out.length >= n) break;
    out.push(a);
  }
  out.sort((x, y) => new Date(x.kickoff).getTime() - new Date(y.kickoff).getTime());

  // Fetch H2H for the top 20 matches to enrich data
  await Promise.all(
    out.slice(0, 20).map(async (a) => {
      if (a.home && a.away) {
        try {
          const h2h = await getH2HDeep(a.home, a.away);
          if (h2h) a.h2h = h2h;
        } catch {
          // ignore
        }
      }
    })
  );

  return { matches: out, requested: n, windowDays: d, scanned, onDate: onValid, onEnd: endValid };
}
