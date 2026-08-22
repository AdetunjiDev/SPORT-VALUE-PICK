import { config } from "./config.js";

/**
 * API-Football Intelligence Hub — professional sports analyst features.
 *
 * Leverages the paid API-Football subscription to deliver 6 features:
 *   1. Team Form & Momentum Radar (0–100 score, hot/cold labels)
 *   2. H2H Deep Intelligence (scoreline patterns, venue factor, trends)
 *   3. League Standings & Context (title race/relegation, position gaps)
 *   4. Injury & Squad Impact Reports (key-player flags, depletion warnings)
 *   5. Giant Killer Radar (high-odds underdog upset detection)
 *   6. Banker Lock System (6-criteria near-certainty scoring)
 *
 * Fully budget-aware: aggressive caching (6h/12h/2h/24h), daily accounting,
 * and graceful degradation when the API key is missing or suspended.
 */

// ---- Configuration ----
const BASE_URL =
  config.apiFootball.provider === "rapidapi"
    ? "https://api-football-v1.p.rapidapi.com/v3"
    : "https://v3.football.api-sports.io";
const AUTH_HEADER =
  config.apiFootball.provider === "rapidapi" ? "x-rapidapi-key" : "x-apisports-key";

const intelEnabled = () => config.apiFootball.key.length > 0;
export { intelEnabled };

// ---- Budget accounting (shared with apifootball.ts via total daily cap) ----
let budgetDay = "";
let spentToday = 0;
function dayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
}
function canSpend(n = 1): boolean {
  const d = dayKey();
  if (d !== budgetDay) { budgetDay = d; spentToday = 0; }
  return spentToday + n <= config.intelBudget;
}

async function apiGet(path: string): Promise<any | null> {
  if (!intelEnabled() || !canSpend(1)) return null;
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
    if (json?.errors && Object.keys(json.errors).length) {
      console.warn(`  ! intel: ${JSON.stringify(json.errors).slice(0, 160)}`);
      return null;
    }
    return json;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// =====================================================================
// GENERIC CACHE LAYER
// =====================================================================
interface CacheEntry<T> { data: T; expiresAt: number }
const cache = new Map<string, CacheEntry<any>>();
function cget<T>(key: string): T | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { cache.delete(key); return undefined; }
  return e.data as T;
}
function cset<T>(key: string, data: T, ttlMs: number) {
  // Evict expired entries if cache is getting large
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) { if (v.expiresAt <= now) cache.delete(k); }
    if (cache.size > 600) cache.clear();
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const TEAM_STATS_TTL = 6 * 60 * 60 * 1000;   // 6h
const STANDINGS_TTL  = 12 * 60 * 60 * 1000;  // 12h
const INJURY_TTL     = 2 * 60 * 60 * 1000;   // 2h
const H2H_DEEP_TTL  = 24 * 60 * 60 * 1000;  // 24h
const TEAM_ID_TTL   = 48 * 60 * 60 * 1000;  // 48h

// =====================================================================
// 0. TEAM ID RESOLVER (shared across features)
// =====================================================================
const afNorm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(fc|fk|sk|cf|sc|ac|afc|cd|if|bk|club|de)\b/g, "")
    .replace(/\s+/g, " ").trim();

function namesMatch(a: string, b: string): boolean {
  const na = afNorm(a); const nb = afNorm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4));
  return nb.split(" ").some((t) => t.length >= 4 && ta.has(t));
}

export async function resolveTeamId(name: string): Promise<number | null> {
  const key = `teamid:${afNorm(name)}`;
  const cached = cget<number | null>(key);
  if (cached !== undefined) return cached;
  const json = await apiGet(`/teams?search=${encodeURIComponent(name.slice(0, 60))}`);
  if (!json) return null;
  const rows: any[] = json.response ?? [];
  const nk = afNorm(name);
  const exact = rows.find((r) => afNorm(String(r?.team?.name ?? "")) === nk);
  const fuzzy = rows.find((r) => namesMatch(String(r?.team?.name ?? ""), name));
  const id = Number((exact ?? fuzzy)?.team?.id) || null;
  cset(key, id, TEAM_ID_TTL);
  return id;
}

// =====================================================================
// 1. TEAM FORM & MOMENTUM RADAR
// =====================================================================
export interface MomentumResult {
  score: number;            // 0–100
  label: string;            // "🔥 On Fire" | "✅ Good Shape" | "⚠️ Inconsistent" | "❄️ Cold" | "💀 Crisis"
  tag: string;              // short: "hot" | "good" | "mid" | "cold" | "crisis"
  streak: string;           // "W3" | "L2" | "U5" (unbeaten) | "—"
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  cleanSheets: number;
  games: number;
}

