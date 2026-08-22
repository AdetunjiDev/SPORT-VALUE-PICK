import type { MatchAnalysis, BetOption } from "./xg.js";
import type { MatchForm, TeamForm } from "./form.js";
import { askAiMatchAnalyst, isBytezEnabled } from "./bytez.js";
import {
  intelEnabled,
  getTeamMomentum,
  getTeamStanding,
  getFixtureInjuries,
  getH2HDeep,
} from "./apifootball-intel.js";

/**
 * Deep-dive AI analyst chat — a conversational layer over the SAME numbers the
 * dashboard already computes (Poisson model probabilities, live SportyBet
 * odds, real past results). Every answer is grounded in that data: the
 * assistant never invents a stat it can't cite.
 *
 * When Bytez AI is enabled, uses state-of-the-art LLMs (Llama 3.3 70B / DeepSeek-R1)
 * to deliver rich, contextualized natural language reasoning. Seamlessly falls
 * back to instant deterministic calculations when offline.
 */

const pc = (p: number) => `${Math.round(p * 100)}%`;
const fairOdds = (p: number) => (p > 0 ? (1 / p).toFixed(2) : "—");

function bestOption(a: MatchAnalysis): BetOption | null {
  return a.options.length ? [...a.options].sort((x, y) => y.prob - x.prob)[0] : null;
}

/** Model-vs-price read for one option: is the odd paying for the risk? */
function valueRead(o: BetOption): string {
  if (!o.odds) return `${o.label}: ${pc(o.prob)} model chance (no live price).`;
  const implied = 1 / Number(o.odds);
  const edge = o.prob - implied;
  const verdict =
    edge >= 0.03
      ? "✅ good value — the model rates it higher than the price implies"
      : edge >= -0.03
        ? "➖ fair price — about what the odds imply"
        : "⚠️ poor value — the odds imply more chance than the model sees";
  return `${o.label} @${o.odds}: model ${pc(o.prob)} vs price-implied ${pc(implied)} → ${verdict}.`;
}

function formLine(f: TeamForm | null, name: string): string {
  if (!f || !f.matches.length) return `${name}: no verified recent results in the database (common for minor/SRL leagues).`;
  const rows = f.matches
    .map((m) => `${m.home} ${m.homeScore}-${m.awayScore} ${m.away}`)
    .join("; ");
  const w = f.matches.filter((m) => m.result === "W").length;
  const d = f.matches.filter((m) => m.result === "D").length;
  const l = f.matches.filter((m) => m.result === "L").length;
  return `${f.team}: ${f.summary} (${w}W ${d}D ${l}L) — ${rows}.`;
}

function overview(a: MatchAnalysis, form: MatchForm | null): string {
  const best = bestOption(a);
  const parts = [
    `🧮 ${a.home} v ${a.away}: the model expects ${a.xgHome.toFixed(2)} – ${a.xgAway.toFixed(2)} goals (xG). Verdict: **${a.verdict}** at ${pc(a.confidence)} confidence; likeliest score ${a.likeliest}.`,
    `Result probabilities — ${a.home}: ${pc(a.pHome)}, Draw: ${pc(a.pDraw)}, ${a.away}: ${pc(a.pAway)}. Goals — Over 2.5: ${pc(a.over25)}, Both to score: ${pc(a.btts)}.`,
  ];
  if (form && (form.home?.matches.length || form.away?.matches.length)) {
    const fh = form.home ? `${form.home.summary}` : "n/a";
    const fa = form.away ? `${form.away.summary}` : "n/a";
    parts.push(`📜 Real recent form — ${a.home}: ${fh} · ${a.away}: ${fa} (ask "form" for the actual scores).`);
  }
  if (best) parts.push(`Statistically safest market shown: **${best.label}** (${pc(best.prob)}${best.odds ? ` @${best.odds}` : ""}).`);
  parts.push(`These are estimates from live prices, never guarantees — only stake what you can afford to lose.`);
  return parts.join("\n");
}

/**
 * Answer one user question about one analysed match. `q` is free text.
 * When Bytez AI is configured, queries LLM model with full grounded context.
 * Falls back to deterministic rule-based analysis.
 */
