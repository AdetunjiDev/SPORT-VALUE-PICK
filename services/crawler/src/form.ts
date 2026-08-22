import { prisma } from "@sportybet/db";
import { config } from "./config.js";
import { fuzzyTeamsMatch } from "./forebet-ai.js";
import { getAfHeadToHead } from "./apifootball.js";

/**
 * Real recent-form lookups — the last 5 FINISHED matches per team with the
 * actual final scores, from TheSportsDB's public API (a real results database,
 * not invented numbers). Two teams × 5 = up to 10 genuine past results per
 * analysed fixture, so users can read form before trusting a pick.
 *
 * Honest scope: coverage is best for the major leagues; small regional or
 * simulated (SRL) fixtures often aren't in the database — those cards say
 * "form unavailable" rather than showing fake history.
 */

export interface PastMatch {
  date: string; // "2026-07-12"
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  result: "W" | "D" | "L"; // from the looked-up team's perspective
}

export interface TeamForm {
  team: string; // canonical name in the results database
  matches: PastMatch[]; // newest first, up to 5
  summary: string; // e.g. "W W D L W" (newest first)
}

const API = () => `https://www.thesportsdb.com/api/v1/json/${config.sportsDbKey}`;

// Long-lived caches: past results change at most once a match-day, and the
// analysis page re-renders every 10 minutes — never re-hit the API for a team
// we already resolved this half-day.
const FORM_TTL_MS = 6 * 60 * 60 * 1000; // hits
const MISS_TTL_MS = 60 * 60 * 1000; // misses (team not in DB) — retry hourly
const formCache = new Map<string, { at: number; data: TeamForm | null }>();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Strict score parse: null/"" means the match hasn't been played — do NOT let
// Number(null) === 0 fabricate a 0-0. Only real recorded scores pass.
const numScore = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

const todayISO = () => new Date().toISOString().slice(0, 10);

// ---- Persistent lookup cache (Postgres) ----
// The free results API is rate-limited, so conclusive answers are stored in
// the DB permanently: hits refresh daily, confirmed misses retry every 6h.
// Coverage therefore COMPOUNDS across refreshes and restarts.
const DB_HIT_TTL_MS = 24 * 60 * 60 * 1000;
const DB_MISS_TTL_MS = 6 * 60 * 60 * 1000;

async function dbCacheGet<T>(key: string): Promise<{ data: T; fresh: boolean } | null> {
  const row = await prisma.lookupCache.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  const data = row.data as unknown as T;
  const empty = data === null || (Array.isArray(data) && data.length === 0);
  const ttl = empty ? DB_MISS_TTL_MS : DB_HIT_TTL_MS;
  return { data, fresh: Date.now() - row.fetchedAt.getTime() < ttl };
}

async function dbCachePut(key: string, data: unknown): Promise<void> {
  await prisma.lookupCache
    .upsert({
      where: { key },
      create: { key, data: data as object },
      update: { data: data as object, fetchedAt: new Date() },
    })
    .catch(() => {});
}

/** Fetch JSON, distinguishing API failure (ok:false — do NOT negative-cache,
 *  it's likely a rate limit) from a genuine empty result. */
