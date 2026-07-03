import { fetchText, stripHtml } from "./adapters/http.js";

/**
 * Manual-prediction feed, merged from two kinds of source:
 *   1. footballpredictions.com — structured tips (tip / odds / probability) for
 *      featured matches, plus every upcoming match from its league pages.
 *   2. Telegram analysis channels (@betmines, @eaglepredict) — daily prediction
 *      posts with written analysis (free-form). Shown as analysis cards with a
 *      "View on Telegram" link and a source badge.
 * Merged, upcoming-first, cached in memory.
 */

export interface ExtPrediction {
  source: string; // "footballpredictions.com" | "forebet.com" | "@betmines" …
  home?: string;
  away?: string;
  title?: string; // headline for free-form posts
  league?: string;
  kickoff?: string; // ISO
  tip?: string;
  odds?: string;
  probability?: string;
  analysis?: string; // free-form written analysis
  url?: string;
  // Structured pick — used to book real SportyBet slips. 1/X/2 = match result;
  // O/U codes = Over/Under goals lines (e.g. O25 = Over 2.5).
  predCode?: "1" | "X" | "2" | "O15" | "O25" | "O35" | "U15" | "U25" | "U35";
  probs?: [number, number, number]; // home / draw / away %
}

/**
 * Derive a bookable pick from free-text tips ("Chelsea to Win", "Draw",
 * "Over 2.5 Goals") so every prediction card can join the slip builder —
 * not just Forebet's structured 1X2 rows.
 */
export function derivePredCode(p: ExtPrediction): ExtPrediction["predCode"] {
  if (p.predCode) return p.predCode;
  const tip = (p.tip ?? "").toLowerCase();
  if (!tip) return undefined;
  const ou = tip.match(/\b(over|under)\s*([123])[.,]5\b/);
  if (ou) return `${ou[1] === "over" ? "O" : "U"}${ou[2]}5` as ExtPrediction["predCode"];
  if (/\bdraw\b/.test(tip)) return "X";
  if (p.home && tip.includes(p.home.toLowerCase())) return "1";
  if (p.away && tip.includes(p.away.toLowerCase())) return "2";
  if (/\bhome\s*(team\s*)?(to\s*)?win\b/.test(tip)) return "1";
  if (/\baway\s*(team\s*)?(to\s*)?win\b/.test(tip)) return "2";
  return undefined;
}

const BASE = "https://footballpredictions.com";
const FOREBET = "https://www.forebet.com";
// Just under the 3-min scan interval so each scheduler cycle pulls fresh data.
const TTL_MS = 150 * 1000;

const LEAGUE_PAGES: { name: string; slug: string }[] = [
  { name: "World Cup", slug: "world-cup-predictions" },
  { name: "Premier League", slug: "premierleaguepredictions" },
  { name: "Championship", slug: "championshippredictions" },
  { name: "La Liga", slug: "primeradivisionpredictions" },
  { name: "Serie A", slug: "serieapredictions" },
  { name: "Bundesliga", slug: "bundesligapredictions" },
  { name: "Ligue 1", slug: "ligue-1-predictions" },
];

// Telegram channels that post daily prediction ANALYSIS (not booking codes).
const TG_PRED_CHANNELS = ["betminesfootballpredictions", "eaglepredict"];

let cache: { at: number; data: ExtPrediction[] } | null = null;

const keyOf = (p: ExtPrediction) =>
  p.home && p.away ? `${p.home}|${p.away}`.toLowerCase() : `${p.source}|${p.title}`.toLowerCase();

async function safeFetch(url: string): Promise<string> {
  try {
    return await fetchText(url, "text/html");
  } catch {
    return "";
  }
}

