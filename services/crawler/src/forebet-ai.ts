import type { Leg } from "./ai.js";
import { getForebetTips, type ExtPrediction } from "./predictions.js";
import { config } from "./config.js";

/**
 * Forebet → SportyBet bridge.
 *
 * Matches Forebet's daily 1X2 model predictions to live SportyBet fixtures via
 * SportyBet's public upcoming-events API, producing bookable legs (eventId +
 * marketId + outcomeId) with REAL SportyBet odds. The AI engine then assembles
 * these into a slip and books a genuine SportyBet code for it. No bet is ever
 * placed — a booking code only saves selections.
 */

// Markets scanned from SportyBet's bulk feed: 1X2, Double Chance, Draw No Bet,
// Over/Under goals, per-team Over/Under, and Both Teams To Score — all verified
// present across the feed, so every pick built from them is bookable.
const EVENTS_API =
  "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1%2C10%2C11%2C18%2C19%2C20%2C29&pageSize=100&option=1&pageNum=";

/** How each pick code books on SportyBet (market/specifier/outcome + label). */
export const PICKS: Record<
  string,
  { marketId: string; specifier: string; outcomeId: string; label: string; market: string }
> = {
  // Match result (1X2)
  "1": { marketId: "1", specifier: "", outcomeId: "1", label: "Home", market: "1X2" },
  X: { marketId: "1", specifier: "", outcomeId: "2", label: "Draw", market: "1X2" },
  "2": { marketId: "1", specifier: "", outcomeId: "3", label: "Away", market: "1X2" },
  // Over/Under total match goals
  O15: { marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Over 1.5 Goals", market: "Over/Under" },
  O25: { marketId: "18", specifier: "total=2.5", outcomeId: "12", label: "Over 2.5 Goals", market: "Over/Under" },
  O35: { marketId: "18", specifier: "total=3.5", outcomeId: "12", label: "Over 3.5 Goals", market: "Over/Under" },
  U15: { marketId: "18", specifier: "total=1.5", outcomeId: "13", label: "Under 1.5 Goals", market: "Over/Under" },
  U25: { marketId: "18", specifier: "total=2.5", outcomeId: "13", label: "Under 2.5 Goals", market: "Over/Under" },
  U35: { marketId: "18", specifier: "total=3.5", outcomeId: "13", label: "Under 3.5 Goals", market: "Over/Under" },
  // Double Chance
  DC1X: { marketId: "10", specifier: "", outcomeId: "9", label: "Home or Draw (1X)", market: "Double Chance" },
  DC12: { marketId: "10", specifier: "", outcomeId: "10", label: "Home or Away (12)", market: "Double Chance" },
  DCX2: { marketId: "10", specifier: "", outcomeId: "11", label: "Draw or Away (X2)", market: "Double Chance" },
  // Draw No Bet
  DNBH: { marketId: "11", specifier: "", outcomeId: "4", label: "Home (Draw No Bet)", market: "Draw No Bet" },
  DNBA: { marketId: "11", specifier: "", outcomeId: "5", label: "Away (Draw No Bet)", market: "Draw No Bet" },
  // Both Teams To Score
  BTTSY: { marketId: "29", specifier: "", outcomeId: "74", label: "Both Teams To Score", market: "BTTS" },
  BTTSN: { marketId: "29", specifier: "", outcomeId: "76", label: "Both Teams NOT To Score", market: "BTTS" },
  // Per-team goals (home)
  HO05: { marketId: "19", specifier: "total=0.5", outcomeId: "12", label: "Home Over 0.5 Goals", market: "Team Goals" },
  HO15: { marketId: "19", specifier: "total=1.5", outcomeId: "12", label: "Home Over 1.5 Goals", market: "Team Goals" },
  HU15: { marketId: "19", specifier: "total=1.5", outcomeId: "13", label: "Home Under 1.5 Goals", market: "Team Goals" },
  // Per-team goals (away)
  AO05: { marketId: "20", specifier: "total=0.5", outcomeId: "12", label: "Away Over 0.5 Goals", market: "Team Goals" },
  AO15: { marketId: "20", specifier: "total=1.5", outcomeId: "12", label: "Away Over 1.5 Goals", market: "Team Goals" },
  AU15: { marketId: "20", specifier: "total=1.5", outcomeId: "13", label: "Away Under 1.5 Goals", market: "Team Goals" },
};

interface SbEvent {
  eventId: string;
  home: string;
  away: string;
  league?: string;
  kickoff: number;
  // Live odds keyed by pick code ("1"/"X"/"2"/"O25"/…)
  outcomes: Record<string, number>;
}

let evCache: { at: number; data: SbEvent[] } | null = null;
const EV_TTL_MS = 10 * 60 * 1000; // events move slowly; AI regen is ~15 min

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        Referer: "https://www.sportybet.com/",
        ClientId: "web",
      },
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function sportyEvents(): Promise<SbEvent[]> {
  if (evCache && Date.now() - evCache.at < EV_TTL_MS) return evCache.data;
  const out: SbEvent[] = [];
  try {
    // 10 pages ≈ 700+ fixtures; cached 10 min so this is ~1 req/min average.
    for (let page = 1; page <= 10; page++) {
      const json = await fetchJson(EVENTS_API + page).catch(() => null);
      const tours: any[] = json?.data?.tournaments ?? [];
      let added = 0;
      for (const t of tours) {
        for (const e of t.events ?? []) {
          if (!e.eventId || !e.homeTeamName || !e.awayTeamName) continue;
          const outcomes: Record<string, number> = {};
          for (const m of e.markets ?? []) {
            for (const [code, meta] of Object.entries(PICKS)) {
              if (String(m.id) !== meta.marketId) continue;
              if (meta.specifier && (m.specifier ?? "") !== meta.specifier) continue;
              const o = (m.outcomes ?? []).find((x: any) => String(x.id) === meta.outcomeId);
              const odds = o ? Number(o.odds) : NaN;
              if (Number.isFinite(odds) && odds > 1) outcomes[code] = odds;
            }
          }
          if (!Object.keys(outcomes).length) continue;
          out.push({
            eventId: String(e.eventId),
            home: String(e.homeTeamName),
            away: String(e.awayTeamName),
            league: t.name ? String(t.name) : undefined,
            kickoff: Number(e.estimateStartTime) || 0,
            outcomes,
          });
          added += 1;
        }
      }
      if (!added) break; // ran out of pages
    }
  } catch {
    /* fall through to cache */
  }
  if (out.length) evCache = { at: Date.now(), data: out };
  return out.length ? out : (evCache?.data ?? []);
}

