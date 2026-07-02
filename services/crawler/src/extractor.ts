import { createHash } from "node:crypto";
import { CODE_TYPE_HINTS, type CodeType } from "@sportybet/shared";

/**
 * Booking-code extraction.
 *
 * SportyBet booking/share codes are short alphanumeric tokens. We only trust
 * tokens that appear in code CONTEXT (near "booking code", "code:", "sporty
 * code", etc.) to avoid false positives from arbitrary words. Everything found
 * is stored as UNVERIFIED — we never claim a code is a valid official SportyBet
 * code without an authoritative check.
 */

const CODE_TOKEN = "[A-Z0-9]{5,12}";

// Context-anchored patterns (the money makers).
const CONTEXT_PATTERNS: RegExp[] = [
  new RegExp(`booking\\s*code[:\\s#\\-]*?(${CODE_TOKEN})`, "gi"),
  new RegExp(`sporty\\s*(?:bet)?\\s*code[:\\s#\\-]*?(${CODE_TOKEN})`, "gi"),
  new RegExp(`\\bcode[:\\s#\\-]+(${CODE_TOKEN})`, "gi"),
  new RegExp(`(${CODE_TOKEN})\\s*(?:booking\\s*code|sporty\\s*code)`, "gi"),
];

// Tokens that look like codes but never are (words + bookmaker names).
const STOPWORDS = new Set([
  "HTTPS",
  "HTTP",
  "SPORTYBET",
  "SPORTY",
  "BOOKING",
  "CODES",
  "TODAY",
  "GAMES",
  "MATCH",
  "ODDS",
  "FOOTBALL",
  "WEEKEND",
  "PREDICTION",
  "PREDICT",
  "WINNING",
  "ACCUMULATOR",
  "CONVERSION",
  "BETSLIP",
  // Common OCR'd betting terms that look code-ish
  "OVER2",
  "UNDER2",
  "OVER25",
  "UNDER25",
  "GOALS",
  "TOTAL",
  // Bookmaker names (contain digits/letters but are not codes)
  "BET9JA",
  "BETWAY",
  "BETKING",
  "MELBET",
  "1XBET",
  "ONEXBET",
  "PARIMATCH",
  "BETANO",
  "STAKE",
  "MSPORT",
  "BANGBET",
]);

export interface ExtractedInfo {
  codes: string[];
  codeType: CodeType;
  totalOdds?: number;
  numberOfGames?: number;
}

function looksLikeCode(token: string): boolean {
  const t = token.toUpperCase();
  if (STOPWORDS.has(t)) return false;
  if (/^(19|20)\d{2}$/.test(t)) return false; // reject 4-digit years
  // SportyBet booking codes are alphanumeric MIXES — require both a letter and
  // a digit. This is the single biggest precision win against headline noise.
  const hasLetter = /[A-Z]/.test(t);
  const hasDigit = /\d/.test(t);
  return hasLetter && hasDigit;
}

export function classifyCodeType(text: string): CodeType {
  const lower = text.toLowerCase();
  for (const [needle, type] of Object.entries(CODE_TYPE_HINTS)) {
    if (lower.includes(needle)) return type;
  }
  return "UNKNOWN";
}

function parseOdds(text: string): number | undefined {
  // Matches "total odds: 22.45", "odds of 5", and "22.45 ODDS".
  const patterns = [
    /(?:total\s*odds?|odds?\s*(?:of)?)[:\s]*([0-9]+(?:\.[0-9]+)?)/i,
    /([0-9]+(?:\.[0-9]+)?)\s*odds\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const v = Number(m[1]);
      if (v >= 1 && v <= 100000) return v;
    }
  }
  return undefined;
}

function parseGames(text: string): number | undefined {
  const m = text.match(/(\d{1,2})\s*(?:games|matches|selections|legs|odds\b)/i);
  if (m) {
    const v = Number(m[1]);
    if (v >= 1 && v <= 50) return v;
  }
  return undefined;
}

export interface ExtractOptions {
  /**
   * Aggressive mode also accepts standalone code-shaped tokens without a
   * "code:" context word. Use ONLY for code-dedicated sources (e.g. Telegram
   * booking-code channels) where a bare token like "DR38VT" IS the code.
   * Never enable for news/RSS — too noisy.
   */
  aggressive?: boolean;
}

const BARE_TOKEN = /\b([A-Z0-9]{5,12})\b/g;

export function extract(text: string, opts: ExtractOptions = {}): ExtractedInfo {
  const found = new Set<string>();

  for (const re of CONTEXT_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const token = match[1]?.toUpperCase();
      if (token && looksLikeCode(token)) found.add(token);
    }
  }

  if (opts.aggressive) {
    const upper = text.toUpperCase();
    let m: RegExpExecArray | null;
    BARE_TOKEN.lastIndex = 0;
    while ((m = BARE_TOKEN.exec(upper)) !== null) {
      const token = m[1];
      if (looksLikeCode(token)) found.add(token);
    }
  }

  return {
    codes: [...found],
    codeType: classifyCodeType(text),
    totalOdds: parseOdds(text),
    numberOfGames: parseGames(text),
  };
}

/** Same code seen on the same calendar day is treated as a duplicate. */
export function contentHash(code: string, isoDate?: string): string {
  const day = (isoDate ? new Date(isoDate) : new Date()).toISOString().slice(0, 10);
  return createHash("sha256").update(`${code.toUpperCase()}|${day}`).digest("hex");
}
