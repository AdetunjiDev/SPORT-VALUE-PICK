import http from "node:http";
import { prisma } from "@sportybet/db";
import { RESPONSIBLE_GAMBLING_DISCLAIMER } from "@sportybet/shared";
import { config } from "./config.js";
import { runCycle, lastRunAt, nextRunAt, lastSummary, intervalSec } from "./scheduler.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stars(n: number): string {
  const v = Math.max(0, Math.min(5, n));
  return "★".repeat(v) + "☆".repeat(5 - v);
}

type Mode = "human" | "ai";
type Tier = "free" | "premium";

async function renderDashboard(mode: Mode = "human", tier: Tier = "free"): Promise<string> {
  const isPremium = tier === "premium";
  const freshCut = Date.now() - config.freeDelayMin * 60_000;
  const [codes, totalCodes, sourceCount, lastRuns, aiSlips, activeCount] = await Promise.all([
    prisma.humanCode.findMany({
      orderBy: { foundAt: "desc" },
      take: 60,
      include: { source: true, score: true },
    }),
    prisma.humanCode.count(),
    prisma.source.count({ where: { enabled: true } }),
    prisma.crawlRun.findMany({ orderBy: { startedAt: "desc" }, take: 8, include: { source: true } }),
    prisma.aiBetSlip.findMany({ orderBy: { totalOdds: "asc" } }),
    prisma.humanCode.count({ where: { status: "ACTIVE" } }),
  ]);

  const latest = codes[0];
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
        <div class="hero-src">${esc(latest.source?.name ?? "—")} · ${new Date(latest.foundAt).toLocaleTimeString()}</div>
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
        <td class="muted">${c.expiresAt ? new Date(c.expiresAt).toLocaleString() : "—"}</td>
        <td class="muted">${esc(c.source?.name ?? "—")}</td>
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

  const nav = (m: Mode, icon: string, label: string, active: boolean) =>
    `<a class="nav-item${active ? " on" : ""}" href="/?mode=${m}"><span class="ni">${icon}</span>${label}</a>`;

  // ---- KPI cards (mode-aware) ----
  const kpis =
    mode === "ai"
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

  const body =
    mode === "ai"
      ? `<div class="cards">${aiCards || '<div class="card empty">No AI slips right now — not enough upcoming matches (common late at night). Fresh slips generate automatically as new fixtures and codes come in.</div>'}</div>`
      : `<div class="split">
          <div class="col-main">
            ${heroCard}
            <div class="card">
              <div class="card-head"><h3>Discovered booking codes</h3><span class="muted">${codes.length} shown</span></div>
              <div class="table-wrap">
                <table class="grid-table">
                  <thead><tr>
                    <th>Code</th><th>Type</th><th>Score</th><th>Odds</th><th>Games</th>
                    <th>League</th><th>Expires</th><th>Source</th><th>Status</th>
                  </tr></thead>
                  <tbody id="rows">${rows || `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">No codes yet — click “Scan now”.</td></tr>`}</tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col-side">
            <div class="card">
              <div class="card-head"><h3>Crawl activity</h3></div>
              <ul class="runs">${runRows || '<li class="muted">No runs yet.</li>'}</ul>
              <div class="muted small mono">${esc(lastSummary)}</div>
            </div>
          </div>
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
  .split{display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start}
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
  .empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:30px}
  .disclaimer{color:var(--muted);font-size:12px;margin-top:6px;text-align:center;padding:8px}
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
    <div class="nav-label">Data</div>
    <a class="nav-item" href="/api/codes" target="_blank"><span class="ni">🔗</span>Codes API</a>
    <a class="nav-item" href="/api/ai-slips" target="_blank"><span class="ni">🧠</span>AI Slips API</a>
    <a class="nav-item" href="/health" target="_blank"><span class="ni">💓</span>Health</a>
    <div class="side-foot">
      <span class="live-dot"></span>Live · scans every ${Math.round(intervalSec / 60)} min<br/>
      <span style="opacity:.8">18+ · Bet responsibly</span>
    </div>
  </aside>
  <div class="app">
    <div class="topbar">
      <div>
        <h1>${mode === "ai" ? "AI-Generated Slips" : "Booking Code Dashboard"}</h1>
        <div class="sub">${mode === "ai" ? "Model recommendations with auto-generated booking codes" : "Live codes discovered & verified against SportyBet"}</div>
      </div>
      <div class="search"><input id="search" placeholder="Search codes, leagues, sources…" oninput="flt(this.value)"/></div>
      <div class="top-right">
        <span class="chip chip-live">Next scan <b id="countdown">—</b></span>
        ${
          isPremium
            ? `<span class="tier-badge tier-premium">👑 PREMIUM</span>`
            : `<span class="tier-badge tier-free">FREE</span><a class="btn gold" href="/upgrade">⭐ Upgrade</a>`
        }
        <button class="btn" onclick="doScan(this)">⟳ Scan now</button>
      </div>
    </div>
    <div class="content">
      ${
        isPremium
          ? ""
          : `<div class="upsell"><div class="grow"><b>You're on the Free plan.</b><br/>Fresh codes are delayed ${config.freeDelayMin} min and AI booking codes are locked. Go Premium for instant codes + one-click booking.</div><a class="btn gold" href="/upgrade">⭐ See plans</a></div>`
      }
      <div class="kpis">${kpis}</div>
      ${body}
      <div class="disclaimer">⚠️ ${esc(RESPONSIBLE_GAMBLING_DISCLAIMER)} ${
        mode === "ai"
          ? "AI slips are model estimates — booking codes save selections only; review & stake yourself."
          : "Codes verified against SportyBet's official API."
      }</div>
    </div>
  </div>
</div>
<script>
  function cp(el, code){
    navigator.clipboard.writeText(code);
    var o = el.textContent; el.textContent = 'Copied!';
    setTimeout(function(){ el.textContent = o; }, 1200);
  }
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
  // friendly one-liner from a raw scan summary
  function niceSummary(s){
    try{
      var m=s.match(/(\\d+) items[\\s\\S]*?(\\d+) new[\\s\\S]*?(\\d+) verified/);
      if(m){ return 'Scan complete · '+m[2]+' new code'+(m[2]==='1'?'':'s')+' · '+m[1]+' items checked'; }
    }catch(e){}
    return 'Scan complete';
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

function kpi(icon: string, value: number, label: string, color: string): string {
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
      const mode: Mode = url.searchParams.get("mode") === "ai" ? "ai" : "human";
      const tier: Tier =
        config.defaultTier === "premium" ||
        /(?:^|;\s*)tier=premium(?:;|$)/.test(req.headers.cookie ?? "")
          ? "premium"
          : "free";

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
        res.end(JSON.stringify({ ok: true, lastRunAt, nextRunAt, intervalSec, lastSummary }));
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
      const html = await renderDashboard(mode, tier);
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