/** Normalise a club name for fuzzy comparison across the two sites. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (Fès → fes)
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(fc|fk|sk|cf|sc|ac|afc|cd|if|bk|club|de)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // Share at least one significant token (≥4 chars) — "Raja Casablanca" ↔ "Raja CA".
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4));
  return nb.split(" ").some((t) => t.length >= 4 && ta.has(t));
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// ---- Shared "which SportyBet pick is best for this fixture" logic ----
// Used by BOTH Expert Picks (ranking/display) and its booking path, so what
// gets booked always matches what was shown — never independently re-derived.
export const RESULT_CODES = ["1", "X", "2"] as const;
export const GOALS_CODES = ["O15", "U15", "O25", "U25", "O35", "U35"] as const;
export const DC_CODES = ["DC1X", "DC12", "DCX2"] as const;
export const DNB_CODES = ["DNBH", "DNBA"] as const;
export const BTTS_CODES = ["BTTSY", "BTTSN"] as const;
export const TEAMGOALS_CODES = ["HO05", "HO15", "HU15", "AO05", "AO15", "AU15"] as const;
// "Safe" = a curated high strike-rate mix (short-priced markets that hit
// often): double chance, over 1.5, each team to score 1+, both teams to score.
export const SAFE_CODES = ["DC1X", "DCX2", "DC12", "O15", "HO05", "AO05", "BTTSY"] as const;

export type GameType =
  | "result"
  | "goals"
  | "double"
  | "dnb"
  | "btts"
  | "teamgoals"
  | "safe"
  | "both";
export const CODE_SETS: Record<GameType, readonly string[]> = {
  result: RESULT_CODES,
  goals: GOALS_CODES,
  double: DC_CODES,
  dnb: DNB_CODES,
  btts: BTTS_CODES,
  teamgoals: TEAMGOALS_CODES,
  safe: SAFE_CODES,
  both: [
    ...RESULT_CODES,
    ...GOALS_CODES,
    ...DC_CODES,
    ...DNB_CODES,
    ...BTTS_CODES,
    ...TEAMGOALS_CODES,
  ],
};
// Each pick's market group — needed to remove the bookmaker's margin (see
// devig() below): 1X2 is a 3-way group, each Over/Under LINE is its own 2-way
// group. Codes not listed here (or listed alone) use the raw implied prob.
const MARKET_GROUP: Record<string, readonly string[]> = {
  "1": RESULT_CODES,
  X: RESULT_CODES,
  "2": RESULT_CODES,
  O15: ["O15", "U15"],
  U15: ["O15", "U15"],
  O25: ["O25", "U25"],
  U25: ["O25", "U25"],
  O35: ["O35", "U35"],
  U35: ["O35", "U35"],
  DNBH: DNB_CODES,
  DNBA: DNB_CODES,
  BTTSY: BTTS_CODES,
  BTTSN: BTTS_CODES,
  HO15: ["HO15", "HU15"],
  HU15: ["HO15", "HU15"],
  AO15: ["AO15", "AU15"],
  AU15: ["AO15", "AU15"],
  // DC codes overlap (not a clean partition) so they use raw implied.
};

/**
 * De-vigged probability for one outcome: raw bookmaker odds always sum to
 * MORE than 100% across a market (their margin/"overround") — e.g. Home 75% +
 * Draw 28% + Away 12% = 115%. Dividing the raw implied probability by that
 * total removes the margin, giving a fairer read on the actual chance rather
 * than a number inflated by the bookmaker's edge. Falls back to the raw
 * (undivided) figure if a sibling price is missing and a fair split can't be
 * computed.
 */
