import { getPredictions, type ExtPrediction } from "./predictions.js";
import { getSportyFixtures, fuzzyTeamsMatch, type SbEvent } from "./forebet-ai.js";

/**
 * "Expert Picks" engine.
 *
 * Scans SportyBet's OWN live fixture + odds feed directly — every league it
 * carries (100+), not just the handful our external prediction sources happen
 * to cover — so every pick returned is guaranteed bookable right now. This
 * matters in practice: external tips (Forebet etc.) often predict a DIFFERENT
 * fixture in the "same" league (e.g. a different regional zone of a lower
 * division) than what SportyBet is actually offering that day, so matching
 * backward from tips to SportyBet routinely comes up empty for anything but
 * the biggest tournaments. Starting from SportyBet's list avoids that entirely.
 *
 * Confidence blends:
 *   1. Market implied probability — SportyBet's own odds for the outcome
 *      (1 / odds). This is the primary, always-available signal.
 *   2. External agreement — if a Forebet / API-Football tip exists for the
 *      SAME fixture and picks the SAME outcome, confidence gets a boost and
 *      the model's win % is cited alongside the market price.
 *
 * A per-league cap keeps one big tournament (World Cup) from dominating every
 * slot — "search every other football game aside World Cup" — while still
 * ranking by confidence within that constraint.
 *
 * These are estimates ranked by confidence — NEVER guarantees. No pick is
 * "sure"; anyone claiming 99–100% guaranteed wins is misleading you.
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

// Only 1X2 outcomes are used as the PRIMARY pick — "predict the result" reads
// naturally as "X to Win" / "Draw", matching how a sports analyst talks. O/U
// odds are still fetched (SportyBet feed carries them) but not used as the
// headline pick here.
const RESULT_CODES = ["1", "X", "2"] as const;

export interface ExpertOptions {
  count: number; // how many picks the user wants
  days: number; // window: fixtures within the next N days (clamped 3..7)
  minConfidence?: number; // optional hard floor; default is NO floor
  maxPerLeague?: number; // diversity cap; default scales with count
  seed?: number; // rotation for variety across refreshes
}

export interface ExpertResult {
  picks: ExpertPick[];
  requested: number;
  windowDays: number;
  // Fixtures that qualified (in-window, has an odds-based pick) before the
  // per-league diversity cap and the final count slice — lets the UI explain
  // honestly why fewer than requested came back.
  poolSize: number;
}

/** Best (shortest-price) 1X2 outcome for a fixture, with its implied prob. */
function marketFavourite(ev: SbEvent): { code: string; odds: number; implied: number } | null {
  let best: { code: string; odds: number; implied: number } | null = null;
  for (const code of RESULT_CODES) {
    const odds = ev.outcomes[code];
    if (!odds || odds <= 1) continue;
    const implied = 1 / odds;
    if (!best || implied > best.implied) best = { code, odds, implied };
  }
  return best;
}

