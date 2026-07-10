import http from "node:http";
import { createHash } from "node:crypto";
import { prisma } from "@sportybet/db";
import { RESPONSIBLE_GAMBLING_DISCLAIMER } from "@sportybet/shared";
import { config } from "./config.js";
import { runCycle, lastRunAt, nextRunAt, lastSummary, intervalSec } from "./scheduler.js";
import { getPredictions } from "./predictions.js";
import { planForTips, legsForFixtureKeys } from "./forebet-ai.js";
import { createBookingCode } from "./booker.js";
import { ocrBuffer } from "./ocr.js";
import { extract } from "./extractor.js";
import { verifyCode } from "./verifier.js";
import { telegramClientEnabled } from "./adapters/telegram-client.js";
import {
  getExpertPicks,
  getExpertRecord,
  getExpertRoi,
  getValuePicks,
  getCombos,
  type GameType,
} from "./analyst.js";
import { getMatchAnalyses } from "./xg.js";

const GAME_TYPES: GameType[] = ["result", "goals", "double", "dnb", "btts", "teamgoals", "safe", "both"];
const validGameType = (v: unknown): GameType =>
  GAME_TYPES.includes(v as GameType) ? (v as GameType) : "result";

/** Read a request body with a hard size cap (default 10 MB for images). */
function readBody(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Trim a team name for compact labels (first two words, capped length). */
function shortName(name: string): string {
  return name.split(/\s+/).slice(0, 2).join(" ").slice(0, 16);
}

/** Full-page password gate shown when APP_PASSWORD is set and the visitor isn't authed. */
function renderLogin(err: boolean): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SportyBet AI · Sign in</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1424;
    font-family:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#eef1f7}
  .box{width:340px;max-width:90vw;background:#161c2e;border:1px solid #263049;border-radius:16px;
    padding:30px 26px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#f2683c,#5b4bd6);
    display:grid;place-items:center;font-size:22px;margin:0 auto 14px}
  h1{font-size:18px;text-align:center;margin:0 0 4px}
  p{text-align:center;color:#8b94ad;font-size:13px;margin:0 0 20px}
  input{width:100%;padding:12px 14px;border:1px solid #2c3854;border-radius:10px;background:#0f1424;
    color:#fff;font-size:15px;outline:none;margin-bottom:12px}
  input:focus{border-color:#f2683c}
  button{width:100%;padding:12px;border:0;border-radius:10px;font-weight:800;font-size:15px;cursor:pointer;
    background:linear-gradient(135deg,#f2683c,#f7864f);color:#fff}
  .err{color:#ff8a8a;font-size:13px;text-align:center;margin:-4px 0 12px}
  .foot{text-align:center;font-size:11px;margin-top:16px;color:#5c667e}
</style></head><body>
  <form class="box" method="post" action="/login">
    <div class="logo">⚽</div>
    <h1>SportyBet AI</h1>
    <p>Private dashboard — enter the password to continue</p>
    ${err ? '<div class="err">Wrong password. Try again.</div>' : ""}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"/>
    <button type="submit">Sign in</button>
    <div class="foot">Authorized access only</div>
  </form>
</body></html>`;
}

function stars(n: number): string {
  const v = Math.max(0, Math.min(5, n));
  return "★".repeat(v) + "☆".repeat(5 - v);
}

type Mode = "human" | "ai" | "pred" | "expert" | "value" | "combo" | "analysis" | "saved";
type Tier = "free" | "premium";

async function renderDashboard(
  mode: Mode = "human",
  tier: Tier = "free",
  dateStr = "",
  expertOpts: { count: number; days: number; gameType: GameType; minConfidence: number } = {
    count: 5,
    days: 5,
    gameType: "safe",
    minConfidence: 0,
  },
  isAdmin = false,
): Promise<string> {
  const preds = mode === "pred" ? await getPredictions() : [];
  // Expert picks: highest-confidence selections across the chosen day window.
  const expertResult =
    mode === "expert"
      ? await getExpertPicks({
          count: expertOpts.count,
          days: expertOpts.days,
          gameType: expertOpts.gameType,
          minConfidence: expertOpts.minConfidence / 100, // form stores plain %, engine wants a 0..1 fraction
          seed: Math.floor(Date.now() / (8 * 60_000)), // rotate every ~8 min
        })
      : { picks: [], requested: 0, windowDays: 0, poolSize: 0 };
  const expertPicks = expertResult.picks;
  const expertRecord = mode === "expert" ? await getExpertRecord().catch(() => null) : null;
  const expertRoi = mode === "expert" ? await getExpertRoi().catch(() => null) : null;
  const valueResult =
    mode === "value"
      ? await getValuePicks({
          count: expertOpts.count,
          days: expertOpts.days,
          seed: Math.floor(Date.now() / (8 * 60_000)),
        }).catch(() => ({ picks: [], requested: 0, windowDays: 0, scanned: 0 }))
      : { picks: [], requested: 0, windowDays: 0, scanned: 0 };
  const combos =
    mode === "combo"
      ? await getCombos(Math.floor(Date.now() / (10 * 60_000))).catch(() => [])
      : [];
  const analysis =
    mode === "analysis"
      ? await getMatchAnalyses(expertOpts.count, expertOpts.days).catch(() => ({
          matches: [],
          requested: 0,
          windowDays: 0,
          scanned: 0,
        }))
      : { matches: [], requested: 0, windowDays: 0, scanned: 0 };
  const savedCodes =
    mode === "saved"
      ? await prisma.generatedCode
          .findMany({ orderBy: { createdAt: "desc" }, take: 200 })
          .catch(() => [])
      : [];
  const isPremium = tier === "premium";
  const freshCut = Date.now() - config.freeDelayMin * 60_000;

  // Date filter. Default view = TODAY (current codes); "all" shows everything;
  // a YYYY-MM-DD shows that WAT calendar day.
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }); // YYYY-MM-DD
  const showAll = dateStr === "all";
  const day = showAll ? "" : /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayStr;
  const dateOk = day !== ""; // a specific day is being shown
  const codeWhere = day
    ? {
        foundAt: {
          gte: new Date(`${day}T00:00:00+01:00`),
          lte: new Date(`${day}T23:59:59.999+01:00`),
        },
      }
    : {};

  // Hide INVALID codes everywhere — they're confirmed junk (wrong bookmaker,
  // promos, or expired), so users only ever see real, usable codes.
  const notInvalid = { status: { not: "INVALID" as const } };
  const [codes, totalCodes, sourceCount, lastRuns, aiSlips, activeCount, dateRows] =
    await Promise.all([
      prisma.humanCode.findMany({
        where: { ...codeWhere, ...notInvalid },
        orderBy: { foundAt: "desc" },
        take: 150,
        include: { source: true, score: true },
      }),
      prisma.humanCode.count({ where: notInvalid }),
      prisma.source.count({ where: { enabled: true } }),
      prisma.crawlRun.findMany({ orderBy: { startedAt: "desc" }, take: 8, include: { source: true } }),
      prisma.aiBetSlip.findMany({ orderBy: { totalOdds: "asc" } }),
      prisma.humanCode.count({ where: { status: "ACTIVE" } }),
      prisma.$queryRaw<{ d: string; n: number }[]>`
        SELECT to_char("foundAt" AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM human_codes WHERE status <> 'INVALID' GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
    ]);

  // Telegram data-source status: are we reading via the OFFICIAL API or the
  // public web-preview scrape? Surfaced on the dashboard so it's visible.
  const tgApiLive = telegramClientEnabled();
  const tgChannels = await prisma.source.count({ where: { enabled: true, type: "TELEGRAM" } });

  // Feature the latest ACTIVE code in the hero — never an INVALID/expired one.
  const latest = codes.find((c) => c.status === "ACTIVE") ?? codes[0];
  const nextMs = nextRunAt ? new Date(nextRunAt).getTime() : 0;
  const lastUpd = lastRunAt ? new Date(lastRunAt).toLocaleTimeString() : "—";
  const lastRunIso = lastRunAt ? new Date(lastRunAt).toISOString() : "";

  // ---- Hero (latest code) ----
  const latestLocked = latest ? !isPremium && new Date(latest.foundAt).getTime() > freshCut : false;
  const heroCard = latest
    ? `
    <div class="hero">
      <div class="hero-left">
        <span class="chip chip-live">🆕 Latest code</span>
        ${
          latestLocked
            ? `<div class="hero-code locked">🔒 PREMIUM</div>
               <div class="hero-meta"><span>This code is fresh — <b>upgrade to unlock instantly</b></span></div>`
            : `<div class="hero-code ccopy" title="Click to copy" onclick="cp(this,'${esc(latest.code)}')">${esc(latest.code)}</div>
               <div class="hero-meta">
                 <span class="pill status s-${esc(latest.status)}">${esc(latest.status)}</span>
                 <span><b>${esc(latest.totalOdds ?? "—")}</b> odds</span>
                 <span><b>${esc(latest.numberOfGames ?? "—")}</b> games</span>
                 <span>${esc(latest.league ?? "—")}</span>
               </div>`
        }
      </div>
      <div class="hero-right">
        ${
          latestLocked
            ? `<a class="btn" href="/upgrade">⭐ Upgrade</a>`
            : `<button class="btn" onclick="cp(this,'${esc(latest.code)}')">Copy code</button>
               <a class="btn ghost" href="https://www.sportybet.com/ng/?shareCode=${esc(latest.code)}" target="_blank" rel="noopener">Open ↗</a>`
        }
        <div class="hero-src">${isAdmin ? `${esc(latest.source?.name ?? "—")} · ` : ""}${new Date(latest.foundAt).toLocaleTimeString()}</div>
      </div>
    </div>`
    : "";

  // ---- Human codes table ----
  const rows = codes
    .map((c, i) => {
      const locked = !isPremium && new Date(c.foundAt).getTime() > freshCut;
      const codeCell = locked
        ? `<a class="lock" href="/upgrade" title="Fresh code — upgrade to unlock">🔒 Premium</a>`
        : `<span class="ccopy" title="Click to copy" onclick="cp(this,'${esc(c.code)}')">${esc(c.code)}</span>`;
      return `
      <tr class="frow${i === 0 ? " fresh" : ""}" data-f="${esc((c.code + " " + (c.league ?? "") + " " + (c.source?.name ?? "")).toLowerCase())}">
        <td class="code">${codeCell}${i === 0 && !locked ? ' <span class="tag new">NEW</span>' : ""}</td>
        <td><span class="tag">${esc(c.codeType)}</span></td>
        <td class="starcol">${c.score ? stars(c.score.stars) : ""}</td>
        <td class="num">${esc(c.totalOdds ?? "—")}</td>
        <td class="num">${esc(c.numberOfGames ?? "—")}</td>
        <td class="muted">${esc(c.league ?? "—")}</td>
        <td class="muted">${new Date(c.foundAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td class="muted">${c.expiresAt ? new Date(c.expiresAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
        ${isAdmin ? `<td class="muted">${esc(c.source?.name ?? "—")}</td>` : ""}
        <td><span class="pill status s-${esc(c.status)}">${esc(c.status)}</span></td>
      </tr>`;
    })
    .join("");

  const runRows = lastRuns
    .map(
      (r) =>
        `<li><span class="dot ${r.status === "SUCCESS" ? "ok" : r.status === "FAILED" ? "bad" : "warn"}"></span>
          <span class="muted">${new Date(r.startedAt).toLocaleTimeString()}</span>
          <span class="rname">${esc(r.source?.name ?? "?")}</span>
          <span class="muted">${r.itemsFound} items · ${r.itemsNew} new</span></li>`,
    )
    .join("");

  // ---- AI slip cards ----
  const vipId = aiSlips.reduce(
    (best, s) => (s.expectedValue > (best?.expectedValue ?? -Infinity) ? s : best),
    null as (typeof aiSlips)[number] | null,
  )?.id;
  const aiCards = aiSlips
    .map((s) => {
      const legs = (s.legs as any[]) ?? [];
      const conf = Math.round(s.confidence * 100);
      const isVip = s.id === vipId;
      const legRows = legs
        .map(
          (l) => `<tr>
            <td>${esc(l.home ?? "—")} <span class="muted">v</span> ${esc(l.away ?? "—")}</td>
            <td class="muted">${esc(l.market ?? "")}: <b>${esc(l.pick ?? "")}</b></td>
            <td class="muted kt">${l.kickoff ? new Date(l.kickoff).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
            <td class="num">${esc(l.odds ?? "—")}</td>
          </tr>`,
        )
        .join("");
      const slipText = legs
        .map((l) => `${l.home} v ${l.away} — ${l.market}: ${l.pick} @${l.odds}`)
        .join("\\n");
      const bookingBlock = !isPremium
        ? `<div class="booking locked-b">
            <div>
              <div class="booking-label">🎟️ Booking code</div>
              <div class="booking-code locked">🔒 ••••••</div>
            </div>
            <a class="btn sm" href="/upgrade">⭐ Unlock code</a>
          </div>`
        : s.bookingCode
          ? `<div class="booking">
            <div>
              <div class="booking-label">🎟️ Booking code</div>
              <div class="booking-code ccopy" title="Click to copy" onclick="cp(this,'${esc(s.bookingCode)}')">${esc(s.bookingCode)}</div>
            </div>
            <div class="booking-actions">
              <button class="btn sm" onclick="cp(this,'${esc(s.bookingCode)}')">Copy</button>
              <a class="btn ghost sm" href="https://www.sportybet.com/ng/?shareCode=${esc(s.bookingCode)}" target="_blank" rel="noopener">Open ↗</a>
            </div>
          </div>`
          : `<div class="booking manual">Auto-booking unavailable — copy the slip and enter manually.</div>`;
      return `
      <div class="slip${isVip ? " vip" : ""}" data-f="${esc(s.title.toLowerCase())}">
        ${isVip ? '<div class="ribbon">👑 VIP PICK</div>' : ""}
        <div class="slip-head">
          <span class="tag ${s.codeType === "SAFE" ? "green" : s.codeType === "HIGH_ODDS" ? "orange" : "indigo"}">${esc(s.codeType)}</span>
          <b class="slip-title">${esc(s.title)}</b>
          <button class="btn ghost sm" style="margin-left:auto" onclick="cp(this,'${esc(slipText)}')">Copy slip</button>
        </div>
        ${bookingBlock}
        <div class="metrics">
          <div><b>${esc(s.totalOdds)}</b><small>Total odds</small></div>
          <div><b>${conf}%</b><small>Confidence</small></div>
          <div><b class="${s.expectedValue >= 0 ? "pos" : "neg"}">${s.expectedValue >= 0 ? "+" : ""}${(s.expectedValue * 100).toFixed(1)}%</b><small>Exp. value</small></div>
          <div><b>${s.kellyStakePct}%</b><small>Kelly</small></div>
        </div>
        <div class="conf"><div class="conf-fill" style="width:${conf}%"></div></div>
        <table class="legs"><tbody>${legRows}</tbody></table>
        <div class="reason">🤖 ${esc(s.reasoning ?? "")}</div>
        <div class="gen muted small">Generated ${new Date(s.createdAt).toLocaleTimeString()} · refreshes every ${Math.round(intervalSec / 60)} min</div>
      </div>`;
    })
    .join("");

  // ---- Predictions, organised as a MATCH CALENDAR ----
  // Fixture predictions are grouped by their WAT kick-off day (Today, Tomorrow,
  // later) and sorted by kick-off time inside each day. Telegram analyst posts
  // (post time, not kick-off) live in their own rail at the end.
  const watDayOf = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) : "";
  const koTime = (iso?: string) =>
    // Date-only kickoffs (PredictZ/WinDrawWin give no time) get no time chip.
    iso && iso.length > 10
      ? new Date(iso).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Africa/Lagos",
        })
      : "";
  const tomorrowStr = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Africa/Lagos",
  });
  const dayTitle = (d: string) =>
    d === todayStr
      ? "Today"
      : d === tomorrowStr
        ? "Tomorrow"
        : new Date(`${d}T12:00:00`).toLocaleDateString("en", {
            weekday: "long",
            month: "short",
            day: "numeric",
          });

  const predCard = (p: (typeof preds)[number]) => {
    const isTg = p.source.startsWith("@");
    const brand =
      p.source === "forebet.com"
        ? "Forebet"
        : p.source === "api-football.com"
          ? "API-Football ⭐"
          : undefined;
    const time = koTime(p.kickoff);
    const kick = isTg
      ? p.kickoff
        ? new Date(p.kickoff).toLocaleString("en", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Africa/Lagos",
          })
        : "—"
      : time || "—";
    const matchup =
      p.home && p.away
        ? `${esc(p.home)} <span class="muted">v</span> ${esc(p.away)}`
        : esc(p.title ?? "Prediction");
    const badge = isTg ? p.source : (brand ?? p.league ?? "Football");
    const hasTip = !!p.tip;
    const hasOdds = !!p.odds;
    const linkLabel = isTg ? "View on Telegram ↗" : "Full analysis ↗";
    const metrics = hasOdds
      ? `<div><b>${esc(p.odds)}</b><small>Odds</small></div>
         <div><b>${esc(p.probability ?? "—")}</b><small>Probability</small></div>
         <div><b>${esc(kick)}</b><small>${isTg ? "Posted" : "Kick-off (WAT)"}</small></div>`
      : `<div><b>${esc(kick)}</b><small>${isTg ? "Posted" : "Kick-off (WAT)"}</small></div>
         <div><b>${esc(p.league ?? (isTg ? "Analyst tip" : "—"))}</b><small>${isTg ? "Source" : "Competition"}</small></div>`;
    const badgeColor = isTg ? "orange" : brand ? "green" : "indigo";
    // Every fixture card joins the slip builder; unmatched picks are skipped
    // at booking time and reported in the toast.
    const selKey = p.home && p.away ? `${p.home}|${p.away}`.toLowerCase() : "";
    const bookable = !!selKey;
    return `
    <div class="slip" data-f="${esc(`${p.home ?? ""} ${p.away ?? ""} ${p.title ?? ""} ${p.league ?? ""} ${p.tip ?? ""}`.toLowerCase())}">
      <div class="slip-head">
        <span class="tag ${badgeColor}">${esc(badge)}</span>
        <b class="slip-title">${matchup}</b>
        ${time && !isTg ? `<span class="ko-chip" title="Kick-off, West Africa Time">⏰ ${time}</span>` : ""}
      </div>
      ${
        hasTip
          ? `<div class="pred-tip">🎯 ${esc(p.tip ?? "—")}</div>
      <div class="metrics">${metrics}</div>`
          : `<div class="pred-preview">${esc(p.analysis ?? "Prediction preview")}…</div>
      <div class="metrics">${metrics}</div>`
      }
      <div class="slip-foot">
        ${p.url ? `<a class="btn ghost sm" href="${esc(p.url)}" target="_blank" rel="noopener">${linkLabel}</a>` : "<span></span>"}
        ${bookable ? `<label class="selbox" title="Add this match to your slip"><input type="checkbox" data-key="${esc(selKey)}" onchange="selTog(this)"/><span>➕ Add to slip</span></label>` : ""}
      </div>
    </div>`;
  };

  // Group fixtures by WAT day; analyst posts go to their own rail.
  const dayGroups = new Map<string, typeof preds>();
  const analystPosts: typeof preds = [];
  for (const p of preds) {
    const d = watDayOf(p.kickoff);
    if (!d || p.source.startsWith("@")) {
      analystPosts.push(p);
      continue;
    }
    if (!dayGroups.has(d)) dayGroups.set(d, []);
    dayGroups.get(d)!.push(p);
  }
  const sortedDays = [...dayGroups.keys()].sort();
  for (const d of sortedDays) {
    dayGroups
      .get(d)!
      .sort(
        (a, b) =>
          new Date(a.kickoff ?? 0).getTime() - new Date(b.kickoff ?? 0).getTime(),
      );
  }

  const dgHeader = (d: string, n: number) => {
    const dt = new Date(`${d}T12:00:00`);
    const dow = dt.toLocaleDateString("en", { weekday: "short" }).toUpperCase();
    const mon = dt.toLocaleDateString("en", { month: "short" });
    return `
    <header class="dg-head">
      <div class="dg-cal${d === todayStr ? " today" : ""}">
        <span class="dg-dow">${d === todayStr ? "TODAY" : dow}</span>
        <span class="dg-num">${d.slice(8, 10)}</span>
        <span class="dg-mon">${mon}</span>
      </div>
      <div class="dg-title">
        <b>${dayTitle(d)}</b>
        <span>${dt.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · kick-off times in WAT</span>
      </div>
      <span class="dg-count">${n} match${n === 1 ? "" : "es"}</span>
    </header>`;
  };

  const dayGroupsHtml = sortedDays
    .map((d) => {
      const grp = dayGroups.get(d)!;
      return `
      <section class="day-group" data-day="${d}">
        ${dgHeader(d, grp.length)}
        <div class="cards">${grp.map(predCard).join("")}</div>
      </section>`;
    })
    .join("");

  const analystHtml = analystPosts.length
    ? `
    <section class="day-group" data-day="analysis">
      <header class="dg-head">
        <div class="dg-cal analyst"><span class="dg-dow">LIVE</span><span class="dg-num">📣</span><span class="dg-mon">feed</span></div>
        <div class="dg-title"><b>Analyst posts</b><span>Latest written analysis from Telegram prediction channels</span></div>
        <span class="dg-count">${analystPosts.length} post${analystPosts.length === 1 ? "" : "s"}</span>
      </header>
      <div class="cards">${analystPosts.map(predCard).join("")}</div>
    </section>`
    : "";

  // Calendar strip: jump/filter between match days.
  const pdChip = (d: string, top: string, mid: string, mon: string, n: number, on = false) => `
    <button class="pd-chip${on ? " on" : ""}" data-day="${d}" onclick="predDay('${d}',this)">
      <span class="pdc-top">${top}</span>
      <span class="pdc-day">${mid}</span>
      <span class="pdc-mon">${mon}</span>
      <span class="pdc-count">${n}</span>
    </button>`;
  const predDateBar =
    sortedDays.length || analystPosts.length
      ? `
    <div class="card pred-datebar">
      <div class="date-nav-head">📅 Match calendar — browse predictions by day</div>
      <div class="date-strip">
        ${pdChip("all", "ALL", "∑", "days", preds.length, true)}
        ${sortedDays
          .map((d) => {
            const dt = new Date(`${d}T12:00:00`);
            const top =
              d === todayStr
                ? "TODAY"
                : d === tomorrowStr
                  ? "TMRW"
                  : dt.toLocaleDateString("en", { weekday: "short" }).toUpperCase();
            return pdChip(
              d,
              top,
              d.slice(8, 10),
              dt.toLocaleDateString("en", { month: "short" }),
              dayGroups.get(d)!.length,
            );
          })
          .join("")}
        ${analystPosts.length ? pdChip("analysis", "LIVE", "📣", "analysts", analystPosts.length) : ""}
      </div>
    </div>`
      : "";

  const nav = (m: Mode, icon: string, label: string, active: boolean) =>
    `<a class="nav-item${active ? " on" : ""}" href="/?mode=${m}"><span class="ni">${icon}</span>${label}</a>`;

  // ---- Date selector (browse codes by the day they were found) ----
  const dayLabel = (d: string) =>
    d === todayStr
      ? "Today"
      : new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  // Always offer a "Today" card even before any codes come in today.
  const dates = dateRows.some((r) => r.d === todayStr)
    ? dateRows
    : [{ d: todayStr, n: 0 }, ...dateRows];
  const dayCard = (d: string, n: number) => {
    const dt = new Date(`${d}T12:00:00`);
    const isToday = d === todayStr;
    const top = isToday ? "TODAY" : dt.toLocaleDateString("en", { weekday: "short" }).toUpperCase();
    const mon = dt.toLocaleDateString("en", { month: "short" });
    return `<a class="day-card${day === d ? " on" : ""}" href="/?mode=human&date=${d}">
      <span class="dc-top">${top}</span>
      <span class="dc-day">${d.slice(8, 10)}</span>
      <span class="dc-mon">${mon}</span>
      <span class="dc-count">${n}</span>
    </a>`;
  };
  const dateBar = `
    <div class="date-nav">
      <div class="date-nav-head">Browse codes by date</div>
      <div class="date-strip">
        <a class="day-card all${showAll ? " on" : ""}" href="/?mode=human&date=all">
          <span class="dc-top">ALL</span><span class="dc-day">∑</span>
          <span class="dc-mon">codes</span><span class="dc-count">${totalCodes}</span>
        </a>
        ${dates.map((r) => dayCard(r.d, r.n)).join("")}
        <label class="day-card pick" title="Pick any date">
          <span class="dc-top">PICK</span><span class="dc-day">📅</span><span class="dc-mon">a date</span>
          <input type="date" class="dc-input" value="${dateOk ? day : ""}" max="${todayStr}"
            onchange="if(this.value)location.href='/?mode=human&date='+this.value"/>
        </label>
      </div>
    </div>`;

  // ---- KPI cards (mode-aware) ----
  const avgConf = expertPicks.length
    ? Math.round((expertPicks.reduce((a, p) => a + p.confidence, 0) / expertPicks.length) * 100)
    : 0;
  const savedByCount = new Set(savedCodes.map((c) => c.generatorName)).size;
  const savedToday = savedCodes.filter(
    (c) =>
      new Date(c.createdAt).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) ===
      new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }),
  ).length;
  const avgEv = valueResult.picks.length
    ? Math.round((valueResult.picks.reduce((a, p) => a + p.ev, 0) / valueResult.picks.length) * 100)
    : 0;
  const bestEv = valueResult.picks.length
    ? Math.round(Math.max(...valueResult.picks.map((p) => p.ev)) * 100)
    : 0;
  const bestCombo = combos.length ? Math.max(...combos.map((c) => c.combinedOdds)) : 0;
  const kpis =
    mode === "analysis"
      ? `
      ${kpi("📊", analysis.matches.length, "matches modelled", "indigo")}
      ${kpi("🥅", analysis.matches.length ? (analysis.matches.reduce((a, m) => a + m.xgHome + m.xgAway, 0) / analysis.matches.length).toFixed(2) : "—", "avg total xG", "green")}
      ${kpi("🎯", analysis.matches.filter((m) => m.confidence >= 0.6).length, "strong verdicts (60%+)", "orange")}
      ${kpi("🔢", "Poisson", "model", "blue")}`
      : mode === "combo"
      ? `
      ${kpi("🎰", combos.length, "combos ready", "indigo")}
      ${kpi("💎", combos.filter((c) => c.kind === "value").length, "value combos", "green")}
      ${kpi("🚀", bestCombo ? bestCombo.toFixed(1) : "—", "biggest odds", "orange")}
      ${kpi("⏱️", "10m", "auto-rebuild", "blue")}`
      : mode === "value"
      ? `
      ${kpi("💎", valueResult.picks.length, "value picks", "indigo")}
      ${kpi("📈", valueResult.picks.length ? `+${avgEv}%` : "—", "avg expected value", "green")}
      ${kpi("🔝", valueResult.picks.length ? `+${bestEv}%` : "—", "best EV", "orange")}
      ${kpi("🔍", valueResult.scanned, "fixtures analysed", "blue")}`
      : mode === "saved"
      ? `
      ${kpi("💾", savedCodes.length, "codes saved", "indigo")}
      ${kpi("📅", savedToday, "saved today", "green")}
      ${kpi("👥", savedByCount, "contributors", "orange")}
      ${kpi("🎟️", savedCodes.reduce((a, c) => a + c.games, 0), "games booked", "blue")}`
      : mode === "expert"
      ? `
      ${kpi("🎯", expertPicks.length, "expert picks", "indigo")}
      ${kpi("📊", avgConf ? `${avgConf}%` : "—", "avg confidence", "green")}
      ${kpi("🗓️", `${expertOpts.days}d`, "search window", "orange")}
      ${kpi("🔗", new Set(expertPicks.map((p) => p.source)).size, "sources scanned", "blue")}`
      : mode === "pred"
      ? `
      ${kpi("📈", preds.length, "predictions", "indigo")}
      ${kpi("🎯", preds.filter((p) => p.odds).length, "with tip + odds", "orange")}
      ${kpi("🔗", new Set(preds.map((p) => p.source)).size, "sources", "blue")}
      ${kpi("🤖", aiSlips.length, "AI slips", "green")}`
      : mode === "ai"
        ? `
      ${kpi("🤖", aiSlips.length, "AI slips ready", "indigo")}
      ${kpi("🎟️", aiSlips.filter((s) => s.bookingCode).length, "with booking codes", "orange")}
      ${kpi("✅", activeCount, "active codes analysed", "green")}
      ${kpi("📡", sourceCount, "live sources", "blue")}`
        : `
      ${kpi("✅", activeCount, "active codes", "green")}
      ${kpi("🗂️", totalCodes, "total discovered", "indigo")}
      ${kpi("📡", sourceCount, "active sources", "blue")}
      ${kpi("🤖", aiSlips.length, "AI slips", "orange")}`;

  const slipBar = `
    <div id="slipbar" class="slipbar" hidden>
      <span class="sb-info">🎟️ <b id="slipcount">0</b> selected</span>
      <input id="genname" class="sb-name" placeholder="Your name" maxlength="60" title="Saved with the generated code"/>
      <button class="btn" id="genbtn" onclick="genCode(this)">⚡ Generate SportyBet Code</button>
      <span id="slipres"></span>
      <button class="btn ghost sm" onclick="clearSel()">Clear</button>
    </div>`;

  // ---- Expert Picks: confidence-ranked selections + controls ----
  const confClass = (c: number) => (c >= 0.7 ? "hi" : c >= 0.6 ? "mid" : "lo");
  const expertCards = expertPicks
    .map((p, i) => {
      const kick = p.kickoff
        ? new Date(p.kickoff).toLocaleString("en", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Africa/Lagos",
          })
        : "TBD";
      const pct = Math.round(p.confidence * 100);
      return `
      <div class="xcard" data-key="${esc(p.key)}">
        <div class="xrank">#${i + 1}</div>
        <div class="xmain">
          <div class="xmatch">${esc(p.home)} <span class="muted">v</span> ${esc(p.away)}</div>
          <div class="xmeta">${esc(p.league ?? "Football")} · ⏰ ${esc(kick)} WAT · ${p.market ? `<b>${esc(p.market)}</b> · ` : ""}<span class="muted">${esc(p.source)}</span></div>
          <div class="xpick">🎯 ${esc(p.pick)}${p.odds ? ` <span class="xodds">@ ${esc(p.odds)}</span>` : ""}</div>
          <div class="xwhy">${p.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>
          ${p.signals && p.signals.length ? `<div class="xsignals">🔎 ${p.signals.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="xconf ${confClass(p.confidence)}">
          <div class="xconf-n">${pct}%</div><div class="xconf-l">confidence</div>
          <label class="xsel"><input type="checkbox" checked data-key="${esc(p.key)}" onchange="selTog(this)"/> in slip</label>
        </div>
      </div>`;
    })
    .join("");

  // ---- Track record card: honest, settled hit-rate by confidence band ----
  const pct1 = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
  const recordCard = (() => {
    if (!expertRecord) return "";
    const r = expertRecord;
    if (r.totalSettled === 0) {
      return `<div class="xrecord card">
        <div class="xrec-head"><b>📊 Track record</b><span class="muted small">building — ${r.pending} pick${r.pending === 1 ? "" : "s"} awaiting results</span></div>
        <div class="muted small">Every recommendation is logged and checked against the real final score after kickoff. Verified win-rate by confidence band appears here once matches finish — an honest, auditable record, not a marketing number.</div>
      </div>`;
    }
    const bandBars = r.bands
      .filter((b) => b.total > 0)
      .map((b) => {
        const hit = b.hitRate ?? 0;
        return `<div class="xband">
          <span class="xband-l">${b.label}</span>
          <div class="xband-track"><div class="xband-fill" style="width:${Math.round(hit * 100)}%"></div></div>
          <span class="xband-v">${pct1(b.hitRate)} <small>(${b.won}/${b.total})</small></span>
        </div>`;
      })
      .join("");
    const recentRows = r.recent
      .map((x) => {
        const icon = x.outcome === "WON" ? "✅" : x.outcome === "LOST" ? "❌" : "➖";
        return `<div class="xrec-row">
          <span>${icon} ${esc(x.home)} v ${esc(x.away)}</span>
          <span class="muted">${esc(x.pickLabel)}${x.finalScore ? ` · ${esc(x.finalScore)}` : ""} · ${Math.round(x.confidence * 100)}%</span>
        </div>`;
      })
      .join("");
    return `<div class="xrecord card">
      <div class="xrec-head"><b>📊 Track record</b><span class="muted small">verified against real final scores · updates automatically</span></div>
      <div class="xrec-top">
        <div class="xrec-big"><b>${pct1(r.hitRate)}</b><small>overall hit rate</small></div>
        <div class="xrec-stat"><b>${r.won}</b><small>won</small></div>
        <div class="xrec-stat"><b>${r.lost}</b><small>lost</small></div>
        <div class="xrec-stat"><b>${r.totalSettled}</b><small>settled</small></div>
        <div class="xrec-stat"><b>${r.pending}</b><small>pending</small></div>
      </div>
      ${bandBars ? `<div class="xbands"><div class="muted small" style="margin-bottom:6px">Win rate by confidence band (does higher confidence really win more?)</div>${bandBars}</div>` : ""}
      ${recentRows ? `<div class="xrecent"><div class="muted small" style="margin:10px 0 4px">Recently settled</div>${recentRows}</div>` : ""}
    </div>`;
  })();

  // ---- ROI / profit card: does flat-staking actually make money? ----
  const roiCard = (() => {
    if (!expertRoi || expertRoi.settled === 0) return "";
    const r = expertRoi;
    const units = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}u`;
    const roiPct = r.roi === null ? "—" : `${r.roi >= 0 ? "+" : ""}${Math.round(r.roi * 100)}%`;
    const good = (r.profit ?? 0) >= 0;

    // Profit sparkline: cumulative units over settled picks.
    const curve = r.curve;
    const w = 320;
    const h = 64;
    let spark = "";
    if (curve.length >= 2) {
      const min = Math.min(0, ...curve);
      const max = Math.max(0, ...curve);
      const range = max - min || 1;
      const x = (i: number) => (i / (curve.length - 1)) * w;
      const y = (v: number) => h - ((v - min) / range) * h;
      const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const zeroY = y(0).toFixed(1);
      const col = good ? "var(--green)" : "var(--bad)";
      spark = `<svg class="roi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>
        <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>
      </svg>`;
    }

    const bandRows = r.bands
      .filter((b) => b.settled > 0)
      .map(
        (b) =>
          `<div class="roi-row"><span class="roi-l">${b.label}</span><span class="roi-n">${b.settled} bets</span><span class="roi-p ${b.profit >= 0 ? "up" : "down"}">${units(b.profit)}</span><span class="roi-r ${(b.roi ?? 0) >= 0 ? "up" : "down"}">${b.roi === null ? "—" : `${b.roi >= 0 ? "+" : ""}${Math.round(b.roi * 100)}%`}</span></div>`,
      )
      .join("");
    const mktRows = r.markets
      .filter((b) => b.settled > 0)
      .map(
        (b) =>
          `<div class="roi-row"><span class="roi-l">${esc(b.label)}</span><span class="roi-n">${b.settled} bets</span><span class="roi-p ${b.profit >= 0 ? "up" : "down"}">${units(b.profit)}</span><span class="roi-r ${(b.roi ?? 0) >= 0 ? "up" : "down"}">${b.roi === null ? "—" : `${b.roi >= 0 ? "+" : ""}${Math.round(b.roi * 100)}%`}</span></div>`,
      )
      .join("");

    return `<div class="xrecord card">
      <div class="xrec-head"><b>💰 Profit & ROI</b><span class="muted small">flat 1-unit stake per pick · the honest "did it make money?" test</span></div>
      <div class="roi-top">
        <div class="roi-big ${good ? "up" : "down"}"><b>${units(r.profit)}</b><small>profit (flat stakes)</small></div>
        <div class="roi-stat ${good ? "up" : "down"}"><b>${roiPct}</b><small>ROI</small></div>
        <div class="roi-stat"><b>${r.settled}</b><small>bets settled</small></div>
        <div class="roi-stat"><b>${r.avgOdds ?? "—"}</b><small>avg odds</small></div>
        <div class="roi-spark-wrap">${spark}</div>
      </div>
      <div class="roi-note muted small">${
        good
          ? `📈 Flat-staking every pick would be <b>up ${units(r.profit)}</b> (${roiPct} ROI) over ${r.settled} settled bets.`
          : `📉 Honestly: flat-staking every pick would be <b>down ${units(r.profit)}</b> (${roiPct} ROI) over ${r.settled} bets. High hit-rate at short odds doesn't guarantee profit — this is why ROI matters more than win-rate.`
      } Still a small sample; give it time to grow.</div>
      ${bandRows ? `<div class="roi-block"><div class="muted small" style="margin:8px 0 4px">Profit by confidence band</div>${bandRows}</div>` : ""}
      ${mktRows ? `<div class="roi-block"><div class="muted small" style="margin:8px 0 4px">Profit by market</div>${mktRows}</div>` : ""}
    </div>`;
  })();

  const expertBody = `
    ${recordCard}
    ${roiCard}
    <div class="xhead card">
      <div>
        <h3 style="margin:0">🎯 Expert Picks — daily recommendations</h3>
        <div class="muted small">Scans every bookable fixture across your window over multiple markets — 1X2, Double Chance, Draw No Bet, Over/Under, BTTS, Team Goals — ranks by de-vigged probability + source agreement, and adds an extra read of each match's other markets (🔎 goals lean, BTTS, safest cover). Estimates ranked by confidence — <b>not guarantees</b>. Corners/cards aren't offered by SportyBet's feed, so they're honestly not shown.</div>
      </div>
      <form class="xform" method="get" action="/">
        <input type="hidden" name="mode" value="expert"/>
        <label>Games
          <select name="n">${[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70]
            .map((n) => `<option value="${n}"${n === expertOpts.count ? " selected" : ""}>${n}</option>`)
            .join("")}</select>
        </label>
        <label>Within
          <select name="days">${[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30]
            .map(
              (d) =>
                `<option value="${d}"${d === expertOpts.days ? " selected" : ""}>${d === 30 ? "1 month" : d === 1 ? "1 day" : `${d} days`}</option>`,
            )
            .join("")}</select>
        </label>
        <label>Game type
          <select name="type" id="xtype">${(
            [
              ["safe", "🛡️ Safe picks (daily mix)"],
              ["result", "Match Result (1X2)"],
              ["double", "Double Chance"],
              ["dnb", "Draw No Bet"],
              ["goals", "Over/Under Goals"],
              ["btts", "Both Teams To Score"],
              ["teamgoals", "Team Goals"],
              ["both", "All markets"],
            ] as [GameType, string][]
          )
            .map(([v, label]) => `<option value="${v}"${v === expertOpts.gameType ? " selected" : ""}>${label}</option>`)
            .join("")}</select>
        </label>
        <label>Min. confidence
          <select name="minconf">${[0, 50, 60, 70, 80, 90]
            .map(
              (v) =>
                `<option value="${v}"${v === expertOpts.minConfidence ? " selected" : ""}>${v === 0 ? "Any" : `${v}%+`}</option>`,
            )
            .join("")}</select>
        </label>
        <button class="btn" type="submit">Get picks</button>
      </form>
    </div>
    ${
      expertResult.poolSize > 0 && expertResult.poolSize < expertResult.requested
        ? `<div class="xshort card">ℹ️ Showing ${expertResult.poolSize} of the ${expertResult.requested} you asked for — that's every fixture in this window we could both read AND confirm bookable on SportyBet right now. More fixtures load in as kickoffs approach; try widening the day range or checking back shortly.</div>`
        : ""
    }
    <div class="xlist">${
      expertCards ||
      '<div class="card empty">No bookable fixtures match your filters — try widening the days (up to a month), loosening the minimum confidence, or including more game types.</div>'
    }</div>${slipBar}`;

  // ---- Value Picks: higher-odds opportunities with a model edge ----
  const valueCards = valueResult.picks
    .map((p, i) => {
      const kick = p.kickoff
        ? new Date(p.kickoff).toLocaleString("en", {
            weekday: "short",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Africa/Lagos",
          })
        : "TBD";
      const edgePct = Math.round(p.edge * 100);
      const evPct = Math.round(p.ev * 100);
      return `
      <div class="xcard vcard" data-key="${esc(p.key)}">
        <div class="xrank">#${i + 1}</div>
        <div class="xmain">
          <div class="xmatch">${esc(p.home)} <span class="muted">v</span> ${esc(p.away)}</div>
          <div class="xmeta">${esc(p.league ?? "Football")} · ⏰ ${esc(kick)} WAT · <span class="muted">${esc(p.source)}</span></div>
          <div class="xpick">💎 ${esc(p.pick)}${p.odds ? ` <span class="xodds">@ ${esc(p.odds)}</span>` : ""}</div>
          <div class="xwhy">${p.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>
          ${p.signals && p.signals.length ? `<div class="xsignals">🔎 ${p.signals.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : ""}
          ${p.url ? `<a class="xanalysis" href="${esc(p.url)}" target="_blank" rel="noopener">📊 Full analysis ↗</a>` : ""}
        </div>
        <div class="xconf vconf">
          <div class="xconf-n">+${evPct}%</div><div class="xconf-l">expected value</div>
          <div class="vedge">+${edgePct}pt edge</div>
          <label class="xsel"><input type="checkbox" checked data-key="${esc(p.key)}" onchange="selTog(this)"/> in slip</label>
        </div>
      </div>`;
    })
    .join("");
  // Auto-recommended: the few strongest overlays by EV, surfaced
  // automatically at the top with an analysis link each — no config needed.
  const autoRec = [...valueResult.picks].sort((a, b) => b.ev - a.ev).slice(0, 3);
  const autoRecHtml = autoRec.length
    ? `<div class="vauto card">
        <div class="vauto-head">⭐ Auto-recommended value <span class="muted small">— our top ${autoRec.length} overlay${autoRec.length === 1 ? "" : "s"} right now, refreshed automatically</span></div>
        <div class="vauto-list">${autoRec
          .map((p) => {
            const kick = p.kickoff
              ? new Date(p.kickoff).toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })
              : "TBD";
            return `<div class="vauto-item">
              <div class="vauto-main">
                <b>${esc(p.home)} v ${esc(p.away)}</b> — 💎 ${esc(p.pick)} <span class="xodds">@ ${esc(p.odds ?? "")}</span>
                <div class="muted small">${esc(p.league ?? "Football")} · ⏰ ${esc(kick)} WAT · +${Math.round(p.ev * 100)}% EV · +${Math.round(p.edge * 100)}pt edge</div>
                <div class="vauto-why">${esc(p.reasons[0] ?? "")}${p.reasons[1] ? " · " + esc(p.reasons[1]) : ""}</div>
              </div>
              <div class="vauto-side">
                ${p.url ? `<a class="btn ghost sm" href="${esc(p.url)}" target="_blank" rel="noopener">📊 Analysis ↗</a>` : ""}
                <label class="xsel"><input type="checkbox" data-key="${esc(p.key)}" onchange="selTog(this)"/> add</label>
              </div>
            </div>`;
          })
          .join("")}</div>
      </div>`
    : "";

  const valueBody = `
    <div class="xhead card">
      <div>
        <h3 style="margin:0">💎 Value Picks — daily opportunities</h3>
        <div class="muted small">Scans upcoming fixtures for <b>overlays</b>: where an independent model (Forebet / API-Football) rates an outcome MORE likely than SportyBet's odds imply. Ranked by expected value (EV). Higher odds, higher risk AND reward — value means good long-term EV, <b>not</b> that any single pick wins. Only fixtures a model actually covers can be assessed, so these are deliberately fewer and choosier.</div>
      </div>
      <form class="xform" method="get" action="/">
        <input type="hidden" name="mode" value="value"/>
        <label>Games
          <select name="n">${[1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 50, 70]
            .map((n) => `<option value="${n}"${n === expertOpts.count ? " selected" : ""}>${n}</option>`)
            .join("")}</select>
        </label>
        <label>Within
          <select name="days">${[1, 2, 3, 5, 7, 14, 30]
            .map(
              (d) =>
                `<option value="${d}"${d === expertOpts.days ? " selected" : ""}>${d === 30 ? "1 month" : d === 1 ? "1 day" : `${d} days`}</option>`,
            )
            .join("")}</select>
        </label>
        <button class="btn" type="submit">Find value</button>
      </form>
    </div>
    ${autoRecHtml}
    <div class="xlist">${
      valueCards ||
      `<div class="card empty">No value overlays right now across ${valueResult.scanned} model-covered fixture${valueResult.scanned === 1 ? "" : "s"} in this window. Value spots are rare by nature — they only appear when a model disagrees with SportyBet's price. Widen the days, or check back as more fixtures get model coverage (busiest mid-day WAT). ${valueResult.scanned === 0 ? "(API-Football's free daily quota may be spent — it resets at midnight UTC and adds coverage.)" : ""}</div>`
    }</div>${slipBar}`;

  // ---- Saved Codes ledger: every generated code + who made it, when ----
  const savedRows = savedCodes
    .map((c) => {
      const dt = new Date(c.createdAt);
      const day = dt.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Africa/Lagos",
      });
      const time = dt.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Lagos",
      });
      const legs = Array.isArray(c.legs) ? (c.legs as any[]) : [];
      const matchList = legs
        .slice(0, 6)
        .map((l) => `${esc(l.home ?? "")} v ${esc(l.away ?? "")} — ${esc(l.pick ?? "")}`)
        .join("<br/>");
      const more = legs.length > 6 ? `<div class="muted small">+${legs.length - 6} more…</div>` : "";
      return `
      <div class="sc-row">
        <div class="sc-when">
          <div class="sc-day">${esc(day)}</div>
          <div class="sc-time">⏰ ${esc(time)} WAT</div>
          <div class="sc-by">👤 ${esc(c.generatorName)}</div>
          <span class="tag ${c.origin === "expert" ? "green" : "indigo"}">${c.origin === "expert" ? "Expert" : "Predictions"}</span>
        </div>
        <div class="sc-mid">
          <div class="sc-matches">${matchList || '<span class="muted">—</span>'}</div>
          ${more}
        </div>
        <div class="sc-right">
          <span class="slipcode ccopy" title="Click to copy" onclick="cp(this,'${esc(c.code)}')">${esc(c.code)}</span>
          <div class="sc-meta">${c.games} games · ${esc(String(c.totalOdds))} odds</div>
          <a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.sportybet.com/ng/?shareCode=${esc(c.code)}">Open ↗</a>
        </div>
      </div>`;
    })
    .join("");
  const savedBody = `
    <div class="sc-head card">
      <div>
        <h3 style="margin:0">💾 Saved Codes</h3>
        <div class="muted small">Every booking code generated in the app is saved here automatically — stamped with the day, time (WAT) and the name of whoever generated it.</div>
      </div>
      <div class="sc-count"><b>${savedCodes.length}</b><small>saved</small></div>
    </div>
    <div class="sc-list">${
      savedRows ||
      '<div class="card empty">No codes saved yet. Generate one from Expert Picks or the Predictions tab — enter your name when prompted, and it will appear here with the date and time.</div>'
    }</div>`;

  // ---- Value Combos: ready-made accumulators to book in one click ----
  const kindClass = (k: string) => (k === "value" ? "vk" : k === "big" ? "bk" : k === "boost" ? "bo" : "sk");
  const comboCards = combos
    .map((c) => {
      const legRows = c.legs
        .map((l) => {
          const kick = l.kickoff
            ? new Date(l.kickoff).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" })
            : "TBD";
          return `<div class="cmb-leg"><span class="cmb-m">${esc(l.home)} v ${esc(l.away)}</span><span class="cmb-p">${esc(l.pick)} <b>@${l.odds.toFixed(2)}</b></span><span class="cmb-k muted">${esc(kick)}</span></div>`;
        })
        .join("");
      const keysAttr = esc(JSON.stringify(c.legs.map((l) => l.key)));
      const evLine =
        c.totalEv !== null
          ? ` · <span class="up">+${Math.round(c.totalEv * 100)}% combined EV</span>`
          : c.winProb !== null && c.winProb !== undefined
            ? ` · <b>${Math.round(c.winProb * 100)}%</b> combined win chance`
            : c.avgConfidence !== null
              ? ` · ${Math.round(c.avgConfidence * 100)}% avg confidence`
              : "";
      return `
      <div class="cmb-card ${kindClass(c.kind)}">
        <div class="cmb-head">
          <div><span class="cmb-title">${c.emoji} ${esc(c.title)}</span><div class="muted small">${esc(c.note)}${evLine}</div></div>
          <div class="cmb-odds"><b>${c.combinedOdds.toFixed(2)}</b><small>${c.legs.length} legs · total odds</small></div>
        </div>
        <div class="cmb-legs">${legRows}</div>
        <div class="cmb-foot">
          <button class="btn" data-keys="${keysAttr}" onclick="bookCombo(this)">⚡ Generate this combo code</button>
          <span class="cmb-res"></span>
        </div>
      </div>`;
    })
    .join("");
  const comboBody = `
    <div class="xhead card">
      <div>
        <h3 style="margin:0">🎰 Value Combos — ready-made accumulators</h3>
        <div class="muted small">Auto-assembled every ~10 min from the current Value and Expert picks into ready combos across odds tiers — pick one and book it in a single click. 🏦 bankers combine short-priced high-hit-rate picks; 💎 value combos combine model-edge overlays; 🔥 Odds Boosters chase big payouts built mostly from <b>Double Chance</b> (covers two of three outcomes, ~75-90% per leg) — the safest way to stack big odds — each showing its honest combined win chance. On large boosters the shown odds are an estimate; the exact odds are locked when you generate the code (odds move). All football. Estimates, not guarantees — every leg must land.</div>
      </div>
    </div>
    <div class="cmb-list">${
      comboCards ||
      '<div class="card empty">No combos available right now — not enough qualifying picks in the current window. They rebuild automatically as fixtures and model coverage come in (busiest mid-day WAT).</div>'
    }</div>`;

  // ---- AI Analysis: Poisson model calibrated to live odds ----
  const bar = (label: string, pct: number, cls: string) =>
    `<div class="an-bar"><span class="an-bl">${label}</span><div class="an-bt"><div class="an-bf ${cls}" style="width:${Math.round(pct * 100)}%"></div></div><span class="an-bv">${Math.round(pct * 100)}%</span></div>`;
  const analysisCards = analysis.matches
    .map((m) => {
      const kick = new Date(m.kickoff).toLocaleString("en", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Lagos",
      });
      const scores = m.topScores
        .slice(0, 5)
        .map(
          (s) =>
            `<div class="an-score"><b>${esc(s.score)}</b><span>${Math.round(s.prob * 100)}%</span></div>`,
        )
        .join("");
      return `
      <div class="an-card">
        <div class="an-head">
          <div>
            <div class="an-match">${esc(m.home)} <span class="muted">v</span> ${esc(m.away)}</div>
            <div class="muted small">${esc(m.league ?? "Football")} · ⏰ ${esc(kick)} WAT</div>
          </div>
          <div class="an-xg" title="Model expected goals">
            <b>${m.xgHome.toFixed(2)} – ${m.xgAway.toFixed(2)}</b><small>expected goals (xG-model)</small>
          </div>
        </div>
        <div class="an-grid">
          <div class="an-col">
            <div class="an-lbl">Match result</div>
            ${bar("1 " + esc(shortName(m.home)), m.pHome, "h")}
            ${bar("X Draw", m.pDraw, "d")}
            ${bar("2 " + esc(shortName(m.away)), m.pAway, "a")}
            <div class="an-lbl" style="margin-top:8px">Goals</div>
            ${bar("Over 2.5", m.over25, "g")}
            ${bar("Both score", m.btts, "g")}
          </div>
          <div class="an-col">
            <div class="an-lbl">Most likely scores</div>
            <div class="an-scores">${scores}</div>
            <div class="an-verdict">🧮 Model verdict: <b>${esc(m.verdict)}</b> · likeliest <b>${esc(m.likeliest)}</b> · ${Math.round(m.confidence * 100)}% confidence</div>
            <div class="an-lbl">Pick a market to add (one per match)</div>
            <div class="an-opts">${m.options
              .map(
                (o) =>
                  `<label class="an-opt" title="${esc(o.market)} · model ${Math.round(o.prob * 100)}%"><input type="checkbox" data-key="${esc(o.key)}" data-match="${esc(m.home + "|" + m.away)}" onchange="anTog(this)"/><span class="an-opt-l">${esc(o.label)}</span><span class="an-opt-o">${o.odds ? "@" + esc(o.odds) : ""}</span><span class="an-opt-p">${Math.round(o.prob * 100)}%</span></label>`,
              )
              .join("")}</div>
          </div>
        </div>
      </div>`;
    })
    .join("");
  const analysisBody = `
    <div class="xhead card">
      <div>
        <h3 style="margin:0">📊 AI Match Analysis — statistical model</h3>
        <div class="muted small">A <b>Poisson goals model</b> calibrated to live SportyBet prices: it solves each team's expected goals from the market, then computes the full correct-score matrix — giving match probabilities, correct-score probabilities, BTTS and over/under, the honest data-driven way. <b>Not</b> shot-based Opta xG (that needs event data we don't have); this is the market-calibrated model real prediction sites use. Estimates, not guarantees.</div>
      </div>
      <form class="xform" method="get" action="/">
        <input type="hidden" name="mode" value="analysis"/>
        <label>Matches
          <select name="n">${[6, 8, 10, 12, 15, 20, 30, 40, 50, 70]
            .map((n) => `<option value="${n}"${n === expertOpts.count ? " selected" : ""}>${n}</option>`)
            .join("")}</select>
        </label>
        <label>Within
          <select name="days">${[1, 2, 3, 5, 7, 14, 21, 30]
            .map((d) => `<option value="${d}"${d === expertOpts.days ? " selected" : ""}>${d === 30 ? "1 month" : d === 1 ? "1 day" : d + " days"}</option>`)
            .join("")}</select>
        </label>
        <button class="btn" type="submit">Analyse</button>
      </form>
    </div>
    <div class="an-list">${
      analysisCards ||
      '<div class="card empty">No fixtures with enough live prices to model right now — try a wider window, or check back as odds populate (busiest mid-day WAT).</div>'
    }</div>${slipBar}`;

  const body =
    mode === "analysis"
      ? analysisBody
      : mode === "combo"
      ? comboBody
      : mode === "saved"
      ? savedBody
      : mode === "value"
      ? valueBody
      : mode === "expert"
      ? expertBody
      : mode === "pred"
      ? `<div class="pred-hint card">✨ <b>Build your own code:</b> tick <i>“➕ Add to slip”</i> on any predictions below (pick 1 to 50), then hit <b>Generate SportyBet Code</b> — you get a real booking code to copy, just like the human ones. Matches SportyBet doesn't offer are skipped automatically.</div>
        ${predDateBar}
        ${dayGroupsHtml || analystHtml ? dayGroupsHtml + analystHtml : '<div class="card empty">No predictions available right now — the source may be updating. Check back shortly.</div>'}${slipBar}`
      : mode === "ai"
        ? `<div class="cards">${aiCards || '<div class="card empty">No AI slips right now — not enough upcoming matches (common late at night). Fresh slips generate automatically as new fixtures and codes come in.</div>'}</div>`
        : `<div class="split${isAdmin ? "" : " full"}">
          <div class="col-main">
            ${heroCard}
            <div class="card">
              <div class="card-head">
                <h3>${showAll ? "All discovered codes" : `Codes found ${dayLabel(day)}`}</h3>
                <span class="muted">${codes.length} shown</span>
              </div>
              ${dateBar}
              <div class="table-wrap">
                <table class="grid-table">
                  <thead><tr>
                    <th>Code</th><th>Type</th><th>Score</th><th>Odds</th><th>Games</th>
                    <th>League</th><th>Found</th><th>Expires</th>${isAdmin ? "<th>Source</th>" : ""}<th>Status</th>
                  </tr></thead>
                  <tbody id="rows">${rows || `<tr><td colspan="${isAdmin ? 10 : 9}" class="muted" style="text-align:center;padding:24px">No codes for ${showAll ? "any date yet" : dayLabel(day) + " yet"} — new codes appear as channels post them. Try “ALL” or an earlier date above.</td></tr>`}</tbody>
                </table>
              </div>
            </div>
          </div>
          ${
            isAdmin
              ? `<div class="col-side">
            <div class="card">
              <div class="card-head"><h3>Data sources</h3></div>
              <div class="src-status">
                <span class="src-pill ${tgApiLive ? "on" : "off"}">
                  ${tgApiLive ? "⚡ Telegram API — LIVE" : "🌐 Telegram — web preview"}
                </span>
                <div class="muted small">${
                  tgApiLive
                    ? `Reading ${tgChannels} channel${tgChannels === 1 ? "" : "s"} in real time via Telegram's official API (MTProto).`
                    : `Scraping public previews of ${tgChannels} channel${tgChannels === 1 ? "" : "s"}. Add TELEGRAM_* keys for real-time API.`
                }</div>
              </div>
            </div>
            <div class="card">
              <div class="card-head"><h3>Crawl activity</h3></div>
              <ul class="runs">${runRows || '<li class="muted">No runs yet.</li>'}</ul>
              <div class="muted small mono">${esc(lastSummary)}</div>
            </div>
          </div>`
              : ""
          }
        </div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SportyBet AI · Booking Code Intelligence</title>
<style>
  :root{
    --bg:#eef1f7; --card:#fff; --ink:#141a2e; --muted:#7b86a3; --line:#e8ecf4;
    --primary:#f2683c; --indigo:#5b4bd6; --blue:#3b82f6; --green:#16a86b;
    --warn:#e6a23a; --bad:#e5484d; --shadow:0 1px 2px rgba(16,24,40,.04),0 4px 16px rgba(16,24,40,.05);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;
    background:var(--bg);color:var(--ink);font-size:14px}
  a{color:inherit;text-decoration:none}
  .layout{display:flex;min-height:100vh}
  /* Sidebar */
  .sidebar{width:250px;background:var(--card);border-right:1px solid var(--line);
    padding:22px 16px;position:sticky;top:0;height:100vh;flex-shrink:0;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:10px;padding:0 8px 20px;font-weight:800;font-size:17px}
  .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--primary),var(--indigo));
    display:grid;place-items:center;color:#fff;font-size:16px}
  .brand span{color:var(--primary)}
  .nav-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
    padding:14px 10px 6px;font-weight:700}
  .nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;
    color:#59617a;font-weight:600;margin-bottom:2px}
  .nav-item:hover{background:#f4f6fb;color:var(--ink)}
  .nav-item.on{background:linear-gradient(135deg,var(--primary),#f7864f);color:#fff;box-shadow:0 6px 16px rgba(242,104,60,.28)}
  .nav-item.on .ni{filter:grayscale(0)}
  .ni{width:20px;text-align:center}
  .side-foot{margin-top:auto;padding:12px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  .src-status{display:flex;flex-direction:column;gap:8px}
  .src-pill{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:6px 12px;
    border-radius:999px;font-size:12px;font-weight:800;line-height:1.2}
  .src-pill.on{background:#eafaf1;color:#0f8a52;border:1px solid #c8ecd8}
  .src-pill.off{background:#fef3e8;color:#b7791f;border:1px solid #f0dcc0}
  .live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;
    box-shadow:0 0 0 0 rgba(22,168,107,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,168,107,.5)}70%{box-shadow:0 0 0 7px rgba(22,168,107,0)}100%{box-shadow:0 0 0 0 rgba(22,168,107,0)}}
  /* App area */
  .app{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{display:flex;align-items:center;gap:16px;padding:16px 26px;background:var(--card);
    border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
  .topbar h1{font-size:18px;margin:0}
  .topbar .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .search{margin-left:14px;flex:1;max-width:340px;position:relative}
  .search input{width:100%;padding:9px 12px 9px 34px;border:1px solid var(--line);border-radius:10px;
    background:#f7f9fc;font-size:13px;outline:none}
  .search input:focus{border-color:var(--primary);background:#fff}
  .search::before{content:'🔍';position:absolute;left:11px;top:8px;font-size:13px;opacity:.6}
  .top-right{margin-left:auto;display:flex;align-items:center;gap:12px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:10px;
    background:#f4f6fb;border:1px solid var(--line);font-size:12px;font-weight:600;color:#59617a}
  .chip b{color:var(--ink);font-variant-numeric:tabular-nums}
  .chip-live{background:#eafaf1;border-color:#c8ecd8;color:#0f8a52}
  .btn{background:linear-gradient(135deg,var(--primary),#f7864f);color:#fff;border:0;border-radius:10px;
    padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 6px 16px rgba(242,104,60,.25)}
  .btn:hover{filter:brightness(1.05)}
  .btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line);box-shadow:none}
  .btn.ghost:hover{background:#f4f6fb}
  .btn.sm{padding:6px 12px;font-size:12px}
  .btn.gold{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06;box-shadow:0 6px 16px rgba(224,165,49,.3)}
  .btn:disabled{opacity:.7;cursor:default}
  /* Expert Picks */
  .xshort{padding:12px 16px;margin-bottom:14px;font-size:13px;background:#eef1fb;border:1px solid #d8ddf5;color:#3a3f6b}
  /* Track record */
  .xrecord{padding:16px 18px;margin-bottom:16px}
  .xrec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .xrec-top{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
  .xrec-big b{font-size:32px;line-height:1;color:var(--green)}
  .xrec-big small,.xrec-stat small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
  .xrec-stat b{font-size:20px;line-height:1}
  .xbands{border-top:1px solid var(--line);padding-top:10px}
  .xband{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:12px}
  .xband-l{width:56px;font-weight:700;color:#59617a;flex-shrink:0}
  .xband-track{flex:1;height:10px;background:#eef1f8;border-radius:999px;overflow:hidden}
  .xband-fill{height:100%;background:linear-gradient(90deg,var(--indigo),var(--green));border-radius:999px}
  .xband-v{width:96px;text-align:right;font-weight:700;flex-shrink:0}
  .xband-v small{color:var(--muted);font-weight:500}
  .xrecent{border-top:1px solid var(--line);padding-top:8px}
  .xrec-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--line)}
  .xrec-row:last-child{border-bottom:0}
  /* ROI / profit */
  .roi-top{display:flex;gap:22px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  .roi-big b{font-size:30px;line-height:1}
  .roi-big.up b,.roi-stat.up b{color:var(--green)} .roi-big.down b,.roi-stat.down b{color:var(--bad)}
  .roi-big small,.roi-stat small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
  .roi-stat b{font-size:20px;line-height:1}
  .roi-spark-wrap{flex:1;min-width:180px}
  .roi-spark{width:100%;height:64px}
  .roi-note{border-top:1px solid var(--line);padding-top:10px;line-height:1.5}
  .roi-block{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}
  .roi-row{display:grid;grid-template-columns:1fr auto 72px 60px;gap:10px;align-items:center;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--line)}
  .roi-row:last-child{border-bottom:0}
  .roi-l{font-weight:700;color:#475069} .roi-n{color:var(--muted);font-size:11px;text-align:right}
  .roi-p,.roi-r{text-align:right;font-weight:800}
  .roi-p.up,.roi-r.up{color:var(--green)} .roi-p.down,.roi-r.down{color:var(--bad)}
  .xhead{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  .xform{display:flex;align-items:end;gap:10px;flex-wrap:wrap}
  .xform label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
  .xform select{padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:#f7f9fc;font-size:13px;font-weight:600;color:var(--ink)}
  .xlist{display:flex;flex-direction:column;gap:12px}
  .xcard{display:flex;align-items:center;gap:16px;background:var(--card);border:1px solid var(--line);
    border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);position:relative}
  .xcard.picked{border:2px solid var(--green);box-shadow:0 8px 24px rgba(22,168,107,.18)}
  .xrank{flex-shrink:0;width:34px;height:34px;border-radius:10px;background:#eeecfb;color:var(--indigo);
    display:grid;place-items:center;font-weight:800;font-size:13px}
  .xmain{flex:1;min-width:0}
  .xmatch{font-weight:800;font-size:15px}
  .xmeta{font-size:12px;color:var(--muted);margin:3px 0 8px}
  .xpick{font-size:13px;font-weight:700;color:var(--ink);background:#f4f6fb;display:inline-block;
    padding:5px 12px;border-radius:999px;margin-bottom:6px}
  .xodds{color:var(--indigo);font-weight:800}
  .xwhy{display:flex;flex-wrap:wrap;gap:6px}
  .xwhy span{font-size:11px;color:#59617a;background:#f7f9fc;border:1px solid var(--line);padding:3px 9px;border-radius:999px}
  .xsignals{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .xsignals span{font-size:11px;color:#0f6b8a;background:#eaf6fb;border:1px solid #cce8f2;padding:3px 9px;border-radius:999px}
  .xconf{flex-shrink:0;text-align:center;width:92px}
  .xconf-n{font-size:22px;font-weight:800;line-height:1.1}
  .xconf-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px}
  .xconf.hi .xconf-n{color:var(--green)}
  .xconf.mid .xconf-n{color:#c9820f}
  .xconf.lo .xconf-n{color:var(--muted)}
  .vcard{border-left:4px solid #7b5bd6}
  .vconf .xconf-n{color:#7b5bd6}
  .vedge{font-size:11px;font-weight:800;color:#0f8a52;background:#eafaf1;border:1px solid #c8ecd8;
    padding:2px 8px;border-radius:999px;margin-bottom:6px;display:inline-block}
  .xanalysis{display:inline-block;margin-top:7px;font-size:12px;font-weight:700;color:var(--indigo)}
  .xanalysis:hover{text-decoration:underline}
  /* Value Combos */
  .cmb-list{display:flex;flex-direction:column;gap:14px}
  .cmb-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--indigo)}
  .cmb-card.vk{border-left-color:#7b5bd6} .cmb-card.sk{border-left-color:var(--green)} .cmb-card.bk{border-left-color:var(--primary)} .cmb-card.bo{border-left-color:#e5484d}
  .cmb-card.bo .cmb-odds b{color:#e5484d}
  .cmb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:10px}
  .cmb-title{font-weight:800;font-size:16px}
  .cmb-odds{text-align:right;flex-shrink:0}
  .cmb-odds b{font-size:24px;line-height:1;color:var(--indigo)} .cmb-odds small{display:block;font-size:10px;color:var(--muted)}
  .cmb-legs{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:6px 0;margin-bottom:12px}
  .cmb-leg{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:5px 0;font-size:12.5px}
  .cmb-m{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cmb-p{white-space:nowrap} .cmb-p b{color:var(--indigo)}
  .cmb-k{font-size:11px;white-space:nowrap}
  /* AI Analysis */
  .an-list{display:flex;flex-direction:column;gap:14px}
  .an-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--blue)}
  .an-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px}
  .an-match{font-weight:800;font-size:16px}
  .an-xg{text-align:right;flex-shrink:0}
  .an-xg b{font-size:22px;line-height:1;color:var(--blue)} .an-xg small{display:block;font-size:10px;color:var(--muted)}
  .an-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .an-col{min-width:0}
  .an-lbl{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
  .an-bar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}
  .an-bl{width:96px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .an-bt{flex:1;height:10px;background:#eef1f8;border-radius:999px;overflow:hidden}
  .an-bf{height:100%;border-radius:999px}
  .an-bf.h{background:var(--green)} .an-bf.a{background:var(--primary)} .an-bf.d{background:var(--muted)} .an-bf.g{background:var(--blue)}
  .an-bv{width:34px;text-align:right;font-weight:700;flex-shrink:0}
  .an-scores{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .an-score{background:#f4f6fb;border:1px solid var(--line);border-radius:9px;padding:6px 10px;text-align:center;min-width:52px}
  .an-score b{display:block;font-size:15px} .an-score span{font-size:11px;color:var(--muted)}
  .an-verdict{font-size:12.5px;background:#e9f1fe;border:1px solid #cfe2fb;border-radius:9px;padding:8px 10px;margin-bottom:8px}
  .an-opts{display:flex;flex-direction:column;gap:6px}
  .an-opt{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;
    border:1px solid var(--line);border-radius:9px;padding:7px 10px;cursor:pointer;font-size:12.5px}
  .an-opt:hover{background:#f7f9fc}
  .an-opt.on{border-color:var(--green);background:#eafaf1}
  .an-opt input{accent-color:var(--green);cursor:pointer}
  .an-opt-l{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .an-opt-o{color:var(--indigo);font-weight:800}
  .an-opt-p{color:var(--muted);font-size:11px;min-width:34px;text-align:right}
  @media(max-width:640px){ .an-grid{grid-template-columns:1fr} .an-head{flex-direction:column} }
  .cmb-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .cmb-res{display:flex;align-items:center;gap:8px}
  @media(max-width:640px){ .cmb-leg{grid-template-columns:1fr auto} .cmb-k{display:none} }
  /* Auto-recommended value banner */
  .vauto{padding:14px 18px;margin-bottom:16px;background:linear-gradient(120deg,#f3f0ff,#eef6ff);border:1px solid #ddd6f5}
  .vauto-head{font-size:14px;font-weight:800;margin-bottom:10px}
  .vauto-list{display:flex;flex-direction:column;gap:10px}
  .vauto-item{display:flex;gap:14px;align-items:center;justify-content:space-between;background:#fff;
    border:1px solid var(--line);border-radius:12px;padding:10px 14px}
  .vauto-main{min-width:0}
  .vauto-why{font-size:12px;color:#475069;margin-top:3px}
  .vauto-side{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  @media(max-width:640px){ .vauto-item{flex-direction:column;align-items:flex-start} .vauto-side{align-items:flex-start} }
  .xsel{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;font-weight:700;
    color:#59617a;cursor:pointer}
  .xsel input{accent-color:var(--green);cursor:pointer}
  @media(max-width:640px){ .xcard{flex-direction:column;align-items:stretch} .xconf{width:auto;display:flex;align-items:center;justify-content:space-between} }
  /* Prediction match calendar */
  .pred-datebar{padding:16px 18px 8px;margin-bottom:18px}
  .pd-chip{position:relative;flex:0 0 auto;width:68px;display:flex;flex-direction:column;
    align-items:center;gap:1px;padding:10px 6px 8px;border-radius:14px;border:1px solid var(--line);
    background:#fff;cursor:pointer;font-family:inherit;transition:transform .12s, box-shadow .12s}
  .pd-chip:hover{transform:translateY(-2px);box-shadow:0 8px 18px rgba(16,24,40,.09);border-color:#cfd6e6}
  .pdc-top{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.5px}
  .pdc-day{font-size:23px;font-weight:800;line-height:1.05;color:var(--ink)}
  .pdc-mon{font-size:10px;color:var(--muted);font-weight:600}
  .pdc-count{margin-top:4px;font-size:10px;font-weight:800;background:#eef1f8;color:#59617a;
    padding:1px 8px;border-radius:999px}
  .pd-chip.on{background:linear-gradient(150deg,var(--indigo),#7b6ce8);border-color:transparent;
    box-shadow:0 8px 20px rgba(91,75,214,.3)}
  .pd-chip.on .pdc-top,.pd-chip.on .pdc-mon{color:rgba(255,255,255,.9)}
  .pd-chip.on .pdc-day{color:#fff}
  .pd-chip.on .pdc-count{background:rgba(255,255,255,.28);color:#fff}
  /* Day groups */
  .day-group{margin-bottom:26px}
  .dg-head{display:flex;align-items:center;gap:14px;margin-bottom:14px;background:var(--card);
    border:1px solid var(--line);border-radius:14px;padding:12px 16px;box-shadow:var(--shadow)}
  .dg-cal{width:58px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;
    background:#f4f6fb;border:1px solid var(--line);border-radius:12px;padding:7px 4px}
  .dg-cal.today{background:linear-gradient(150deg,var(--primary),#f7864f);border-color:transparent}
  .dg-cal.today .dg-dow,.dg-cal.today .dg-num,.dg-cal.today .dg-mon{color:#fff}
  .dg-cal.analyst{background:linear-gradient(150deg,#e0a531,#f6c453);border-color:transparent}
  .dg-dow{font-size:9px;font-weight:800;color:var(--muted);letter-spacing:.6px}
  .dg-num{font-size:21px;font-weight:800;line-height:1.1}
  .dg-mon{font-size:10px;color:var(--muted);font-weight:600}
  .dg-title b{display:block;font-size:16px}
  .dg-title span{font-size:12px;color:var(--muted)}
  .dg-count{margin-left:auto;font-size:12px;font-weight:800;background:#eeecfb;color:var(--indigo);
    padding:5px 12px;border-radius:999px;white-space:nowrap}
  .ko-chip{margin-left:auto;flex-shrink:0;font-size:12px;font-weight:800;color:var(--indigo);
    background:#eeecfb;padding:4px 10px;border-radius:999px;white-space:nowrap}
  .slip-head .ko-chip + .selbox, .slip-head .selbox{margin-left:10px}
  .slip-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px}
  /* Prediction slip builder */
  .pred-hint{padding:14px 18px;margin-bottom:16px;font-size:13px;background:linear-gradient(120deg,#eafaf1,#eeecfb);border:1px solid #d5eee0}
  .selbox{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;
    color:var(--green);cursor:pointer;padding:4px 10px;border:1px dashed #bfe7d2;border-radius:8px;white-space:nowrap}
  .selbox:hover{background:#eafaf1}
  .selbox input{accent-color:var(--green);cursor:pointer}
  .slip.picked{border:2px solid var(--green);box-shadow:0 8px 24px rgba(22,168,107,.18)}
  .slipbar{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:40;
    display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:92vw;
    background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 18px;
    box-shadow:0 12px 36px rgba(16,24,40,.18)}
  .sb-info{font-size:13px;font-weight:600;color:#475069}
  .sb-note{font-size:12px;font-weight:600;color:#0f8a52;max-width:420px}
  .sb-note.warn{color:#b7791f}
  .slipcode{display:inline-block;background:#141a2e;color:#7df0b8;font-family:ui-monospace,Consolas,monospace;
    font-size:16px;font-weight:800;letter-spacing:2px;padding:7px 14px;border-radius:9px;cursor:pointer}
  .slipcode:hover{filter:brightness(1.2)}
  .sb-name{padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;width:130px;
    background:#f7f9fc;outline:none}
  .sb-name:focus{border-color:var(--primary);background:#fff}
  /* Saved Codes ledger */
  .sc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
  .sc-count{text-align:center}.sc-count b{font-size:26px;display:block;line-height:1;color:var(--indigo)}
  .sc-count small{font-size:11px;color:var(--muted)}
  .sc-list{display:flex;flex-direction:column;gap:10px}
  .sc-row{display:flex;gap:16px;align-items:stretch;background:var(--card);border:1px solid var(--line);
    border-radius:14px;padding:14px 16px;box-shadow:var(--shadow)}
  .sc-when{flex-shrink:0;width:180px;display:flex;flex-direction:column;gap:3px;font-size:12px}
  .sc-day{font-weight:800;font-size:13px}
  .sc-time,.sc-by{color:#59617a}
  .sc-when .tag{align-self:flex-start;margin-top:4px}
  .sc-mid{flex:1;min-width:0;font-size:12.5px;line-height:1.5;border-left:1px solid var(--line);padding-left:16px}
  .sc-right{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  .sc-meta{font-size:11px;color:var(--muted)}
  @media(max-width:720px){ .sc-row{flex-direction:column} .sc-when{width:auto} .sc-mid{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:10px} .sc-right{align-items:flex-start} }
  /* Drag-and-drop overlay */
  #dropzone{position:fixed;inset:0;z-index:70;background:rgba(20,26,46,.55);display:grid;place-items:center;
    opacity:0;pointer-events:none;transition:opacity .15s}
  #dropzone.show{opacity:1}
  .dz-inner{background:var(--card);border:3px dashed var(--primary);border-radius:20px;
    padding:44px 64px;text-align:center;font-size:20px;font-weight:800;line-height:1.6;
    box-shadow:0 20px 60px rgba(16,24,40,.35)}
  .dz-inner small{font-size:13px;color:var(--muted);font-weight:500}
  /* OCR modal */
  #ocrmodal{position:fixed;inset:0;z-index:60;background:rgba(16,24,40,.45);display:grid;place-items:center;padding:20px}
  .ocr-box{background:var(--card);border-radius:16px;padding:20px 22px;max-width:520px;width:100%;
    box-shadow:0 20px 60px rgba(16,24,40,.3)}
  .ocr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .ocr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--line)}
  #toast{position:fixed;right:22px;bottom:22px;z-index:50;max-width:360px;
    background:#141a2e;color:#fff;padding:13px 18px;border-radius:12px;font-size:13px;font-weight:600;
    box-shadow:0 10px 30px rgba(16,24,40,.25);opacity:0;transform:translateY(10px);
    transition:opacity .25s,transform .25s;pointer-events:none}
  #toast.show{opacity:1;transform:translateY(0)}
  #toast.ok{background:#123a24}#toast.warn{background:#7a5b12}
  /* Premium gating */
  .tier-badge{padding:6px 12px;border-radius:10px;font-size:12px;font-weight:800}
  .tier-free{background:#f1f5f9;color:#64748b}
  .tier-premium{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06}
  .lock{color:#b7791f;font-weight:700;text-decoration:none;cursor:pointer}
  .lock:hover{text-decoration:underline}
  .hero-code.locked,.booking-code.locked{color:rgba(255,255,255,.55);letter-spacing:4px}
  .booking-code.locked{color:#b7791f}
  .locked-b{background:linear-gradient(120deg,#fff6e6,#eeecfb);border-color:#f0e2c6}
  .upsell{background:linear-gradient(120deg,#3a2a06,#5b4bd6);color:#fff;border-radius:14px;
    padding:16px 20px;margin-bottom:18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .upsell b{font-size:15px}.upsell .grow{flex:1;min-width:200px}
  .slip.vip{border:2px solid #e0a531;box-shadow:0 8px 24px rgba(224,165,49,.22)}
  .ribbon{position:absolute;top:-10px;right:14px;background:linear-gradient(135deg,#e0a531,#f6c453);
    color:#3a2a06;font-size:11px;font-weight:800;padding:4px 12px;border-radius:8px}
  .slip{position:relative}
  /* Pricing */
  .pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:18px}
  .plan{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:var(--shadow)}
  .plan.pop{border:2px solid var(--primary)}
  .plan h3{margin:0 0 4px;font-size:16px}
  .plan .price{font-size:30px;font-weight:800;margin:8px 0}
  .plan .price small{font-size:13px;color:var(--muted);font-weight:500}
  .plan ul{list-style:none;padding:0;margin:14px 0;font-size:13px;color:#475069}
  .plan li{padding:6px 0;border-bottom:1px solid var(--line)}
  .plan li::before{content:'✓ ';color:var(--green);font-weight:800}
  .plan li.no{color:#a0a8bd}.plan li.no::before{content:'✕ ';color:#c9cfdb}
  @media(max-width:900px){ .pricing{grid-template-columns:1fr} }
  /* Content */
  .content{padding:22px 26px 40px;overflow:auto}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;
    display:flex;align-items:center;gap:14px;box-shadow:var(--shadow)}
  .kpi .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-size:20px}
  .kpi.green .ic{background:#eafaf1}.kpi.indigo .ic{background:#eeecfb}
  .kpi.blue .ic{background:#e9f1fe}.kpi.orange .ic{background:#fdeee7}
  .kpi b{font-size:24px;display:block;line-height:1.1}
  .kpi small{color:var(--muted);font-size:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
    padding:18px;margin-bottom:18px}
  .card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .card-head h3{margin:0;font-size:15px}
  .date-nav{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .date-nav-head{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;
    letter-spacing:.6px;margin-bottom:10px}
  .date-strip{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px}
  .date-strip::-webkit-scrollbar{height:6px}
  .date-strip::-webkit-scrollbar-thumb{background:#d7dce8;border-radius:3px}
  .day-card{position:relative;flex:0 0 auto;width:68px;display:flex;flex-direction:column;
    align-items:center;gap:1px;padding:11px 6px 9px;border:1px solid var(--line);border-radius:16px;
    background:#fff;text-decoration:none;color:var(--ink);
    transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}
  .day-card:hover{transform:translateY(-2px);box-shadow:0 8px 18px rgba(16,24,40,.09);border-color:#cfd6e6}
  .dc-top{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.5px}
  .dc-day{font-size:23px;font-weight:800;line-height:1.05}
  .dc-mon{font-size:10px;color:var(--muted);margin-bottom:5px}
  .dc-count{font-size:10px;font-weight:700;background:#eef1f8;color:#59617a;border-radius:999px;
    padding:1px 9px;min-width:22px;text-align:center}
  .day-card.on{background:linear-gradient(150deg,var(--primary),#f7864f);border-color:transparent;
    color:#fff;box-shadow:0 8px 20px rgba(242,104,60,.32)}
  .day-card.on .dc-top,.day-card.on .dc-mon{color:rgba(255,255,255,.9)}
  .day-card.on .dc-count{background:rgba(255,255,255,.28);color:#fff}
  .day-card.all .dc-day{color:var(--indigo)} .day-card.all.on .dc-day{color:#fff}
  .day-card.pick{border-style:dashed;cursor:pointer;justify-content:center}
  .dc-input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
  .split{display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start}
  .split.full{grid-template-columns:1fr}
  .col-side .card{position:sticky;top:90px}
  /* Hero */
  .hero{background:linear-gradient(120deg,var(--indigo),#7b4bd6 55%,var(--primary));color:#fff;
    border-radius:16px;padding:22px;display:flex;justify-content:space-between;gap:18px;
    box-shadow:0 12px 30px rgba(91,75,214,.28);margin-bottom:18px;flex-wrap:wrap}
  .hero-code{font-family:ui-monospace,Menlo,monospace;font-size:38px;font-weight:800;letter-spacing:3px;margin:8px 0}
  .hero-meta{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px;opacity:.95}
  .hero-meta b{font-weight:800}
  .hero-right{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .hero-src{font-size:12px;opacity:.85;margin-top:4px}
  .hero .btn.ghost{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.3)}
  /* Table */
  .table-wrap{overflow-x:auto}
  table.grid-table{width:100%;border-collapse:collapse;font-size:13px}
  .grid-table th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line)}
  .grid-table td{padding:11px 10px;border-bottom:1px solid var(--line)}
  .grid-table tr:last-child td{border-bottom:0}
  .frow:hover{background:#f8fafd}
  tr.fresh{background:#fff7f2}
  td.code{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#b4530f}
  td.num{font-variant-numeric:tabular-nums;font-weight:600}
  .starcol{color:var(--warn);letter-spacing:1px;font-size:12px}
  .muted{color:var(--muted)}.small{font-size:12px}.mono{font-family:ui-monospace,monospace}
  .ccopy{cursor:pointer;border-bottom:1px dashed #d7a877}
  .ccopy:hover{color:var(--primary)}
  .tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;
    background:#eef1f8;color:#59617a}
  .tag.new{background:#eafaf1;color:#0f8a52}
  .tag.green{background:#eafaf1;color:#0f8a52}.tag.orange{background:#fdeee7;color:var(--primary)}
  .tag.indigo{background:#eeecfb;color:var(--indigo)}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700}
  .status.s-ACTIVE{background:#eafaf1;color:#0f8a52}
  .status.s-UNVERIFIED{background:#fef6e7;color:#b7791f}
  .status.s-EXPIRED,.status.s-INVALID,.status.s-DUPLICATE{background:#fdecec;color:var(--bad)}
  .runs{list-style:none;margin:0;padding:0}
  .runs li{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .runs li:last-child{border-bottom:0}
  .rname{font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:var(--green)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
  /* AI cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
  .slip{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow)}
  .slip-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .slip-title{font-size:15px}
  .booking{display:flex;justify-content:space-between;align-items:center;gap:10px;
    background:linear-gradient(120deg,#fdeee7,#eeecfb);border:1px solid #f0dfd6;border-radius:12px;padding:12px 14px;margin-bottom:12px}
  .booking.manual{color:var(--muted);font-size:12.5px;justify-content:flex-start}
  .booking-label{font-size:11px;font-weight:700;color:var(--primary)}
  .booking-code{font-family:ui-monospace,Menlo,monospace;font-size:24px;font-weight:800;letter-spacing:2px;color:#141a2e}
  .booking-actions{display:flex;gap:8px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
  .metrics b{font-size:18px;display:block}.metrics small{color:var(--muted);font-size:11px}
  .metrics .pos{color:var(--green)}.metrics .neg{color:var(--bad)}
  .conf{height:8px;background:#eef1f8;border-radius:6px;overflow:hidden;margin-bottom:12px}
  .conf-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--indigo))}
  table.legs{width:100%;font-size:12.5px;border-collapse:collapse}
  table.legs td{padding:7px 4px;border-bottom:1px solid var(--line)}
  table.legs tr:last-child td{border-bottom:0}
  .reason{color:#6b7594;font-size:12px;margin-top:10px;line-height:1.5}
  .pred-tip{background:#eeecfb;color:var(--indigo);font-weight:800;font-size:15px;
    border-radius:10px;padding:10px 14px;margin:10px 0}
  .pred-preview{color:#6b7594;font-size:13px;line-height:1.5;margin:10px 0;font-style:italic}
  .empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:30px}
  .disclaimer{color:var(--muted);font-size:12px;margin-top:6px;text-align:center;padding:8px;line-height:1.6}
  .disclaimer a{color:var(--bad);font-weight:700}
  /* Prominent risk banner */
  .risk-banner{display:flex;align-items:center;gap:14px;background:#fff4f2;border:1.5px solid #f4b9ad;
    border-left:5px solid var(--bad);border-radius:12px;padding:12px 16px;margin-bottom:16px;
    box-shadow:0 4px 16px rgba(229,72,77,.08)}
  .rb-icon{font-size:24px;flex-shrink:0}
  .rb-text{font-size:13px;line-height:1.5;color:#7a1d1d}
  .rb-text b{color:#c0341a}
  .rb-text u{text-underline-offset:2px}
  .rb-link{display:inline-block;margin-left:6px;color:var(--bad);font-weight:700;text-decoration:underline;cursor:pointer}
  .rb-close{flex-shrink:0;align-self:flex-start;background:#fff;border:1px solid #f0c4bb;color:#a5352a;
    border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
  .rb-close:hover{background:#fdece8}
  .risk-detail{background:#fff;border:1px solid var(--line);border-left:5px solid var(--bad);border-radius:12px;
    padding:14px 20px;margin-bottom:16px;font-size:13px;color:#475069}
  .risk-detail ul{margin:10px 0 2px;padding-left:20px}
  .risk-detail li{padding:4px 0}
  .risk-detail a{color:var(--bad);font-weight:700}
  @media(max-width:640px){ .risk-banner{flex-direction:column;align-items:flex-start} }
  @media(max-width:1000px){ .kpis{grid-template-columns:repeat(2,1fr)} .split{grid-template-columns:1fr} .col-side .card{position:static} }
  @media(max-width:760px){ .sidebar{display:none} .search{display:none} }
</style></head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand"><span class="logo">⚡</span>SportyBet <span>&nbsp;AI</span></div>
    <div class="nav-label">Main</div>
    ${nav("human", "📊", "Dashboard", mode === "human")}
    ${nav("ai", "🤖", "AI Codes", mode === "ai")}
    ${nav("pred", "📈", "Predictions", mode === "pred")}
    ${nav("expert", "🎯", "Expert Picks", mode === "expert")}
    ${nav("value", "💎", "Value Picks", mode === "value")}
    ${nav("analysis", "📊", "AI Analysis", mode === "analysis")}
    ${nav("combo", "🎰", "Value Combos", mode === "combo")}
    ${nav("saved", "💾", "Saved Codes", mode === "saved")}
    <div class="nav-label">Data</div>
    <a class="nav-item" href="/api/codes" target="_blank"><span class="ni">🔗</span>Codes API</a>
    <a class="nav-item" href="/api/ai-slips" target="_blank"><span class="ni">🧠</span>AI Slips API</a>
    <a class="nav-item" href="/health" target="_blank"><span class="ni">💓</span>Health</a>
    <div class="side-foot">
      ${config.adminKey && isAdmin ? `<div style="margin-bottom:8px"><span style="background:#3a2a06;color:#f6c453;font-weight:800;font-size:10px;padding:2px 8px;border-radius:6px">👑 ADMIN</span> <a href="/admin/off" style="color:var(--muted);font-size:11px">exit</a></div>` : ""}
      <span class="live-dot"></span>Live · scans every ${Math.round(intervalSec / 60)} min<br/>
      <span style="opacity:.8">18+ · Bet responsibly</span>
    </div>
  </aside>
  <div class="app">
    <div class="topbar">
      <div>
        <h1>${mode === "analysis" ? "AI Match Analysis" : mode === "combo" ? "Value Combos" : mode === "value" ? "Value Picks" : mode === "saved" ? "Saved Codes" : mode === "expert" ? "Expert Picks" : mode === "pred" ? "Match Predictions" : mode === "ai" ? "AI-Generated Slips" : "Booking Code Dashboard"}</h1>
        <div class="sub">${mode === "analysis" ? "Poisson model calibrated to live odds — match & correct-score probabilities" : mode === "combo" ? "Ready-made accumulators auto-built from the best picks — book one in a click" : mode === "value" ? "Higher-odds opportunities where a model beats the market price — EV-ranked, estimates not guarantees" : mode === "saved" ? "Every generated code — with the day, time and who made it" : mode === "expert" ? "Confidence-ranked picks across your chosen window — estimates, never guarantees" : mode === "pred" ? "Third-party statistical tips — not booking codes" : mode === "ai" ? "Model recommendations with auto-generated booking codes" : "Live codes discovered & verified against SportyBet"}</div>
      </div>
      <div class="search"><input id="search" placeholder="Search codes, leagues, sources…" oninput="flt(this.value)"/></div>
      <div class="top-right">
        <span class="chip chip-live">Next scan <b id="countdown">—</b></span>
        ${
          isPremium
            ? `<span class="tier-badge tier-premium">👑 PREMIUM</span>`
            : `<span class="tier-badge tier-free">FREE</span><a class="btn gold" href="/upgrade">⭐ Upgrade</a>`
        }
        <label class="btn ghost" style="cursor:pointer" title="Upload a bet-slip screenshot — we'll read the booking code out of it">📷 Scan slip image<input type="file" accept="image/*" style="display:none" onchange="ocrUp(this)"/></label>
        <button class="btn" onclick="doScan(this)">⟳ Scan now</button>
      </div>
    </div>
    <div class="content">
      <div class="risk-banner" id="riskBanner">
        <span class="rb-icon">⚠️</span>
        <div class="rb-text">
          <b>High-risk gambling — you can lose your money.</b>
          These booking codes, AI slips and predictions are statistical estimates, <u>never guarantees</u>. No code is "sure". Anyone promising guaranteed wins is scamming you. Only stake what you can afford to lose entirely. 18+ only.
          <a href="#" onclick="rbMore(event)" class="rb-link">Read full risk warning</a>
        </div>
        <button class="rb-close" onclick="rbClose()" title="I understand the risks">I understand ✕</button>
      </div>
      <div class="risk-detail" id="riskDetail" hidden>
        <b>Full risk warning</b>
        <ul>
          <li><b>Nothing here is a guaranteed win.</b> Booking codes found from public channels, AI-generated slips, and third-party predictions are all estimates. Even the best tipsters lose bets regularly.</li>
          <li><b>We never place bets or move your money.</b> A booking code only saves a selection you must review and stake yourself on SportyBet.</li>
          <li><b>Avoid "fixed match" and "100% sure" scams.</b> No one can guarantee outcomes. Never pay for "VIP sure odds".</li>
          <li><b>Gambling is addictive and can cause serious financial harm.</b> Only bet what you can afford to lose. If it stops being fun, stop. Help: <a href="https://www.begambleaware.org" target="_blank" rel="noopener">BeGambleAware.org</a>.</li>
          <li><b>18+ only.</b> You are responsible for complying with the gambling laws in your location.</li>
        </ul>
      </div>
      ${
        isPremium
          ? ""
          : `<div class="upsell"><div class="grow"><b>You're on the Free plan.</b><br/>Fresh codes are delayed ${config.freeDelayMin} min and AI booking codes are locked. Go Premium for instant codes + one-click booking.</div><a class="btn gold" href="/upgrade">⭐ See plans</a></div>`
      }
      <div class="kpis">${kpis}</div>
      ${body}
      <div class="disclaimer"><b>⚠️ Gambling involves real risk of loss — never bet more than you can afford to lose.</b><br/>${esc(RESPONSIBLE_GAMBLING_DISCLAIMER)} ${
        mode === "expert"
          ? "Confidence scores blend model win probability, market odds and source agreement — they rank likelihood, they do NOT guarantee an outcome. No pick is ever \"sure\"; anyone claiming 99–100% guaranteed wins is misleading you."
          : mode === "pred"
          ? "Predictions from footballpredictions.com, forebet.com + Telegram analysts (@betmines, @eaglepredict) — third-party tips, not affiliated with SportyBet. No prediction is ever guaranteed."
          : mode === "ai"
            ? "AI slips are model estimates — booking codes save selections only; review & stake yourself."
            : "Codes are verified against SportyBet's official API for validity only — validity is not a prediction of winning."
      } 18+ only · <a href="https://www.begambleaware.org" target="_blank" rel="noopener">Get help: BeGambleAware.org</a></div>
    </div>
  </div>
