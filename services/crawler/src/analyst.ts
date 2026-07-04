import { getPredictions, type ExtPrediction } from "./predictions.js";
import { bookableTipKeys } from "./forebet-ai.js";

/**
 * "Expert Picks" engine.
 *
 * Acts like a seasoned analyst: it scans every fixture we have a prediction for
 * across the next few days and ranks them by a transparent CONFIDENCE score,
 * blending three real signals:
 *   1. Model probability — Forebet / API-Football win % for the tipped outcome.
 *   2. Market odds       — the bookmaker's own implied probability (1 / odds).
 *   3. Source agreement  — a small boost when a pick is short-priced AND the
 *                          model likes it (the two signals concur).
 *
 * It returns the N highest-confidence picks the user asks for, spread across a
 * 3–7 day window. These are ESTIMATES ranked by confidence — never guarantees.
 * No pick is "sure"; the score just says which look strongest right now.
 */

export interface ExpertPick {
  home: string;
  away: string;
  league?: string;
  kickoff?: string; // ISO
  pick: string; // human label, e.g. "Manchester City to Win"
  key: string; // "home|away" (lowercase) — bookable via /api/predictions/book
  confidence: number; // 0..1
  odds?: string;
  reasons: string[];
  source: string;
  url?: string;
}

const PICK_LABEL: Record<string, (h: string, a: string) => string> = {
  "1": (h) => `${h} to Win`,
  X: () => "Draw",
  "2": (_h, a) => `${a} to Win`,
  O15: () => "Over 1.5 Goals",
  O25: () => "Over 2.5 Goals",
  O35: () => "Over 3.5 Goals",
  U15: () => "Under 1.5 Goals",
  U25: () => "Under 2.5 Goals",
  U35: () => "Under 3.5 Goals",
};

function impliedFromOdds(odds?: string): number | undefined {
  const v = Number(odds);
  if (!Number.isFinite(v) || v <= 1) return undefined;
  return 1 / v;
}

/** Confidence 0..1 for a prediction's tipped outcome, with the reasons why. */
function scoreOf(p: ExtPrediction): { conf: number; reasons: string[] } | null {
  const code = p.predCode;
  if (!code || !p.home || !p.away) return null;
  const reasons: string[] = [];
  let model: number | undefined;

  // 1) Model probability for 1X2 picks (home/draw/away %).
  if (p.probs && (code === "1" || code === "X" || code === "2")) {
    const idx = code === "1" ? 0 : code === "X" ? 1 : 2;
    const pct = p.probs[idx];
    if (pct > 0) {
      model = pct / 100;
      reasons.push(`${pct}% model win probability`);
    }
  }

  // 2) Market implied probability from odds.
  const implied = impliedFromOdds(p.odds);
  if (implied) reasons.push(`market odds ${p.odds} (${Math.round(implied * 100)}% implied)`);

  // Blend: average model + market when both present; else whichever we have.
  let conf: number | undefined;
  if (model !== undefined && implied !== undefined) {
    conf = model * 0.6 + implied * 0.4;
    // 3) Agreement boost when both signals are already strong.
    if (model >= 0.6 && implied >= 0.6) {
      conf = Math.min(0.95, conf + 0.05);
      reasons.push("model & market agree (short price + high win %)");
    }
  } else {
    conf = model ?? implied;
  }
  if (conf === undefined) return null;

  reasons.push(`via ${p.source}`);
  return { conf: Math.min(0.95, conf), reasons };
}

export interface ExpertOptions {
  count: number; // how many picks the user wants
  days: number; // window: fixtures within the next N days (clamped 3..7)
  minConfidence?: number; // default 0.55
  seed?: number; // rotation for variety across refreshes
}

/** The N highest-confidence picks within the date window. */
export async function getExpertPicks(opts: ExpertOptions): Promise<ExpertPick[]> {
  const count = Math.max(1, Math.min(50, Math.floor(opts.count) || 5));
  const days = Math.max(3, Math.min(7, Math.floor(opts.days) || 5));
  const minConf = opts.minConfidence ?? 0.55;

  const preds = await getPredictions();
  const now = Date.now();
  const maxT = now + days * 86_400_000;

  // Candidate pool first (window + shape), THEN check which are actually
  // bookable on SportyBet — an expert pick you can't turn into a code isn't
  // useful, so unbookable matches are filtered out rather than just flagged.
  type BookableCandidate = ExtPrediction & { home: string; away: string; predCode: NonNullable<ExtPrediction["predCode"]> };
  const candidates = preds.filter((p): p is BookableCandidate => {
    if (!p.kickoff || !p.home || !p.away || !p.predCode) return false;
    const dateOnly = p.kickoff.length <= 10;
    const start = dateOnly ? new Date(`${p.kickoff}T00:00:00+01:00`).getTime() : new Date(p.kickoff).getTime();
    const end = dateOnly ? new Date(`${p.kickoff}T23:59:59+01:00`).getTime() : start;
    return Number.isFinite(end) && end > now && start <= maxT;
  });
  let bookable: Set<string>;
  try {
    bookable = await bookableTipKeys(candidates);
  } catch {
    bookable = new Set(); // SportyBet hiccup — fail open to no picks, not a crash
  }

  const scored: ExpertPick[] = [];
  const seen = new Set<string>();
  for (const p of candidates) {
    const key = `${p.home}|${p.away}`.toLowerCase();
    if (!bookable.has(key)) continue; // must be bookable on SportyBet right now
    if (seen.has(key)) continue;
    const s = scoreOf(p);
    if (!s || s.conf < minConf) continue;
    seen.add(key);
    const label = (PICK_LABEL[p.predCode] ?? (() => p.tip ?? p.predCode!))(p.home, p.away);
    scored.push({
      home: p.home,
      away: p.away,
      league: p.league,
      kickoff: p.kickoff,
      pick: label,
      key,
      confidence: s.conf,
      odds: p.odds,
      reasons: s.reasons,
      source: p.source,
      url: p.url,
    });
  }

  // Rank by confidence, then take a slightly wider top band and rotate within
  // it (variety across refreshes) — still high-confidence, never the long tail.
  scored.sort((a, b) => b.confidence - a.confidence);
  const band = scored.slice(0, Math.min(scored.length, count + 6));
  const off = band.length ? (((opts.seed ?? 0) % band.length) + band.length) % band.length : 0;
  const chosen = band
    .slice(off)
    .concat(band.slice(0, off))
    .slice(0, count);

  // Present soonest kick-off first.
  chosen.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
  return chosen;
}
