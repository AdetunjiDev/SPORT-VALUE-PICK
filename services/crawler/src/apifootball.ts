import { config } from "./config.js";
import type { ExtPrediction } from "./predictions.js";

/**
 * API-Football (api-sports.io) adapter — an optional PREMIUM data feed.
 *
 * Supplies reliable fixtures (exact kick-off times + leagues) and, within a
 * daily budget, model predictions (1X2 %, over/under, advice) that merge into
 * the predictions calendar and feed the AI slip pool.
 *
 * Free-tier friendly by design:
 *  - No key ⇒ this whole module is a no-op (returns []), so the app runs and
 *    ships without paying. Drop APIFOOTBALL_KEY in .env to switch it on.
 *  - Fixtures are fetched once and cached ~3h (a few calls/day).
 *  - Predictions cost 1 request each, so we spend only a few per cycle and cap
 *    the total per day — never blowing the 100/day free quota.
 */

const BASE_URL =
  config.apiFootball.provider === "rapidapi"
    ? "https://api-football-v1.p.rapidapi.com/v3"
    : "https://v3.football.api-sports.io";

const AUTH_HEADER = config.apiFootball.provider === "rapidapi" ? "x-rapidapi-key" : "x-apisports-key";

export const apiFootballEnabled = () => config.apiFootball.key.length > 0;

// --- Frugal request accounting (resets each WAT calendar day) ---
let budgetDay = "";
let spentToday = 0;
function dayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}
function canSpend(n = 1): boolean {
  const d = dayKey();
  if (d !== budgetDay) {
    budgetDay = d;
    spentToday = 0;
  }
  return spentToday + n <= config.apiFootball.dailyBudget;
}

async function apiGet(path: string): Promise<any | null> {
  if (!apiFootballEnabled() || !canSpend(1)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { [AUTH_HEADER]: config.apiFootball.key, Accept: "application/json" },
      signal: controller.signal,
    });
    spentToday += 1;
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    // API-Sports reports quota/plan errors in an `errors` object, not HTTP codes.
    if (json && json.errors && Object.keys(json.errors).length) {
      console.warn(`  ! api-football: ${JSON.stringify(json.errors).slice(0, 160)}`);
      return null;
    }
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface AfFixture {
  id: number;
  home: string;
  away: string;
  league?: string;
  kickoff: string; // ISO
}

let fxCache: { at: number; data: AfFixture[] } | null = null;
const FX_TTL_MS = 3 * 60 * 60 * 1000; // 3h — fixtures barely move

/** Today's + tomorrow's fixtures (2 requests, cached 3h). */
async function fixtures(): Promise<AfFixture[]> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL_MS) return fxCache.data;
  const today = dayKey();
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Africa/Lagos",
  });
  const out: AfFixture[] = [];
  for (const date of [today, tomorrow]) {
    const json = await apiGet(`/fixtures?date=${date}&timezone=Africa/Lagos`);
    for (const r of json?.response ?? []) {
      if (!r?.fixture?.id || !r?.teams?.home?.name || !r?.teams?.away?.name) continue;
      out.push({
        id: Number(r.fixture.id),
        home: String(r.teams.home.name),
        away: String(r.teams.away.name),
        league: r?.league?.name ? String(r.league.name) : undefined,
        kickoff: String(r.fixture.date),
      });
    }
  }
  if (out.length) fxCache = { at: Date.now(), data: out };
  return out.length ? out : (fxCache?.data ?? []);
}

// Per-fixture predictions, cached until end of day (they don't change intraday).
const predCache = new Map<number, ExtPrediction>();
let predCacheDay = "";

function mapUnderOver(uo: unknown): ExtPrediction["predCode"] | undefined {
  // API-Football gives e.g. "-2.5" (under 2.5) or "+2.5" (over 2.5).
  const m = String(uo ?? "").match(/([+-])\s*([123])\.5/);
  if (!m) return undefined;
  const line = m[2];
  return (m[1] === "+" ? `O${line}5` : `U${line}5`) as ExtPrediction["predCode"];
}

async function predictionFor(fx: AfFixture): Promise<ExtPrediction | null> {
  if (predCacheDay !== dayKey()) {
    predCache.clear();
    predCacheDay = dayKey();
  }
  const cached = predCache.get(fx.id);
  if (cached) return cached;
  if (!canSpend(1)) return null;

  const json = await apiGet(`/predictions?fixture=${fx.id}`);
  const p = json?.response?.[0]?.predictions;
  if (!p) return null;

  const pct = p.percent ?? {};
  const probs: [number, number, number] | undefined =
    pct.home || pct.draw || pct.away
      ? [parseInt(pct.home) || 0, parseInt(pct.draw) || 0, parseInt(pct.away) || 0]
      : undefined;

  // Winner → 1/X/2 (fall back to over/under advice if there's no clear winner).
  const winner = String(p.winner?.name ?? "").toLowerCase();
  let predCode: ExtPrediction["predCode"] | undefined;
  let tip: string | undefined;
  if (winner && fx.home.toLowerCase().includes(winner.split(" ")[0])) {
    predCode = "1";
    tip = `${fx.home} to Win`;
  } else if (winner && fx.away.toLowerCase().includes(winner.split(" ")[0])) {
    predCode = "2";
    tip = `${fx.away} to Win`;
  } else {
    predCode = mapUnderOver(p.under_over);
    if (predCode) tip = predCode.startsWith("O") ? `Over ${predCode[1]}.5 Goals` : `Under ${predCode[1]}.5 Goals`;
  }

  const result: ExtPrediction = {
    source: "api-football.com",
    home: fx.home,
    away: fx.away,
    league: fx.league,
    kickoff: fx.kickoff,
    tip: tip ?? (p.advice ? String(p.advice) : undefined),
    probability: probs ? `${probs[0]}% / ${probs[1]}% / ${probs[2]}%` : undefined,
    analysis: p.advice ? `API-Football model: ${p.advice}` : undefined,
    predCode,
    probs,
  };
  predCache.set(fx.id, result);
  return result;
}

let feedCache: { at: number; data: ExtPrediction[] } | null = null;
const FEED_TTL_MS = 150 * 1000;

/**
 * API-Football predictions for the calendar + AI pool. Returns [] when no key
 * is configured or the daily budget is exhausted (falls back to last data).
 */
export async function getApiFootballPredictions(): Promise<ExtPrediction[]> {
  if (!apiFootballEnabled()) return [];
  if (feedCache && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache.data;

  const fx = await fixtures();
  if (!fx.length) return feedCache?.data ?? [];

  const now = Date.now();
  const upcoming = fx
    .filter((f) => new Date(f.kickoff).getTime() > now)
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());

  // Every upcoming fixture is at least a calendar entry (reliable kick-off +
  // league). Spend a small budget enriching the soonest ones with predictions.
  const out: ExtPrediction[] = [];
  let enriched = 0;
  for (const f of upcoming) {
    if (enriched < config.apiFootball.predsPerCycle) {
      const pred = await predictionFor(f);
      if (pred) {
        out.push(pred);
        enriched += 1;
        continue;
      }
    }
    // Already-cached prediction (free) or a bare fixture entry.
    const cachedPred = predCache.get(f.id);
    out.push(
      cachedPred ?? {
        source: "api-football.com",
        home: f.home,
        away: f.away,
        league: f.league,
        kickoff: f.kickoff,
      },
    );
  }

  if (out.length) feedCache = { at: Date.now(), data: out };
  return out.length ? out : (feedCache?.data ?? []);
}
