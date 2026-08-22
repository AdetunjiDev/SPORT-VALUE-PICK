import test from "node:test";
import assert from "node:assert/strict";
import { normalizePreferences, normalizeLeagues, normalizeSavedPick, preferenceSummary } from "./personalization.js";

test("normalizePreferences clamps and sanitizes values", () => {
  const result = normalizePreferences({
    preferredGameType: "double",
    minConfidence: 150,
    maxOdds: 0,
    favoriteLeagues: ["Premier League", "", "  La Liga  ", "Champions League"],
    notifyOnNewPicks: "false",
  } as any);

  assert.equal(result.preferredGameType, "double");
  assert.equal(result.minConfidence, 1);
  assert.equal(result.maxOdds, 1);
  assert.deepEqual(result.favoriteLeagues, ["Premier League", "La Liga", "Champions League"]);
  assert.equal(result.notifyOnNewPicks, false);
});

test("preferenceSummary formats concise defaults", () => {
  const summary = preferenceSummary(normalizePreferences({}));
  assert.match(summary, /safe/i);
  assert.match(summary, /0%/);
});

test("normalizeLeagues trims and removes empties", () => {
  assert.deepEqual(normalizeLeagues([" Premier League ", "", "La Liga", "  "]), ["Premier League", "La Liga"]);
  assert.deepEqual(normalizeLeagues(""), []);
});

test("normalizeSavedPick trims and clamps values", () => {
  const result = normalizeSavedPick({
    home: "  Arsenal  ",
    away: "Chelsea",
    league: "  Premier League  ",
    market: "Double Chance",
    selection: "1X",
    odds: 12,
    confidence: 1.4,
    notes: "  Strong value  ",
  } as any);

  assert.equal(result.home, "Arsenal");
  assert.equal(result.away, "Chelsea");
  assert.equal(result.league, "Premier League");
  assert.equal(result.market, "Double Chance");
  assert.equal(result.selection, "1X");
  assert.equal(result.odds, 10);
  assert.equal(result.confidence, 1);
  assert.equal(result.notes, "Strong value");
});