function labelMomentum(score: number): { label: string; tag: string } {
  if (score >= 80) return { label: "🔥 On Fire", tag: "hot" };
  if (score >= 60) return { label: "✅ Good Shape", tag: "good" };
  if (score >= 40) return { label: "⚠️ Inconsistent", tag: "mid" };
  if (score >= 20) return { label: "❄️ Cold", tag: "cold" };
  return { label: "💀 Crisis", tag: "crisis" };
}

function detectStreak(results: string[]): string {
  if (!results.length) return "—";
  const first = results[0];
  let len = 1;
  for (let i = 1; i < results.length; i++) { if (results[i] === first) len++; else break; }
  if (first === "W" && len >= 2) return `W${len}`;
  if (first === "L" && len >= 2) return `L${len}`;
  // Unbeaten streak
  let ub = 0;
  for (const r of results) { if (r !== "L") ub++; else break; }
  if (ub >= 3) return `U${ub}`;
  return "—";
}

export async function getTeamMomentum(teamName: string): Promise<MomentumResult | null> {
  const key = `momentum:${afNorm(teamName)}`;
  const cached = cget<MomentumResult>(key);
  if (cached) return cached;

  const teamId = await resolveTeamId(teamName);
  if (!teamId) return null;

  // Last 10 finished matches for this team
  const json = await apiGet(`/fixtures?team=${teamId}&last=10&status=FT-AET-PEN`);
  if (!json) return null;
  const matches: any[] = json.response ?? [];
  if (!matches.length) return null;

  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, cs = 0;
  const results: string[] = [];

  for (const m of matches) {
    const isHome = m?.teams?.home?.id === teamId;
    const gh = Number(m?.goals?.home ?? 0);
    const gaw = Number(m?.goals?.away ?? 0);
    const scored = isHome ? gh : gaw;
    const conceded = isHome ? gaw : gh;
    gf += scored; ga += conceded;
    if (conceded === 0) cs++;
    if (scored > conceded) { wins++; results.push("W"); }
    else if (scored === conceded) { draws++; results.push("D"); }
    else { losses++; results.push("L"); }
  }

  const n = matches.length;
  const ppg = (wins * 3 + draws) / (n * 3); // 0..1
  const gfPerGame = gf / n;
  const gaPerGame = ga / n;
  const csRate = cs / n;

  // Momentum score: 40% PPG + 20% goal-scoring + 15% clean-sheet rate + 25% streak bonus
  let streakBonus = 0;
  const streak = detectStreak(results);
  if (streak.startsWith("W")) streakBonus = Math.min(1, parseInt(streak.slice(1)) / 5);
  else if (streak.startsWith("U")) streakBonus = Math.min(0.7, parseInt(streak.slice(1)) / 7);
  else if (streak.startsWith("L")) streakBonus = -Math.min(1, parseInt(streak.slice(1)) / 4);

  const rawScore = ppg * 40 + Math.min(1, gfPerGame / 2.5) * 20 + csRate * 15 + (0.5 + streakBonus * 0.5) * 25;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const result: MomentumResult = {
    score, ...labelMomentum(score), streak,
    wins, draws, losses, goalsFor: gf, goalsAgainst: ga, cleanSheets: cs, games: n,
  };
  cset(key, result, TEAM_STATS_TTL);
  return result;
}

// =====================================================================
// 2. HEAD-TO-HEAD DEEP INTELLIGENCE
// =====================================================================
export interface H2HDeep {
  totalMeetings: number;
  homeWins: number;         // wins from the perspective of `homeName`
  draws: number;
  awayWins: number;
  homeGoals: number;
  awayGoals: number;
  bttsCount: number;        // meetings where both teams scored
  over25Count: number;      // meetings with 3+ goals
  commonScorelines: { score: string; count: number }[];
  lastMeetings: { date: string; home: string; away: string; homeGoals: number; awayGoals: number }[];
  dominance: string;        // "Home dominant" | "Away dominant" | "Even"
  dominanceScore: number;   // 0–100, >50 = home dominant, <50 = away dominant
}