async function fetchJson(url: string): Promise<{ ok: boolean; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, json: null };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a team name to TheSportsDB's soccer team id.
 *  null = confirmed not found; "err" = API failure (don't cache the miss). */
async function findTeam(name: string): Promise<{ id: string; name: string } | null | "err"> {
  const r = await fetchJson(`${API()}/searchteams.php?t=${encodeURIComponent(name)}`);
  if (!r.ok) return "err";
  const teams: any[] = r.json?.teams ?? [];
  const soccer = teams.filter((t) => t?.strSport === "Soccer" && t?.idTeam);
  const hit =
    soccer.find((t) => norm(t.strTeam) === norm(name)) ??
    soccer.find((t) => fuzzyTeamsMatch(t.strTeam, name));
  return hit ? { id: String(hit.idTeam), name: String(hit.strTeam) } : null;
}

/** Last up-to-5 finished matches for a team, with REAL final scores. */
export async function getTeamForm(teamName: string): Promise<TeamForm | null> {
  const key = norm(teamName);
  const hit = formCache.get(key);
  if (hit && Date.now() - hit.at < (hit.data ? FORM_TTL_MS : MISS_TTL_MS)) return hit.data;

  // Durable cache: answers found in any previous run/restart come from the DB.
  const dbHit = await dbCacheGet<TeamForm | null>(`form:${key}`);
  if (dbHit?.fresh) {
    formCache.set(key, { at: Date.now(), data: dbHit.data });
    return dbHit.data;
  }

  let data: TeamForm | null = null;
  const team = await findTeam(teamName);
  if (team === "err") return dbHit?.data ?? hit?.data ?? null; // transient API failure — serve stale
  if (team) {
    const r = await fetchJson(`${API()}/eventslast.php?id=${encodeURIComponent(team.id)}`);
    if (!r.ok) return dbHit?.data ?? hit?.data ?? null; // transient — don't cache as a miss
    const rows: any[] = r.json?.results ?? [];
    const matches: PastMatch[] = [];
    for (const r of rows) {
      const hs = numScore(r?.intHomeScore);
      const as = numScore(r?.intAwayScore);
      if (!r?.strHomeTeam || !r?.strAwayTeam || hs === null || as === null) continue;
      // >= today: fixtures dated today may carry a pre-filled 0-0 before kickoff.
      if (r?.dateEvent && String(r.dateEvent) >= todayISO()) continue;
      const isHome = fuzzyTeamsMatch(String(r.strHomeTeam), team.name);
      const mine = isHome ? hs : as;
      const theirs = isHome ? as : hs;
      matches.push({
        date: String(r.dateEvent ?? ""),
        home: String(r.strHomeTeam),
        away: String(r.strAwayTeam),
        homeScore: hs,
        awayScore: as,
        result: mine > theirs ? "W" : mine === theirs ? "D" : "L",
      });
      if (matches.length >= 5) break;
    }
    if (matches.length) {
      data = { team: team.name, matches, summary: matches.map((m) => m.result).join(" ") };
    }
  }
  formCache.set(key, { at: Date.now(), data });
  void dbCachePut(`form:${key}`, data); // durable — survives restarts
  return data;
}

export interface MatchForm {
  home: TeamForm | null;
  away: TeamForm | null;
  /** Past meetings between the two clubs (real scores, newest first, ≤10).
   *  `result` is from the CURRENT home team's perspective. */
  h2h: PastMatch[];
}

const h2hCache = new Map<string, { at: number; data: PastMatch[] }>();

// How many past meetings we aim to show per fixture, and how many seasons back
// to dig for them. Same-league rivals meet ~2×/season, so 4 seasons ≈ 5+ games.
const H2H_TARGET = 5;
const H2H_SEASONS_BACK = 4;

/** Real head-to-head history between two clubs (empty when not in the DB). */
async function headToHead(homeName: string, awayName: string): Promise<PastMatch[]> {
  const key = `${norm(homeName)}|${norm(awayName)}`;
  const hit = h2hCache.get(key);
  if (hit && Date.now() - hit.at < (hit.data.length ? FORM_TTL_MS : MISS_TTL_MS)) return hit.data;

  // Durable cache first: pairings resolved in ANY previous run come from the DB.
  const dbHit = await dbCacheGet<PastMatch[]>(`h2h:${key}`);
  if (dbHit?.fresh) {
    h2hCache.set(key, { at: Date.now(), data: dbHit.data });
    return dbHit.data;
  }

  // PREMIUM path: API-Football's dedicated H2H endpoint (deep coverage, small
  // leagues included) whenever APIFOOTBALL_KEY is set. null = adapter off /
  // budget spent / API error → fall through to the free source below.
  const af = await getAfHeadToHead(homeName, awayName).catch(() => null);
  if (af && af.length) {
    const data: PastMatch[] = af.map((m) => {
      const ourHomeWasHome = fuzzyTeamsMatch(m.home, homeName);
      const mine = ourHomeWasHome ? m.homeScore : m.awayScore;
      const theirs = ourHomeWasHome ? m.awayScore : m.homeScore;
      return {
        date: m.date,
        home: m.home,
        away: m.away,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        result: mine > theirs ? "W" : mine === theirs ? "D" : "L",
      };
    });
    h2hCache.set(key, { at: Date.now(), data });
    void dbCachePut(`h2h:${key}`, data);
    return data;
  }

  let apiFailed = false;
  const fetchMeetings = async (a: string, b: string, season?: string): Promise<any[]> => {
    const q = `${a} vs ${b}`.replace(/\s+/g, "_");
    const url = `${API()}/searchevents.php?e=${encodeURIComponent(q)}${season ? `&s=${season}` : ""}`;
    const r = await fetchJson(url);
    if (!r.ok) apiFailed = true;
    return r.json?.event ?? r.json?.events ?? [];
  };

  const seen = new Set<string>();
  const out: PastMatch[] = [];
  const collect = (raw: any[]) => {
    for (const r of raw) {
      if (r?.strSport !== "Soccer") continue;
      const hs = numScore(r?.intHomeScore);
      const as = numScore(r?.intAwayScore);
      if (!r?.strHomeTeam || !r?.strAwayTeam || hs === null || as === null) continue;
      // >= today: an unplayed fixture dated today can carry a pre-filled 0-0.
      if (r?.dateEvent && String(r.dateEvent) >= todayISO()) continue;
      // Both named clubs must actually be the two clubs of THIS fixture.
      const okPair =
        (fuzzyTeamsMatch(r.strHomeTeam, homeName) && fuzzyTeamsMatch(r.strAwayTeam, awayName)) ||
        (fuzzyTeamsMatch(r.strHomeTeam, awayName) && fuzzyTeamsMatch(r.strAwayTeam, homeName));
      if (!okPair) continue;
      const id = String(r.idEvent ?? `${r.dateEvent}|${r.strHomeTeam}|${hs}-${as}`);
      if (seen.has(id)) continue;
      seen.add(id);
      const ourHomeWasHome = fuzzyTeamsMatch(r.strHomeTeam, homeName);
      const mine = ourHomeWasHome ? hs : as;
      const theirs = ourHomeWasHome ? as : hs;
      out.push({
        date: String(r.dateEvent ?? ""),
        home: String(r.strHomeTeam),
        away: String(r.strAwayTeam),
        homeScore: hs,
        awayScore: as,
        result: mine > theirs ? "W" : mine === theirs ? "D" : "L",
      });
    }
  };

  // Season strings, newest first: undefined = API default (current season),
  // then explicit past seasons ("2025-2026", "2024-2025", …). European seasons
  // roll over mid-year. We stop as soon as we've collected H2H_TARGET meetings
  // so well-known rivals cost only a couple of requests.
  const nowD = new Date();
  const startYear = nowD.getUTCMonth() + 1 >= 7 ? nowD.getUTCFullYear() : nowD.getUTCFullYear() - 1;
  const seasons: (string | undefined)[] = [undefined];
  for (let k = 1; k <= H2H_SEASONS_BACK; k++) seasons.push(`${startYear - k}-${startYear - k + 1}`);
  for (const s of seasons) {
    const [a, b] = await Promise.all([
      fetchMeetings(homeName, awayName, s),
      fetchMeetings(awayName, homeName, s),
    ]);
    collect([...a, ...b]);
    if (out.length >= H2H_TARGET) break;
  }

  out.sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0));
  const data = out.slice(0, 10);
  // An empty result during an API failure is inconclusive — don't cache it.
  if (data.length || !apiFailed) {
    h2hCache.set(key, { at: Date.now(), data });
    void dbCachePut(`h2h:${key}`, data); // durable — survives restarts
  }
  return data;
}

