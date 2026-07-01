import { prisma } from "@sportybet/db";
import { config } from "./config.js";

/**
 * Code verification & enrichment via SportyBet's OWN public API — the same
 * endpoint the website calls when you paste a booking code. This is
 * authoritative live data (validity, expiry, games, odds, leagues), not a
 * scrape or a bypass. Kept polite: each code is verified once, then only
 * re-checked periodically, with a delay between calls.
 */

const SHARE_API = "https://www.sportybet.com/api/ng/orders/share";

export interface CodeEnrichment {
  status: "ACTIVE" | "INVALID" | "EXPIRED";
  numberOfGames?: number;
  totalOdds?: number;
  league?: string;
  country?: string;
  matchDate?: Date;
  expiresAt?: Date;
  betType?: string;
  selections?: SelectionLeg[];
  transientError?: boolean; // true if we couldn't decide (don't overwrite state)
}

/**
 * Compute total odds as the product of selected outcomes' odds — but ONLY when
 * every selection resolves against the markets in the response. If any is
 * missing (SportyBet returns a partial market set for some tickets), return
 * undefined rather than a misleading partial product.
 */
function computeOddsFromTicket(data: any): number | undefined {
  const selections: any[] = data?.ticket?.selections ?? [];
  const events: any[] = data?.outcomes ?? [];
  if (!selections.length || !events.length) return undefined;

  const marketsByEvent = new Map<string, any[]>(
    events.map((e) => [String(e.eventId), e.markets ?? []]),
  );

  let product = 1;
  for (const s of selections) {
    const markets = marketsByEvent.get(String(s.eventId)) ?? [];
    const market =
      markets.find(
        (m) => String(m.id) === String(s.marketId) && (m.specifier ?? "") === (s.specifier ?? ""),
      ) ?? markets.find((m) => String(m.id) === String(s.marketId));
    const outcome = market?.outcomes?.find((o: any) => String(o.id) === String(s.outcomeId));
    const odds = outcome?.odds ? Number(outcome.odds) : NaN;
    if (!Number.isFinite(odds) || odds <= 0) return undefined; // incomplete → bail
    product *= odds;
  }
  // Sanity cap: a straight accumulator product this large means it's really a
  // system bet (or SportyBet caps the payout), so the product isn't the true
  // total odds. Leave it blank rather than show a nonsense number.
  if (product <= 1 || product > 100000) return undefined;
  return Math.round(product * 100) / 100;
}

export interface SelectionLeg {
  eventId: string;
  home?: string;
  away?: string;
  league?: string;
  kickoff?: number;
  market?: string;
  pick?: string;
  odds?: number;
  // Raw identifiers needed to re-book this selection into a new code:
  marketId?: string;
  specifier?: string;
  outcomeId?: string;
}

/** Pull the human-readable legs (teams, market, pick, odds) from a share ticket. */
function extractSelections(data: any): SelectionLeg[] {
  const sels: any[] = data?.ticket?.selections ?? [];
  const events: any[] = data?.outcomes ?? [];
  const byEvent = new Map<string, any>(events.map((e) => [String(e.eventId), e]));
  const legs: SelectionLeg[] = [];
  for (const s of sels) {
    const ev = byEvent.get(String(s.eventId));
    if (!ev) continue;
    const markets = ev.markets ?? [];
    const mkt =
      markets.find(
        (m: any) =>
          String(m.id) === String(s.marketId) && (m.specifier ?? "") === (s.specifier ?? ""),
      ) ?? markets.find((m: any) => String(m.id) === String(s.marketId));
    const out = mkt?.outcomes?.find((o: any) => String(o.id) === String(s.outcomeId));
    legs.push({
      eventId: String(s.eventId),
      home: ev.homeTeamName,
      away: ev.awayTeamName,
      league: ev?.sport?.category?.tournament?.name,
      kickoff: ev.estimateStartTime ? Number(ev.estimateStartTime) : undefined,
      market: mkt?.desc,
      pick: out?.desc,
      odds: out?.odds ? Number(out.odds) : undefined,
      marketId: String(s.marketId),
      specifier: s.specifier ?? "",
      outcomeId: String(s.outcomeId),
    });
  }
  return legs;
}

function mostFrequent(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let max = 0;
  for (const [k, n] of counts) {
    if (n > max) {
      max = n;
      best = k;
    }
  }
  return best;
}