export async function analystAnswer(q: string, a: MatchAnalysis, form: MatchForm | null): Promise<string> {
  const t = q.toLowerCase();

  // If Bytez AI is available and the query is not a basic single-word greeting, ask LLM
  if (isBytezEnabled() && t.trim().length > 3) {
    try {
      const best = bestOption(a);
      const formSummary = form ? `${a.home}: ${form.home?.summary ?? "n/a"} | ${a.away}: ${form.away?.summary ?? "n/a"}` : undefined;
      const h2hSummary = form?.h2h?.length
        ? `${form.h2h.length} past meetings (${form.h2h.map((m) => `${m.home} ${m.homeScore}-${m.awayScore} ${m.away}`).join(", ")})`
        : undefined;

      const aiResponse = await askAiMatchAnalyst(q, {
        home: a.home,
        away: a.away,
        league: a.league,
        kickoff: a.kickoff,
        xgHome: a.xgHome,
        xgAway: a.xgAway,
        pHome: a.pHome,
        pDraw: a.pDraw,
        pAway: a.pAway,
        over25: a.over25,
        btts: a.btts,
        verdict: a.verdict,
        confidence: a.confidence,
        likeliest: a.likeliest,
        bestPick: best ? `${best.label} (${pc(best.prob)}${best.odds ? ` @${best.odds}` : ""})` : undefined,
        formSummary,
        h2hSummary,
      });

      if (aiResponse) {
        return `${aiResponse}\n\n⚡ _Powered by Bytez AI Analyst_`;
      }
    } catch {
      /* fallback to deterministic engine */
    }
  }

  // --- API-Football Intel: handle momentum/standings/injury questions ---
  if (intelEnabled()) {
    if (/momentum|form.*radar|hot.*cold|streak|shape|fitness/i.test(t)) {
      const [hMom, aMom] = await Promise.all([
        getTeamMomentum(a.home).catch(() => null),
        getTeamMomentum(a.away).catch(() => null),
      ]);
      const parts: string[] = [`🔥 **Momentum Radar** (last 10 games, API-Football):`];
      if (hMom) parts.push(`${a.home}: ${hMom.label} — Score ${hMom.score}/100, ${hMom.wins}W ${hMom.draws}D ${hMom.losses}L, GF:${hMom.goalsFor} GA:${hMom.goalsAgainst}, Streak: ${hMom.streak}`);
      else parts.push(`${a.home}: data not available`);
      if (aMom) parts.push(`${a.away}: ${aMom.label} — Score ${aMom.score}/100, ${aMom.wins}W ${aMom.draws}D ${aMom.losses}L, GF:${aMom.goalsFor} GA:${aMom.goalsAgainst}, Streak: ${aMom.streak}`);
      else parts.push(`${a.away}: data not available`);
      if (hMom && aMom) {
        const gap = hMom.score - aMom.score;
        parts.push(Math.abs(gap) >= 20 ? `Momentum edge: **${gap > 0 ? a.home : a.away}** (+${Math.abs(gap)} pts)` : `Momentum is close — no clear advantage.`);
      }
      return parts.join("\n");
    }
    if (/standing|table|league.*pos|rank|title|relegat|where.*sit/i.test(t) && a.league) {
      const [hStd, aStd] = await Promise.all([
        getTeamStanding(a.home, a.league).catch(() => null),
        getTeamStanding(a.away, a.league).catch(() => null),
      ]);
      const parts: string[] = [`📊 **League Standings Context** (${a.league}):`];
      if (hStd) parts.push(`${a.home}: ${hStd.rank}/${hStd.totalTeams} — ${hStd.points}pts (${hStd.ppg} PPG), Form: ${hStd.form || "n/a"} → ${hStd.motivationTier}`);
      else parts.push(`${a.home}: standings not available`);
      if (aStd) parts.push(`${a.away}: ${aStd.rank}/${aStd.totalTeams} — ${aStd.points}pts (${aStd.ppg} PPG), Form: ${aStd.form || "n/a"} → ${aStd.motivationTier}`);
      else parts.push(`${a.away}: standings not available`);
      if (hStd && aStd) {
        const gap = Math.abs(hStd.rank - aStd.rank);
        parts.push(gap >= 8 ? `⚠️ Class mismatch: ${gap} places apart — ${hStd.rank < aStd.rank ? a.home : a.away} is clearly higher quality.` : `Close in the table — ${gap} places apart.`);
      }
      return parts.join("\n");
    }
    if (/injur|squad|fitness|miss|out|suspend|absent/i.test(t)) {
      const [hInj, aInj] = await Promise.all([
        getFixtureInjuries(null, a.home).catch(() => null),
        getFixtureInjuries(null, a.away).catch(() => null),
      ]);
      const parts: string[] = [`🏥 **Injury & Squad Report** (API-Football):`];
      if (hInj) {
        parts.push(`${a.home}: ${hInj.severity} — ${hInj.summary}`);
        if (hInj.injuries.length) parts.push(`  Missing: ${hInj.injuries.map((i) => `${i.player} (${i.reason})`).join(", ")}`);
      } else parts.push(`${a.home}: no injury data available`);
      if (aInj) {
        parts.push(`${a.away}: ${aInj.severity} — ${aInj.summary}`);
        if (aInj.injuries.length) parts.push(`  Missing: ${aInj.injuries.map((i) => `${i.player} (${i.reason})`).join(", ")}`);
      } else parts.push(`${a.away}: no injury data available`);
      return parts.join("\n");
    }
  }

  if (/^\s*(overview|start|hi|hello)?\s*$/.test(t) || /overview|summary|about|analy[sz]e/.test(t)) {
    return overview(a, form);
  }
  if (/h2h|head[- ]?to[- ]?head|meeting|each other|played before|previous match/.test(t)) {
    const h2h = form?.h2h ?? [];
    if (!h2h.length)
      return `🤝 No previous meetings between ${a.home} and ${a.away} in the results database — lean on each team's own recent form instead (ask "form").`;
    const rows = h2h.map((m) => `${m.date}: ${m.home} ${m.homeScore}-${m.awayScore} ${m.away}`).join("\n");
    const hw = h2h.filter((m) => m.result === "W").length;
    const dr = h2h.filter((m) => m.result === "D").length;
    const aw = h2h.length - hw - dr;
    return [
      `🤝 Last ${h2h.length} real meeting${h2h.length === 1 ? "" : "s"} (actual scores, newest first):`,
      rows,
      `Head-to-head record: ${a.home} ${hw} — ${dr} draw${dr === 1 ? "" : "s"} — ${aw} ${a.away}. The model currently prices this one ${pc(a.pHome)} / ${pc(a.pDraw)} / ${pc(a.pAway)}.`,
    ].join("\n");
  }
  if (/form|recent|last\s*(5|five|10|ten)|history|past|results?/.test(t)) {
    const lines = [
      `📜 Last real results (actual final scores, newest first):`,
      formLine(form?.home ?? null, a.home),
      formLine(form?.away ?? null, a.away),
    ];
    const fh = form?.home;
    const fa = form?.away;
    if (fh && fa) {
      const wins = (f: TeamForm) => f.matches.filter((m) => m.result === "W").length;
      lines.push(
        wins(fh) > wins(fa)
          ? `Form edge: ${a.home} (${wins(fh)} wins in ${fh.matches.length} vs ${wins(fa)} in ${fa.matches.length}) — and the model already prices ${a.home} at ${pc(a.pHome)}.`
          : wins(fa) > wins(fh)
            ? `Form edge: ${a.away} (${wins(fa)} wins in ${fa.matches.length} vs ${wins(fh)} in ${fh.matches.length}) — the model gives ${a.away} ${pc(a.pAway)}.`
            : `Form is even (${wins(fh)} wins each) — the model splits it ${pc(a.pHome)} / ${pc(a.pDraw)} / ${pc(a.pAway)}.`,
      );
    }
    return lines.join("\n");
  }
  if (/safe|best|banker|sure|strongest|which (pick|market|option)/.test(t)) {
    const sorted = [...a.options].sort((x, y) => y.prob - x.prob);
    if (!sorted.length) return "No bookable markets are priced for this match right now.";
    const [b, second] = sorted;
    return [
      `🛡️ Safest market shown: **${b.label}** — ${pc(b.prob)} model chance${b.odds ? ` @${b.odds} (fair ≈ @${fairOdds(b.prob)})` : ""}.`,
      second ? `Next safest: ${second.label} at ${pc(second.prob)}${second.odds ? ` @${second.odds}` : ""}.` : "",
      `Remember: "safest" still loses ${pc(1 - b.prob)} of the time — nothing is a sure win.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (/over|under|goals?|o\/u|total/.test(t)) {
    const lean = a.over25 >= 0.5 ? "Over" : "Under";
    return [
      `🥅 Total goals: the model expects ${(a.xgHome + a.xgAway).toFixed(2)} goals.`,
      `Over 0.5: ${pc(a.over05)} · Over 1.5: ${pc(a.over15)} · Over 2.5: ${pc(a.over25)} (so Under 2.5 = ${pc(1 - a.over25)}).`,
      `Lean: **${lean} 2.5** — but at ${pc(Math.max(a.over25, 1 - a.over25))} it's ${Math.max(a.over25, 1 - a.over25) >= 0.65 ? "a solid lean" : "close to a coin-flip, so don't overstake"}.`,
    ].join("\n");
  }
  if (/btts|both.*score|gg\b/.test(t)) {
    return `⚽ Both teams to score: ${pc(a.btts)} (No = ${pc(1 - a.btts)}). That follows from the xG split ${a.xgHome.toFixed(2)} – ${a.xgAway.toFixed(2)} — ${a.btts >= 0.55 ? "both attacks are expected to find a goal" : "at least one clean sheet is genuinely likely"}.`;
  }
  if (/score|correct|scoreline|exact/.test(t)) {
    const top = a.topScores.slice(0, 4).map((s) => `${s.score} (${pc(s.prob)})`).join(", ");
    return `🎯 Most likely scorelines: ${top}. Correct-score is a high-variance market — even the single likeliest score (${a.likeliest}) only lands ${pc(a.topScores[0]?.prob ?? 0)} of the time, so treat it as a fun punt, not a plan.`;
  }
  if (/value|worth|pay|price|odd/.test(t)) {
    if (!a.options.length) return "No live prices to evaluate right now.";
    const reads = a.options.map(valueRead);
    return [`💰 Value check (model probability vs what the price implies):`, ...reads].join("\n");
  }
  if (/win|who|result|1x2|victor|favourite|favorite/.test(t)) {
    return [
      `🏆 Result probabilities — ${a.home}: ${pc(a.pHome)} · Draw: ${pc(a.pDraw)} · ${a.away}: ${pc(a.pAway)}.`,
      `Model verdict: **${a.verdict}** (${pc(a.confidence)}). ${a.confidence < 0.5 ? "That's under 50% — this match is genuinely open, consider Double Chance instead of a straight win." : "Reasonable, but a Double Chance covers the draw if you want safety."}`,
    ].join("\n");
  }
  if (/risk|risky|danger|avoid/.test(t)) {
    const sorted = [...a.options].sort((x, y) => x.prob - y.prob);
    const risky = sorted[0];
    const safe = sorted[sorted.length - 1];
    return [
      `⚠️ Risk read: ${risky ? `the riskiest market shown is ${risky.label} (${pc(risky.prob)})` : "no priced markets"}${safe ? `; the safest is ${safe.label} (${pc(safe.prob)})` : ""}.`,
      `Fewer legs = fewer ways to lose. If this match is the shaky one in your slip, swap it for the safer market or drop it entirely.`,
    ].join("\n");
  }
  // Unknown question — give the overview plus a hint at what I can answer.
  return `${overview(a, form)}\n\n💬 You can ask me: "safest pick?", "over or under?", "both teams to score?", "likely score?", "recent form?", "head to head?", "is the odd good value?", "who wins?", "momentum?", "standings?", "injuries?"`;
}