export function devig(outcomes: Record<string, number>, code: string): number {
  const odds = outcomes[code];
  if (!odds || odds <= 1) return 0;
  const raw = 1 / odds;
  const group = MARKET_GROUP[code] ?? [code];
  if (group.length < 2) return raw; // no sibling to devig against — use raw
  let overround = 0;
  let complete = true;
  for (const c of group) {
    const o = outcomes[c];
    if (!o || o <= 1) {
      complete = false;
      break;
    }
    overround += 1 / o;
  }
  return complete && overround > 0 ? raw / overround : raw;
}

/** Best (highest fair-probability) outcome among the given codes, for a fixture. */
export function bestOutcome(
  ev: SbEvent,
  codes: readonly string[],
): { code: string; odds: number; implied: number } | null {
  let best: { code: string; odds: number; implied: number } | null = null;
  for (const code of codes) {
    const odds = ev.outcomes[code];
    if (!odds || odds <= 1) continue;
    const implied = devig(ev.outcomes, code);
    if (!best || implied > best.implied) best = { code, odds, implied };
  }
  return best;
}

interface TipMatch {
  tip: ExtPrediction;
  ev: SbEvent;
  code: string; // pick code into PICKS
  odds: number;
}

/** Match predictions (home/away + predCode) to live SportyBet fixtures. */
async function matchTips(tips: ExtPrediction[]): Promise<TipMatch[]> {
  const events = await sportyEvents();
  if (!tips.length || !events.length) return [];
  const now = Date.now();
  const out: TipMatch[] = [];
  const used = new Set<string>();
  for (const tip of tips) {
    if (!tip.home || !tip.away || !tip.predCode) continue;
    const ev = events.find(
      (e) =>
        e.kickoff > now &&
        !used.has(e.eventId) &&
        teamsMatch(e.home, tip.home!) &&
        teamsMatch(e.away, tip.away!),
    );
    if (!ev) continue;
    const odds = ev.outcomes[tip.predCode];
    if (!odds || !PICKS[tip.predCode]) continue;
    used.add(ev.eventId);
    out.push({ tip, ev, code: tip.predCode, odds });
  }
  return out;
}

/**
 * Predictions matched to SportyBet as bookable AI-engine legs. Only future
 * matches with an active 1X2 price for the predicted outcome. Used by the AI
 * engine AND the user slip-builder.
 */
