import { config } from "./config.js";

/**
 * Auto-generate a REAL SportyBet booking code from a set of selections, using
 * SportyBet's own public booking endpoint (POST /orders/share) — the same call
 * their site makes when you tap "Book". A booking code just SAVES selections to
 * a shareable reference: NO money moves and NO bet is placed. The user still
 * loads the code and decides whether to stake. We never auto-place bets.
 */

const SHARE_API = "https://www.sportybet.com/api/ng/orders/share";

export interface BookableLeg {
  eventId: string;
  marketId?: string;
  specifier?: string;
  outcomeId?: string;
}

export interface BookingResult {
  code?: string;
  url?: string;
  games?: number;
  unavailable?: number;
  error?: string;
}

export async function createBookingCode(legs: BookableLeg[]): Promise<BookingResult> {
  const selections = legs
    .filter((l) => l.eventId && l.marketId && l.outcomeId)
    .map((l) => ({
      eventId: l.eventId,
      marketId: l.marketId,
      specifier: l.specifier ?? "",
      outcomeId: l.outcomeId,
    }))
    .slice(0, 70); // SportyBet slip cap
  if (selections.length < 1) return { error: "no bookable selections" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(SHARE_API, {
      method: "POST",
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: "https://www.sportybet.com/",
        ClientId: "web",
      },
      body: JSON.stringify({ selections }),
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (json.bizCode !== 10000 || !json.data?.shareCode) {
      return { error: `bizCode=${json.bizCode ?? "?"}` };
    }
    return {
      code: json.data.shareCode,
      url: json.data.shareURL,
      games: Array.isArray(json.data.outcomes) ? json.data.outcomes.length : undefined,
      unavailable: Array.isArray(json.data.unavailableOutcomes)
        ? json.data.unavailableOutcomes.length
        : 0,
    };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}
