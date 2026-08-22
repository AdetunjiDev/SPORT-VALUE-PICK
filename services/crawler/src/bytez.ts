import { config } from "./config.js";
import { createHash } from "node:crypto";

/**
 * Bytez AI Service (Llama 3.3 70B / DeepSeek-R1 / Qwen 2.5)
 *
 * Provides intelligent sports betting analysis, match value explanations,
 * and conversational Q&A grounded in live odds and statistical models.
 * Includes in-memory response caching and robust offline fallbacks.
 */

interface CacheEntry {
  response: string;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function isBytezEnabled(): boolean {
  return Boolean(config.bytez.apiKey && config.bytez.apiKey.trim().length > 0);
}

function hashKey(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Perform a chat completion request against the Bytez API.
 */
export async function bytezChat(
  messages: ChatMessage[],
  opts: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const apiKey = config.bytez.apiKey?.trim();
  if (!apiKey) return null;

  const model = opts.model ?? config.bytez.model;
  const cacheKey = hashKey(`${model}:${JSON.stringify(messages)}`);

  // Check cache
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  const timeoutMs = opts.timeoutMs ?? config.bytez.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 350,
  };

  const isOpenRouter = apiKey.startsWith("sk-or-") || apiKey.startsWith("Bearer sk-or-");
  const authHeader = apiKey.startsWith("Key ") || apiKey.startsWith("Bearer ")
    ? apiKey
    : (isOpenRouter ? `Bearer ${apiKey}` : `Key ${apiKey}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };
  if (isOpenRouter) {
    headers["HTTP-Referer"] = config.publicBaseUrl || "http://localhost:3000";
    headers["X-Title"] = "SportyBet Value Pick AI";
  }

  // Primary endpoint with secondary endpoint fallback
  const endpoints = isOpenRouter
    ? ["https://openrouter.ai/api/v1/chat/completions"]
    : [
        "https://api.bytez.com/models/v2/openai/v1/chat/completions",
        "https://api.bytez.com/v1/chat/completions",
      ];

  try {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const text = data?.choices?.[0]?.message?.content?.trim();
          if (text) {
            // Trim cache if too large
            if (responseCache.size > 200) {
              const now = Date.now();
              for (const [k, v] of responseCache.entries()) {
                if (v.expiresAt <= now) responseCache.delete(k);
              }
              if (responseCache.size > 300) responseCache.clear();
            }

            responseCache.set(cacheKey, {
              response: text,
              expiresAt: Date.now() + CACHE_TTL_MS,
            });
            return text;
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") break;
        // Continue to fallback endpoint
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return null;
}

/**
 * Generate a sharp, high-conviction narrative for an AI Value Slip.
 */
export async function generateSlipNarrative(slip: {
  title: string;
  totalOdds: number;
  confidence: number;
  expectedValue: number;
  legs: Array<{ home?: string; away?: string; pick?: string; odds?: number; market?: string; prob?: number }>;
}): Promise<string> {
  const legsDesc = slip.legs
    .map(
      (l) =>
        `- ${l.home} vs ${l.away}: Pick "${l.pick}" (${l.market || "1X2"}) @${l.odds || "1.50"} (Model prob: ${
          l.prob ? Math.round(l.prob * 100) : 60
        }%)`,
    )
    .join("\n");

  const systemPrompt =
    "You are an elite sports betting analyst and quantitative modeler for Sporty Value Pick AI. " +
    "Provide a concise, professional 2-3 sentence executive summary explaining why this value slip has positive mathematical expected value and strong tactical justification. " +
    "Be grounded, realistic, avoid hype or guaranteed win claims, and focus on risk-reward edge.";

  const userPrompt = `Review this value slip:\nTitle: ${slip.title}\nCombined Odds: ${slip.totalOdds}\nModel Win Chance: ${Math.round(
    slip.confidence * 100,
  )}%\nExpected Value: +${Math.round(slip.expectedValue * 100)}%\n\nSelections:\n${legsDesc}\n\nWrite a 2-sentence expert value summary for bettors.`;

  if (isBytezEnabled()) {
    try {
      const answer = await bytezChat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { maxTokens: 140, temperature: 0.3 },
      );
      if (answer) return answer;
    } catch {
      /* fallback below */
    }
  }

  // Deterministic statistical fallback
  return (
    `Algorithmically assembled overlay with +${Math.round(slip.expectedValue * 100)}% expected value. ` +
    `Combines ${slip.legs.length} mathematically validated selections offering an optimal risk-to-reward ratio ` +
    `at combined odds of ${slip.totalOdds}.`
  );
}

/**
 * Generate an expert tactical reasoning for an individual value pick.
 */
export async function generateMatchValueInsight(pick: {
  home: string;
  away: string;
  pick: string;
  market?: string;
  odds: string | number;
  modelProb: number;
  edge: number;
  ev: number;
  signals?: string[];
  intelReport?: any;
}): Promise<string> {
  const systemPrompt =
    "You are a seasoned Wall Street analyst turned professional sports bettor. " +
    "You speak in sharp, professional finance terms (alpha, mispricing, market inefficiency, fading the public). " +
    "Explain in 1-2 punchy sentences why backing this specific outcome offers genuine mathematical value against bookmaker pricing. " +
    "Focus on the data edge and qualitative signals provided.";

  let intelSummary = "";
  if (pick.intelReport) {
    const r = pick.intelReport;
    if (r.homeMomentum) intelSummary += `\nHome Form: ${r.homeMomentum.label} (Score: ${r.homeMomentum.score})`;
    if (r.awayMomentum) intelSummary += `\nAway Form: ${r.awayMomentum.label} (Score: ${r.awayMomentum.score})`;
    if (r.homeStanding && r.awayStanding) intelSummary += `\nMotivation: Home is ${r.homeStanding.motivationTier}, Away is ${r.awayStanding.motivationTier}`;
    if (r.homeInjuries?.totalOut > 0) intelSummary += `\nHome Injuries: ${r.homeInjuries.summary}`;
    if (r.awayInjuries?.totalOut > 0) intelSummary += `\nAway Injuries: ${r.awayInjuries.summary}`;
  }

  const userPrompt = `Match: ${pick.home} vs ${pick.away}
Selection: ${pick.pick} (${pick.market ?? "1X2"})
Price: @${pick.odds}
Model Probability: ${Math.round(pick.modelProb * 100)}%
Edge: +${Math.round(pick.edge * 100)}%
Expected Value: +${Math.round(pick.ev * 100)}%
${pick.signals?.length ? `Supporting Signals: ${pick.signals.join(", ")}` : ""}${intelSummary}

Give a 1-sentence Wall Street style value rationale.`;

  if (isBytezEnabled()) {
    try {
      const answer = await bytezChat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { maxTokens: 80, temperature: 0.3 },
      );
      if (answer) return answer;
    } catch {
      /* fallback below */
    }
  }

  return `Model probability (${Math.round(pick.modelProb * 100)}%) outpaces bookmaker implied price by +${Math.round(
    pick.edge * 100,
  )}pts with positive Expected Value (+${Math.round(pick.ev * 100)}%).`;
}

/**
 * Conversational AI Analyst query powered by Bytez LLM.
 */
export async function askAiMatchAnalyst(
  question: string,
  context: {
    home: string;
    away: string;
    league?: string;
    kickoff?: string | number;
    xgHome: number;
    xgAway: number;
    pHome: number;
    pDraw: number;
    pAway: number;
    over25: number;
    btts: number;
    verdict: string;
    confidence: number;
    likeliest: string;
    bestPick?: string;
    formSummary?: string;
    h2hSummary?: string;
  },
): Promise<string | null> {
  if (!isBytezEnabled()) return null;

  const systemPrompt =
    "You are the Sporty Value Pick AI Senior Football Analyst. You assist users with match breakdowns, tactical probabilities, and betting risk analysis. " +
    "Ground all answers STRICTLY in the provided Poisson xG, match probabilities, head-to-head records, and form figures. " +
    "Never promise guarantees; emphasize mathematical expectation, bankroll discipline, and value edges. Keep responses structured, concise, and easy to read with emojis.";

  const userPrompt = `User Question: "${question}"

Match Data:
- Fixture: ${context.home} vs ${context.away} (${context.league || "League"})
- Expected Goals (xG): ${context.home} ${context.xgHome.toFixed(2)} - ${context.xgAway.toFixed(2)} ${context.away}
- Win/Draw Probabilities: ${context.home} ${Math.round(context.pHome * 100)}% | Draw ${Math.round(
    context.pDraw * 100,
  )}% | ${context.away} ${Math.round(context.pAway * 100)}%
- Goals Markets: Over 2.5 Goals: ${Math.round(context.over25 * 100)}% | Both Teams To Score: ${Math.round(
    context.btts * 100,
  )}%
- Statistical Verdict: ${context.verdict} (${Math.round(context.confidence * 100)}% confidence, likeliest score: ${
    context.likeliest
  })
${context.bestPick ? `- Recommended Market: ${context.bestPick}` : ""}
${context.formSummary ? `- Form: ${context.formSummary}` : ""}
${context.h2hSummary ? `- Head-to-Head: ${context.h2hSummary}` : ""}

Answer the user directly and helpfully based on these exact numbers.`;

  return bytezChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 350, temperature: 0.35 },
  );
}