/** A same-fixture external tip (Forebet / API-Football), if one exists. */
function findExternalTip(ev: SbEvent, preds: ExtPrediction[]): ExtPrediction | undefined {
  return preds.find(
    (p) => p.home && p.away && fuzzyTeamsMatch(p.home, ev.home) && fuzzyTeamsMatch(p.away, ev.away),
  );
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** The N highest-confidence, GUARANTEED-BOOKABLE picks within the window. */
export async function getExpertPicks(opts: ExpertOptions): Promise<ExpertResult> {
  const count = Math.max(1, Math.min(50, Math.floor(opts.count) || 5));
  const days = Math.max(3, Math.min(7, Math.floor(opts.days) || 5));
  const minConf = opts.minConfidence ?? 0;
  // Diversity cap: scales with how many picks were asked for, floor of 3, so a
  // big request still spreads across leagues instead of one tournament
  // filling every slot. (count=5 → cap 3; count=20 → cap 5; count=50 → cap 9)
  const maxPerLeague = opts.maxPerLeague ?? Math.max(3, Math.ceil(count / 4) + 2);

  const now = Date.now();
  const maxT = now + days * 86_400_000;

  const [fixtures, preds] = await Promise.all([
    getSportyFixtures().catch(() => [] as SbEvent[]),
    getPredictions().catch(() => [] as ExtPrediction[]),
  ]);

  const scored: ExpertPick[] = [];
  for (const ev of fixtures) {
    if (!ev.kickoff || ev.kickoff <= now || ev.kickoff > maxT) continue; // in window only
    const fav = marketFavourite(ev);
    if (!fav) continue; // no usable 1X2 price for this fixture right now

    const reasons: string[] = [`market odds ${fav.odds.toFixed(2)} (${Math.round(fav.implied * 100)}% implied)`];
    let confidence = fav.implied;

    const tip = findExternalTip(ev, preds);
    if (tip?.predCode && RESULT_CODES.includes(tip.predCode as (typeof RESULT_CODES)[number])) {
      const idx = tip.predCode === "1" ? 0 : tip.predCode === "X" ? 1 : 2;
      const modelPct = tip.probs?.[idx];
      if (tip.predCode === fav.code) {
        // External model agrees with SportyBet's own favourite — real signal
        // agreement, not just one source's opinion.
        if (modelPct) {
          confidence = confidence * 0.6 + (modelPct / 100) * 0.4;
          reasons.push(`${modelPct}% model win probability (${tip.source})`);
        }
        confidence = Math.min(0.95, confidence + 0.05);
        reasons.push(`confirmed by ${tip.source}`);
      }
    }

    const label = (PICK_LABEL[fav.code] ?? (() => fav.code))(ev.home, ev.away);
    scored.push({
      home: ev.home,
      away: ev.away,
      league: ev.league,
      kickoff: new Date(ev.kickoff).toISOString(),
      pick: label,
      key: `${ev.home}|${ev.away}`.toLowerCase(),
      confidence: round(Math.min(0.95, confidence)),
      odds: fav.odds.toFixed(2),
      reasons,
      source: tip ? `SportyBet + ${tip.source}` : "SportyBet odds",
    });
  }

  const eligible = scored.filter((p) => p.confidence >= minConf);
  eligible.sort((a, b) => b.confidence - a.confidence);

  // Greedy selection with a per-league cap so one tournament (World Cup, the
  // biggest thing on the board right now) can't fill every slot — spreads
  // across whatever other leagues SportyBet is carrying today.
  const leagueCount = new Map<string, number>();
  const diversified: ExpertPick[] = [];
  for (const p of eligible) {
    const lg = p.league ?? "—";
    const n = leagueCount.get(lg) ?? 0;
    if (n >= maxPerLeague) continue;
    leagueCount.set(lg, n + 1);
    diversified.push(p);
  }
  // If the cap left slots unfilled (few leagues in total), backfill from the
  // remainder ignoring the cap rather than under-deliver on the count.
  if (diversified.length < Math.min(count, eligible.length)) {
    const used = new Set(diversified.map((p) => p.key));
    for (const p of eligible) {
      if (diversified.length >= Math.min(count + 6, eligible.length)) break;
      if (!used.has(p.key)) {
        used.add(p.key);
        diversified.push(p);
      }
    }
    diversified.sort((a, b) => b.confidence - a.confidence);
  }

  // Rotate within a slightly wider top band for variety across refreshes.
  const band = diversified.slice(0, Math.min(diversified.length, count + 6));
  const off = band.length ? (((opts.seed ?? 0) % band.length) + band.length) % band.length : 0;
  const chosen = band.slice(off).concat(band.slice(0, off)).slice(0, count);

  // Present soonest kick-off first.
  chosen.sort((a, b) => new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime());
  return { picks: chosen, requested: count, windowDays: days, poolSize: eligible.length };
}