/** Both teams' recent form + head-to-head for one fixture. */
export async function getMatchForm(home: string, away: string): Promise<MatchForm> {
  const [h, a] = await Promise.all([
    getTeamForm(home).catch(() => null),
    getTeamForm(away).catch(() => null),
  ]);
  // Query H2H with the results-DB canonical names when we resolved them —
  // "FC Copenhagen" finds meetings that SportyBet's "Copenhagen" wouldn't.
  const h2h = await headToHead(h?.team ?? home, a?.team ?? away).catch(() => []);
  return { home: h, away: a, h2h };
}

/**
 * Team "excellence now" rating on a 0–10 scale, computed from REAL data only:
 * points-per-game over the last real results (55%) blended with the market's
 * current strength read for this fixture (45%). Per-player ratings would need
 * licensed player data we don't have — this is the honest team-level signal.
 */
export function teamRating(
  f: TeamForm | null,
  modelProb: number,
): { score: number; trend: string; basis: "form+market" | "market-only" } {
  const market = Math.max(0, Math.min(1, modelProb));
  if (!f || !f.matches.length) {
    return { score: Math.round(market * 100) / 10, trend: "→ steady", basis: "market-only" };
  }
  const pts = f.matches.reduce((s, m) => s + (m.result === "W" ? 3 : m.result === "D" ? 1 : 0), 0);
  const ppg = pts / (3 * f.matches.length); // 0..1
  const score = Math.round((0.55 * ppg + 0.45 * market) * 100) / 10;
  const [r1, r2] = [f.matches[0]?.result, f.matches[1]?.result];
  const trend =
    r1 === "W" && r2 === "W"
      ? "🔥 hot"
      : r1 === "L" && r2 === "L"
        ? "❄️ cold"
        : r1 === "W"
          ? "↗ rising"
          : r1 === "L"
            ? "↘ dipping"
            : "→ steady";
  return { score, trend, basis: "form+market" };
}

/**
 * Warm the form cache for a page of fixtures within a time budget, returning
 * whatever resolved in time (keyed "home|away" lowercased). Lookups that miss
 * the budget keep running in the background and fill the cache for the next
 * render (the analysis page auto-refreshes), so coverage improves per refresh.
 */
export async function getFormsForMatches(
  pairs: { home: string; away: string }[],
  budgetMs = 6000,
): Promise<Map<string, MatchForm>> {
  const out = new Map<string, MatchForm>();
  const CONCURRENCY = 6;
  let idx = 0;
  const worker = async () => {
    while (idx < pairs.length) {
      const p = pairs[idx++];
      const mf = await getMatchForm(p.home, p.away);
      out.set(`${p.home}|${p.away}`.toLowerCase(), mf);
    }
  };
  const all = Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await Promise.race([all, new Promise((r) => setTimeout(r, budgetMs))]);
  return out;
}