</div>
<script>
  function cp(el, code){
    navigator.clipboard.writeText(code);
    var o = el.textContent; el.textContent = 'Copied!';
    setTimeout(function(){ el.textContent = o; }, 1200);
  }
  /* Risk banner: dismissable per browser session — always shown again on a new visit. */
  function rbClose(){
    var b = document.getElementById('riskBanner'); if(b) b.style.display='none';
    var d = document.getElementById('riskDetail'); if(d) d.hidden = true;
    try{ sessionStorage.setItem('riskAck','1'); }catch(e){}
  }
  function rbMore(e){
    if(e) e.preventDefault();
    var d = document.getElementById('riskDetail'); if(d) d.hidden = !d.hidden;
  }
  (function(){
    try{ if(sessionStorage.getItem('riskAck')){ var b=document.getElementById('riskBanner'); if(b) b.style.display='none'; } }catch(e){}
  })();
  function flt(q){
    q = (q||'').toLowerCase().trim();
    document.querySelectorAll('.frow,.slip').forEach(function(el){
      var f = el.getAttribute('data-f')||'';
      el.style.display = (!q || f.indexOf(q)>=0) ? '' : 'none';
    });
  }
  function showToast(msg, kind){
    var t=document.getElementById('toast');
    if(!t){ t=document.createElement('div'); t.id='toast'; document.body.appendChild(t); }
    t.className='toast show '+(kind||''); t.textContent=msg;
    clearTimeout(window.__tt); window.__tt=setTimeout(function(){ t.className='toast '+(kind||''); }, 4500);
  }
  function doScan(btn){
    var o=btn.textContent; btn.disabled=true; btn.textContent='⟳ Scanning…';
    showToast('Scanning 15 sources… results in ~20s');
    fetch('/scan',{method:'POST'}).catch(function(){});
    setTimeout(function(){ btn.disabled=false; btn.textContent=o; }, 4000);
  }
  /* ---- Prediction match calendar: filter day groups ---- */
  function predDay(d, el){
    document.querySelectorAll('.pd-chip').forEach(function(c){ c.classList.remove('on'); });
    if(el) el.classList.add('on');
    document.querySelectorAll('.day-group').forEach(function(g){
      g.style.display = (d === 'all' || g.getAttribute('data-day') === d) ? '' : 'none';
    });
    window.scrollTo({top: 0, behavior: 'smooth'});
  }
  /* ---- Prediction slip builder ---- */
  var SEL = {};
  function selTog(cb){
    var k = cb.getAttribute('data-key');
    if(cb.checked) SEL[k]=1; else delete SEL[k];
    var card = cb.closest('.slip') || cb.closest('.xcard');
    if(card) card.classList.toggle('picked', cb.checked);
    updBar();
  }
  // AI Analysis options: only ONE market per match can be booked (same event),
  // so ticking one option unticks the others in that match.
  function anTog(cb){
    if(cb.checked){
      var match = cb.getAttribute('data-match');
      document.querySelectorAll('input[type=checkbox][data-match="'+match+'"]').forEach(function(o){
        if(o !== cb && o.checked){ o.checked = false; delete SEL[o.getAttribute('data-key')]; }
      });
    }
    var lab = cb.closest('.an-opt'); if(lab) lab.classList.toggle('on', cb.checked);
    document.querySelectorAll('input[type=checkbox][data-match="'+cb.getAttribute('data-match')+'"]').forEach(function(o){
      var l=o.closest('.an-opt'); if(l) l.classList.toggle('on', o.checked);
    });
    selTog(cb);
  }
  function updBar(){
    var n = Object.keys(SEL).length;
    var bar = document.getElementById('slipbar'); if(!bar) return;
    bar.hidden = n === 0;
    document.getElementById('slipcount').textContent = n;
  }
  function clearSel(){
    SEL = {};
    document.querySelectorAll('[data-key]').forEach(function(c){ if(c.tagName==='INPUT') c.checked=false; });
    document.querySelectorAll('.slip.picked,.xcard.picked').forEach(function(s){ s.classList.remove('picked'); });
    var r = document.getElementById('slipres'); if(r) r.innerHTML='';
    updBar();
  }
  // Pre-selected picks (Expert Picks come checked by default) → seed SEL on load.
  (function(){
    document.querySelectorAll('input[type=checkbox][data-key]').forEach(function(cb){
      if(cb.checked){ SEL[cb.getAttribute('data-key')] = 1; var c = cb.closest('.xcard'); if(c) c.classList.add('picked'); }
    });
    // Prefill the saved generator name so it's remembered across visits.
    try{ var n = localStorage.getItem('genName'); var el = document.getElementById('genname'); if(n && el) el.value = n; }catch(e){}
    updBar();
  })();
  // One-click book a ready-made combo (Value Combos tab).
  async function bookCombo(btn){
    var keys;
    try{ keys = JSON.parse(btn.getAttribute('data-keys')||'[]'); }catch(e){ keys = []; }
    if(!keys || !keys.length){ showToast('This combo has no legs','warn'); return; }
    var name = '';
    try{ name = localStorage.getItem('genName') || ''; }catch(e){}
    if(!name){ name = (prompt('Your name (saved with this code):')||'').trim(); if(name){ try{ localStorage.setItem('genName',name); }catch(e){} } }
    if(!name){ showToast('Enter your name to save the code','warn'); return; }
    var res = btn.parentElement.querySelector('.cmb-res');
    btn.disabled = true; var o = btn.textContent; btn.textContent = '⚡ Booking…';
    try{
      var r = await fetch('/api/predictions/book',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({keys:keys, name:name, origin:'combo'})});
      var j = await r.json();
      if(j.code){
        if(res) res.innerHTML = '<span class="slipcode ccopy" title="Click to copy" onclick="cp(this,\\''+j.code+'\\')">'+j.code+'</span>'+
          '<a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.sportybet.com/ng/?shareCode='+j.code+'">Open ↗</a>';
        showToast('✅ Combo code '+j.code+' — '+j.matched+' legs, '+(j.totalOdds||'—')+' odds. Click to copy.','ok');
      } else { showToast(j.error || 'Booking failed — try again shortly','warn'); }
    }catch(e){ showToast('Booking failed — network error','warn'); }
    btn.disabled = false; btn.textContent = o;
  }
  async function genCode(btn){
    var keys = Object.keys(SEL);
    if(keys.length < 1){ showToast('Pick at least 1 match first','warn'); return; }
    if(keys.length > 70){ showToast('Maximum 70 matches per code — remove some','warn'); return; }
    // Capture the generator's name (remembered per browser). Prompt once if unset.
    var nameEl = document.getElementById('genname');
    var name = (nameEl && nameEl.value.trim()) || '';
    if(!name){ try{ name = localStorage.getItem('genName') || ''; }catch(e){} }
    if(!name){ name = (prompt('Your name (saved with this code):') || '').trim(); }
    if(!name){ showToast('Enter your name to save the code','warn'); return; }
    try{ localStorage.setItem('genName', name); }catch(e){}
    if(nameEl && !nameEl.value) nameEl.value = name;
    btn.disabled = true; var o = btn.textContent; btn.textContent = '⚡ Booking on SportyBet…';
    try{
      // On the Expert Picks page, tell the server which game type (1X2 /
      // Over-Under / both) was selected, so it books the SAME market it
      // displayed rather than re-deriving a possibly different one.
      var xtype = document.getElementById('xtype');
      var body = {keys:keys, name:name, origin: xtype ? 'expert' : 'predictions'};
      if(xtype) body.gameType = xtype.value;
      var r = await fetch('/api/predictions/book',{method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
      var j = await r.json();
      if(j.code){
        var skipped = j.skipped || [];
        var note = j.matched + ' of ' + j.requested + ' games booked' + (j.savedBy ? ' · saved by '+j.savedBy : '');
        document.getElementById('slipres').innerHTML =
          '<span class="slipcode ccopy" title="Click to copy" onclick="cp(this,\\''+j.code+'\\')">'+j.code+'</span>'+
          '<a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.sportybet.com/ng/?shareCode='+j.code+'">Open ↗</a>'+
          '<span class="sb-note'+(skipped.length?' warn':'')+'" title="'+skipped.join(' · ')+'">'+note+
          (skipped.length?' — skipped (not on SportyBet): '+skipped.join(', '):'')+'</span>';
        showToast('✅ Code '+j.code+' — '+j.matched+' games, '+(j.totalOdds||'—')+' odds'+
          (skipped.length?' · '+skipped.length+' skipped':'')+'. Click it to copy.','ok');
      } else {
        showToast(j.error || 'Booking failed — try again shortly','warn');
      }
    }catch(e){ showToast('Booking failed — network error','warn'); }
    btn.disabled = false; btn.textContent = o;
  }
  /* ---- Bet-slip image scanner (OCR) ----
     One shared path for the 📷 button, drag-and-drop anywhere, and Ctrl+V. */
  function ocrUp(inp){
    var f = inp.files && inp.files[0];
    if(f) ocrFile(f);
    inp.value = '';
  }
  function ocrFile(f){
    if(!f) return;
    if(f.type && f.type.indexOf('image') !== 0){ showToast('That file is not an image — drop a screenshot of a bet slip','warn'); return; }
    if(f.size > 7*1024*1024){ showToast('Image too large — max 7MB','warn'); return; }
    showToast('🔍 Reading your slip image… takes ~10s');
    var rd = new FileReader();
    rd.onload = async function(){
      try{
        var r = await fetch('/api/ocr',{method:'POST',
          headers:{'Content-Type':'application/json'}, body: JSON.stringify({image: rd.result})});
        var j = await r.json();
        if(j.error){ showToast(j.error,'warn'); } else { showOcr(j); }
      }catch(e){ showToast('Could not read the image — try a sharper screenshot','warn'); }
    };
    rd.readAsDataURL(f);
  }
  /* Drag a screenshot anywhere onto the page → overlay appears → drop = scan.
     Ctrl+V with a screenshot in the clipboard scans too. */
  (function(){
    var ov = null, hideTimer = null;
    function overlay(){
      if(!ov){
        ov = document.createElement('div');
        ov.id = 'dropzone';
        ov.innerHTML = '<div class="dz-inner">📷<br/>Drop your bet-slip image<br/><small>we will read the booking code out of it automatically</small></div>';
        document.body.appendChild(ov);
      }
      return ov;
    }
    document.addEventListener('dragover', function(e){
      var types = (e.dataTransfer && e.dataTransfer.types) || [];
      var hasFile = false;
      for(var i=0;i<types.length;i++){ if(types[i]==='Files'){ hasFile=true; break; } }
      if(!hasFile) return;
      e.preventDefault();
      overlay().classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function(){ overlay().classList.remove('show'); }, 300);
    });
    document.addEventListener('drop', function(e){
      e.preventDefault();
      overlay().classList.remove('show');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if(f) ocrFile(f);
    });
    document.addEventListener('paste', function(e){
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for(var i=0;i<items.length;i++){
        if(items[i].type && items[i].type.indexOf('image') === 0){
          var f = items[i].getAsFile();
          if(f){ e.preventDefault(); ocrFile(f); break; }
        }
      }
    });
  })();
  function showOcr(j){
    var codes = (j && j.codes) || [];
    var rows = codes.length
      ? codes.map(function(c){
          return '<div class="ocr-row">'+
            '<span class="slipcode ccopy" title="Click to copy" onclick="cp(this,\\''+c.code+'\\')">'+c.code+'</span>'+
            '<span class="pill status s-'+c.status+'">'+c.status+'</span>'+
            (c.totalOdds ? '<span class="muted">'+c.totalOdds+' odds</span>' : '')+
            (c.games ? '<span class="muted">'+c.games+' games</span>' : '')+
            '<a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.sportybet.com/ng/?shareCode='+c.code+'">Open ↗</a>'+
          '</div>';
        }).join('')
      : '<div class="muted" style="padding:8px 0">No booking code found in this image. Make sure the code text is visible, sharp, and not cut off.</div>';
    var m = document.getElementById('ocrmodal');
    if(!m){ m = document.createElement('div'); m.id='ocrmodal'; document.body.appendChild(m); }
    m.innerHTML = '<div class="ocr-box">'+
      '<div class="ocr-head"><b>📷 Codes found in your image</b>'+
      '<button class="btn ghost sm" onclick="document.getElementById(\\'ocrmodal\\').remove()">✕ Close</button></div>'+
      rows+
      '<div class="muted small" style="margin-top:10px">Click a code to copy · status checked live against SportyBet</div>'+
    '</div>';
  }
  // friendly one-liner from a raw scan summary
  function niceSummary(s){
    try{
      var items=(s.match(/(\\d+) items/)||[])[1]||'?';
      var nw=(s.match(/(\\d+) new/)||[])[1];
      if(nw && nw!=='0'){ return '🎉 Scan complete · '+nw+' NEW code'+(nw==='1'?'':'s')+' found!'; }
      return '✓ Scan complete · '+items+' items checked · no new codes posted yet';
    }catch(e){}
    return '✓ Scan complete';
  }
  (function(){
    var NEXT = ${nextMs};
    var LASTRUN = "${lastRunIso}";
    var el = document.getElementById('countdown');
    // Show a toast for a scan that completed just before this page (re)loaded.
    try{ var done=sessionStorage.getItem('scanDone'); if(done){ sessionStorage.removeItem('scanDone'); showToast(done,'ok'); } }catch(e){}
    // Countdown display (updates every second).
    function tick(){
      if(!el) return;
      if(!NEXT){ el.textContent='—'; return; }
      var r = Math.round((NEXT - Date.now())/1000);
      if(r > 0){ var m=Math.floor(r/60), s=r%60; el.textContent = m+':'+(s<10?'0':'')+s; }
      else { el.textContent='scanning…'; }
    }
    tick(); setInterval(tick, 1000);
    // LIVE refresh: poll /health; reload the moment a new scan completes.
    async function poll(){
      try{
        var h = await (await fetch('/health',{cache:'no-store'})).json();
        if(h.nextRunAt){ NEXT = new Date(h.nextRunAt).getTime(); }
        if(h.lastRunAt && LASTRUN && h.lastRunAt !== LASTRUN){
          try{ sessionStorage.setItem('scanDone', niceSummary(h.lastSummary||'')); }catch(e){}
          location.reload();
        } else if(h.lastRunAt && !LASTRUN){ LASTRUN = h.lastRunAt; }
      }catch(e){}
    }
    setInterval(poll, 5000);
  })();
</script>
</body></html>`;
}

function kpi(icon: string, value: number | string, label: string, color: string): string {
  return `<div class="kpi ${color}"><div class="ic">${icon}</div><div><b>${value}</b><small>${label}</small></div></div>`;
}

function renderUpgrade(err = false): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Go Premium · SportyBet AI</title>
<style>
  body{margin:0;font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;background:#eef1f7;color:#141a2e}
  .wrap{max-width:1000px;margin:0 auto;padding:40px 24px}
  a{color:#f2683c;text-decoration:none}
  h1{font-size:28px;margin:0 0 6px}.lead{color:#64748b;margin-bottom:28px}
  .pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
  .plan{background:#fff;border:1px solid #e8ecf4;border-radius:16px;padding:24px;box-shadow:0 4px 16px rgba(16,24,40,.05)}
  .plan.pop{border:2px solid #f2683c;position:relative}
  .plan.pop::before{content:'MOST POPULAR';position:absolute;top:-11px;left:24px;background:#f2683c;color:#fff;font-size:10px;font-weight:800;padding:3px 10px;border-radius:6px}
  .plan h3{margin:0 0 4px;font-size:18px}
  .price{font-size:34px;font-weight:800;margin:10px 0}.price small{font-size:14px;color:#64748b;font-weight:500}
  ul{list-style:none;padding:0;margin:16px 0;font-size:13.5px;color:#475069}
  li{padding:7px 0;border-bottom:1px solid #eef1f8}
  li::before{content:'✓ ';color:#16a86b;font-weight:800}
  li.no{color:#a0a8bd}li.no::before{content:'✕ ';color:#c9cfdb}
  .btn{display:block;text-align:center;background:linear-gradient(135deg,#f2683c,#f7864f);color:#fff;
    border:0;border-radius:10px;padding:12px;font-weight:800;cursor:pointer;margin-top:12px;text-decoration:none}
  .btn.gold{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06}
  .btn.ghost{background:#fff;color:#141a2e;border:1px solid #e8ecf4}
  .demo{margin-top:28px;background:#fff;border:1px solid #e8ecf4;border-radius:14px;padding:20px}
  .demo input{padding:10px 12px;border:1px solid #e8ecf4;border-radius:10px;font-size:14px;width:200px}
  .err{color:#e5484d;font-size:13px;margin-top:8px}
  .note{color:#64748b;font-size:12.5px;margin-top:10px}
</style></head><body><div class="wrap">
  <a href="/">← Back to dashboard</a>
  <h1 style="margin-top:14px">Unlock the codes that win 👑</h1>
  <div class="lead">Free gives you a taste. Premium gives you speed and the one-click booking codes.</div>
  <div class="pricing">
    <div class="plan">
      <h3>Free</h3><div class="price">₦0</div>
      <ul><li>Codes delayed ${config.freeDelayMin} min</li><li>1 AI slip (preview)</li>
      <li class="no">Instant fresh codes</li><li class="no">One-click booking codes</li>
      <li class="no">VIP pick</li><li class="no">Real-time alerts</li></ul>
      <a class="btn ghost" href="/">Current plan</a>
    </div>
    <div class="plan pop">
      <h3>Pro</h3><div class="price">₦2,500<small>/mo</small></div>
      <ul><li><b>Instant</b> booking codes</li><li>All AI slips + <b>booking codes</b></li>
      <li>Real-time alerts</li><li>Performance analytics (ROI)</li><li>Ad-free</li><li class="no">VIP exclusive pick</li></ul>
      <a class="btn" href="/checkout?plan=pro">Get Pro</a>
    </div>
    <div class="plan">
      <h3>VIP</h3><div class="price">₦6,000<small>/mo</small></div>
      <ul><li>Everything in Pro</li><li><b>👑 VIP high-confidence pick</b></li>
      <li>Priority sources</li><li>Multi-bookmaker codes</li><li>API access</li><li>Priority support</li></ul>
      <a class="btn gold" href="/checkout?plan=vip">Get VIP</a>
    </div>
  </div>
  <div class="demo">
    <b>Try Premium now (demo)</b>
    <div class="note">Real checkout uses Stripe / Paystack / Flutterwave (needs your keys). For now, enter the demo access code to preview the Premium experience.</div>
    <form action="/unlock" method="get" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <input name="key" placeholder="demo access code" autocomplete="off"/>
      <button class="btn" style="width:auto;padding:10px 18px;margin:0" type="submit">Unlock Premium</button>
    </form>
    ${err ? '<div class="err">Invalid access code.</div>' : ""}
    <div class="note">Hint for testing: the default demo code is <code>vip2026</code> (set via PREMIUM_ACCESS_KEY).</div>
  </div>
</div></body></html>`;
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

      // ---- App access gate ----
      // If APP_PASSWORD is set, every route requires a valid auth cookie except
      // the login page/handler and /health (kept open for uptime monitors).
      // External viewers can't load any page — or its source — without it.
      if (config.appPassword) {
        const authToken = sha256Hex(config.appPassword);
        const cookies = req.headers.cookie ?? "";
        const authed = new RegExp(`(?:^|;\\s*)app_auth=${authToken}(?:;|$)`).test(cookies);
        const open = url.pathname === "/login" || url.pathname === "/health";
        if (url.pathname === "/logout") {
          res.writeHead(303, { "Set-Cookie": "app_auth=; Path=/; Max-Age=0; SameSite=Lax", Location: "/login" });
          res.end();
          return;
        }
        if (url.pathname === "/login" && req.method === "POST") {
          const body = new URLSearchParams((await readBody(req, 4096)) || "");
          if (body.get("password") === config.appPassword) {
            res.writeHead(303, {
              // 30-day session; HttpOnly so page scripts can't read it.
              "Set-Cookie": `app_auth=${authToken}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
              Location: "/",
            });
            res.end();
          } else {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderLogin(true));
          }
          return;
        }
        if (!authed && !open) {
          res.writeHead(url.pathname === "/login" ? 200 : 401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLogin(false));
          return;
        }
      }

      const modeParam = url.searchParams.get("mode");
      const mode: Mode =
        modeParam === "ai"
          ? "ai"
          : modeParam === "pred"
            ? "pred"
            : modeParam === "expert"
              ? "expert"
              : modeParam === "value"
                ? "value"
                : modeParam === "combo"
                  ? "combo"
                  : modeParam === "analysis"
                    ? "analysis"
                    : modeParam === "saved"
                      ? "saved"
                      : "human";
      const tier: Tier =
        config.defaultTier === "premium" ||
        /(?:^|;\s*)tier=premium(?:;|$)/.test(req.headers.cookie ?? "")
          ? "premium"
          : "free";

      // Admin sees source-revealing info (which channel a code came from,
      // crawl activity). If no ADMIN_KEY is configured, treat everyone as admin
      // so the owner isn't locked out of their own data by default.
      const isAdmin =
        !config.adminKey ||
        new RegExp(`(?:^|;\\s*)admin=${sha256Hex(config.adminKey)}(?:;|$)`).test(req.headers.cookie ?? "");

      // Admin unlock / lock routes.
      if (url.pathname === "/admin") {
        if (config.adminKey && url.searchParams.get("key") === config.adminKey) {
          res.writeHead(303, {
            "Set-Cookie": `admin=${sha256Hex(config.adminKey)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
            Location: "/",
          });
        } else {
          res.writeHead(303, { Location: "/" });
        }
        res.end();
        return;
      }
      if (url.pathname === "/admin/off") {
        res.writeHead(303, { "Set-Cookie": "admin=; Path=/; Max-Age=0; SameSite=Lax", Location: "/" });
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/scan") {
        // Fire in the background so the button returns instantly; the dashboard
        // polls /health and refreshes when the scan completes.
        void runCycle("manual");
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, started: true }));
        return;
      }
      if (url.pathname === "/upgrade") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderUpgrade(url.searchParams.get("err") === "1"));
        return;
      }
      if (url.pathname === "/unlock") {
        if (url.searchParams.get("key") === config.premiumKey) {
          // Demo premium unlock. Real billing = Stripe/Paystack webhook later.
          res.writeHead(303, {
            "Set-Cookie": "tier=premium; Path=/; Max-Age=2592000; SameSite=Lax",
            Location: "/",
          });
          res.end();
        } else {
          res.writeHead(303, { Location: "/upgrade?err=1" });
          res.end();
        }
        return;
      }
      if (url.pathname === "/downgrade") {
        res.writeHead(303, { "Set-Cookie": "tier=; Path=/; Max-Age=0", Location: "/" });
        res.end();
        return;
      }
      if (url.pathname === "/checkout") {
        // Placeholder for real payment provider redirect (Stripe/Paystack/Flutterwave).
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px;color:#141a2e">
           <h2>Checkout — ${esc(url.searchParams.get("plan") ?? "pro")} plan</h2>
           <p>This is where the real payment flow goes. Wire up Stripe, Paystack, or Flutterwave
           (needs your API keys) and, on a successful webhook, mark the user Premium.</p>
           <p><a href="/upgrade">← Back</a> · <a href="/unlock?key=${esc(config.premiumKey)}">Simulate successful payment →</a></p>
           </body>`,
        );
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            lastRunAt,
            nextRunAt,
            intervalSec,
            lastSummary,
            telegramApi: telegramClientEnabled() ? "live" : "web-preview",
          }),
        );
        return;
      }
      if (url.pathname === "/api/codes") {
        const data = await prisma.humanCode.findMany({
          orderBy: { foundAt: "desc" },
          take: 100,
          include: { source: { select: { name: true } }, score: true },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data, meta: { total: data.length } }));
        return;
      }
      if (url.pathname === "/api/ai-slips") {
        const data = await prisma.aiBetSlip.findMany({ orderBy: { totalOdds: "asc" } });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data, meta: { total: data.length } }));
        return;
      }
      if (url.pathname === "/api/predictions") {
        const data = await getPredictions();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data, meta: { total: data.length } }));
        return;
      }
      if (url.pathname === "/api/expert/record") {
        const data = await getExpertRecord();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (url.pathname === "/api/expert/roi") {
        const data = await getExpertRoi();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/predictions/book") {
        // Book the user's selected predictions into a REAL SportyBet code.
        // A booking code saves selections only — no bet is placed, no money moves.
        const json = (s: number, o: unknown) => {
          res.writeHead(s, { "Content-Type": "application/json" });
          res.end(JSON.stringify(o));
        };
        let keys: string[] = [];
        let gameType: GameType = "result";
        let generatorName = "Anonymous";
        let origin = "predictions";
        try {
          const body = JSON.parse((await readBody(req, 64 * 1024)) || "{}");
          keys = Array.isArray(body.keys) ? body.keys.map((k: unknown) => String(k)) : [];
          gameType = validGameType(body.gameType);
          if (body.name) generatorName = String(body.name).trim().slice(0, 60) || "Anonymous";
          if (body.origin === "expert" || body.origin === "combo") origin = String(body.origin);
        } catch {
          return json(400, { error: "Bad request body." });
        }
        if (keys.length < 1) return json(400, { error: "Select at least 1 match." });
        if (keys.length > 70) return json(400, { error: "Maximum 70 matches per booking code." });

        // Path 1: keys backed by an external tip (Predictions tab cards).
        const preds = await getPredictions();
        const wanted = preds.filter(
          (p) => p.home && p.away && keys.includes(`${p.home}|${p.away}`.toLowerCase()),
        );
        const { legs: tipLegs, matchedKeys: tipMatched } = wanted.length
          ? await planForTips(wanted)
          : { legs: [], matchedKeys: [] as string[] };

        // Path 2: any leftover keys — e.g. from Expert Picks, which sources
        // selections straight from SportyBet's fixture list rather than an
        // external tip. Book directly against SportyBet's own favourite for
        // that fixture (same pick Expert Picks displayed).
        const remainingKeys = keys.filter((k) => !tipMatched.includes(k));
        const { legs: directLegs, matchedKeys: directMatched } = await legsForFixtureKeys(remainingKeys, gameType);

        const legs = [...tipLegs, ...directLegs];
        const matchedSet = new Set([...tipMatched, ...directMatched]);

        // Human-readable names for the skip report, preferring proper casing
        // from whichever source resolved the fixture.
        const nameByKey = new Map<string, string>();
        for (const p of wanted) if (p.home && p.away) nameByKey.set(`${p.home}|${p.away}`.toLowerCase(), `${p.home} v ${p.away}`);
        for (const l of legs) nameByKey.set(`${l.home}|${l.away}`.toLowerCase(), `${l.home} v ${l.away}`);
        const titleFromKey = (k: string) =>
          k
            .split("|")
            .slice(0, 2) // drop any trailing outcome-code part (value-pick keys)
            .map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase()))
            .join(" v ");
        const skipped = keys.filter((k) => !matchedSet.has(k)).map((k) => nameByKey.get(k) ?? titleFromKey(k));

        if (!legs.length)
          return json(422, {
            error: "None of those matches are on SportyBet right now (kicked off, or not offered) — try other matches.",
          });
        const booking = await createBookingCode(
          legs.map((l) => ({
            eventId: l.eventId,
            marketId: l.marketId,
            specifier: l.specifier,
            outcomeId: l.outcomeId,
          })),
        );
        if (!booking.code)
          return json(502, { error: "SportyBet booking failed — try again in a minute." });
        const totalOdds = Math.round(legs.reduce((a, l) => a * l.odds, 1) * 100) / 100;

        // Save the generated code to the ledger with day+time (createdAt) and
        // who generated it. Best-effort — never fail the booking over this.
        try {
          await prisma.generatedCode.create({
            data: {
              code: booking.code,
              url: booking.url,
              generatorName,
              origin,
              games: booking.games ?? legs.length,
              totalOdds,
              legs: legs.map((l) => ({
                home: l.home,
                away: l.away,
                league: l.league,
                pick: l.pick,
                odds: l.odds,
                kickoff: l.kickoff,
              })) as any,
            },
          });
        } catch {
          /* ledger save failed — booking still succeeded, continue */
        }

        return json(200, {
          code: booking.code,
          url: booking.url,
          games: booking.games ?? legs.length,
          requested: keys.length,
          matched: legs.length,
          skipped,
          totalOdds,
          savedBy: generatorName,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/ocr") {
        // Bet-slip image scanner: OCR the uploaded image, extract code-shaped
        // tokens, and verify each against SportyBet's official API.
        const json = (s: number, o: unknown) => {
          res.writeHead(s, { "Content-Type": "application/json" });
          res.end(JSON.stringify(o));
        };
        let b64 = "";
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          b64 = String(body.image ?? "").replace(/^data:image\/[a-z+.-]+;base64,/i, "");
        } catch (e: any) {
          return json(400, { error: e?.message === "payload too large" ? "Image too large (max ~7MB)." : "Bad request body." });
        }
        if (!b64) return json(400, { error: "No image provided." });
        const buf = Buffer.from(b64, "base64");
        if (buf.length < 100) return json(400, { error: "Image could not be decoded." });
        const text = await ocrBuffer(buf);
        if (!text) return json(200, { text: "", codes: [] });
        const { codes } = extract(text, { aggressive: true });
        const results: {
          code: string;
          status: string;
          totalOdds?: number;
          games?: number;
        }[] = [];
        for (const code of codes.slice(0, 6)) {
          const e = await verifyCode(code);
          results.push({
            code,
            status: e.transientError ? "UNVERIFIED" : e.status,
            totalOdds: e.totalOdds,
            games: e.numberOfGames,
          });
        }
        // Real codes first: ACTIVE, then UNVERIFIED/EXPIRED, junk INVALID last.
        const rank = (s: string) => (s === "ACTIVE" ? 0 : s === "INVALID" ? 2 : 1);
        results.sort((a, b) => rank(a.status) - rank(b.status));
        return json(200, { text: text.slice(0, 400), codes: results });
      }
      const dateStr = url.searchParams.get("date") ?? "";
      const countDefault = mode === "analysis" ? 12 : 5;
      const expertCount = Math.max(1, Math.min(70, Number(url.searchParams.get("n")) || countDefault));
      // Value mode defaults to a wider window (14d) since overlays are sparse;
      // other modes default to 5 days.
      const daysDefault = mode === "value" ? 14 : 5;
      const expertDays = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || daysDefault));
      const typeParam = url.searchParams.get("type");
      // Default view = the daily "safe picks" mix (high strike-rate markets).
      const expertGameType: GameType = typeParam ? validGameType(typeParam) : "safe";
      const expertMinConf = Math.max(0, Math.min(90, Number(url.searchParams.get("minconf")) || 0));
      const html = await renderDashboard(
        mode,
        tier,
        dateStr,
        {
          count: expertCount,
          days: expertDays,
          gameType: expertGameType,
          minConfidence: expertMinConf, // plain percentage (0/50/60/70/80/90) — kept for form state
        },
        isAdmin,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${err?.message ?? err}`);
    }
  });

  server.listen(config.port, () => {
    console.log(`Dashboard:  http://localhost:${config.port}`);
    console.log(`Health:     http://localhost:${config.port}/health`);
    console.log(`JSON API:   http://localhost:${config.port}/api/codes`);
  });
  return server;
}
