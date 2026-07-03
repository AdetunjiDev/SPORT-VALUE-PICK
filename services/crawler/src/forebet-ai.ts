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

const EVENTS_API =
  "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1%2C18&pageSize=100&option=1&pageNum=";

/** How each pick code books on SportyBet (market/specifier/outcome + label). */
const PICKS: Record<
  string,
  { marketId: string; specifier: string; outcomeId: string; label: string; market: string }
> = {
  "1": { marketId: "1", specifier: "", outcomeId: "1", label: "Home", market: "1X2" },
  X: { marketId: "1", specifier: "", outcomeId: "2", label: "Draw", market: "1X2" },
  "2": { marketId: "1", specifier: "", outcomeId: "3", label: "Away", market: "1X2" },
  O15: { marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Over 1.5", market: "Over/Under" },
  O25: { marketId: "18", specifier: "total=2.5", outcomeId: "12", label: "Over 2.5", market: "Over/Under" },
  O35: { marketId: "18", specifier: "total=3.5", outcomeId: "12", label: "Over 3.5", market: "Over/Under" },
  U15: { marketId: "18", specifier: "total=1.5", outcomeId: "13", label: "Under 1.5", market: "Over/Under" },
  U25: { marketId: "18", specifier: "total=2.5", outcomeId: "13", label: "Under 2.5", market: "Over/Under" },
  U35: { marketId: "18", specifier: "total=3.5", outcomeId: "13", label: "Under 3.5", market: "Over/Under" },
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
    for (let page = 1; page <= 3; page++) {
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
export async function legsForTips(tips: ExtPrediction[]): Promise<Leg[]> {
  const now = Date.now();
  return (await matchTips(tips)).map(({ tip, ev, code, odds }) => {
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
