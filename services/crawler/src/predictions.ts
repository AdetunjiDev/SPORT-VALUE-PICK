import { fetchText, stripHtml } from "./adapters/http.js";

/**
 * Manual-prediction feed: scrapes match tips (teams, league, kick-off, tip,
 * odds, probability) from footballpredictions.com. These are third-party
 * statistical PREDICTIONS — not SportyBet booking codes — shown in their own
 * tab with clear attribution. Cached in memory (predictions change slowly).
 */

export interface ExtPrediction {
  home: string;
  away: string;
  league?: string;
  kickoff?: string; // ISO
  tip?: string;
  odds?: string;
  probability?: string;
  url?: string;
}

const SRC = "https://footballpredictions.com/";
const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: ExtPrediction[] } | null = null;

function parse(html: string): ExtPrediction[] {
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

export async function getPredictions(): Promise<ExtPrediction[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const html = await fetchText(SRC, "text/html");
    const data = parse(html);
    if (data.length) cache = { at: Date.now(), data };
    return data.length ? data : (cache?.data ?? []);
  } catch {
    return cache?.data ?? [];
  }
}