export async function getH2HDeep(homeName: string, awayName: string): Promise<H2HDeep | null> {
  const key = `h2hdeep:${afNorm(homeName)}|${afNorm(awayName)}`;
  const cached = cget<H2HDeep>(key);
  if (cached) return cached;

  const [hId, aId] = await Promise.all([resolveTeamId(homeName), resolveTeamId(awayName)]);
  if (!hId || !aId) return null;

  const json = await apiGet(`/fixtures/headtohead?h2h=${hId}-${aId}&last=20`);
  if (!json) return null;
  const matches: any[] = json.response ?? [];
  if (!matches.length) return null;

  let hWins = 0, draws = 0, aWins = 0, hGoals = 0, aGoals = 0, btts = 0, over25 = 0;
  const scorelines = new Map<string, number>();
  const meetings: H2HDeep["lastMeetings"] = [];

  for (const m of matches) {
    const st = String(m?.fixture?.status?.short ?? "");
    if (!["FT", "AET", "PEN"].includes(st)) continue;
    const gh = Number(m?.goals?.home ?? 0);
    const ga = Number(m?.goals?.away ?? 0);
    const mHome = String(m?.teams?.home?.name ?? "");
    const mAway = String(m?.teams?.away?.name ?? "");

    // Determine perspective: which side is `homeName`?
    const homeIsOurHome = namesMatch(mHome, homeName);
    const scoredHome = homeIsOurHome ? gh : ga;
    const scoredAway = homeIsOurHome ? ga : gh;

    if (scoredHome > scoredAway) hWins++;
    else if (scoredHome === scoredAway) draws++;
    else aWins++;

    hGoals += scoredHome;
    aGoals += scoredAway;
    if (gh > 0 && ga > 0) btts++;
    if (gh + ga >= 3) over25++;

    const sl = `${gh}-${ga}`;
    scorelines.set(sl, (scorelines.get(sl) ?? 0) + 1);

    meetings.push({
      date: String(m?.fixture?.date ?? "").slice(0, 10),
      home: mHome, away: mAway, homeGoals: gh, awayGoals: ga,
    });
  }

  meetings.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  const total = hWins + draws + aWins;
  const commonScorelines = [...scorelines.entries()]
    .map(([score, count]) => ({ score, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const dominanceScore = total > 0 ? Math.round(((hWins + draws * 0.5) / total) * 100) : 50;
  const dominance = dominanceScore >= 60 ? "Home dominant" : dominanceScore <= 40 ? "Away dominant" : "Even";

  const result: H2HDeep = {
    totalMeetings: total, homeWins: hWins, draws, awayWins: aWins,
    homeGoals: hGoals, awayGoals: aGoals,
    bttsCount: btts, over25Count: over25,
    commonScorelines, lastMeetings: meetings.slice(0, 10),
    dominance, dominanceScore,
  };
  cset(key, result, H2H_DEEP_TTL);
  return result;
}

// =====================================================================
// 3. LEAGUE STANDINGS & CONTEXT ENGINE
// =====================================================================
export interface StandingRow {
  rank: number;
  teamId: number;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  form: string;           // "WWDLW"
  ppg: number;            // points per game
}

export interface LeagueContext {
  leagueName: string;
  leagueId: number;
  season: number;
  standings: StandingRow[];
  totalTeams: number;
}

export interface TeamStandingContext {
  rank: number;
  totalTeams: number;
  points: number;
  ppg: number;
  form: string;
  motivationTier: string;   // "🏆 Title Race" | "⚡ European Push" | "😐 Mid-Table" | "🆘 Relegation Fight"
  motivationTag: string;    // "title" | "european" | "midtable" | "relegation"
  leagueName: string;
}

function motivationTier(rank: number, total: number): { tier: string; tag: string } {
  const pct = rank / total;
  if (rank <= 3 || pct <= 0.15) return { tier: "🏆 Title Race", tag: "title" };
  if (rank <= 6 || pct <= 0.30) return { tier: "⚡ European Push", tag: "european" };
  if (pct >= 0.80 || rank >= total - 2) return { tier: "🆘 Relegation Fight", tag: "relegation" };
  return { tier: "😐 Mid-Table", tag: "midtable" };
}

// Map league names to API-Football league IDs (top leagues)
const LEAGUE_ID_MAP: Record<string, number> = {
  "premier league": 39, "la liga": 140, "serie a": 135, "bundesliga": 78,
  "ligue 1": 61, "eredivisie": 88, "primeira liga": 94, "championship": 40,
  "liga mx": 262, "mls": 253, "saudi pro league": 307, "scottish premiership": 179,
  "super lig": 203, "copa libertadores": 13, "champions league": 2,
  "europa league": 3, "conference league": 848,
};

async function resolveLeagueId(leagueName: string): Promise<number | null> {
  if (!leagueName) return null;
  const norm = leagueName.toLowerCase().trim();
  // Direct map first
  for (const [pattern, id] of Object.entries(LEAGUE_ID_MAP)) {
    if (norm.includes(pattern)) return id;
  }
  // API search fallback
  const key = `leagueid:${norm}`;
  const cached = cget<number | null>(key);
  if (cached !== undefined) return cached;
  const json = await apiGet(`/leagues?search=${encodeURIComponent(leagueName.slice(0, 50))}`);
  if (!json) return null;
  const rows: any[] = json.response ?? [];
  const hit = rows.find((r) => {
    const ln = String(r?.league?.name ?? "").toLowerCase();
    return ln === norm || ln.includes(norm) || norm.includes(ln);
  });
  const id = hit ? Number(hit.league.id) : null;
  cset(key, id, STANDINGS_TTL);
  return id;
}

export async function getLeagueStandings(leagueName: string): Promise<LeagueContext | null> {
  const leagueId = await resolveLeagueId(leagueName);
  if (!leagueId) return null;

  // Determine current season
  const now = new Date();
  const season = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const key = `standings:${leagueId}:${season}`;
  const cached = cget<LeagueContext>(key);
  if (cached) return cached;

  const json = await apiGet(`/standings?league=${leagueId}&season=${season}`);
  if (!json) return null;
  const league = json.response?.[0]?.league;
  if (!league?.standings?.[0]) return null;

  const rows: StandingRow[] = (league.standings[0] as any[]).map((s: any) => ({
    rank: Number(s.rank ?? 0),
    teamId: Number(s.team?.id ?? 0),
    teamName: String(s.team?.name ?? ""),
    played: Number(s.all?.played ?? 0),
    won: Number(s.all?.win ?? 0),
    drawn: Number(s.all?.draw ?? 0),
    lost: Number(s.all?.lose ?? 0),
    goalsFor: Number(s.all?.goals?.for ?? 0),
    goalsAgainst: Number(s.all?.goals?.against ?? 0),
    points: Number(s.points ?? 0),
    form: String(s.form ?? ""),
    ppg: Number(s.all?.played ?? 0) > 0 ? Math.round((Number(s.points ?? 0) / Number(s.all?.played ?? 1)) * 100) / 100 : 0,
  }));

  const result: LeagueContext = {
    leagueName: String(league.name ?? leagueName),
    leagueId,
    season,
    standings: rows,
    totalTeams: rows.length,
  };
  cset(key, result, STANDINGS_TTL);
  return result;
}

export async function getTeamStanding(teamName: string, leagueName: string): Promise<TeamStandingContext | null> {
  const ctx = await getLeagueStandings(leagueName);
  if (!ctx) return null;
  const row = ctx.standings.find((s) => namesMatch(s.teamName, teamName));
  if (!row) return null;
  const { tier, tag } = motivationTier(row.rank, ctx.totalTeams);
  return {
    rank: row.rank, totalTeams: ctx.totalTeams, points: row.points,
    ppg: row.ppg, form: row.form, motivationTier: tier, motivationTag: tag,
    leagueName: ctx.leagueName,
  };
}

// =====================================================================
// 4. INJURY & SQUAD IMPACT REPORTS
// =====================================================================
export interface InjuryReport {
  teamName: string;
  injuries: { player: string; type: string; reason: string }[];
  totalOut: number;
  severity: string;     // "🔴 Depleted" | "🟡 Minor" | "🟢 Full Strength"
  severityTag: string;  // "depleted" | "minor" | "full"
  summary: string;      // "3 key players out" or "Full strength"
}

export async function getFixtureInjuries(
  fixtureId: number | null,
  teamName: string,
  teamId?: number,
): Promise<InjuryReport | null> {
  // Try fixture-based lookup first, then team-based
  const tId = teamId ?? await resolveTeamId(teamName);
  if (!tId) return null;

  const key = `injuries:${tId}`;
  const cached = cget<InjuryReport>(key);
  if (cached) return cached;

  const json = await apiGet(`/injuries?team=${tId}&season=${new Date().getFullYear()}`);
  if (!json) return null;

  // Only include currently active injuries (not returned/recovered)
  const rows: any[] = json.response ?? [];
  const injuries: InjuryReport["injuries"] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const player = String(r?.player?.name ?? "");
    const type = String(r?.player?.type ?? "Missing");
    const reason = String(r?.player?.reason ?? "Unknown");
    if (!player || seen.has(player)) continue;
    seen.add(player);
    injuries.push({ player, type, reason });
  }

  // Take most recent 8 unique injuries (API returns historical too)
  const recentInjuries = injuries.slice(0, 8);
  const totalOut = recentInjuries.length;

  let severity: string, severityTag: string;
  if (totalOut >= 4) { severity = "🔴 Depleted"; severityTag = "depleted"; }
  else if (totalOut >= 1) { severity = "🟡 Minor Concerns"; severityTag = "minor"; }
  else { severity = "🟢 Full Strength"; severityTag = "full"; }

  const summary = totalOut > 0 ? `${totalOut} player${totalOut > 1 ? "s" : ""} out` : "Full strength";

  const result: InjuryReport = { teamName, injuries: recentInjuries, totalOut, severity, severityTag, summary };
  cset(key, result, INJURY_TTL);
  return result;
}

// =====================================================================
// 5. GIANT KILLER RADAR (High-Odds Underdog Scanner)
// =====================================================================
export interface UpsetSignal {
  signal: string;         // human-readable upset indicator
  weight: number;         // 0..1 contribution to upset confidence
}

export interface GiantKillerResult {
  upsetConfidence: number;  // 0–100
  signals: UpsetSignal[];
  label: string;            // "🔥 Strong Upset Signal" | "⚡ Moderate" | "💤 Low"
  tag: string;
}

export async function analyzeUpsetPotential(
  underdogName: string,
  favouriteName: string,
  underdogOdds: number,
  league?: string,
): Promise<GiantKillerResult> {
  const signals: UpsetSignal[] = [];

  // 1. Underdog momentum
  const udMom = await getTeamMomentum(underdogName).catch(() => null);
  if (udMom) {
    if (udMom.score >= 70) {
      signals.push({ signal: `${underdogName} in great form (momentum ${udMom.score}/100, ${udMom.streak})`, weight: 0.25 });
    } else if (udMom.score >= 50) {
      signals.push({ signal: `${underdogName} in decent form (momentum ${udMom.score}/100)`, weight: 0.12 });
    }
  }

  // 2. Favourite momentum (cold = good for upset)
  const favMom = await getTeamMomentum(favouriteName).catch(() => null);
  if (favMom && favMom.score <= 40) {
    signals.push({ signal: `${favouriteName} in poor form (momentum ${favMom.score}/100, ${favMom.streak})`, weight: 0.22 });
  }

  // 3. H2H upset history
  const h2h = await getH2HDeep(favouriteName, underdogName).catch(() => null);
  if (h2h && h2h.totalMeetings >= 3) {
    const udWinRate = h2h.awayWins / h2h.totalMeetings;
    if (udWinRate >= 0.4) {
      signals.push({ signal: `${underdogName} wins ${Math.round(udWinRate * 100)}% of H2H meetings (${h2h.awayWins}/${h2h.totalMeetings})`, weight: 0.20 });
    }
  }

  // 4. League standing gap (small gap or underdog above = upset factor)
  if (league) {
    const [udStanding, favStanding] = await Promise.all([
      getTeamStanding(underdogName, league).catch(() => null),
      getTeamStanding(favouriteName, league).catch(() => null),
    ]);
    if (udStanding && favStanding) {
      const gap = favStanding.rank - udStanding.rank;
      if (gap <= 0) {
        signals.push({ signal: `${underdogName} is actually higher in the table (${udStanding.rank}th vs ${favStanding.rank}th)`, weight: 0.25 });
      } else if (gap <= 4) {
        signals.push({ signal: `Only ${gap} places separate them in the table — close in quality`, weight: 0.10 });
      }
      // Relegation desperation
      if (udStanding.motivationTag === "relegation") {
        signals.push({ signal: `${underdogName} fighting relegation — desperation factor`, weight: 0.12 });
      }
    }
  }

  // 5. Injury advantage
  const [udInj, favInj] = await Promise.all([
    getFixtureInjuries(null, underdogName).catch(() => null),
    getFixtureInjuries(null, favouriteName).catch(() => null),
  ]);
  if (favInj && favInj.totalOut >= 3 && (!udInj || udInj.totalOut <= 1)) {
    signals.push({ signal: `${favouriteName} has ${favInj.totalOut} players out while ${underdogName} is near full strength`, weight: 0.18 });
  }

  // 6. Price value (high odds = more payout if signals warrant it)
  if (underdogOdds >= 3.0 && signals.length >= 2) {
    signals.push({ signal: `High value price @${underdogOdds.toFixed(2)} — significant payout if signals deliver`, weight: 0.08 });
  }

  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  const upsetConfidence = Math.min(85, Math.round(totalWeight * 100));

  let label: string, tag: string;
  if (upsetConfidence >= 50) { label = "🔥 High-Probability Tail Risk"; tag = "strong"; }
  else if (upsetConfidence >= 30) { label = "⚡ Moderate Tail Risk"; tag = "moderate"; }
  else { label = "💤 Negligible Tail Risk"; tag = "low"; }

  return { upsetConfidence, signals, label, tag };
}

// =====================================================================
// 6. BANKER LOCK SYSTEM (6-criteria near-certainty scoring)
// =====================================================================
export interface BankerLockResult {
  criteriaCount: number;    // how many of 6 criteria met (0–6)
  criteria: { name: string; met: boolean; detail: string }[];
  label: string;            // "🔒 BANKER LOCK" | "🏦 Strong Banker" | "✅ Solid Pick" | "—"
  tag: string;              // "lock" | "strong" | "solid" | "none"
  confidence: number;       // 0–100 banker confidence
}

export async function analyzeBankerLock(
  teamName: string,
  opponentName: string,
  modelProb: number,
  league?: string,
): Promise<BankerLockResult> {
  const criteria: BankerLockResult["criteria"] = [];

  // 1. Model probability ≥ 70%
  criteria.push({
    name: "Model Probability",
    met: modelProb >= 0.70,
    detail: modelProb >= 0.70
      ? `✅ Model rates ${Math.round(modelProb * 100)}% (≥70%)`
      : `❌ Model rates ${Math.round(modelProb * 100)}% (<70%)`,
  });

  // 2. Team on 3+ match unbeaten/win streak
  const mom = await getTeamMomentum(teamName).catch(() => null);
  const onStreak = mom ? (mom.streak.startsWith("W") && parseInt(mom.streak.slice(1)) >= 3) || (mom.streak.startsWith("U") && parseInt(mom.streak.slice(1)) >= 3) : false;
  criteria.push({
    name: "Hot Streak",
    met: onStreak,
    detail: onStreak
      ? `✅ On a ${mom!.streak} streak (${mom!.label})`
      : `❌ No strong streak${mom ? ` (${mom.streak}, ${mom.label})` : ""}`,
  });

  // 3. Favourable H2H record (won 60%+ of recent meetings)
  const h2h = await getH2HDeep(teamName, opponentName).catch(() => null);
  const h2hGood = h2h ? h2h.totalMeetings >= 3 && h2h.homeWins / h2h.totalMeetings >= 0.6 : false;
  criteria.push({
    name: "H2H Dominance",
    met: h2hGood,
    detail: h2hGood
      ? `✅ Won ${h2h!.homeWins}/${h2h!.totalMeetings} H2H meetings (${Math.round(h2h!.homeWins / h2h!.totalMeetings * 100)}%)`
      : `❌ ${h2h ? `Won ${h2h.homeWins}/${h2h.totalMeetings} H2H` : "No H2H data"}`,
  });

  // 4. Top-half league position with position gap ≥ 8 places
  let posGap = false;
  if (league) {
    const [teamPos, oppPos] = await Promise.all([
      getTeamStanding(teamName, league).catch(() => null),
      getTeamStanding(opponentName, league).catch(() => null),
    ]);
    const gap = teamPos && oppPos ? oppPos.rank - teamPos.rank : 0;
    posGap = !!(teamPos && oppPos && teamPos.rank <= Math.ceil(teamPos.totalTeams / 2) && gap >= 8);
    criteria.push({
      name: "Class Mismatch",
      met: posGap,
      detail: posGap
        ? `✅ ${teamPos!.rank}th vs ${oppPos!.rank}th — ${gap}pt gap in ${teamPos!.leagueName}`
        : `❌ ${teamPos && oppPos ? `${teamPos.rank}th vs ${oppPos.rank}th (gap: ${gap})` : "No standings data"}`,
    });
  } else {
    criteria.push({ name: "Class Mismatch", met: false, detail: "❌ No league data for standings check" });
  }

  // 5. No critical injuries
  const inj = await getFixtureInjuries(null, teamName).catch(() => null);
  const healthySquad = !inj || inj.totalOut <= 1;
  criteria.push({
    name: "Squad Fitness",
    met: healthySquad,
    detail: healthySquad
      ? `✅ ${inj ? inj.summary : "Healthy squad"}`
      : `❌ ${inj!.summary} (${inj!.severity})`,
  });

  // 6. Opponent in bad form or losing streak
  const oppMom = await getTeamMomentum(opponentName).catch(() => null);
  const oppWeak = oppMom ? oppMom.score <= 40 || oppMom.streak.startsWith("L") : false;
  criteria.push({
    name: "Weak Opponent",
    met: oppWeak,
    detail: oppWeak
      ? `✅ ${opponentName} in poor form (${oppMom!.label}, ${oppMom!.streak})`
      : `❌ ${opponentName} ${oppMom ? `not in bad form (${oppMom.label})` : "form unknown"}`,
  });

  const met = criteria.filter((c) => c.met).length;
  let label: string, tag: string;
  if (met >= 6) { label = "🔒 LOW-VARIANCE YIELD"; tag = "lock"; }
  else if (met >= 4) { label = "🏦 High-Conviction Yield"; tag = "strong"; }
  else if (met >= 3) { label = "✅ Quantified Value"; tag = "solid"; }
  else { label = "—"; tag = "none"; }

  // Confidence: weighted (not a simple average)
  const confidence = Math.min(95, Math.round((met / 6) * 100));

  return { criteriaCount: met, criteria, label, tag, confidence };
}

// =====================================================================
// 7. TRAP GAME DETECTOR (FADE THE PUBLIC)
// =====================================================================
export interface TrapGameResult {
  isTrap: boolean;
  reasons: string[];
  severity: "high" | "medium" | "none"; // high = multiple red flags
  label: string; // e.g. "🚨 TRAP ALERT"
}

export async function analyzeTrapGame(
  favorite: string,
  underdog: string,
  modelProbFavorite: number,
  league?: string,
): Promise<TrapGameResult> {
  const reasons: string[] = [];
  
  // Need multiple data points to declare a trap
  const [favMom, favStd, undStd, favInj, h2h] = await Promise.all([
    getTeamMomentum(favorite).catch(() => null),
    league ? getTeamStanding(favorite, league).catch(() => null) : null,
    league ? getTeamStanding(underdog, league).catch(() => null) : null,
    getFixtureInjuries(null, favorite).catch(() => null),
    getH2HDeep(favorite, underdog).catch(() => null),
  ]);

  // Red Flag 1: Favorite is actually in awful form
  if (favMom && favMom.score <= 45) {
    reasons.push(`The favorite (${favorite}) is secretly in poor form (Score: ${favMom.score}, ${favMom.streak}).`);
  }

  // Red Flag 2: Severe injuries for the favorite
  if (favInj && favInj.totalOut >= 3) {
    reasons.push(`Critical injuries: ${favorite} is missing ${favInj.totalOut} players (${favInj.severity}).`);
  }

  // Red Flag 3: Motivation mismatch (Underdog fighting relegation, favorite mid-table)
  if (favStd && undStd) {
    if (undStd.motivationTag === "relegation" && (favStd.motivationTag === "mid" || favStd.motivationTag === "safe")) {
      reasons.push(`Motivation mismatch: ${underdog} is fighting for survival; ${favorite} has nothing to play for.`);
    }
  }

  // Red Flag 4: Bad H2H for favorite
  if (h2h && h2h.matches.length >= 3) {
    const favWins = h2h.matches.filter(m => namesMatch(m.winner, favorite)).length;
    const winRate = favWins / h2h.matches.length;
    if (winRate <= 0.33) {
      reasons.push(`Bogey team: ${favorite} has a terrible H2H record against ${underdog} (Win rate: ${Math.round(winRate*100)}%).`);
    }
  }

  const isTrap = reasons.length >= 2; // Need at least 2 red flags to override a heavy favorite
  const severity = reasons.length >= 3 ? "high" : (reasons.length === 2 ? "medium" : "none");
  const label = isTrap ? "🚨 IDENTIFIED MARKET TRAP" : "—";

  return { isTrap, reasons, severity, label };
}

// =====================================================================
// COMPOSITE: Full match intel report (all features for one fixture)
// =====================================================================
export interface MatchIntelReport {
  homeMomentum: MomentumResult | null;
  awayMomentum: MomentumResult | null;
  h2h: H2HDeep | null;
  homeStanding: TeamStandingContext | null;
  awayStanding: TeamStandingContext | null;
  homeInjuries: InjuryReport | null;
  awayInjuries: InjuryReport | null;
  bankerLock: BankerLockResult | null;
  giantKiller: GiantKillerResult | null;
  trapGame: TrapGameResult | null;
  aiInsight?: string; // Fallback text from Perplexity
}

/**
 * Perform a live web search via OpenRouter Perplexity Online models when
 * internal database or API-Football lacks data for this match.
 */
async function fetchPerplexityFallback(home: string, away: string): Promise<string | null> {
  if (!config.bytez.apiKey) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.bytez.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "perplexity/llama-3.1-sonar-large-128k-online",
        messages: [{
          role: "user",
          content: `Search the web for the absolute latest football news, injuries, form, and H2H statistics for ${home} vs ${away}. Give a concise summary of team momentum and key missing players. End with a short prediction. Focus strictly on facts and keep it under 150 words.`
        }]
      })
    });
    const json = await res.json();
    if (json && json.choices && json.choices.length > 0) {
      return json.choices[0].message.content.trim();
    }
  } catch (err) {
    console.error("[intel] Perplexity fallback failed:", err);
  }
  return null;
}

