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
  "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&option=1&pageNum=";

interface SbEvent {
  eventId: string;
  home: string;
  away: string;
  league?: string;
  kickoff: number;
  // 1X2 outcomes keyed by outcome id: "1"=home, "2"=draw, "3"=away
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
          const m = (e.markets ?? []).find((mk: any) => String(mk.id) === "1");
          if (!m || !e.eventId || !e.homeTeamName || !e.awayTeamName) continue;
          const outcomes: Record<string, number> = {};
          for (const o of m.outcomes ?? []) {
            const odds = Number(o.odds);
            if (odds > 1) outcomes[String(o.id)] = odds;
          }
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

/**
 * Match any set of predictions (with home/away + predCode) to live SportyBet
 * fixtures as bookable legs. Only future matches with an active 1X2 price for
 * the predicted outcome. Used by the AI engine AND the user slip-builder.
 */
export async function legsForTips(tips: ExtPrediction[]): Promise<Leg[]> {
  const events = await sportyEvents();
  if (!tips.length || !events.length) return [];
  const now = Date.now();
  const legs: Leg[] = [];
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
    const outcomeId = tip.predCode === "1" ? "1" : tip.predCode === "X" ? "2" : "3";
    const odds = ev.outcomes[outcomeId];
    if (!odds) continue;
    used.add(ev.eventId);
    // Model probability: Forebet's own % when present, else implied from odds.
    const probIdx = tip.predCode === "1" ? 0 : tip.predCode === "X" ? 1 : 2;
    const fbProb = tip.probs?.[probIdx];
    const prob = Math.min(0.95, fbProb ? fbProb / 100 : 1 / odds + 0.02);
    const pick = tip.predCode === "1" ? "Home" : tip.predCode === "X" ? "Draw" : "Away";
    legs.push({
      eventId: ev.eventId,
      home: ev.home,
      away: ev.away,
      league: ev.league ?? tip.league,
      kickoff: ev.kickoff,
      market: "1X2",
      pick,
      odds: round(odds, 2),
      prob: round(prob),
      consensus: 1,
      foundAt: now,
      marketId: "1",
      specifier: "",
      outcomeId,
    });
  }
  return legs;
}

/** Forebet's full daily tip list as bookable legs (for the AI engine). */
export async function forebetLegs(): Promise<Leg[]> {
  return legsForTips(await getForebetTips());
}
