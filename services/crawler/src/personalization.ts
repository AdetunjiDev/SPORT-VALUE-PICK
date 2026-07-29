export type PreferencePayload = {
  preferredGameType?: string | null;
  minConfidence?: number | null;
  maxOdds?: number | null;
  favoriteLeagues?: string[] | null;
  notifyOnNewPicks?: boolean | null;
};

export type UserPreferences = {
  preferredGameType: string;
  minConfidence: number;
  maxOdds: number;
  favoriteLeagues: string[];
  notifyOnNewPicks: boolean;
};

export type SavedPickPayload = {
  home?: string | null;
  away?: string | null;
  league?: string | null;
  market?: string | null;
  selection?: string | null;
  odds?: number | null;
  confidence?: number | null;
  notes?: string | null;
};

export type SavedPick = {
  home: string;
  away: string;
  league: string | null;
  market: string;
  selection: string;
  odds: number;
  confidence: number;
  notes: string | null;
};

const VALID_GAME_TYPES = ["result", "goals", "double", "dnb", "btts", "teamgoals", "safe", "both"] as const;

export function normalizeLeagues(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\n]+/)
      : [];

  return raw
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

export function normalizePreferences(payload: PreferencePayload = {}): UserPreferences {
  const preferredGameType = typeof payload.preferredGameType === "string" && VALID_GAME_TYPES.includes(payload.preferredGameType as any)
    ? payload.preferredGameType
    : "safe";

  const minConfidence = Number.isFinite(Number(payload.minConfidence)) ? Number(payload.minConfidence) : 0;
  const maxOdds = Number.isFinite(Number(payload.maxOdds)) ? Number(payload.maxOdds) : 0;

  return {
    preferredGameType,
    minConfidence: Math.max(0, Math.min(1, minConfidence)),
    maxOdds: Math.max(0, Math.min(10, maxOdds)),
    favoriteLeagues: normalizeLeagues(payload.favoriteLeagues),
    notifyOnNewPicks: payload.notifyOnNewPicks === true,
  };
}

export function normalizeSavedPick(payload: SavedPickPayload = {}): SavedPick {
  const home = String(payload.home ?? "").trim();
  const away = String(payload.away ?? "").trim();
  const league = String(payload.league ?? "").trim();
  const market = String(payload.market ?? "").trim();
  const selection = String(payload.selection ?? "").trim();
  const odds = Number.isFinite(Number(payload.odds)) ? Number(payload.odds) : 0;
  const confidence = Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0;
  const notes = String(payload.notes ?? "").trim();

  return {
    home,
    away,
    league: league || null,
    market,
    selection,
    odds: Math.max(0, Math.min(10, odds)),
    confidence: Math.max(0, Math.min(1, confidence)),
    notes: notes || null,
  };
}

export function preferenceSummary(pref: UserPreferences): string {
  const gameType = pref.preferredGameType || "safe";
  const minConfidencePct = Math.round(pref.minConfidence * 100);
  const leagues = pref.favoriteLeagues.length ? pref.favoriteLeagues.join(", ") : "No leagues selected";
  return `Game type: ${gameType}; min confidence: ${minConfidencePct}%; leagues: ${leagues}; alerts: ${pref.notifyOnNewPicks ? "on" : "off"}`;
}