function parseHomepageTips(html: string): ExtPrediction[] {
  const start = html.indexOf("betting-tips-alt");
  const region = start >= 0 ? html.slice(start) : html;
  const cardRe = /<a href="([^"]+)"\s+class="pred-card">([\s\S]*?)<\/a>/g;
  const out: ExtPrediction[] = [];
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(region)) !== null && out.length < 40) {
    const url = m[1];
    const c = m[2];
    const names = [...c.matchAll(/pred-card-team-name">([^<]+)</g)].map((x) => x[1].trim());
    if (names.length < 2) continue;
    const league = (c.match(/pred-card-league">\s*<span>([\s\S]*?)<\/span>/) || [])[1]
      ?.replace(/&#x2022;[\s\S]*/, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    const kickoff = (c.match(/data-datetime="([^"]+)"/) || [])[1];
    const tipsTable = (c.match(/pred-card-tips">([\s\S]*?)<\/table>/) || [])[1] || "";
    const cells = [...tipsTable.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => stripHtml(x[1]));
    out.push({
      source: "footballpredictions.com",
      home: names[0],
      away: names[1],
      league: league || undefined,
      kickoff: kickoff || undefined,
      tip: cells[0] || undefined,
      odds: cells[1] || undefined,
      probability: cells[2] || undefined,
      url,
    });
  }
  return out;
}

function parseLeaguePage(html: string, league: string): ExtPrediction[] {
  const now = Date.now();
  const blocks = html.split('<div class="prediction"').slice(1);
  const out: ExtPrediction[] = [];
  for (const b of blocks) {
    const clubs = [...b.matchAll(/class="clublink"[^>]*>([^<]+)</g)].map((x) => x[1].trim());
    const dt = (b.match(/data-datetime="([^"]+)"/) || [])[1];
    if (clubs.length < 2 || !dt) continue;
    if (new Date(dt).getTime() < now) continue;
    const href = (b.match(/href="(https:\/\/footballpredictions\.com\/[^"]*-vs-[^"]*)"/) || [])[1];
    const txtM = b.match(/predictiontxt[^>]*>([\s\S]*?)<\/p>/);
    const analysis = txtM ? stripHtml(txtM[1].replace(/<!--[\s\S]*?-->/g, "")).slice(0, 160) : undefined;
    out.push({
      source: "footballpredictions.com",
      home: clubs[0],
      away: clubs[1],
      league,
      kickoff: dt,
      analysis,
      url: href,
    });
  }
  return out;
}

const PROMO_RE =
  /(VIP MEMBER|GRAB|JOIN (?:NOW|OUR)|SUBSCRIBE|LINK IN BIO|DM (?:ME|US)|CONGRATULAT|WON ?✅|bit\.ly|t\.me\/\+|PASSWORD|SIGN ?UP|REGISTER|GIVEAWAY|BATTLE|WIN A |USD ?\d|PRIZE|WINNING STREAK|NEARLY PERFECT|PERFECT DAY|ENJOYING OUR|ARE YOU ENJOYING)/i;
// Must look like an actual prediction to be included.
const PRED_RE =
  /(prediction|\btip\b|expected to|over \d|under \d|both teams|\bbtts\b|correct score|to win|double chance|\bvs\b|\bv\.?\b|match:)/i;

function tgText(chunk: string): string {
  const m = chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return "";
  return m[1]
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .normalize("NFKC") // flatten fancy unicode (𝐄𝐧𝐠𝐥𝐚𝐧𝐝 → England)
    .trim();
}

async function telegramPredictions(): Promise<ExtPrediction[]> {
  const out: ExtPrediction[] = [];
  const htmls = await Promise.all(
    TG_PRED_CHANNELS.map((ch) => safeFetch(`https://t.me/s/${ch}`)),
  );
  htmls.forEach((html, idx) => {
    if (!html) return;
    const ch = TG_PRED_CHANNELS[idx];
    const chunks = html.split('class="tgme_widget_message ').slice(1);
    for (const c of chunks) {
      const text = tgText(c);
      if (text.length < 40 || PROMO_RE.test(text) || !PRED_RE.test(text)) continue;
      const dt = (c.match(/datetime="([^"]+)"/) || [])[1];
      if (dt && Date.now() - new Date(dt).getTime() > 36 * 3.6e6) continue; // last 36h
      const post = (c.match(/data-post="([^"]+)"/) || [])[1];
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      // Structured posts (e.g. @eaglepredict) label their fields — parse them.
      const matchLine = text.match(/Match:\s*([^\n]+)/i)?.[1]?.trim();
      const predLine = text.match(/Prediction:\s*([^\n]+)/i)?.[1]?.trim();
      const leagueLine = text.match(/League:\s*([^\n]+)/i)?.[1]?.trim();
      // Detect a "TeamA vs TeamB" from the Match: line or the body.
      const vs = (matchLine ?? text).match(
        /([A-Z][A-Za-z .'&-]{2,24})\s+(?:vs?|v|-|—)\s+([A-Z][A-Za-z .'&-]{2,24})/,
      );

      out.push({
        source: `@${ch}`,
        home: vs?.[1]?.trim(),
        away: vs?.[2]?.trim(),
        title: matchLine ?? lines[0]?.slice(0, 90),
        league: leagueLine,
        tip: predLine, // shown as the tip when present (these channels give no odds)
        analysis: text.slice(0, 400),
        kickoff: dt || undefined,
        url: post ? `https://t.me/${post}` : undefined,
      });
    }
  });
  return out;
}

// Map Forebet's 1/X/2 code to a readable tip label.
function forebetTip(code: string, home: string, away: string): string {
  if (code === "1") return `${home} to Win`;
  if (code === "X") return "Draw";
  if (code === "2") return `${away} to Win`;
  return code;
}

async function forebetPredictions(): Promise<ExtPrediction[]> {
  const html = await safeFetch(
    `${FOREBET}/en/football-tips-and-predictions-for-today/predictions-1x2`,
  );
  if (!html) return [];
  const out: ExtPrediction[] = [];
  // Each match row is wrapped in class='rcnt …'
  const blocks = html.match(/class='rcnt [^']*'>([\s\S]*?)(?=class='rcnt |class='datepred|<\/div>\s*<\/div>\s*<\/div>\s*<\/section)/g) ?? [];
  for (const b of blocks) {
    const home = (b.match(/itemprop="homeTeam"[^>]*>[\s\S]*?itemprop="name">([^<]+)</) ?? [])[1]?.trim();
    const away = (b.match(/itemprop="awayTeam"[^>]*>[\s\S]*?itemprop="name">([^<]+)</) ?? [])[1]?.trim();
    if (!home || !away) continue;
    const url = (b.match(/href="(\/en\/football\/matches\/[^"]+)"/) ?? [])[1];
    const kickoff = (b.match(/datetime="([^"]+)"/) ?? [])[1];
    const dateBah = (b.match(/class="date_bah">([\d/: ]+)</) ?? [])[1]?.trim();
    // League name is the 4th argument in the getstag() onclick call
    const leagueM = b.match(/getstag\(this,\d+,'[^']*','([^']+)'/);
    const league = leagueM ? leagueM[1].replace(/-/g, " ") : undefined;
    // Forebet's suggested prediction: 1, X or 2
    const rawPred = (b.match(/class="forepr"><span>([^<]+)<\/span>/) ?? [])[1]?.trim();
    const predCode = rawPred === "1" || rawPred === "X" || rawPred === "2" ? rawPred : undefined;
    const tip = rawPred ? forebetTip(rawPred, home, away) : undefined;
    // Predicted score e.g. "1 - 3"
    const scoreM = b.match(/class="scrmobpred[^"]*">([^<]+)<span/);
    const score = scoreM ? scoreM[1].replace(/-/g, "–").trim() : undefined;
    // Average odds
    const oddsM = b.match(/class="avg_sc[^"]*"[^>]*>([0-9.]+)<\//);
    const odds = oddsM ? oddsM[1] : undefined;
    // 1/X/2 probabilities from fprc
    const probM = b.match(/class='fprc'><span>(\d+)<\/span><span>(\d+)<\/span><span[^>]*>(\d+)<\/span>/);
    const prob = probM ? `${probM[1]}% / ${probM[2]}% / ${probM[3]}%` : undefined;
    const probs = probM
      ? ([Number(probM[1]), Number(probM[2]), Number(probM[3])] as [number, number, number])
      : undefined;
    const analysis = [
      score ? `Predicted score: ${score}` : null,
      prob ? `1X2 probability: ${prob}` : null,
    ].filter(Boolean).join(" · ") || undefined;
    out.push({
      source: "forebet.com",
      home,
      away,
      league,
      kickoff: kickoff || dateBah,
      tip,
      odds,
      analysis,
      url: url ? `${FOREBET}${url}` : undefined,
      predCode,
      probs,
    });
  }
  return out;
}

// Separate cache so the AI engine can pull Forebet tips without re-fetching.
let fbCache: { at: number; data: ExtPrediction[] } | null = null;

/** Cached Forebet tips — used by both getPredictions() and the AI engine. */
export async function getForebetTips(): Promise<ExtPrediction[]> {
  if (fbCache && Date.now() - fbCache.at < TTL_MS) return fbCache.data;
  const data = await forebetPredictions();
  if (data.length) fbCache = { at: Date.now(), data };
  return data.length ? data : (fbCache?.data ?? []);
}

export async function getPredictions(): Promise<ExtPrediction[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const [homeHtml, tg, forebet, ...leagueHtmls] = await Promise.all([
      safeFetch(`${BASE}/`),
      telegramPredictions(),
      getForebetTips(),
      ...LEAGUE_PAGES.map((l) => safeFetch(`${BASE}/footballpredictions/${l.slug}/`)),
    ]);

    const byKey = new Map<string, ExtPrediction>();
    leagueHtmls.forEach((html, i) => {
      if (html) for (const p of parseLeaguePage(html, LEAGUE_PAGES[i].name)) byKey.set(keyOf(p), p);
    });
    for (const p of parseHomepageTips(homeHtml)) {
      const ex = byKey.get(keyOf(p));
      byKey.set(keyOf(p), ex ? { ...ex, ...p } : p);
    }
    // Merge Forebet: enrich existing entries (add tip/score) or add new ones.
    // predCode/probs always carry over so merged cards stay bookable.
    for (const p of forebet) {
      const ex = byKey.get(keyOf(p));
      byKey.set(
        keyOf(p),
        ex
          ? {
              ...ex,
              tip: ex.tip ?? p.tip,
              odds: ex.odds ?? p.odds,
              analysis: ex.analysis ?? p.analysis,
              predCode: ex.predCode ?? p.predCode,
              probs: ex.probs ?? p.probs,
            }
          : p,
      );
    }
    for (const p of tg) if (!byKey.has(keyOf(p))) byKey.set(keyOf(p), p);

    const list = [...byKey.values()];
    // Fill in bookable picks derived from tip text where possible.
    for (const p of list) p.predCode = derivePredCode(p);
    // Structured tips (with odds) first, then everything by soonest/most-recent.
    const t = (p: ExtPrediction) => (p.kickoff ? new Date(p.kickoff).getTime() : 0);
    const data = list
      .sort((a, b) => {
        const ao = a.odds ? 1 : 0;
        const bo = b.odds ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return t(a) - t(b);
      })
      .slice(0, 120);

    if (data.length) cache = { at: Date.now(), data };
    return data.length ? data : (cache?.data ?? []);
  } catch {
    return cache?.data ?? [];
  }
}