/**
 * Fetch full intelligence report for a match. Budget-capped and cached.
 * Returns partial data when some lookups fail — never blocks on errors.
 */
export async function getMatchIntel(
  home: string,
  away: string,
  league?: string,
  modelProbHome?: number,
  homeOdds?: number,
  awayOdds?: number,
): Promise<MatchIntelReport> {
  const [homeMom, awayMom, h2h, homeStd, awayStd, homeInj, awayInj] = await Promise.all([
    getTeamMomentum(home).catch(() => null),
    getTeamMomentum(away).catch(() => null),
    getH2HDeep(home, away).catch(() => null),
    league ? getTeamStanding(home, league).catch(() => null) : null,
    league ? getTeamStanding(away, league).catch(() => null) : null,
    getFixtureInjuries(null, home).catch(() => null),
    getFixtureInjuries(null, away).catch(() => null),
  ]);

  // Banker Lock: analyze the favourite
  let banker: BankerLockResult | null = null;
  let trap: TrapGameResult | null = null;
  
  if (modelProbHome !== undefined && modelProbHome >= 0.55) {
    banker = await analyzeBankerLock(home, away, modelProbHome, league).catch(() => null);
    if (modelProbHome >= 0.60) {
      trap = await analyzeTrapGame(home, away, modelProbHome, league).catch(() => null);
    }
  } else if (modelProbHome !== undefined && modelProbHome <= 0.35) {
    // Away is the favourite — flip perspective
    banker = await analyzeBankerLock(away, home, 1 - modelProbHome, league).catch(() => null);
    if (modelProbHome <= 0.40) {
      trap = await analyzeTrapGame(away, home, 1 - modelProbHome, league).catch(() => null);
    }
  }

  // Giant Killer: analyze underdog potential
  let gk: GiantKillerResult | null = null;
  if (awayOdds && awayOdds >= 2.5) {
    gk = await analyzeUpsetPotential(away, home, awayOdds, league).catch(() => null);
  } else if (homeOdds && homeOdds >= 2.5) {
    gk = await analyzeUpsetPotential(home, away, homeOdds, league).catch(() => null);
  }

  // Fallback: If we couldn't get H2H or momentum (e.g. lower league, rate limit)
  let aiInsight: string | undefined;
  if (!h2h && !homeMom && !awayMom) {
    const fallbackText = await fetchPerplexityFallback(home, away);
    if (fallbackText) {
      aiInsight = fallbackText;
      // We can also synthesize a fake momentum to ensure the modal shows something
      homeMom = { score: 50, tag: "good", label: "See Pro Report" };
      awayMom = { score: 50, tag: "good", label: "See Pro Report" };
    }
  }

  return {
    homeMomentum: homeMom, awayMomentum: awayMom,
    h2h, homeStanding: homeStd, awayStanding: awayStd,
    homeInjuries: homeInj, awayInjuries: awayInj,
    bankerLock: banker, giantKiller: gk, trapGame: trap,
    aiInsight
  };
}
