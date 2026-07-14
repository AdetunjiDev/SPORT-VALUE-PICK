/**
 * Bookmaker registry — the foundation of multi-bookmaker support.
 *
 * Today only SportyBet is fully implemented (fixtures + odds + booking codes).
 * The others are registered as "coming soon": the dashboard lists them and lets
 * the user pick, but each needs its OWN adapter (odds feed, booking-code
 * creation, verification) before it can go live — those are separate,
 * per-bookmaker integrations, not a config flip.
 *
 * When an adapter is built, implement the Bookmaker interface below and set
 * status: "live". Everything analytical (Poisson model, value, combos, ROI)
 * reuses across bookmakers — only the three data operations differ.
 */

export type BookmakerStatus = "live" | "soon";

export interface BookmakerInfo {
  id: string;
  name: string;
  emoji: string;
  status: BookmakerStatus;
  note?: string;
}

export const BOOKMAKERS: BookmakerInfo[] = [
  { id: "sportybet", name: "SportyBet", emoji: "⚽", status: "live" },
  { id: "msport", name: "MSport", emoji: "🟢", status: "soon", note: "similar platform — next to launch" },
  { id: "betking", name: "BetKing", emoji: "👑", status: "soon" },
  { id: "1xbet", name: "1xBet", emoji: "1️⃣", status: "soon" },
  { id: "betway", name: "Betway", emoji: "🅱️", status: "soon", note: "heavier bot-protection — later" },
  { id: "bet9ja", name: "Bet9ja", emoji: "9️⃣", status: "soon", note: "heavier bot-protection — later" },
];

export const DEFAULT_BOOKMAKER = "sportybet";

export function getBookmaker(id: string | undefined | null): BookmakerInfo {
  return BOOKMAKERS.find((b) => b.id === id) ?? BOOKMAKERS[0];
}

/** The active bookmaker actually used for data right now (always the live one). */
export function activeBookmaker(): BookmakerInfo {
  return BOOKMAKERS.find((b) => b.status === "live") ?? BOOKMAKERS[0];
}