function buildLegs(matches: TipMatch[]): Leg[] {
  const now = Date.now();
  return matches.map(({ tip, ev, code, odds }) => {
    const meta = PICKS[code];
    // Model probability: Forebet's own 1X2 % when present, else implied odds.
    const fbProb =
      code === "1"
        ? tip.probs?.[0]
        : code === "X"
          ? tip.probs?.[1]
          : code === "2"
            ? tip.probs?.[2]
            : undefined;
    const prob = Math.min(0.95, fbProb ? fbProb / 100 : 1 / odds + 0.02);
    return {
      eventId: ev.eventId,
      home: ev.home,
      away: ev.away,
      league: ev.league ?? tip.league,
      kickoff: ev.kickoff,
      market: meta.market,
      pick: meta.label,
      odds: round(odds, 2),
      prob: round(prob),
      consensus: 1,
      foundAt: now,
      marketId: meta.marketId,
      specifier: meta.specifier,
      outcomeId: meta.outcomeId,
    };
  });
}

export async function legsForTips(tips: ExtPrediction[]): Promise<Leg[]> {
  return buildLegs(await matchTips(tips));
}

/**
 * Booking plan for the slip builder: legs to book PLUS which tip keys matched,
 * so the caller can tell the user exactly which selections were skipped.
 */
export async function planForTips(
  tips: ExtPrediction[],
): Promise<{ legs: Leg[]; matchedKeys: string[] }> {
  const matches = await matchTips(tips);
  return {
    legs: buildLegs(matches),
    matchedKeys: matches.map((m) => `${m.tip.home}|${m.tip.away}`.toLowerCase()),
  };
}

/**
 * Which of these predictions can ACTUALLY be booked on SportyBet right now.
 * Returns the slip-builder keys (home|away lowercased) that matched — the
 * dashboard only shows "Add to slip" on these, so the Generate button never
 * fails on matches SportyBet doesn't offer.
 */
export async function bookableTipKeys(tips: ExtPrediction[]): Promise<Set<string>> {
  const matches = await matchTips(tips);
  return new Set(matches.map((m) => `${m.tip.home}|${m.tip.away}`.toLowerCase()));
}

/** Forebet's full daily tip list as bookable legs (for the AI engine). */
export async function forebetLegs(): Promise<Leg[]> {
  return legsForTips(await getForebetTips());
}

// ---- Exposed for Expert Picks: SportyBet's own live fixture+odds feed ----
// This is the ground truth of what's actually bookable, across every league
// SportyBet carries (not just the leagues our external prediction sources
// happen to cover) — Expert Picks scans this directly instead of matching
// backward from tips, so every pick it returns is guaranteed bookable.
export type { SbEvent };
export const getSportyFixtures = sportyEvents;
export const fuzzyTeamsMatch = teamsMatch;

/**
 * Book directly against SportyBet's own best (de-vigged) outcome for
 * arbitrary "home|away" keys, restricted to the SAME game-type code set
 * Expert Picks was displaying (result/goals/both) when the user selected
 * them. Used for Expert Picks selections, which are sourced straight from
 * SportyBet's fixture list rather than an external tip — so, unlike
 * planForTips(), there's no ExtPrediction/predCode to look up. Resolves each
 * key against the SAME live fixture list with the SAME bestOutcome() logic
 * used for display, so the booked code always matches what the user saw
 * (barring odds moving between page-load and booking).
 */
export async function legsForFixtureKeys(
  keys: string[],
  gameType: GameType = "result",
): Promise<{ legs: Leg[]; matchedKeys: string[] }> {
  if (!keys.length) return { legs: [], matchedKeys: [] };
  const codes = CODE_SETS[gameType] ?? CODE_SETS.result;
  const events = await sportyEvents();
  const now = Date.now();
  const legs: Leg[] = [];
  const matchedKeys: string[] = [];
  const used = new Set<string>();
  for (const key of keys) {
    const [h, a] = key.split("|");
    if (!h || !a) continue;
    const ev = events.find(
      (e) => e.kickoff > now && !used.has(e.eventId) && teamsMatch(e.home, h) && teamsMatch(e.away, a),
    );
    if (!ev) continue;
    const fav = bestOutcome(ev, codes);
    if (!fav) continue;
    const meta = PICKS[fav.code];
    used.add(ev.eventId);
    legs.push({
      eventId: ev.eventId,
      home: ev.home,
      away: ev.away,
      league: ev.league,
      kickoff: ev.kickoff,
      market: meta.market,
      pick: meta.label,
      odds: round(fav.odds, 2),
      prob: round(Math.min(0.95, fav.implied)),
      consensus: 1,
      foundAt: now,
      marketId: meta.marketId,
      specifier: meta.specifier,
      outcomeId: meta.outcomeId,
    });
    matchedKeys.push(key);
  }
  return { legs, matchedKeys };
}