export async function verifyCode(code: string): Promise<CodeEnrichment> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(`${SHARE_API}/${encodeURIComponent(code)}`, {
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        Referer: "https://www.sportybet.com/",
      },
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));

    // 19000 = invalid, 19001 = not found → genuinely bad code.
    if (json.bizCode === 19000 || json.bizCode === 19001) {
      return { status: "INVALID" };
    }
    // Anything other than success (e.g. 19999 transient) → don't change state.
    if (json.bizCode !== 10000 || !json.data) {
      return { status: "ACTIVE", transientError: true };
    }

    const d = json.data;
    const ticket = d.ticket ?? {};
    const outcomes: any[] = Array.isArray(d.outcomes) ? d.outcomes : [];

    const kickoffs = outcomes
      .map((e) => Number(e?.estimateStartTime))
      .filter((n) => Number.isFinite(n) && n > 0);
    const matchDate = kickoffs.length ? new Date(Math.min(...kickoffs)) : undefined;

    const league = mostFrequent(
      outcomes.map((e) => e?.sport?.category?.tournament?.name),
    );
    const country = mostFrequent(outcomes.map((e) => e?.sport?.category?.name));

    const displayOdds = ticket.displayTotalOdds ? Number(ticket.displayTotalOdds) : undefined;
    const totalOdds =
      Number.isFinite(displayOdds) && (displayOdds as number) > 0
        ? displayOdds
        : computeOddsFromTicket(d);
    const expiresAt = d.deadline ? new Date(Number(d.deadline)) : undefined;
    const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;

    return {
      status: expired ? "EXPIRED" : "ACTIVE",
      numberOfGames: outcomes.length || undefined,
      totalOdds: Number.isFinite(totalOdds) ? totalOdds : undefined,
      league,
      country,
      matchDate,
      expiresAt,
      betType: d.betType,
      selections: extractSelections(d),
    };
  } catch {
    return { status: "ACTIVE", transientError: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Star/risk from verified odds — higher odds = higher risk, lower stars. */
function scoreFromOdds(totalOdds?: number, trust = 0.5) {
  const risk = !totalOdds ? "MEDIUM" : totalOdds > 20 ? "HIGH" : totalOdds > 6 ? "MEDIUM" : "LOW";
  // Verified codes get a reliability bump; safer odds score higher.
  const oddsFactor = !totalOdds ? 0.5 : totalOdds <= 6 ? 1 : totalOdds <= 20 ? 0.7 : 0.4;
  const reliability = Math.min(1, 0.4 + trust * 0.4 + oddsFactor * 0.2);
  const stars = Math.max(1, Math.min(5, Math.round(reliability * 5)));
  return { risk: risk as "LOW" | "MEDIUM" | "HIGH", reliability, stars };
}

/**
 * Verify codes that are UNVERIFIED, or ACTIVE but not re-checked in the last
 * hour (to catch expiry). Capped per cycle to stay polite.
 */
export async function verifyPending(limit = 25): Promise<{ verified: number; active: number }> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const codes = await prisma.humanCode.findMany({
    where: {
      OR: [
        { status: "UNVERIFIED" },
        { status: "ACTIVE", OR: [{ verifiedAt: null }, { verifiedAt: { lt: oneHourAgo } }] },
      ],
    },
    orderBy: { foundAt: "desc" },
    take: limit,
    include: { source: { select: { trustScore: true } } },
  });

  let verified = 0;
  let active = 0;
  for (const c of codes) {
    const e = await verifyCode(c.code);
    if (e.transientError) continue;

    const { risk, reliability, stars } = scoreFromOdds(e.totalOdds, c.source?.trustScore ?? 0.5);
    await prisma.humanCode.update({
      where: { id: c.id },
      data: {
        status: e.status,
        numberOfGames: e.numberOfGames ?? c.numberOfGames,
        totalOdds: e.totalOdds ?? c.totalOdds,
        league: e.league ?? c.league,
        country: e.country ?? c.country,
        matchDate: e.matchDate ?? c.matchDate,
        expiresAt: e.expiresAt ?? c.expiresAt,
        betType: e.betType ?? undefined,
        selections: e.selections && e.selections.length ? (e.selections as any) : undefined,
        verifiedAt: new Date(),
        score: {
          upsert: {
            create: {
              stars,
              confidencePct: Math.round(reliability * 100),
              riskLevel: risk,
              sourceReliability: reliability,
              oddsStability: e.status === "ACTIVE" ? 1 : 0,
            },
            update: {
              stars,
              confidencePct: Math.round(reliability * 100),
              riskLevel: risk,
              sourceReliability: reliability,
            },
          },
        },
      },
    });
    await prisma.codeVerification.create({
      data: {
        humanCodeId: c.id,
        checkType: "VALIDITY",
        passed: e.status === "ACTIVE",
        detail: `status=${e.status} odds=${e.totalOdds ?? "-"} games=${e.numberOfGames ?? "-"}`,
      },
    });

    verified += 1;
    if (e.status === "ACTIVE") active += 1;
    await new Promise((r) => setTimeout(r, 500)); // polite pacing
  }
  return { verified, active };
}
