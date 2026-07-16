import http from "node:http";
import { createHash } from "node:crypto";
import { prisma } from "@sportybet/db";
import { RESPONSIBLE_GAMBLING_DISCLAIMER } from "@sportybet/shared";
import { config } from "./config.js";
import { runCycle, lastRunAt, nextRunAt, lastSummary, intervalSec } from "./scheduler.js";
import { getPredictions } from "./predictions.js";
import { planForTips, legsForFixtureKeys, getSportyFixtures, fuzzyTeamsMatch } from "./forebet-ai.js";
import { createBookingCode } from "./booker.js";
import { ocrBuffer } from "./ocr.js";
import { extract } from "./extractor.js";
import { verifyCode } from "./verifier.js";
import { telegramClientEnabled } from "./adapters/telegram-client.js";
import { hashPassword, verifyPassword, signSession, verifySession, readCookie, rateLimited, EMAIL_RE } from "./auth.js";
import { PLANS, validPlan, paystackEnabled, initTransaction, verifyAndGrant, grantFromCharge, webhookSignatureValid, getBusinessMetrics } from "./billing.js";
import type { BusinessMetrics } from "./billing.js";
import {
  getExpertPicks,
  getExpertRecord,
  getExpertRoi,
  getValuePicks,
  getCombos,
  type GameType,
} from "./analyst.js";
import { getMatchAnalyses, analyzeEvent } from "./xg.js";
import { getFormsForMatches, getMatchForm, type MatchForm } from "./form.js";
import { analystAnswer } from "./analyst-chat.js";
import { BOOKMAKERS, getBookmaker, activeBookmaker } from "./bookmakers.js";

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

// ---------------------------------------------------------------------------
// Auth experience (login / signup).
// One premium violet-glass onboarding screen: 3D animated hero panel on the
// left, a sliding "Sign in / Create account" switcher on the right. /login
// and /signup both render this page with the matching tab active, so moving
// between them is instant (no reload) while deep links and the browser back
// button keep working via history.replaceState.
// ---------------------------------------------------------------------------

const LOGIN_ERRORS: Record<string, string> = {
  "1": "Wrong password. Try again.",
  bad: "Email or password is incorrect.",
  rate: "Too many attempts — wait a few minutes and try again.",
  signup: "Please sign in to continue.",
};

const SIGNUP_ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  pw: "Password must be at least 8 characters.",
  match: "Passwords don't match.",
  exists: "An account with this email already exists — sign in instead.",
  rate: "Too many signups from this connection — try again later.",
  off: "Self-registration is disabled.",
};

function renderAuth(
  active: "login" | "signup",
  opts: { loginErr?: string | null; signupErr?: string | null; notice?: string } = {},
): string {
  const canSignup = config.allowSignup;
  const tab: "login" | "signup" = canSignup && active === "signup" ? "signup" : "login";
  const loginErr = opts.loginErr && LOGIN_ERRORS[opts.loginErr] ? LOGIN_ERRORS[opts.loginErr] : null;
  const signupErr = opts.signupErr && SIGNUP_ERRORS[opts.signupErr] ? SIGNUP_ERRORS[opts.signupErr] : null;

  const eyeBtn = `<button type="button" class="eye" aria-label="Show password" aria-pressed="false" tabindex="-1">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><line class="slash" x1="4" y1="20" x2="20" y2="4"/></svg>
  </button>`;

  const ownerForm = config.appPassword
    ? `<details class="owner"${opts.loginErr === "1" ? " open" : ""}>
      <summary>Owner / staff access password</summary>
      <form method="post" action="/login" class="af" style="margin-top:10px">
        <div class="field"><input type="password" name="password" placeholder="Access password" autocomplete="current-password"/>${eyeBtn}</div>
        <button type="submit" class="btn"><span class="bl">Sign in with password</span></button>
      </form>
    </details>`
    : "";

  const loginPane = `<div class="pane${tab === "login" ? " on" : ""}" id="pane-login" role="tabpanel">
    <h1>Welcome back</h1>
    <p class="hint">Sign in to see today's verified codes</p>
    ${opts.notice ? `<div class="ok">${esc(opts.notice)}</div>` : ""}
    ${loginErr ? `<div class="err">${loginErr}</div>` : ""}
    <form method="post" action="/login" class="af">
      <div class="field"><input type="email" name="email" placeholder="Email" autocomplete="email" data-focus="1"/></div>
      <div class="field"><input type="password" name="password" placeholder="Password" autocomplete="current-password"/>${eyeBtn}</div>
      <button type="submit" class="btn"><span class="bl">Sign in</span></button>
    </form>
    ${canSignup ? `<div class="alt">New here? <a href="/signup" data-go="signup">Create a free account</a></div>` : ""}
    ${ownerForm}
  </div>`;

  const signupPane = canSignup
    ? `<div class="pane${tab === "signup" ? " on" : ""}" id="pane-signup" role="tabpanel">
    <h1>Create your account</h1>
    <p class="hint">Free to join — live verified codes in seconds</p>
    ${signupErr ? `<div class="err">${signupErr}</div>` : ""}
    <form method="post" action="/signup" class="af">
      <div class="field"><input type="email" name="email" placeholder="Email" autocomplete="email" data-focus="1"/></div>
      <div class="field"><input type="password" name="password" id="suPw" placeholder="Password (min 8 characters)" autocomplete="new-password"/>${eyeBtn}</div>
      <div class="meter" id="meter" data-score="0" aria-hidden="true"><i></i><i></i><i></i><em id="mlab"></em></div>
      <div class="field" id="cfField"><input type="password" name="confirm" id="suCf" placeholder="Confirm password" autocomplete="new-password"/>${eyeBtn}</div>
      <button type="submit" class="btn"><span class="bl">Create free account</span></button>
    </form>
    <div class="alt">Already have an account? <a href="/login" data-go="login">Sign in</a></div>
  </div>`
    : "";

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="theme-color" content="#f4f1fb"/>
<title>Sporty Value Pick AI · ${tab === "signup" ? "Create account" : "Sign in"}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap" media="print" onload="this.media='all'"/>
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap"/></noscript>
<style>
  /* Web fonts load non-blockingly via <link> in <head> so first paint never waits on the network (works offline too). */
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;overflow-x:hidden;
    background:
      radial-gradient(900px 520px at 80% -10%,rgba(124,58,237,.14),transparent 60%),
      radial-gradient(700px 480px at -10% 30%,rgba(56,189,248,.09),transparent 55%),
      radial-gradient(700px 600px at 50% 115%,rgba(168,85,247,.12),transparent 62%),
      #f4f1fb;
    font-family:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#1a1333}
  /* --- ambient drifting glow blobs --- */
  .cosmos{position:fixed;inset:0;pointer-events:none;z-index:0}
  .blob{position:absolute;border-radius:50%;filter:blur(70px);opacity:.26}
  .b1{width:420px;height:420px;left:-120px;top:-100px;background:rgba(124,58,237,.35);animation:drift 16s ease-in-out infinite alternate}
  .b2{width:360px;height:360px;right:-110px;bottom:-90px;background:rgba(168,85,247,.28);animation:drift 20s ease-in-out infinite alternate-reverse}
  .b3{width:240px;height:240px;left:55%;top:8%;background:rgba(56,189,248,.14);animation:drift 24s ease-in-out infinite alternate}
  @keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(60px,40px) scale(1.12)}}

  /* --- glass shell --- */
  .shell{position:relative;z-index:1;display:grid;grid-template-columns:1.05fr 1fr;width:min(940px,96vw);
    background:#ffffff;
    border:1px solid rgba(124,58,237,.18);border-radius:26px;overflow:hidden;
    box-shadow:0 30px 80px rgba(76,29,149,.18),0 2px 8px rgba(24,12,60,.06);
    animation:rise .65s cubic-bezier(.22,1,.36,1) both;transform-style:preserve-3d;will-change:transform;
    transition:transform .18s ease}
  @keyframes rise{from{opacity:0;transform:translateY(26px) scale(.97)}to{opacity:1;transform:none}}

  /* --- brand / onboarding panel --- */
  .brand{position:relative;padding:38px 36px 30px;overflow:hidden;
    background:linear-gradient(165deg,rgba(124,58,237,.30),rgba(20,13,46,.2) 55%),#120b2b;
    border-right:1px solid rgba(139,92,246,.22)}
  .brand::after{content:"";position:absolute;width:340px;height:340px;right:-140px;top:-140px;border-radius:50%;
    border:1px solid rgba(167,139,250,.18);pointer-events:none;z-index:2}
  /* Action photo backdrop: violet duotone veil + slow Ken Burns zoom; the img
     removes itself on load failure so the gradient panel is the fallback. */
  .brand .ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 18%;
    opacity:0;transform:scale(1.06);transition:opacity .7s ease,transform 7s ease;filter:saturate(.85) contrast(1.05)}
  .brand .ph.on{opacity:.5;transform:scale(1)}
  .brand .veil{position:absolute;inset:0;z-index:1;
    background:linear-gradient(165deg,rgba(124,58,237,.38),rgba(18,11,43,.55) 45%,rgba(18,11,43,.88) 78%,#120b2b 97%)}
  .brand>:not(.ph):not(.veil){position:relative;z-index:2}
  .mark{display:flex;align-items:center;gap:10px;font-family:'Sora',sans-serif;font-weight:800;font-size:15px;letter-spacing:.3px}
  .mark i{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-style:normal;font-size:17px;
    background:linear-gradient(145deg,#a78bfa,#7c3aed 60%,#4c1d95);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 20px rgba(124,58,237,.5)}
  /* 3D hero: floating ball + tilted orbit rings + orbiting sparks */
  .hero3d{position:relative;width:170px;height:170px;margin:22px auto 20px;perspective:700px}
  .ring{position:absolute;left:50%;top:50%;border-radius:50%;border:1px solid rgba(167,139,250,.35);pointer-events:none}
  .r1{width:160px;height:160px;margin:-80px;transform:rotateX(68deg);animation:ringpulse 5s ease-in-out infinite}
  .r2{width:120px;height:120px;margin:-60px;transform:rotateX(68deg) rotateY(14deg);border-color:rgba(56,189,248,.25);animation:ringpulse 5s ease-in-out 1.2s infinite}
  @keyframes ringpulse{0%,100%{opacity:.55}50%{opacity:1}}
  .dot{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%}
  .d1{background:#a78bfa;box-shadow:0 0 14px 2px rgba(167,139,250,.9);animation:orbit 6.5s linear infinite}
  .d2{width:6px;height:6px;margin:-3px;background:#38bdf8;box-shadow:0 0 12px 2px rgba(56,189,248,.8);animation:orbit 9s linear reverse infinite}
  .d3{width:5px;height:5px;margin:-2.5px;background:#f0abfc;box-shadow:0 0 10px 2px rgba(240,171,252,.8);animation:orbit 12s linear .8s infinite}
  @keyframes orbit{from{transform:rotate(0deg) translateX(76px) rotate(0deg)}to{transform:rotate(360deg) translateX(76px) rotate(-360deg)}}
  .ball{position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px;border-radius:50%;display:grid;place-items:center;
    font-size:56px;background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.28),rgba(255,255,255,0) 42%),
    radial-gradient(circle at 60% 70%,rgba(124,58,237,.55),rgba(30,17,66,.9) 75%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 18px 44px rgba(76,29,149,.65),0 0 60px rgba(139,92,246,.35);
    animation:float 5s ease-in-out infinite}
  @keyframes float{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-10px) rotate(3deg)}}
  .bshadow{position:absolute;left:50%;bottom:2px;width:90px;height:14px;margin-left:-45px;border-radius:50%;
    background:radial-gradient(ellipse,rgba(3,0,20,.65),transparent 70%);animation:shadowpulse 5s ease-in-out infinite}
  @keyframes shadowpulse{0%,100%{transform:scaleX(1);opacity:.8}50%{transform:scaleX(.78);opacity:.5}}
  .brand h2{font-family:'Sora',sans-serif;font-size:24px;line-height:1.25;margin:0 0 8px;text-align:center;letter-spacing:.2px}
  .grad{background:linear-gradient(90deg,#c4b5fd,#a78bfa,#38bdf8);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:#9a91bd;font-size:13px;line-height:1.55;text-align:center;margin:0 0 20px}
  .feats{list-style:none;margin:0;padding:0;display:grid;gap:10px}
  .feats li{display:flex;gap:12px;align-items:center;padding:10px 12px;border-radius:14px;
    background:rgba(15,9,36,.5);border:1px solid rgba(255,255,255,.08);
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
    animation:featin .55s cubic-bezier(.22,1,.36,1) both}
  .feats li:nth-child(1){animation-delay:.15s}.feats li:nth-child(2){animation-delay:.28s}.feats li:nth-child(3){animation-delay:.41s}
  @keyframes featin{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
  .fi{width:34px;height:34px;flex:0 0 34px;border-radius:10px;display:grid;place-items:center;font-size:16px;
    background:rgba(139,92,246,.16);border:1px solid rgba(139,92,246,.3)}
  .feats b{display:block;font-size:13px}
  .feats small{color:#9a91bd;font-size:11.5px}
  .trust{margin-top:18px;text-align:center;font-size:11.5px;color:#8d84b3}

  /* --- form panel --- */
  .side{padding:32px 32px 26px;display:flex;flex-direction:column}
  .tabs{position:relative;display:grid;grid-template-columns:1fr 1fr;background:rgba(24,12,60,.05);
    border:1px solid rgba(24,12,60,.09);border-radius:999px;padding:4px;margin-bottom:22px}
  .tabs .ind{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 4px);border-radius:999px;
    background:linear-gradient(135deg,#a78bfa,#7c3aed);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 6px 18px rgba(124,58,237,.45);
    transition:transform .32s cubic-bezier(.22,1,.36,1)}
  .tabs[data-tab="signup"] .ind{transform:translateX(100%)}
  .tab{position:relative;z-index:1;border:0;background:none;padding:10px 6px;border-radius:999px;cursor:pointer;
    font-family:'Inter',sans-serif;font-weight:700;font-size:13.5px;color:#6b6490;transition:color .25s}
  .tabs[data-tab="login"] #tabLogin,.tabs[data-tab="signup"] #tabSignup{color:#fff}
  .pane{display:none}
  .pane.on{display:block;animation:panein .32s cubic-bezier(.22,1,.36,1)}
  @keyframes panein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  h1{font-family:'Sora','Inter',sans-serif;font-size:20px;margin:0 0 4px;letter-spacing:.2px}
  .hint{color:#6b6490;font-size:13px;margin:0 0 18px}
  .field{position:relative;margin-bottom:12px}
  input{width:100%;padding:12px 44px 12px 14px;border:1px solid rgba(24,12,60,.16);border-radius:12px;background:#fff;
    color:#1a1333;font-size:15px;outline:none;transition:border-color .15s,background .15s,box-shadow .15s}
  input::placeholder{color:#8b85ab}
  input:focus{border-color:#8b5cf6;background:#fff;box-shadow:0 0 0 3px rgba(139,92,246,.16)}
  #cfField.bad input{border-color:rgba(251,113,133,.7)}
  #cfField.good input{border-color:rgba(52,211,153,.6)}
  .eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;cursor:pointer;
    color:#7d74a3;padding:8px;border-radius:10px;line-height:0;transition:color .15s}
  .eye:hover{color:#7c3aed}
  .eye .slash{opacity:0;transition:opacity .15s}
  .eye[aria-pressed="true"] .slash{opacity:1}
  .btn{position:relative;width:100%;padding:13px;border:0;border-radius:12px;font-weight:800;font-size:15px;cursor:pointer;
    font-family:'Inter',sans-serif;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 10px 26px rgba(124,58,237,.45);
    transition:transform .12s,filter .12s;overflow:hidden}
  .btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
  .btn:active{transform:translateY(0) scale(.99)}
  .btn.busy{pointer-events:none;filter:saturate(.7) brightness(.9)}
  .btn.busy .bl{visibility:hidden}
  .btn.busy::after{content:"";position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px;
    border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spinload .7s linear infinite}
  @keyframes spinload{to{transform:rotate(360deg)}}
  .meter{display:flex;align-items:center;gap:6px;margin:-4px 2px 12px;min-height:12px}
  .meter i{height:4px;flex:1;border-radius:99px;background:rgba(24,12,60,.10);transition:background .25s}
  .meter em{font-style:normal;font-size:11px;color:#7d74a3;min-width:44px;text-align:right}
  .meter[data-score="1"] i:nth-child(1){background:#fb7185}
  .meter[data-score="2"] i:nth-child(-n+2){background:#fbbf24}
  .meter[data-score="3"] i:nth-child(-n+3){background:#34d399}
  .err{color:#c0344a;font-size:13px;margin:0 0 12px;padding:10px 12px;border-radius:12px;
    background:rgba(225,29,72,.07);border:1px solid rgba(225,29,72,.25);animation:shake .4s cubic-bezier(.36,.07,.19,.97)}
  @keyframes shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}30%,50%,70%{transform:translateX(-4px)}40%,60%{transform:translateX(4px)}}
  .ok{color:#0f8a52;font-size:13px;margin:0 0 12px;padding:10px 12px;border-radius:12px;
    background:rgba(16,150,90,.08);border:1px solid rgba(16,150,90,.28)}
  .alt{text-align:center;font-size:13px;margin-top:16px;color:#6b6490}
  .alt a{color:#6d28d9;text-decoration:none;font-weight:700}
  .alt a:hover{text-decoration:underline}
  .foot{text-align:center;font-size:11px;margin-top:auto;padding-top:18px;color:#8b85ab;line-height:1.6}
  details.owner{margin-top:16px;border-top:1px solid rgba(24,12,60,.10);padding-top:12px}
  details.owner summary{font-size:12px;color:#6b6490;cursor:pointer;text-align:center}

  @media (max-width:860px){
    body{padding:14px}
    .shell{grid-template-columns:1fr;width:min(430px,96vw)}
    .brand{padding:24px 24px 6px;border-right:0;border-bottom:1px solid rgba(139,92,246,.18)}
    .mark{justify-content:center}
    .hero3d{width:120px;height:120px;margin:14px auto 10px}
    .ball{width:70px;height:70px;margin:-35px;font-size:40px}
    @keyframes orbit{from{transform:rotate(0deg) translateX(54px) rotate(0deg)}to{transform:rotate(360deg) translateX(54px) rotate(-360deg)}}
    .r1{width:112px;height:112px;margin:-56px}.r2{width:86px;height:86px;margin:-43px}
    .brand h2{font-size:19px}
    .sub{margin-bottom:12px}
    .feats,.trust,.brand::after{display:none}
    .brand .ph.on{opacity:.38}
    .side{padding:24px 22px 20px}
  }
  @media (prefers-reduced-motion: reduce){
    *,*::before,*::after{animation:none!important;transition:none!important}
  }
</style></head><body>
<div class="cosmos" aria-hidden="true"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i></div>
<main class="shell" id="shell">
  <section class="brand">
    <img class="ph${tab === "login" ? " on" : ""}" id="phLogin" alt="" aria-hidden="true" loading="lazy" decoding="async" fetchpriority="low" onerror="this.remove()"
      src="https://images.unsplash.com/photo-1560272564-c83b66b1ad12?q=80&amp;w=1100&amp;auto=format&amp;fit=crop"/>
    <img class="ph${tab === "signup" ? " on" : ""}" id="phSignup" alt="" aria-hidden="true" decoding="async" fetchpriority="low" onerror="this.remove()"
      src="https://images.unsplash.com/photo-1600250395178-40fe752e5189?q=80&amp;w=1100&amp;auto=format&amp;fit=crop"/>
    <i class="veil" aria-hidden="true"></i>
    <div class="mark"><i>⚽</i>Sporty Value Pick AI</div>
    <div class="hero3d" aria-hidden="true">
      <i class="ring r1"></i><i class="ring r2"></i>
      <i class="dot d1"></i><i class="dot d2"></i><i class="dot d3"></i>
      <div class="ball">⚽</div>
      <i class="bshadow"></i>
    </div>
    <h2>Pick smarter, <span class="grad">not harder</span></h2>
    <p class="sub">Live verified booking codes, AI match analysis and value picks — refreshed all day.</p>
    <ul class="feats">
      <li><span class="fi">⚡</span><div><b>Live verified codes</b><small>Fresh codes, checked in real time</small></div></li>
      <li><span class="fi">🧠</span><div><b>AI match analysis</b><small>Score model calibrated to live odds</small></div></li>
      <li><span class="fi">🎯</span><div><b>4 markets per match</b><small>Result · Over/Under · BTTS · Double chance</small></div></li>
    </ul>
    <div class="trust">🔒 Secure Paystack checkout · Instant access</div>
  </section>
  <section class="side">
    ${
      canSignup
        ? `<div class="tabs" id="tabs" data-tab="${tab}" role="tablist">
      <span class="ind" aria-hidden="true"></span>
      <button type="button" class="tab" id="tabLogin" role="tab" aria-selected="${tab === "login"}" aria-controls="pane-login">Sign in</button>
      <button type="button" class="tab" id="tabSignup" role="tab" aria-selected="${tab === "signup"}" aria-controls="pane-signup">Create account</button>
    </div>`
        : ""
    }
    ${loginPane}
    ${signupPane}
    <div class="foot">18+ only · Bet responsibly — never stake more than you can afford to lose.<br/>By creating an account you confirm you are 18 or older.</div>
  </section>
</main>
<script>
(function(){
  var fine = window.matchMedia && matchMedia('(pointer:fine)').matches;
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Tab switching without a page reload; URL follows the active pane.
  function go(t){
    var tabs = document.getElementById('tabs');
    if (!tabs) return;
    tabs.setAttribute('data-tab', t);
    var bl = document.getElementById('tabLogin'), bs = document.getElementById('tabSignup');
    if (bl) bl.setAttribute('aria-selected', String(t === 'login'));
    if (bs) bs.setAttribute('aria-selected', String(t === 'signup'));
    var pl = document.getElementById('pane-login'), ps = document.getElementById('pane-signup');
    if (pl) { pl.classList.remove('on'); }
    if (ps) { ps.classList.remove('on'); }
    var onPane = t === 'signup' ? ps : pl;
    if (onPane) { void onPane.offsetWidth; onPane.classList.add('on'); }
    var p1 = document.getElementById('phLogin'), p2 = document.getElementById('phSignup');
    if (p1) p1.classList.toggle('on', t === 'login');
    if (p2) p2.classList.toggle('on', t === 'signup');
    try { history.replaceState(null, '', t === 'signup' ? '/signup' : '/login'); } catch(e){}
    if (fine && onPane) { var f = onPane.querySelector('[data-focus]'); if (f && !f.value) f.focus(); }
  }
  var tl = document.getElementById('tabLogin'), ts = document.getElementById('tabSignup');
  if (tl) tl.addEventListener('click', function(){ go('login'); });
  if (ts) ts.addEventListener('click', function(){ go('signup'); });
  var links = document.querySelectorAll('a[data-go]');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function(e){
      if (document.getElementById('tabs')) { e.preventDefault(); go(this.getAttribute('data-go')); }
    });
  }

  // Autofocus the first empty input of the active pane (desktop only).
  if (fine) {
    var on = document.querySelector('.pane.on [data-focus]');
    if (on && !on.value) on.focus();
  }

  // Show / hide password toggles.
  var eyes = document.querySelectorAll('.eye');
  for (var j = 0; j < eyes.length; j++) {
    eyes[j].addEventListener('click', function(){
      var inp = this.parentElement.querySelector('input');
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      this.setAttribute('aria-pressed', String(show));
      this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      inp.focus();
    });
  }

  // Signup: live password strength + confirm match.
  var pw = document.getElementById('suPw'), cf = document.getElementById('suCf');
  var meter = document.getElementById('meter'), mlab = document.getElementById('mlab');
  function score(v){
    if (!v) return 0;
    var pts = 0;
    if (v.length >= 8) pts++;
    if (v.length >= 12) pts++;
    if (/[A-Z]/.test(v) && /[0-9]/.test(v)) pts++;
    if (/[^A-Za-z0-9]/.test(v)) pts++;
    return Math.max(1, Math.min(3, pts));
  }
  function paintPw(){
    if (!pw || !meter) return;
    var s = score(pw.value);
    meter.setAttribute('data-score', String(s));
    if (mlab) mlab.textContent = !pw.value ? '' : (s <= 1 ? 'Weak' : s === 2 ? 'Good' : 'Strong');
    paintCf();
  }
  function paintCf(){
    var wrap = document.getElementById('cfField');
    if (!cf || !wrap) return;
    wrap.classList.remove('bad', 'good');
    if (cf.value && pw) wrap.classList.add(cf.value === pw.value ? 'good' : 'bad');
  }
  if (pw) pw.addEventListener('input', paintPw);
  if (cf) cf.addEventListener('input', paintCf);

  // Submit: spinner + double-submit guard.
  // NOTE: never disable the submit button here — disabling it while the submit
  // is in flight can cancel the form navigation in Chrome (the POST never
  // fires). Guard with a flag and show the spinner visually instead.
  var forms = document.querySelectorAll('form.af');
  for (var k = 0; k < forms.length; k++) {
    forms[k].addEventListener('submit', function(e){
      if (this.dataset.sent === '1') { e.preventDefault(); return; } // double-submit guard
      this.dataset.sent = '1';
      var b = this.querySelector('.btn');
      if (b) b.classList.add('busy');
    });
  }

  // Subtle 3D tilt of the whole card following the pointer (desktop only).
  var shell = document.getElementById('shell');
  if (shell && fine && !still) {
    shell.addEventListener('pointermove', function(e){
      var r = shell.getBoundingClientRect();
      var rx = ((e.clientY - r.top) / r.height - 0.5) * -4;
      var ry = ((e.clientX - r.left) / r.width - 0.5) * 4;
      shell.style.transform = 'perspective(1200px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)';
    });
    shell.addEventListener('pointerleave', function(){ shell.style.transform = ''; });
  }
})();
</script>
</body></html>`;
}

/** Sign-in page: user accounts (email+password) plus the legacy owner password. */
function renderLogin(err: string | null, notice?: string): string {
  return renderAuth("login", { loginErr: err, notice });
}

/** Account creation page. */
function renderSignup(err: string | null): string {
  return renderAuth("signup", { signupErr: err });
}

function stars(n: number): string {
  const v = Math.max(0, Math.min(5, n));
  return "★".repeat(v) + "☆".repeat(5 - v);
}

type Mode = "human" | "ai" | "pred" | "expert" | "value" | "combo" | "analysis" | "saved" | "metrics";
type Tier = "free" | "premium";

async function renderDashboard(
  mode: Mode = "human",
  tier: Tier = "free",
  dateStr = "",
  expertOpts: { count: number; days: number; gameType: GameType; minConfidence: number; onDate?: string; onEnd?: string } = {
    count: 5,
    days: 5,
    gameType: "safe",
    minConfidence: 0,
  },
  isAdmin = false,
  account: { email: string; premiumUntil: Date | null } | null = null,
  bookieId = "sportybet",
): Promise<string> {
  const bookie = getBookmaker(bookieId);
  const liveBookie = activeBookmaker();
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
  // Track record is shown in Expert mode and on the admin Metrics page.
  const showRecord = mode === "expert" || mode === "metrics";
  const expertRecord = showRecord ? await getExpertRecord().catch(() => null) : null;
  const expertRoi = showRecord ? await getExpertRoi().catch(() => null) : null;
  // Owner business metrics (users / subscribers / revenue) — admin only.
  const metrics: BusinessMetrics | null =
    mode === "metrics" && isAdmin ? await getBusinessMetrics().catch(() => null) : null;
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
      ? await getMatchAnalyses(expertOpts.count, expertOpts.days, expertOpts.onDate, expertOpts.onEnd).catch(() => ({
          matches: [],
          requested: 0,
          windowDays: 0,
          scanned: 0,
        }))
      : { matches: [], requested: 0, windowDays: 0, scanned: 0 };
  // Real past results (actual final scores) for the analysed fixtures — served
  // from a long-lived cache; misses keep resolving in the background and appear
  // on the next auto-refresh, so coverage grows without slowing the page.
  const analysisForms: Map<string, MatchForm> =
    mode === "analysis" && analysis.matches.length
      ? await getFormsForMatches(
          analysis.matches.map((m) => ({ home: m.home, away: m.away })),
          6000,
        ).catch(() => new Map())
      : new Map();
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
    <div class="hero" id="hero3d">
      <div class="hero-art" aria-hidden="true">
        <span class="hero-aurora"></span>
        <div class="hero-fx" id="heroFx">
          <span class="hero-ring"></span>
          <div class="ball3d">
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <radialGradient id="bshade" cx="34%" cy="28%" r="80%">
                  <stop offset="0%" stop-color="#ffffff"/>
                  <stop offset="45%" stop-color="#ece7fb"/>
                  <stop offset="78%" stop-color="#b9abe6"/>
                  <stop offset="100%" stop-color="#5f4ea6"/>
                </radialGradient>
                <radialGradient id="bglow" cx="34%" cy="26%" r="42%">
                  <stop offset="0%" stop-color="#ffffff" stop-opacity=".95"/>
                  <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
                </radialGradient>
              </defs>
              <circle cx="100" cy="100" r="94" fill="url(#bshade)"/>
              <g fill="#2b1e5c" opacity=".92">
                <path d="M100 74 L124 92 L115 120 L85 120 L76 92 Z"/>
                <path d="M40 62 L58 52 L70 66 L60 84 L42 82 Z" opacity=".8"/>
                <path d="M138 40 L158 46 L160 66 L142 74 L128 58 Z" opacity=".82"/>
                <path d="M28 128 L46 122 L56 138 L44 154 L28 148 Z" opacity=".72"/>
                <path d="M150 122 L168 116 L176 132 L166 148 L148 142 Z" opacity=".7"/>
                <path d="M86 168 L112 168 L118 184 L92 190 L80 182 Z" opacity=".6"/>
              </g>
              <g stroke="#2b1e5c" stroke-width="3" fill="none" opacity=".55" stroke-linecap="round">
                <path d="M100 74 L96 46"/><path d="M124 92 L150 78"/><path d="M115 120 L136 140"/>
                <path d="M85 120 L62 138"/><path d="M76 92 L52 80"/>
              </g>
              <ellipse cx="70" cy="56" rx="34" ry="24" fill="url(#bglow)"/>
              <circle cx="100" cy="100" r="94" fill="none" stroke="#3b2a6e" stroke-opacity=".5" stroke-width="2"/>
            </svg>
          </div>
        </div>
        <span class="hero-orb o1"></span>
        <span class="hero-orb o2"></span>
        <span class="spark s1"></span>
        <span class="spark s2"></span>
        <span class="spark s3"></span>
      </div>
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
  // Full, human date for "today" (in the app's Lagos timezone) shown beside the header.
  const todayFull = new Date(`${todayStr}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const dateBar = `
    <div class="date-nav">
      <div class="date-nav-head">Browse codes by date <span class="date-today">${todayFull}</span></div>
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
    mode === "metrics"
      ? metrics
        ? `
      ${kpi("👥", metrics.totalUsers, `total users · +${metrics.newUsers30}/30d`, "indigo")}
      ${kpi("👑", metrics.activeSubscribers, "active subscribers", "green")}
      ${kpi("💰", fmtNgn(metrics.revenue30Ngn), "revenue · 30 days", "orange")}
      ${kpi("🏦", fmtNgn(metrics.revenueAllNgn), "revenue · all time", "blue")}`
        : `
      ${kpi("🔒", "—", "admin only", "indigo")}
      ${kpi("👑", "—", "active subscribers", "green")}
      ${kpi("💰", "—", "revenue · 30 days", "orange")}
      ${kpi("🏦", "—", "revenue · all time", "blue")}`
      : mode === "analysis"
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
      <span class="sb-stats" id="slipstats" hidden title="Live combined odds and the model's chance that EVERY leg wins">
        ≈ <b id="slipodds">—</b> odds · 🎯 <b id="slipchance">—</b> chance
      </span>
      <span class="sb-stake" id="slipstake" hidden title="Enter a stake to see the potential payout at the combined odds">
        ₦<input id="stake" type="number" min="0" step="100" placeholder="Stake" oninput="updPayout(true)"/> → <b id="payout">—</b>
      </span>
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
          <label class="xsel"><input type="checkbox" checked data-key="${esc(p.key)}" data-odds="${p.odds ?? ""}" data-prob="${p.confidence}" onchange="selTog(this)"/> in slip</label>
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
          <label class="xsel"><input type="checkbox" checked data-key="${esc(p.key)}" data-odds="${p.odds ?? ""}" data-prob="${p.modelProb}" onchange="selTog(this)"/> in slip</label>
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
  // Traffic-light signal for a market option, driven by WIN LIKELIHOOD (what
  // "safe" means to a user). Every bookmaker price carries a margin, so pure
  // value would paint nearly everything red — the click-time alert handles
  // genuinely bad prices instead.
  const sigClass = (prob: number, _odds?: string) => {
    if (prob >= 0.7) return "sig-hi";
    if (prob >= 0.55) return "sig-mid";
    return "sig-lo";
  };
  // Compact W/D/L pills for a team's real recent results (newest first).
  const formPills = (f: { matches: { result: string }[] } | null | undefined) =>
    f && f.matches.length
      ? f.matches.map((x) => `<i class="fp fp-${x.result.toLowerCase()}">${x.result}</i>`).join("")
      : `<i class="fp fp-na">—</i>`;
  const formRows = (f: { team: string; matches: { date: string; home: string; away: string; homeScore: number; awayScore: number; result: string }[] } | null | undefined, name: string) => {
    if (!f || !f.matches.length)
      return `<div class="an-form-col"><b>${esc(shortName(name))}</b><div class="muted small">No verified past results in the database for this team (common for minor/SRL leagues).</div></div>`;
    const rows = f.matches
      .map((x) => {
        const d = x.date
          ? new Date(`${x.date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
          : "";
        return `<div class="an-form-row"><i class="fp fp-${x.result.toLowerCase()}">${x.result}</i><span class="afr-d">${esc(d)}</span><span class="afr-m">${esc(x.home)} <b>${x.homeScore}-${x.awayScore}</b> ${esc(x.away)}</span></div>`;
      })
      .join("");
    return `<div class="an-form-col"><b>${esc(f.team)}</b>${rows}</div>`;
  };
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
      const mf = analysisForms.get(`${m.home}|${m.away}`.toLowerCase());
      const hasForm = !!(mf && (mf.home?.matches.length || mf.away?.matches.length));
      const waText = encodeURIComponent(
        `🧮 ${m.home} v ${m.away} (${m.league ?? "Football"})\nAI verdict: ${m.verdict} — ${Math.round(m.confidence * 100)}% · likeliest score ${m.likeliest}\nOver 2.5: ${Math.round(m.over25 * 100)}% · BTTS: ${Math.round(m.btts * 100)}%\nWhat do you think — worth backing? (via Sporty Value Pick AI · estimates, not guarantees, 18+)`,
      );
      return `
      <div class="an-card">
        <div class="an-head">
          <div>
            <div class="an-match">${esc(m.home)} <span class="muted">v</span> ${esc(m.away)}</div>
            <div class="muted small">${esc(m.league ?? "Football")} · ⏰ ${esc(kick)} WAT</div>
            <div class="an-formline" title="Real recent results, newest first (W win · D draw · L loss)">${formPills(mf?.home)}<span class="afl-vs">vs</span>${formPills(mf?.away)}</div>
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
            ${bar("Over 0.5", m.over05, "g")}
            ${bar("Over 2.5", m.over25, "g")}
            ${bar("Both score", m.btts, "g")}
          </div>
          <div class="an-col">
            <div class="an-lbl">Most likely scores</div>
            <div class="an-scores">${scores}</div>
            <div class="an-verdict">🧮 Model verdict: <b>${esc(m.verdict)}</b> · likeliest <b>${esc(m.likeliest)}</b> · ${Math.round(m.confidence * 100)}% confidence</div>
            <div class="an-lbl">Pick a market to add — choose any (one per match)</div>
            <div class="an-siglegend"><span><i class="sdot sd-hi"></i>strong</span><span><i class="sdot sd-mid"></i>decent</span><span><i class="sdot sd-lo"></i>risky</span></div>
            <div class="an-opts">${m.options
              .map(
                (o) =>
                  `<label class="an-opt ${sigClass(o.prob, o.odds)}" title="${esc(o.market)} · model ${Math.round(o.prob * 100)}%"><input type="checkbox" data-key="${esc(o.key)}" data-match="${esc(m.home + "|" + m.away)}" data-odds="${o.odds ?? ""}" data-prob="${o.prob}" data-label="${esc(o.label)}" onchange="anTog(this)"/><i class="sdot"></i><span class="an-opt-l">${esc(o.label)}</span><span class="an-opt-o">${o.odds ? "@" + esc(o.odds) : ""}</span><span class="an-opt-p">${Math.round(o.prob * 100)}%</span></label>`,
              )
              .join("")}</div>
          </div>
        </div>
        ${
          hasForm
            ? `<details class="an-formbox"><summary>📜 Last ${(mf!.home?.matches.length ?? 0) + (mf!.away?.matches.length ?? 0)} real results — form guide (actual final scores)</summary>
          <div class="an-form">${formRows(mf!.home, m.home)}${formRows(mf!.away, m.away)}</div></details>`
            : ""
        }
        <div class="an-actions">
          <button class="btn ghost sm" data-home="${esc(m.home)}" data-away="${esc(m.away)}" data-league="${esc(m.league ?? "Football")}" data-wa="${waText}" onclick="anChat(this)">🧠 Deep-dive · chat with AI</button>
          <a class="btn ghost sm" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener" title="Send this analysis to a friend on WhatsApp and decide together">📞 Ask a friend</a>
        </div>
      </div>`;
    })
    .join("");
  // AI Match Analysis calendar: pick a specific match-day (or a weekend range);
  // blank = rolling window. All dates are Africa/Lagos (WAT) to match the app.
  const analysisOn = expertOpts.onDate ?? "";
  const analysisTo = expertOpts.onEnd ?? "";
  const anDayStr = (k: number) =>
    new Date(Date.now() + k * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const anToday = anDayStr(0);
  const anTomorrow = anDayStr(1);
  const maxAnalysisDate = anDayStr(30); // fixtures horizon
  // Upcoming Saturday+Sunday (on a Sunday, "the weekend" is just today).
  const anDow = new Date(`${anToday}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  const anSat = anDow === 0 ? anToday : anDayStr(6 - anDow);
  const anSun = anDow === 0 ? anToday : anDayStr(6 - anDow + 1);
  const fmtAnDay = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  // Human label for the active selection (single day or range).
  const analysisRangeLabel = analysisOn
    ? analysisTo && analysisTo !== analysisOn
      ? `${fmtAnDay(analysisOn)} – ${fmtAnDay(analysisTo)}`
      : fmtAnDay(analysisOn)
    : "";
  // Which quick-chip (if any) matches the current selection, for highlighting.
  const anChipActive =
    !analysisOn
      ? "all"
      : analysisTo && analysisTo !== analysisOn && analysisOn === anSat && analysisTo === anSun
        ? "weekend"
        : !analysisTo && analysisOn === anToday
          ? "today"
          : !analysisTo && analysisOn === anTomorrow
            ? "tomorrow"
            : "custom";
  const anBase = `/?mode=analysis&n=${expertOpts.count}`;
  const anChip = (key: string, href: string, label: string) =>
    `<a class="an-chip${anChipActive === key ? " on" : ""}" href="${href}">${label}</a>`;
  const analysisBody = `
    <div class="xhead card">
      <div>
        <h3 style="margin:0">📊 AI Match Analysis — statistical model <span class="an-live">🔄 auto-scans every 10 min · next in <b id="an-countdown">10:00</b></span></h3>
        <div class="muted small">A <b>Poisson goals model</b> calibrated to live SportyBet prices: it solves each team's expected goals from the market, then computes the full correct-score matrix — giving match probabilities, correct-score probabilities, BTTS and over/under, the honest data-driven way. <b>Not</b> shot-based Opta xG (that needs event data we don't have); this is the market-calibrated model real prediction sites use. Estimates, not guarantees.</div>
      </div>
      <form class="xform" method="get" action="/">
        <input type="hidden" name="mode" value="analysis"/>
        <input type="hidden" name="to" value="${analysisTo}"/>
        <label>Matches
          <select name="n">${[6, 8, 10, 12, 15, 20, 30, 40, 50, 70]
            .map((n) => `<option value="${n}"${n === expertOpts.count ? " selected" : ""}>${n}</option>`)
            .join("")}</select>
        </label>
        <label>On date
          <input type="date" name="on" value="${analysisOn}" min="${todayStr}" max="${maxAnalysisDate}"
            title="Analyse a specific match-day — clear it to use the window instead"
            onchange="var t=this.form.querySelector('[name=to]'); if(t) t.value=''; this.form.submit()"/>
        </label>
        <label>Within
          <select name="days"${analysisOn ? " disabled" : ""} title="${analysisOn ? "Ignored while a date is picked" : "Rolling window from now"}">${[1, 2, 3, 5, 7, 14, 21, 30]
            .map((d) => `<option value="${d}"${d === expertOpts.days ? " selected" : ""}>${d === 30 ? "1 month" : d === 1 ? "1 day" : d + " days"}</option>`)
            .join("")}</select>
        </label>
        <button class="btn" type="submit">Analyse</button>
      </form>
    </div>
    <div class="an-chips">
      ${anChip("today", `${anBase}&on=${anToday}`, "Today")}
      ${anChip("tomorrow", `${anBase}&on=${anTomorrow}`, "Tomorrow")}
      ${anChip("weekend", `${anBase}&on=${anSat}&to=${anSun}`, "This weekend")}
      ${anChip("all", `${anBase}&days=${expertOpts.days}`, "All upcoming")}
    </div>
    ${
      analysisRangeLabel
        ? `<div class="an-window card"><span>📅 Showing matches ${analysisTo && analysisTo !== analysisOn ? "for" : "on"} <b>${analysisRangeLabel}</b></span><a class="btn ghost sm" href="${anBase}&days=${expertOpts.days}">Back to window</a></div>`
        : ""
    }
    ${
      analysisCards
        ? `<div class="ai-tools card">
      <span class="ai-tools-l">🤖 AI Quick Slip${analysisRangeLabel ? ` · <span class="ai-tools-day">${analysisRangeLabel}</span>` : ""}</span>
      <button class="btn sm" onclick="anPreset('safe')" title="The 3 highest-probability picks across the matches shown">🛡️ Safest 3</button>
      <button class="btn sm" onclick="anPreset(2)" title="Safest route to ~2.0 combined odds">🎯 2+ odds</button>
      <button class="btn sm" onclick="anPreset(5)" title="Safest route to ~5.0 combined odds">🚀 5+ odds</button>
      <button class="btn sm" onclick="anPreset(10)" title="Safest route to ~10 combined odds">🔥 10+ odds</button>
      <button class="btn ghost sm" onclick="clearSel()">Clear</button>
      <span class="muted small">One tap auto-picks the best markets ${analysisRangeLabel ? "for this day" : "for you"} — review below, then hit <b>Generate</b>. Estimates, not guarantees.</span>
    </div>`
        : ""
    }
    <div class="an-list">${
      analysisCards ||
      '<div class="card empty">No fixtures with enough live prices to model right now — try a wider window, or check back as odds populate (busiest mid-day WAT).</div>'
    }</div>
    <div id="anchat" class="anchat" hidden onclick="if(event.target===this)anChatClose()">
      <div class="anchat-panel">
        <div class="anchat-head"><b id="anchat-title">Deep-dive analysis</b><span class="anchat-hint">Esc or tap outside to close</span><button class="anchat-x" onclick="anChatClose()" aria-label="Close" title="Close (Esc)">✕</button></div>
        <div class="anchat-log" id="anchat-log"></div>
        <div class="anchat-chips">
          <button onclick="anChatAsk('Safest pick?')">🛡️ Safest pick?</button>
          <button onclick="anChatAsk('Over or under 2.5 goals?')">🥅 Over/Under?</button>
          <button onclick="anChatAsk('Both teams to score?')">⚽ BTTS?</button>
          <button onclick="anChatAsk('Most likely correct score?')">🎯 Likely score?</button>
          <button onclick="anChatAsk('Recent form and past results?')">📜 Form?</button>
          <button onclick="anChatAsk('Are the odds good value?')">💰 Value check</button>
        </div>
        <form class="anchat-form" onsubmit="return anChatSend(event)">
          <input id="anchat-q" placeholder="Ask the AI analyst about this match…" maxlength="200" autocomplete="off"/>
          <button class="btn sm" type="submit">Send</button>
        </form>
        <div class="anchat-foot">
          <a id="anchat-wa" class="btn ghost sm" target="_blank" rel="noopener">📞 Ask a friend on WhatsApp</a>
          <span class="muted small">Answers come from the live statistical model — estimates, not guarantees · 18+</span>
        </div>
        <button class="anchat-done" onclick="anChatClose()">Close</button>
      </div>
    </div>${slipBar}`;

  // ---- Owner Metrics page (admin only) ----
  const mxPlan = (label: string, n: number) =>
    `<div class="mx-plan"><b>${n}</b><span>${label} passes</span></div>`;
  const metricsBody = !isAdmin
    ? `<div class="card empty">🔒 The metrics dashboard is admin-only. <a href="/admin?key=" style="color:var(--indigo)">Unlock with your admin key</a>.</div>`
    : !metrics
      ? `<div class="card empty">Couldn't load metrics right now — the database may be waking up. Refresh in a moment.</div>`
      : `
    <div class="xhead card">
      <div>
        <h3 style="margin:0">📈 Owner Metrics — the numbers buyers &amp; advertisers ask for</h3>
        <div class="muted small">Users, active subscribers and revenue, plus the verified pick track record below. ${
          metrics.paystackLive
            ? "Paystack is <b>live</b> — revenue is real."
            : "Paystack checkout is <b>not live yet</b>, so revenue reads ₦0 until you add a live secret key."
        }</div>
      </div>
    </div>
    <div class="card">
      <div class="muted small" style="margin-bottom:10px">Passes sold (all-time, by type)</div>
      <div class="mx-plans">
        ${mxPlan("Daily", metrics.planCounts.daily)}
        ${mxPlan("Weekly", metrics.planCounts.weekly)}
        ${mxPlan("Monthly", metrics.planCounts.monthly)}
      </div>
      <div class="muted small" style="margin:16px 0 4px">Recent payments</div>
      ${
        metrics.recent.length
          ? metrics.recent
              .map(
                (r) =>
                  `<div class="xrec-row"><span>${esc(r.email)}</span><span class="muted">${r.plan} · ${fmtNgn(
                    r.amountNgn,
                  )} · ${new Date(r.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></div>`,
              )
              .join("")
          : `<div class="muted small">No payments yet — they'll appear here once Paystack is live and a customer buys a pass.</div>`
      }
    </div>
    ${recordCard || '<div class="card empty">No settled picks yet — the track record fills in as fixtures finish and get scored.</div>'}
    ${roiCard}`;

  const body =
    mode === "metrics"
      ? metricsBody
      : mode === "analysis"
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
<html lang="en" data-theme="light"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sporty Value Pick AI · Booking Code Intelligence</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap" media="print" onload="this.media='all'"/>
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap"/></noscript>
<style>
  /* Web fonts load non-blockingly via <link> in <head> so first paint never waits on the network (works offline too). */
  :root{
    --bg:#0b0817; --card:#161033; --ink:#f2eefb; --muted:#9a91bd; --line:rgba(255,255,255,.09);
    --primary:#8b5cf6; --indigo:#8b7cf6; --blue:#38bdf8; --green:#34d399;
    --warn:#fbbf24; --bad:#fb7185; --gold:#f6c453;
    --shadow:inset 0 1px 0 rgba(255,255,255,.04),0 10px 30px rgba(3,0,20,.45);
  }
  *{box-sizing:border-box}
  ::selection{background:rgba(139,92,246,.45);color:#fff}
  body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;
    background:
      radial-gradient(1100px 620px at 85% -10%,rgba(124,58,237,.30),transparent 60%),
      radial-gradient(900px 540px at -12% 18%,rgba(56,189,248,.10),transparent 55%),
      radial-gradient(820px 700px at 55% 115%,rgba(168,85,247,.16),transparent 62%),
      var(--bg);
    background-attachment:fixed;color:var(--ink);font-size:14px}
  a{color:inherit;text-decoration:none}
  h1,h2,h3,.brand{font-family:'Sora','Inter',ui-sans-serif,system-ui,sans-serif;letter-spacing:.2px}
  ::-webkit-scrollbar{width:10px;height:8px}
  ::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:6px;border:2px solid transparent;background-clip:padding-box}
  ::-webkit-scrollbar-track{background:transparent}
  input,select,button{font-family:inherit}
  :focus-visible{outline:2px solid rgba(139,92,246,.7);outline-offset:2px}
  .layout{display:flex;min-height:100vh}
  /* Sidebar */
  .sidebar{width:250px;background:rgba(15,10,32,.72);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    border-right:1px solid var(--line);
    padding:22px 16px;position:sticky;top:0;height:100vh;flex-shrink:0;display:flex;flex-direction:column}
  .brand{display:flex;align-items:center;gap:10px;padding:0 8px 20px;font-weight:800;font-size:17px}
  .logo{width:36px;height:36px;border-radius:11px;background:linear-gradient(145deg,#a78bfa,#7c3aed 60%,#4c1d95);
    display:grid;place-items:center;color:#fff;font-size:16px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 20px rgba(124,58,237,.45)}
  .brand span{background:linear-gradient(90deg,#c4b5fd,#818cf8);-webkit-background-clip:text;background-clip:text;color:transparent}
  .nav-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
    padding:14px 10px 6px;font-weight:700}
  .nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:11px;
    color:#b3aad4;font-weight:600;margin-bottom:2px;border:1px solid transparent;
    transition:background .15s,color .15s,transform .15s}
  .nav-item:hover{background:rgba(139,92,246,.10);color:var(--ink);transform:translateX(2px)}
  .nav-item.on{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;border-color:rgba(255,255,255,.14);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 8px 22px rgba(124,58,237,.45)}
  .nav-item.on .ni{filter:grayscale(0)}
  .ni{width:20px;text-align:center}
  .side-foot{margin-top:auto;padding:12px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  .src-status{display:flex;flex-direction:column;gap:8px}
  .src-pill{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:6px 12px;
    border-radius:999px;font-size:12px;font-weight:800;line-height:1.2}
  .src-pill.on{background:rgba(52,211,153,.12);color:#6ee7b7;border:1px solid rgba(52,211,153,.35)}
  .src-pill.off{background:rgba(251,191,36,.10);color:#fcd34d;border:1px solid rgba(251,191,36,.3)}
  .live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;
    box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
  /* App area */
  .app{flex:1;min-width:0;display:flex;flex-direction:column}
  .topbar{display:flex;align-items:center;gap:16px;padding:16px 26px;background:rgba(13,9,28,.72);
    backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
  .topbar h1{font-size:18px;margin:0}
  .topbar .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .search{margin-left:14px;flex:1;max-width:340px;position:relative}
  .search input{width:100%;padding:9px 12px 9px 34px;border:1px solid var(--line);border-radius:11px;
    background:rgba(255,255,255,.05);color:var(--ink);font-size:13px;outline:none;transition:border-color .15s,background .15s}
  .search input::placeholder{color:#7d74a3}
  .search input:focus{border-color:var(--primary);background:rgba(139,92,246,.08)}
  .search::before{content:'🔍';position:absolute;left:11px;top:8px;font-size:13px;opacity:.6}
  .top-right{margin-left:auto;display:flex;align-items:center;gap:12px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:11px;
    background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:12px;font-weight:600;color:#b3aad4}
  .chip b{color:var(--ink);font-variant-numeric:tabular-nums}
  .chip-live{background:rgba(52,211,153,.10);border-color:rgba(52,211,153,.3);color:#6ee7b7}
  .btn{background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;border:0;border-radius:11px;
    padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 8px 20px rgba(124,58,237,.4);
    transition:transform .12s,box-shadow .12s,filter .12s}
  .btn:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 12px 26px rgba(124,58,237,.5)}
  .btn:active{transform:translateY(0) scale(.98)}
  .btn.ghost{background:rgba(255,255,255,.05);color:var(--ink);border:1px solid var(--line);box-shadow:none}
  .btn.ghost:hover{background:rgba(255,255,255,.09)}
  .btn.sm{padding:6px 12px;font-size:12px}
  .btn.gold{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 8px 20px rgba(224,165,49,.35)}
  .btn:disabled{opacity:.6;cursor:default;transform:none}
  /* Expert Picks */
  .xshort{padding:12px 16px;margin-bottom:14px;font-size:13px;background:rgba(139,124,246,.10);
    border:1px solid rgba(139,124,246,.3);color:#c7c1ef}
  /* Track record */
  .xrecord{padding:16px 18px;margin-bottom:16px}
  .xrec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .xrec-top{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
  .xrec-big b{font-size:32px;line-height:1;color:var(--green);text-shadow:0 0 22px rgba(52,211,153,.4)}
  .xrec-big small,.xrec-stat small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
  .xrec-stat b{font-size:20px;line-height:1}
  .xbands{border-top:1px solid var(--line);padding-top:10px}
  .xband{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:12px}
  .xband-l{width:56px;font-weight:700;color:#b3aad4;flex-shrink:0}
  .xband-track{flex:1;height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
  .xband-fill{height:100%;background:linear-gradient(90deg,var(--indigo),var(--green));border-radius:999px}
  .xband-v{width:96px;text-align:right;font-weight:700;flex-shrink:0}
  .xband-v small{color:var(--muted);font-weight:500}
  .mx-plans{display:flex;gap:10px;flex-wrap:wrap}
  .mx-plan{flex:1;min-width:90px;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:12px;
    padding:12px 14px;text-align:center}
  .mx-plan b{display:block;font-size:24px;line-height:1;color:var(--indigo)}
  .mx-plan span{font-size:11px;color:var(--muted)}
  html[data-theme="light"] .mx-plan{background:#fff}
  html[data-theme="light"] .mx-plan b{color:#6d28d9}
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
  .roi-l{font-weight:700;color:#c7c1ef} .roi-n{color:var(--muted);font-size:11px;text-align:right}
  .roi-p,.roi-r{text-align:right;font-weight:800}
  .roi-p.up,.roi-r.up{color:var(--green)} .roi-p.down,.roi-r.down{color:var(--bad)}
  .xhead{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  .xform{display:flex;align-items:end;gap:10px;flex-wrap:wrap}
  .xform label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
  .xform select{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#1a1440;font-size:13px;font-weight:600;color:var(--ink)}
  .xlist{display:flex;flex-direction:column;gap:12px}
  .xcard{display:flex;align-items:center;gap:16px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);
    border:1px solid var(--line);
    border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);position:relative;
    transition:transform .15s,box-shadow .15s,border-color .15s}
  .xcard:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.4);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 16px 38px rgba(3,0,20,.55)}
  .xcard.picked{border:2px solid var(--green);box-shadow:0 8px 26px rgba(52,211,153,.22)}
  .xrank{flex-shrink:0;width:34px;height:34px;border-radius:10px;background:rgba(139,124,246,.16);color:#c4b5fd;
    display:grid;place-items:center;font-weight:800;font-size:13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
  .xmain{flex:1;min-width:0}
  .xmatch{font-weight:800;font-size:15px}
  .xmeta{font-size:12px;color:var(--muted);margin:3px 0 8px}
  .xpick{font-size:13px;font-weight:700;color:var(--ink);background:rgba(255,255,255,.06);display:inline-block;
    padding:5px 12px;border-radius:999px;margin-bottom:6px;border:1px solid var(--line)}
  .xodds{color:#c4b5fd;font-weight:800}
  .xwhy{display:flex;flex-wrap:wrap;gap:6px}
  .xwhy span{font-size:11px;color:#b6aed6;background:rgba(255,255,255,.045);border:1px solid var(--line);padding:3px 9px;border-radius:999px}
  .xsignals{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .xsignals span{font-size:11px;color:#7dd3fc;background:rgba(56,189,248,.10);border:1px solid rgba(56,189,248,.28);padding:3px 9px;border-radius:999px}
  .xconf{flex-shrink:0;text-align:center;width:92px}
  .xconf-n{font-size:22px;font-weight:800;line-height:1.1}
  .xconf-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px}
  .xconf.hi .xconf-n{color:var(--green);text-shadow:0 0 18px rgba(52,211,153,.45)}
  .xconf.mid .xconf-n{color:var(--warn)}
  .xconf.lo .xconf-n{color:var(--muted)}
  .vcard{border-left:4px solid #a78bfa}
  .vconf .xconf-n{color:#c4b5fd;text-shadow:0 0 18px rgba(167,139,250,.45)}
  .vedge{font-size:11px;font-weight:800;color:#6ee7b7;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.35);
    padding:2px 8px;border-radius:999px;margin-bottom:6px;display:inline-block}
  .xanalysis{display:inline-block;margin-top:7px;font-size:12px;font-weight:700;color:#c4b5fd}
  .xanalysis:hover{text-decoration:underline}
  /* Value Combos */
  .cmb-list{display:flex;flex-direction:column;gap:14px}
  .cmb-card{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);
    border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--indigo);
    transition:transform .15s,box-shadow .15s}
  .cmb-card:hover{transform:translateY(-2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 16px 38px rgba(3,0,20,.55)}
  .cmb-card.vk{border-left-color:#a78bfa} .cmb-card.sk{border-left-color:var(--green)} .cmb-card.bk{border-left-color:#fb923c} .cmb-card.bo{border-left-color:var(--bad)}
  .cmb-card.bo .cmb-odds b{color:var(--bad)}
  .cmb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:10px}
  .cmb-title{font-weight:800;font-size:16px}
  .cmb-odds{text-align:right;flex-shrink:0}
  .cmb-odds b{font-size:24px;line-height:1;color:#c4b5fd;text-shadow:0 0 18px rgba(167,139,250,.4)} .cmb-odds small{display:block;font-size:10px;color:var(--muted)}
  .cmb-legs{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:6px 0;margin-bottom:12px}
  .cmb-leg{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:5px 0;font-size:12.5px}
  .cmb-m{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cmb-p{white-space:nowrap} .cmb-p b{color:#c4b5fd}
  .cmb-k{font-size:11px;white-space:nowrap}
  /* AI Analysis */
  .an-live{display:inline-block;margin-left:8px;font-size:11px;font-weight:700;color:#0f8a52;
    background:#eafaf1;border:1px solid #c8ecd8;border-radius:999px;padding:3px 10px;vertical-align:middle}
  .an-live b{font-variant-numeric:tabular-nums}
  .an-list{display:flex;flex-direction:column;gap:14px}
  .an-card{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);
    border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--blue);
    transition:transform .15s,box-shadow .15s}
  .an-card:hover{transform:translateY(-2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 16px 38px rgba(3,0,20,.55)}
  .an-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px}
  .an-match{font-weight:800;font-size:16px}
  .an-xg{text-align:right;flex-shrink:0}
  .an-xg b{font-size:22px;line-height:1;color:var(--blue);text-shadow:0 0 18px rgba(56,189,248,.4)} .an-xg small{display:block;font-size:10px;color:var(--muted)}
  .an-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .an-col{min-width:0}
  .an-lbl{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
  .an-bar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}
  .an-bl{width:96px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .an-bt{flex:1;height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
  .an-bf{height:100%;border-radius:999px}
  .an-bf.h{background:linear-gradient(90deg,#34d399,#10b981)} .an-bf.a{background:linear-gradient(90deg,#fb923c,#f472b6)} .an-bf.d{background:#6f678f} .an-bf.g{background:linear-gradient(90deg,#38bdf8,#818cf8)}
  .an-bv{width:34px;text-align:right;font-weight:700;flex-shrink:0}
  .an-window{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px}
  .an-window b{color:#c4b5fd}
  .an-chips{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 12px}
  .an-chip{font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:999px;text-decoration:none;
    border:1px solid var(--line);color:var(--ink);background:rgba(255,255,255,.04);transition:transform .12s,border-color .12s,background .12s}
  .an-chip:hover{transform:translateY(-1px);border-color:rgba(139,92,246,.45)}
  .an-chip.on{background:linear-gradient(150deg,#8b5cf6,#6d28d9);color:#fff;border-color:transparent;
    box-shadow:0 6px 16px rgba(124,58,237,.4)}
  .ai-tools-day{background:rgba(139,92,246,.22);color:#c4b5fd;font-weight:800;padding:1px 9px;border-radius:999px;font-size:12px}
  .an-scores{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .an-score{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:9px;padding:6px 10px;text-align:center;min-width:52px}
  .an-score b{display:block;font-size:15px} .an-score span{font-size:11px;color:var(--muted)}
  .an-verdict{font-size:12.5px;background:rgba(56,189,248,.10);border:1px solid rgba(56,189,248,.28);border-radius:9px;padding:8px 10px;margin-bottom:8px}
  .an-opts{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto;padding-right:4px}
  .an-opts::-webkit-scrollbar{width:6px}
  .an-opts::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:3px}
  .an-opt{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:8px;align-items:center;
    border:1px solid var(--line);border-radius:9px;padding:7px 10px;cursor:pointer;font-size:12.5px;transition:background .12s,border-color .12s}
  .an-opt:hover{background:rgba(255,255,255,.045)}
  .an-opt.on{border-color:var(--green);background:rgba(52,211,153,.10)}
  .an-opt input{accent-color:var(--green);cursor:pointer}
  .an-opt-l{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .an-opt-o{color:#c4b5fd;font-weight:800}
  .an-opt-p{color:var(--muted);font-size:11px;min-width:34px;text-align:right}
  /* Traffic-light signal dots on each market option: green pulse = strong,
     amber = decent, red = risky (low probability or badly-priced odds). */
  .sdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;display:inline-block}
  .an-opt.sig-hi .sdot{background:var(--green);animation:sigpulse-g 1.6s ease-in-out infinite}
  .an-opt.sig-mid .sdot{background:var(--warn);animation:sigpulse-a 2.2s ease-in-out infinite}
  .an-opt.sig-lo .sdot{background:var(--bad);animation:sigpulse-r 1.1s ease-in-out infinite}
  .an-opt.sig-hi{border-left:3px solid rgba(52,211,153,.6)}
  .an-opt.sig-mid{border-left:3px solid rgba(251,191,36,.55)}
  .an-opt.sig-lo{border-left:3px solid rgba(251,113,133,.6)}
  @keyframes sigpulse-g{0%,100%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}50%{box-shadow:0 0 0 5px rgba(52,211,153,0)}}
  @keyframes sigpulse-a{0%,100%{box-shadow:0 0 0 0 rgba(251,191,36,.5)}50%{box-shadow:0 0 0 5px rgba(251,191,36,0)}}
  @keyframes sigpulse-r{0%,100%{box-shadow:0 0 0 0 rgba(251,113,133,.6)}50%{box-shadow:0 0 0 6px rgba(251,113,133,0)}}
  .an-siglegend{display:flex;gap:12px;font-size:11px;color:var(--muted);margin:-2px 0 6px}
  .an-siglegend span{display:inline-flex;align-items:center;gap:5px}
  .an-siglegend .sd-hi{background:var(--green)}.an-siglegend .sd-mid{background:var(--warn)}.an-siglegend .sd-lo{background:var(--bad)}
  /* Real recent-form guide (actual final scores) */
  .an-formline{display:flex;align-items:center;gap:3px;margin-top:6px}
  .afl-vs{font-size:10px;color:var(--muted);margin:0 5px;font-weight:700}
  .fp{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:5px;
    font-size:10px;font-weight:800;font-style:normal;color:#fff}
  .fp-w{background:#16a06b}.fp-d{background:#8b8fa3}.fp-l{background:#e35d6a}.fp-na{background:rgba(255,255,255,.12);color:var(--muted)}
  .an-formbox{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}
  .an-formbox summary{cursor:pointer;font-size:12.5px;font-weight:700;color:#c4b5fd;list-style:none}
  .an-formbox summary::-webkit-details-marker{display:none}
  .an-formbox summary:hover{text-decoration:underline}
  .an-form{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px}
  .an-form-col b{display:block;font-size:12px;margin-bottom:5px}
  .an-form-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 0;color:var(--muted)}
  .afr-d{flex-shrink:0;min-width:44px}
  .afr-m{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .afr-m b{color:var(--ink)}
  .an-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;border-top:1px dashed var(--line);padding-top:10px}
  /* Deep-dive analyst chat modal */
  .anchat{position:fixed;inset:0;z-index:60;background:rgba(5,2,16,.66);backdrop-filter:blur(3px);
    display:flex;align-items:flex-end;justify-content:center;padding:14px}
  @media(min-width:640px){ .anchat{align-items:center} }
  .anchat-panel{width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column;
    background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px rgba(3,0,20,.6)}
  .anchat-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .anchat-x{background:var(--card);border:1px solid var(--line);border-radius:9px;color:var(--ink);
    font-size:18px;line-height:1;cursor:pointer;padding:7px 12px;font-weight:800;transition:all .12s}
  .anchat-x:hover{background:#fdeee7;border-color:var(--primary);color:var(--primary)}
  .anchat-done{width:100%;margin-top:8px;padding:11px;border:1px solid var(--line);border-radius:10px;
    background:var(--card);color:var(--ink);font-weight:700;font-size:13px;cursor:pointer}
  .anchat-done:hover{background:#f4f6fb}
  .anchat-hint{font-size:11px;color:var(--muted);font-weight:600}
  .anchat-x:hover{color:var(--ink)}
  .anchat-log{flex:1;min-height:180px;max-height:46vh;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
  .anchat-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:12.5px;line-height:1.55}
  .anchat-msg.ai{align-self:flex-start;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.3)}
  .anchat-msg.me{align-self:flex-end;background:rgba(56,189,248,.13);border:1px solid rgba(56,189,248,.3)}
  .anchat-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 10px}
  .anchat-chips button{background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:999px;
    color:var(--ink);font-size:11.5px;font-weight:600;padding:5px 11px;cursor:pointer}
  .anchat-chips button:hover{border-color:var(--primary);color:#c4b5fd}
  .anchat-form{display:flex;gap:8px;padding:0 16px 12px}
  .anchat-form input{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;
    background:rgba(255,255,255,.04);color:var(--ink);outline:none}
  .anchat-form input:focus{border-color:var(--primary)}
  .anchat-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 16px 14px}
  @media(max-width:640px){ .an-form{grid-template-columns:1fr} }
  @media(max-width:640px){ .an-grid{grid-template-columns:1fr} .an-head{flex-direction:column} }
  .cmb-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .cmb-res{display:flex;align-items:center;gap:8px}
  @media(max-width:640px){ .cmb-leg{grid-template-columns:1fr auto} .cmb-k{display:none} }
  /* Auto-recommended value banner */
  .vauto{padding:14px 18px;margin-bottom:16px;background:linear-gradient(120deg,rgba(139,92,246,.16),rgba(56,189,248,.10)),var(--card);border:1px solid rgba(139,92,246,.35)}
  .vauto-head{font-size:14px;font-weight:800;margin-bottom:10px}
  .vauto-list{display:flex;flex-direction:column;gap:10px}
  .vauto-item{display:flex;gap:14px;align-items:center;justify-content:space-between;background:rgba(9,6,20,.55);
    border:1px solid var(--line);border-radius:12px;padding:10px 14px}
  .vauto-main{min-width:0}
  .vauto-why{font-size:12px;color:#b6aed6;margin-top:3px}
  .vauto-side{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  @media(max-width:640px){ .vauto-item{flex-direction:column;align-items:flex-start} .vauto-side{align-items:flex-start} }
  .xsel{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11px;font-weight:700;
    color:#b3aad4;cursor:pointer}
  .xsel input{accent-color:var(--green);cursor:pointer}
  @media(max-width:640px){ .xcard{flex-direction:column;align-items:stretch} .xconf{width:auto;display:flex;align-items:center;justify-content:space-between} }
  /* Prediction match calendar */
  .pred-datebar{padding:16px 18px 8px;margin-bottom:18px}
  .pd-chip{position:relative;flex:0 0 auto;width:68px;display:flex;flex-direction:column;
    align-items:center;gap:1px;padding:10px 6px 8px;border-radius:14px;border:1px solid var(--line);
    background:rgba(255,255,255,.04);color:var(--ink);cursor:pointer;font-family:inherit;transition:transform .12s, box-shadow .12s, border-color .12s}
  .pd-chip:hover{transform:translateY(-2px);box-shadow:0 10px 22px rgba(3,0,20,.5);border-color:rgba(139,92,246,.45)}
  .pdc-top{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.5px}
  .pdc-day{font-size:23px;font-weight:800;line-height:1.05;color:var(--ink)}
  .pdc-mon{font-size:10px;color:var(--muted);font-weight:600}
  .pdc-count{margin-top:4px;font-size:10px;font-weight:800;background:rgba(255,255,255,.08);color:#b6aed6;
    padding:1px 8px;border-radius:999px}
  .pd-chip.on{background:linear-gradient(150deg,#8b5cf6,#6d28d9);border-color:rgba(255,255,255,.16);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 24px rgba(124,58,237,.45)}
  .pd-chip.on .pdc-top,.pd-chip.on .pdc-mon{color:rgba(255,255,255,.9)}
  .pd-chip.on .pdc-day{color:#fff}
  .pd-chip.on .pdc-count{background:rgba(255,255,255,.28);color:#fff}
  /* Day groups */
  .day-group{margin-bottom:26px}
  .dg-head{display:flex;align-items:center;gap:14px;margin-bottom:14px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);
    border:1px solid var(--line);border-radius:14px;padding:12px 16px;box-shadow:var(--shadow)}
  .dg-cal{width:58px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;
    background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:12px;padding:7px 4px}
  .dg-cal.today{background:linear-gradient(150deg,#8b5cf6,#ec4899);border-color:rgba(255,255,255,.18);
    box-shadow:0 8px 20px rgba(139,92,246,.4)}
  .dg-cal.today .dg-dow,.dg-cal.today .dg-num,.dg-cal.today .dg-mon{color:#fff}
  .dg-cal.analyst{background:linear-gradient(150deg,#e0a531,#f6c453);border-color:transparent}
  .dg-cal.analyst .dg-dow,.dg-cal.analyst .dg-num,.dg-cal.analyst .dg-mon{color:#3a2a06}
  .dg-dow{font-size:9px;font-weight:800;color:var(--muted);letter-spacing:.6px}
  .dg-num{font-size:21px;font-weight:800;line-height:1.1}
  .dg-mon{font-size:10px;color:var(--muted);font-weight:600}
  .dg-title b{display:block;font-size:16px}
  .dg-title span{font-size:12px;color:var(--muted)}
  .dg-count{margin-left:auto;font-size:12px;font-weight:800;background:rgba(139,124,246,.16);color:#c4b5fd;
    padding:5px 12px;border-radius:999px;white-space:nowrap}
  .ko-chip{margin-left:auto;flex-shrink:0;font-size:12px;font-weight:800;color:#c4b5fd;
    background:rgba(139,124,246,.16);padding:4px 10px;border-radius:999px;white-space:nowrap}
  .slip-head .ko-chip + .selbox, .slip-head .selbox{margin-left:10px}
  .slip-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px}
  /* Prediction slip builder */
  .pred-hint{padding:14px 18px;margin-bottom:16px;font-size:13px;background:linear-gradient(120deg,rgba(52,211,153,.10),rgba(139,124,246,.12)),var(--card);border:1px solid rgba(52,211,153,.28)}
  .selbox{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;
    color:#6ee7b7;cursor:pointer;padding:4px 10px;border:1px dashed rgba(52,211,153,.45);border-radius:8px;white-space:nowrap;transition:background .12s}
  .selbox:hover{background:rgba(52,211,153,.10)}
  .selbox input{accent-color:var(--green);cursor:pointer}
  .slip.picked{border:2px solid var(--green);box-shadow:0 8px 26px rgba(52,211,153,.22)}
  .slipbar{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:40;
    display:flex;align-items:center;gap:12px;flex-wrap:wrap;max-width:92vw;
    background:rgba(17,12,36,.88);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
    border:1px solid rgba(139,92,246,.4);border-radius:16px;padding:12px 18px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 18px 50px rgba(3,0,20,.7)}
  .sb-info{font-size:13px;font-weight:600;color:#c7c1ef}
  .sb-note{font-size:12px;font-weight:600;color:#6ee7b7;max-width:420px}
  .sb-note.warn{color:var(--warn)}
  .slipcode{display:inline-block;background:#060411;color:#7df0b8;font-family:ui-monospace,Consolas,monospace;
    font-size:16px;font-weight:800;letter-spacing:2px;padding:7px 14px;border-radius:9px;cursor:pointer;
    border:1px solid rgba(52,211,153,.4);box-shadow:0 0 22px rgba(52,211,153,.18)}
  .slipcode:hover{filter:brightness(1.25)}
  .sb-name{padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;width:130px;
    background:rgba(255,255,255,.05);color:var(--ink);outline:none}
  .sb-name::placeholder{color:#7d74a3}
  .sb-name:focus{border-color:var(--primary);background:rgba(139,92,246,.08)}
  .sb-stats{font-size:12.5px;font-weight:700;color:#c4b5fd;white-space:nowrap}
  .sb-stats b{font-size:14px}
  .sb-stake{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;color:#b3aad4;white-space:nowrap}
  .sb-stake input{width:76px;padding:7px 8px;border:1px solid var(--line);border-radius:9px;font-size:13px;
    background:rgba(255,255,255,.05);color:var(--ink);outline:none}
  .sb-stake input:focus{border-color:var(--primary);background:rgba(139,92,246,.08)}
  .sb-stake b{color:var(--green);font-size:14px}
  /* AI Quick Slip toolbar (AI Analysis) */
  .ai-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding:12px 16px}
  .ai-tools-l{font-weight:800;font-size:13px;color:#c4b5fd;white-space:nowrap}
  /* Saved Codes ledger */
  .sc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
  .sc-count{text-align:center}.sc-count b{font-size:26px;display:block;line-height:1;color:#c4b5fd;text-shadow:0 0 18px rgba(167,139,250,.4)}
  .sc-count small{font-size:11px;color:var(--muted)}
  .sc-list{display:flex;flex-direction:column;gap:10px}
  .sc-row{display:flex;gap:16px;align-items:stretch;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);
    border:1px solid var(--line);
    border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);transition:transform .15s,border-color .15s}
  .sc-row:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.35)}
  .sc-when{flex-shrink:0;width:180px;display:flex;flex-direction:column;gap:3px;font-size:12px}
  .sc-day{font-weight:800;font-size:13px}
  .sc-time,.sc-by{color:#b3aad4}
  .sc-when .tag{align-self:flex-start;margin-top:4px}
  .sc-mid{flex:1;min-width:0;font-size:12.5px;line-height:1.5;border-left:1px solid var(--line);padding-left:16px}
  .sc-right{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  .sc-meta{font-size:11px;color:var(--muted)}
  @media(max-width:720px){ .sc-row{flex-direction:column} .sc-when{width:auto} .sc-mid{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:10px} .sc-right{align-items:flex-start} }
  /* Drag-and-drop overlay */
  #dropzone{position:fixed;inset:0;z-index:70;background:rgba(5,3,12,.72);backdrop-filter:blur(6px);display:grid;place-items:center;
    opacity:0;pointer-events:none;transition:opacity .15s}
  #dropzone.show{opacity:1}
  .dz-inner{background:var(--card);border:3px dashed var(--primary);border-radius:20px;
    padding:44px 64px;text-align:center;font-size:20px;font-weight:800;line-height:1.6;
    box-shadow:0 24px 70px rgba(3,0,20,.8),0 0 60px rgba(124,58,237,.35)}
  .dz-inner small{font-size:13px;color:var(--muted);font-weight:500}
  /* OCR modal */
  #ocrmodal{position:fixed;inset:0;z-index:60;background:rgba(5,3,12,.65);backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px}
  .ocr-box{background:var(--card);border:1px solid rgba(139,92,246,.35);border-radius:16px;padding:20px 22px;max-width:520px;width:100%;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 24px 70px rgba(3,0,20,.8)}
  .ocr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .ocr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--line)}
  #toast{position:fixed;right:22px;bottom:22px;z-index:50;max-width:360px;
    background:#1c1440;color:#fff;padding:13px 18px;border-radius:12px;font-size:13px;font-weight:600;
    border:1px solid rgba(139,92,246,.45);
    box-shadow:0 14px 40px rgba(3,0,20,.7);opacity:0;transform:translateY(10px);
    transition:opacity .25s,transform .25s;pointer-events:none}
  #toast.show{opacity:1;transform:translateY(0)}
  #toast.ok{background:#0e2f21;border-color:rgba(52,211,153,.45)}#toast.warn{background:#4a3a12;border-color:rgba(251,191,36,.45)}
  /* Premium gating */
  .tier-badge{padding:6px 12px;border-radius:10px;font-size:12px;font-weight:800}
  .tier-free{background:rgba(255,255,255,.08);color:#b6aed6}
  .tier-premium{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06;box-shadow:0 6px 18px rgba(224,165,49,.35)}
  .lock{color:var(--warn);font-weight:700;text-decoration:none;cursor:pointer}
  .lock:hover{text-decoration:underline}
  .hero-code.locked,.booking-code.locked{color:rgba(255,255,255,.55);letter-spacing:4px}
  .booking-code.locked{color:var(--warn)}
  .locked-b{background:linear-gradient(120deg,rgba(246,196,83,.10),rgba(139,124,246,.10)),var(--card);border-color:rgba(246,196,83,.3)}
  .upsell{background:linear-gradient(120deg,#2a1b4d,#6d28d9);color:#fff;border:1px solid rgba(167,139,250,.35);border-radius:16px;
    padding:16px 20px;margin-bottom:18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 14px 36px rgba(124,58,237,.3)}
  .upsell b{font-size:15px}.upsell .grow{flex:1;min-width:200px}
  .slip.vip{border:2px solid #e0a531;box-shadow:0 8px 28px rgba(224,165,49,.28)}
  .ribbon{position:absolute;top:-10px;right:14px;background:linear-gradient(135deg,#e0a531,#f6c453);
    color:#3a2a06;font-size:11px;font-weight:800;padding:4px 12px;border-radius:8px;box-shadow:0 6px 16px rgba(224,165,49,.4)}
  .slip{position:relative}
  /* Pricing */
  .pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:18px}
  .plan{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:var(--shadow)}
  .plan.pop{border:2px solid var(--primary);box-shadow:0 14px 40px rgba(124,58,237,.3)}
  .plan h3{margin:0 0 4px;font-size:16px}
  .plan .price{font-size:30px;font-weight:800;margin:8px 0}
  .plan .price small{font-size:13px;color:var(--muted);font-weight:500}
  .plan ul{list-style:none;padding:0;margin:14px 0;font-size:13px;color:#c7c1ef}
  .plan li{padding:6px 0;border-bottom:1px solid var(--line)}
  .plan li::before{content:'✓ ';color:var(--green);font-weight:800}
  .plan li.no{color:#6f678f}.plan li.no::before{content:'✕ ';color:#4a4368}
  @media(max-width:900px){ .pricing{grid-template-columns:1fr} }
  /* Content */
  .content{padding:22px 26px 40px;overflow:auto}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}
  .kpi{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;
    display:flex;align-items:center;gap:14px;box-shadow:var(--shadow);transition:transform .15s,border-color .15s}
  .kpi:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.35)}
  .kpi .ic{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;font-size:20px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
  .kpi.green .ic{background:rgba(52,211,153,.14)}.kpi.indigo .ic{background:rgba(139,124,246,.16)}
  .kpi.blue .ic{background:rgba(56,189,248,.14)}.kpi.orange .ic{background:rgba(251,146,60,.14)}
  .kpi b{font-size:24px;display:block;line-height:1.1}
  .kpi small{color:var(--muted);font-size:12px}
  .card{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);
    padding:18px;margin-bottom:18px}
  .card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .card-head h3{margin:0;font-size:15px}
  .date-nav{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .date-nav-head{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;
    letter-spacing:.6px;margin-bottom:10px}
  .date-today{text-transform:none;letter-spacing:.2px;color:var(--ink);font-weight:700;
    margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(139,92,246,.16);
    border:1px solid rgba(139,92,246,.3)}
  .date-strip{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px}
  .date-strip::-webkit-scrollbar{height:6px}
  .date-strip::-webkit-scrollbar-thumb{background:rgba(139,92,246,.35);border-radius:3px}
  .day-card{position:relative;flex:0 0 auto;width:68px;display:flex;flex-direction:column;
    align-items:center;gap:1px;padding:11px 6px 9px;border:1px solid var(--line);border-radius:16px;
    background:rgba(255,255,255,.04);text-decoration:none;color:var(--ink);
    transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}
  .day-card:hover{transform:translateY(-2px);box-shadow:0 10px 22px rgba(3,0,20,.5);border-color:rgba(139,92,246,.45)}
  .dc-top{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:.5px}
  .dc-day{font-size:23px;font-weight:800;line-height:1.05}
  .dc-mon{font-size:10px;color:var(--muted);margin-bottom:5px}
  .dc-count{font-size:10px;font-weight:700;background:rgba(255,255,255,.08);color:#b6aed6;border-radius:999px;
    padding:1px 9px;min-width:22px;text-align:center}
  .day-card.on{background:linear-gradient(150deg,#8b5cf6,#6d28d9);border-color:rgba(255,255,255,.16);
    color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 24px rgba(124,58,237,.45)}
  .day-card.on .dc-top,.day-card.on .dc-mon{color:rgba(255,255,255,.9)}
  .day-card.on .dc-count{background:rgba(255,255,255,.28);color:#fff}
  .day-card.all .dc-day{color:#c4b5fd} .day-card.all.on .dc-day{color:#fff}
  .day-card.pick{border-style:dashed;cursor:pointer;justify-content:center}
  .dc-input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
  .split{display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start}
  .split.full{grid-template-columns:1fr}
  .col-side .card{position:sticky;top:90px}
  /* Hero */
  .hero{background:linear-gradient(120deg,#4c1d95,#7c3aed 45%,#a855f7 78%,#ec4899 120%);color:#fff;
    border:1px solid rgba(255,255,255,.16);
    border-radius:18px;padding:22px;display:flex;justify-content:space-between;gap:18px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 18px 48px rgba(124,58,237,.45);margin-bottom:18px;flex-wrap:wrap;
    position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(420px 180px at 18% 0%,rgba(255,255,255,.22),transparent 60%)}
  .hero::after{content:'';position:absolute;top:0;bottom:0;width:45%;pointer-events:none;
    background:linear-gradient(105deg,transparent 20%,rgba(255,255,255,.14) 50%,transparent 80%);
    animation:heroShine 6s ease-in-out infinite}
  @keyframes heroShine{0%{left:-50%}55%{left:110%}100%{left:110%}}
  .hero-left,.hero-right{position:relative;z-index:1}
  .hero-code{font-family:ui-monospace,Menlo,monospace;font-size:38px;font-weight:800;letter-spacing:3px;margin:8px 0;
    text-shadow:0 0 26px rgba(255,255,255,.45)}
  .hero-meta{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:13px;opacity:.95}
  .hero-meta b{font-weight:800}
  .hero-right{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .hero-src{font-size:12px;opacity:.85;margin-top:4px}
  .hero .btn{background:rgba(255,255,255,.94);color:#4c1d95;box-shadow:0 8px 22px rgba(0,0,0,.25)}
  .hero .btn.ghost{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.35)}
  /* Table */
  .table-wrap{overflow-x:auto}
  table.grid-table{width:100%;border-collapse:collapse;font-size:13px}
  .grid-table th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line)}
  .grid-table td{padding:11px 10px;border-bottom:1px solid var(--line)}
  .grid-table tr:last-child td{border-bottom:0}
  .frow:hover{background:rgba(139,92,246,.06)}
  tr.fresh{background:rgba(139,92,246,.10)}
  td.code{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#d6c9ff}
  td.num{font-variant-numeric:tabular-nums;font-weight:600}
  .starcol{color:var(--warn);letter-spacing:1px;font-size:12px}
  .muted{color:var(--muted)}.small{font-size:12px}.mono{font-family:ui-monospace,monospace}
  .ccopy{cursor:pointer;border-bottom:1px dashed rgba(167,139,250,.55)}
  .ccopy:hover{color:#c4b5fd}
  .tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;
    background:rgba(255,255,255,.07);color:#b6aed6}
  .tag.new{background:rgba(52,211,153,.16);color:#6ee7b7}
  .tag.green{background:rgba(52,211,153,.16);color:#6ee7b7}.tag.orange{background:rgba(251,146,60,.16);color:#fdba74}
  .tag.indigo{background:rgba(139,124,246,.18);color:#c4b5fd}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700}
  .status.s-ACTIVE{background:rgba(52,211,153,.16);color:#6ee7b7}
  .status.s-UNVERIFIED{background:rgba(251,191,36,.14);color:#fcd34d}
  .status.s-EXPIRED,.status.s-INVALID,.status.s-DUPLICATE{background:rgba(251,113,133,.14);color:#fda4af}
  .runs{list-style:none;margin:0;padding:0}
  .runs li{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .runs li:last-child{border-bottom:0}
  .rname{font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:var(--green)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
  /* AI cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
  .slip{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.01)),var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow);
    transition:transform .15s,box-shadow .15s,border-color .15s}
  .slip:hover{transform:translateY(-2px);border-color:rgba(139,92,246,.35);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 16px 38px rgba(3,0,20,.55)}
  .slip-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
  .slip-title{font-size:15px}
  .booking{display:flex;justify-content:space-between;align-items:center;gap:10px;
    background:linear-gradient(120deg,rgba(236,72,153,.12),rgba(139,124,246,.14));border:1px solid rgba(236,72,153,.28);border-radius:12px;padding:12px 14px;margin-bottom:12px}
  .booking.manual{color:var(--muted);font-size:12.5px;justify-content:flex-start}
  .booking-label{font-size:11px;font-weight:700;color:#f9a8d4}
  .booking-code{font-family:ui-monospace,Menlo,monospace;font-size:24px;font-weight:800;letter-spacing:2px;color:#fff;
    text-shadow:0 0 20px rgba(236,72,153,.45)}
  .booking-actions{display:flex;gap:8px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
  .metrics b{font-size:18px;display:block}.metrics small{color:var(--muted);font-size:11px}
  .metrics .pos{color:var(--green)}.metrics .neg{color:var(--bad)}
  .conf{height:8px;background:rgba(255,255,255,.08);border-radius:6px;overflow:hidden;margin-bottom:12px}
  .conf-fill{height:100%;background:linear-gradient(90deg,var(--green),#a78bfa)}
  table.legs{width:100%;font-size:12.5px;border-collapse:collapse}
  table.legs td{padding:7px 4px;border-bottom:1px solid var(--line)}
  table.legs tr:last-child td{border-bottom:0}
  .reason{color:#a79ecb;font-size:12px;margin-top:10px;line-height:1.5}
  .pred-tip{background:rgba(139,124,246,.16);color:#c4b5fd;font-weight:800;font-size:15px;
    border:1px solid rgba(139,124,246,.3);border-radius:10px;padding:10px 14px;margin:10px 0}
  .pred-preview{color:#a79ecb;font-size:13px;line-height:1.5;margin:10px 0;font-style:italic}
  .empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:30px}
  .disclaimer{color:var(--muted);font-size:12px;margin-top:6px;text-align:center;padding:8px;line-height:1.6}
  .disclaimer a{color:var(--bad);font-weight:700}
  /* Prominent risk banner */
  .bookie-sel{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);
    color:var(--ink);font-size:13px;font-weight:700;cursor:pointer;outline:none}
  .bookie-sel:focus{border-color:var(--primary)}
  .bookie-soon{background:#fff4e6;border:1px solid #f4d9a8;color:#8a5a12;border-radius:12px;
    padding:12px 16px;margin-bottom:14px;font-size:13px;line-height:1.5}
  .bookie-soon a{color:var(--primary);font-weight:700}
  .risk-banner{display:flex;align-items:center;gap:14px;background:rgba(251,113,133,.08);border:1.5px solid rgba(251,113,133,.35);
    border-left:5px solid var(--bad);border-radius:12px;padding:12px 16px;margin-bottom:16px;
    box-shadow:0 6px 22px rgba(251,113,133,.10)}
  .rb-icon{font-size:24px;flex-shrink:0}
  .rb-text{font-size:13px;line-height:1.5;color:#fda4af}
  .rb-text b{color:#fecdd3}
  .rb-text u{text-underline-offset:2px}
  .rb-link{display:inline-block;margin-left:6px;color:#fb7185;font-weight:700;text-decoration:underline;cursor:pointer}
  .rb-close{flex-shrink:0;align-self:flex-start;background:rgba(255,255,255,.06);border:1px solid rgba(251,113,133,.35);color:#fda4af;
    border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
  .rb-close:hover{background:rgba(251,113,133,.14)}
  .risk-detail{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--bad);border-radius:12px;
    padding:14px 20px;margin-bottom:16px;font-size:13px;color:#b6aed6}
  .risk-detail ul{margin:10px 0 2px;padding-left:20px}
  .risk-detail li{padding:4px 0}
  .risk-detail a{color:#fb7185;font-weight:700}
  /* Hero artwork + 3D tilt */
  .hero{transform-style:preserve-3d;will-change:transform;transition:transform .18s ease-out;
    animation:riseIn .7s cubic-bezier(.22,1,.36,1) backwards}
  .hero-left{transform:translateZ(26px)}
  .hero-right{transform:translateZ(18px)}
  .hero-art{position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden;border-radius:inherit}
  .hero-aurora{position:absolute;left:-15%;top:-110%;width:130%;padding-bottom:130%;border-radius:50%;opacity:.55;
    background:conic-gradient(from 0deg,rgba(255,255,255,0),rgba(255,255,255,.16) 22%,rgba(56,189,248,.14) 40%,rgba(255,255,255,0) 55%);
    animation:auroraSpin 16s linear infinite}
  @keyframes auroraSpin{to{transform:rotate(360deg)}}
  .hero-fx{position:absolute;inset:0;will-change:transform}
  .ball3d{position:absolute;right:110px;top:50%;width:148px;height:148px;margin-top:-82px;
    filter:drop-shadow(0 26px 30px rgba(0,0,0,.45));animation:ballFloat 7s ease-in-out infinite}
  .ball3d svg{width:100%;height:100%;display:block}
  @keyframes ballFloat{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-16px) rotate(9deg)}}
  .hero-ring{position:absolute;right:78px;top:50%;width:212px;height:212px;margin-top:-106px;border-radius:50%;
    border:1.5px solid rgba(255,255,255,.22);border-top-color:rgba(255,255,255,.6);
    animation:ringSpin 9s linear infinite}
  @keyframes ringSpin{from{transform:rotateX(66deg) rotateZ(0)}to{transform:rotateX(66deg) rotateZ(360deg)}}
  .hero-orb{position:absolute;border-radius:50%;filter:blur(2px)}
  .hero-orb.o1{width:190px;height:190px;right:-56px;bottom:-96px;
    background:radial-gradient(circle at 30% 30%,rgba(255,255,255,.35),rgba(255,255,255,.06) 60%,transparent 72%)}
  .hero-orb.o2{width:92px;height:92px;right:300px;top:-42px;
    background:radial-gradient(circle at 30% 30%,rgba(255,255,255,.3),transparent 65%);
    animation:orbBob 8s ease-in-out infinite}
  @keyframes orbBob{0%,100%{transform:translateY(0)}50%{transform:translateY(12px)}}
  .spark{position:absolute;width:6px;height:6px;border-radius:50%;background:#fff;filter:blur(.5px);
    animation:sparkFloat 6s ease-in-out infinite}
  .spark.s1{right:70px;top:22%}
  .spark.s2{right:270px;top:68%;width:4px;height:4px;animation-delay:1.8s}
  .spark.s3{right:330px;top:26%;width:5px;height:5px;animation-delay:3.4s}
  @keyframes sparkFloat{0%,100%{transform:translateY(0);opacity:.3}50%{transform:translateY(-14px);opacity:.85}}
  @media(max-width:760px){ .ball3d,.hero-ring,.spark{display:none} }
  /* Ambient 3D background orbs */
  .bgfx{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
  .bgfx i{position:absolute;border-radius:50%;filter:blur(58px);opacity:.5;will-change:transform}
  .bgfx .b1{width:440px;height:440px;left:-140px;top:58%;
    background:radial-gradient(circle at 32% 32%,rgba(124,58,237,.42),transparent 70%);
    animation:drift1 28s ease-in-out infinite}
  .bgfx .b2{width:340px;height:340px;right:-100px;top:8%;
    background:radial-gradient(circle at 32% 32%,rgba(168,85,247,.34),transparent 70%);
    animation:drift2 34s ease-in-out infinite}
  .bgfx .b3{width:260px;height:260px;left:42%;bottom:-140px;
    background:radial-gradient(circle at 32% 32%,rgba(56,189,248,.24),transparent 70%);
    animation:drift1 40s ease-in-out infinite reverse}
  @keyframes drift1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(60px,-50px) scale(1.12)}}
  @keyframes drift2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-70px,50px) scale(1.08)}}
  html[data-theme="light"] .bgfx i{opacity:.22}
  .layout{position:relative;z-index:1}
  /* Entrance / scroll-reveal animations */
  @keyframes riseIn{from{opacity:0;transform:translateY(22px) scale(.985)}to{opacity:1;transform:none}}
  .rv{opacity:0;transform:translateY(20px) scale(.985)}
  .rv-in{opacity:1;transform:none;
    transition:opacity .65s cubic-bezier(.22,1,.36,1) var(--rvd,0ms),transform .65s cubic-bezier(.22,1,.36,1) var(--rvd,0ms)}
  /* KPI 3D hover + icon depth */
  .kpis{perspective:1000px}
  .kpi{transform-style:preserve-3d;position:relative;overflow:hidden}
  .kpi::after{content:'';position:absolute;top:0;left:-70%;width:45%;height:100%;pointer-events:none;
    background:linear-gradient(105deg,transparent,rgba(255,255,255,.10),transparent);transform:skewX(-18deg);transition:left .5s ease}
  .kpi:hover::after{left:125%}
  .kpi:hover{transform:translateY(-4px) rotateX(3.5deg);border-color:rgba(139,92,246,.5);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 18px 40px rgba(124,58,237,.25)}
  .kpi .ic{transition:transform .2s ease}
  .kpi:hover .ic{transform:translateZ(22px) scale(1.1)}
  /* Button shine sweep */
  .btn{position:relative;overflow:hidden}
  .btn::after{content:'';position:absolute;top:0;left:-70%;width:45%;height:100%;pointer-events:none;
    background:linear-gradient(105deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-18deg);transition:left .45s ease}
  .btn:hover::after{left:130%}
  .btn.ghost::after{background:linear-gradient(105deg,transparent,rgba(255,255,255,.12),transparent)}
  /* Brand polish */
  .brand .logo{animation:logoFloat 5s ease-in-out infinite}
  @keyframes logoFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
  .brand span:not(.logo){background-size:200% auto;animation:gradShift 7s linear infinite}
  @keyframes gradShift{to{background-position:200% center}}
  /* Onboarding tour */
  #obwrap{position:fixed;inset:0;z-index:80}
  #obwrap.center{background:rgba(5,3,12,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  #obspot{position:absolute;border-radius:16px;pointer-events:none;
    box-shadow:0 0 0 9999px rgba(5,3,12,.72),0 0 0 3px rgba(167,139,250,.85),0 0 36px rgba(139,92,246,.55);
    transition:top .35s cubic-bezier(.22,1,.36,1),left .35s cubic-bezier(.22,1,.36,1),
      width .35s cubic-bezier(.22,1,.36,1),height .35s cubic-bezier(.22,1,.36,1)}
  #obcard{position:absolute;width:344px;max-width:calc(100vw - 32px);
    background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01)),#1a1240;
    border:1px solid rgba(139,92,246,.45);border-radius:16px;padding:18px 20px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 60px rgba(3,0,20,.8);
    transition:top .35s cubic-bezier(.22,1,.36,1),left .35s cubic-bezier(.22,1,.36,1);
    animation:riseIn .4s cubic-bezier(.22,1,.36,1)}
  #obcard h3{margin:0 0 6px;font-size:16px}
  #obcard p{margin:0 0 14px;font-size:13px;line-height:1.55;color:#c7c1ef}
  .ob-step{display:inline-block;font-size:10px;font-weight:800;color:#c4b5fd;letter-spacing:.6px;
    text-transform:uppercase;margin-bottom:9px;background:rgba(139,124,246,.16);padding:3px 10px;border-radius:999px}
  .ob-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .ob-dots{display:flex;gap:5px}
  .ob-dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.18);transition:background .2s,transform .2s}
  .ob-dots i.on{background:#a78bfa;transform:scale(1.3)}
  .ob-btns{display:flex;gap:8px}
  html[data-theme="light"] #obcard{background:#fff}
  html[data-theme="light"] #obcard p{color:#4a4173}
  html[data-theme="light"] .ob-dots i{background:rgba(24,12,60,.15)}
  html[data-theme="light"] .ob-dots i.on{background:#7c3aed}
  /* Theme toggle */
  .theme-btn{padding:7px 11px;font-size:15px;line-height:1}
  /* ---- Light theme (🌙/☀️ toggle in the topbar) ---- */
  html[data-theme="light"]{--card:#ffffff;--ink:#1a1333;--muted:#6b6490;--line:rgba(24,12,60,.12);
    --shadow:0 1px 2px rgba(24,16,60,.04),0 10px 28px rgba(24,16,60,.08)}
  html[data-theme="light"] body{
    background:
      radial-gradient(1100px 620px at 85% -10%,rgba(124,58,237,.12),transparent 60%),
      radial-gradient(900px 540px at -12% 18%,rgba(56,189,248,.08),transparent 55%),
      #eef0f8;
    background-attachment:fixed;color:var(--ink)}
  html[data-theme="light"] .sidebar,html[data-theme="light"] .topbar{background:rgba(255,255,255,.85)}
  html[data-theme="light"] .search input,html[data-theme="light"] .sb-name,html[data-theme="light"] .sb-stake input{background:rgba(24,12,60,.05);color:var(--ink)}
  html[data-theme="light"] .search input::placeholder,html[data-theme="light"] .sb-name::placeholder{color:#8b85ab}
  html[data-theme="light"] .chip{background:rgba(24,12,60,.05);color:#5b5380}
  html[data-theme="light"] .chip-live{background:rgba(16,150,90,.10);border-color:rgba(16,150,90,.3);color:#0f8a52}
  html[data-theme="light"] .btn.ghost{background:#fff;border-color:var(--line);color:var(--ink)}
  html[data-theme="light"] .btn.ghost:hover{background:#f3f1fb}
  html[data-theme="light"] .nav-item{color:#5b5380}
  html[data-theme="light"] .nav-item:hover{background:rgba(124,58,237,.08);color:var(--ink)}
  html[data-theme="light"] .xform select{background:#fff;color:var(--ink)}
  html[data-theme="light"] .xpick{background:rgba(24,12,60,.05)}
  html[data-theme="light"] .xwhy span{color:#5f578a;background:rgba(24,12,60,.04)}
  html[data-theme="light"] .xsignals span{color:#0f6b8a;background:rgba(56,189,248,.10)}
  html[data-theme="light"] .xsel,html[data-theme="light"] .sb-stake{color:#5b5380}
  html[data-theme="light"] .xband-l,html[data-theme="light"] .sc-time,html[data-theme="light"] .sc-by{color:#5b5380}
  html[data-theme="light"] .roi-l,html[data-theme="light"] .sb-info,html[data-theme="light"] .plan ul{color:#4a4173}
  html[data-theme="light"] .xshort{background:rgba(124,58,237,.07);border-color:rgba(124,58,237,.25);color:#463d78}
  html[data-theme="light"] .xodds,html[data-theme="light"] .cmb-p b,html[data-theme="light"] .an-opt-o,html[data-theme="light"] .sb-stats,html[data-theme="light"] .ai-tools-l,html[data-theme="light"] .xanalysis,html[data-theme="light"] .day-card.all .dc-day{color:#6d28d9}
  html[data-theme="light"] .cmb-odds b,html[data-theme="light"] .sc-count b{color:#6d28d9;text-shadow:none}
  html[data-theme="light"] .vconf .xconf-n{color:#7c3aed;text-shadow:none}
  html[data-theme="light"] .xrec-big b,html[data-theme="light"] .xconf.hi .xconf-n,html[data-theme="light"] .an-xg b{text-shadow:none}
  html[data-theme="light"] .dg-count,html[data-theme="light"] .ko-chip{background:rgba(124,58,237,.10);color:#6d28d9}
  html[data-theme="light"] .pred-tip{background:rgba(124,58,237,.08);border-color:rgba(124,58,237,.22);color:#6d28d9}
  html[data-theme="light"] .reason,html[data-theme="light"] .pred-preview{color:#6f6795}
  html[data-theme="light"] .vauto{background:linear-gradient(120deg,rgba(139,92,246,.08),rgba(56,189,248,.06)),#fff;border-color:rgba(139,92,246,.25)}
  html[data-theme="light"] .vauto-item{background:#fff}
  html[data-theme="light"] .vauto-why{color:#5f578a}
  html[data-theme="light"] .tag{background:rgba(24,12,60,.06);color:#5f578a}
  html[data-theme="light"] .tag.new,html[data-theme="light"] .tag.green{background:rgba(16,150,90,.12);color:#0f8a52}
  html[data-theme="light"] .tag.orange{background:rgba(234,88,12,.10);color:#c2570f}
  html[data-theme="light"] .tag.indigo{background:rgba(124,58,237,.10);color:#6d28d9}
  html[data-theme="light"] .status.s-ACTIVE{background:rgba(16,150,90,.12);color:#0f8a52}
  html[data-theme="light"] .status.s-UNVERIFIED{background:rgba(217,119,6,.12);color:#b7791f}
  html[data-theme="light"] .status.s-EXPIRED,html[data-theme="light"] .status.s-INVALID,html[data-theme="light"] .status.s-DUPLICATE{background:rgba(225,29,72,.10);color:#c0344a}
  html[data-theme="light"] td.code{color:#6d28d9}
  html[data-theme="light"] .frow:hover{background:rgba(124,58,237,.05)}
  html[data-theme="light"] tr.fresh{background:rgba(124,58,237,.07)}
  html[data-theme="light"] .day-card:not(.on),html[data-theme="light"] .pd-chip:not(.on),html[data-theme="light"] .an-chip:not(.on){background:#fff}
  html[data-theme="light"] .an-chip:not(.on):hover{background:#f3f1fb}
  html[data-theme="light"] .dc-count,html[data-theme="light"] .pdc-count{background:rgba(24,12,60,.06);color:#5f578a}
  html[data-theme="light"] .dg-cal,html[data-theme="light"] .an-score{background:rgba(24,12,60,.04)}
  html[data-theme="light"] .an-bt,html[data-theme="light"] .xband-track,html[data-theme="light"] .conf{background:rgba(24,12,60,.08)}
  html[data-theme="light"] .an-verdict{background:rgba(56,189,248,.09)}
  html[data-theme="light"] .an-opt:hover{background:rgba(24,12,60,.03)}
  html[data-theme="light"] .an-opt.on{background:rgba(16,150,90,.08)}
  html[data-theme="light"] .fp-na{background:rgba(24,12,60,.08)}
  html[data-theme="light"] .anchat{background:rgba(26,19,51,.35)}
  html[data-theme="light"] .anchat-msg.ai{background:rgba(124,58,237,.07)}
  html[data-theme="light"] .anchat-msg.me{background:rgba(56,189,248,.08)}
  html[data-theme="light"] .anchat-chips button{background:rgba(24,12,60,.04)}
  html[data-theme="light"] .anchat-form input{background:#fff}
  html[data-theme="light"] .selbox{color:#0f8a52;border-color:rgba(16,150,90,.4)}
  html[data-theme="light"] .selbox:hover{background:rgba(16,150,90,.07)}
  html[data-theme="light"] .sb-note{color:#0f8a52}
  html[data-theme="light"] .sb-note.warn{color:#b7791f}
  html[data-theme="light"] .src-pill.on{background:rgba(16,150,90,.10);color:#0f8a52;border-color:rgba(16,150,90,.3)}
  html[data-theme="light"] .src-pill.off{background:rgba(217,119,6,.10);color:#b7791f;border-color:rgba(217,119,6,.3)}
  html[data-theme="light"] .tier-free{background:rgba(24,12,60,.06);color:#5f578a}
  html[data-theme="light"] .slipbar{background:rgba(255,255,255,.94);border-color:rgba(124,58,237,.35)}
  html[data-theme="light"] .booking{background:linear-gradient(120deg,rgba(236,72,153,.08),rgba(139,124,246,.10));border-color:rgba(236,72,153,.22)}
  html[data-theme="light"] .booking-label{color:#be3d84}
  html[data-theme="light"] .booking-code{color:#1a1333;text-shadow:none}
  html[data-theme="light"] .pred-hint{background:linear-gradient(120deg,rgba(16,150,90,.07),rgba(139,124,246,.08)),#fff;border-color:rgba(16,150,90,.25)}
  html[data-theme="light"] .risk-banner{background:rgba(225,29,72,.06);border-color:rgba(225,29,72,.28)}
  html[data-theme="light"] .rb-text{color:#8f2540}
  html[data-theme="light"] .rb-text b{color:#a51d3c}
  html[data-theme="light"] .rb-close{background:#fff;border-color:rgba(225,29,72,.3);color:#a51d3c}
  html[data-theme="light"] .risk-detail{color:#5f578a}
  html[data-theme="light"] .plan li.no{color:#9a94b8}
  html[data-theme="light"] .plan li.no::before{color:#c9c4dd}
  html[data-theme="light"] ::-webkit-scrollbar-thumb{background:rgba(124,58,237,.3)}
  @media (prefers-reduced-motion: reduce){
    *,*::before,*::after{animation:none !important;transition:none !important}
  }
  @media(max-width:640px){ .risk-banner{flex-direction:column;align-items:flex-start} }
  @media(max-width:1000px){ .kpis{grid-template-columns:repeat(2,1fr)} .split{grid-template-columns:1fr} .col-side .card{position:static} }
  @media(max-width:760px){
    .layout{flex-direction:column}
    /* Sidebar collapses into a horizontal, swipeable tab bar pinned to the top
       instead of disappearing — so navigation still works on phones. */
    .sidebar{width:auto;height:auto;position:sticky;top:0;z-index:6;flex-direction:row;flex-wrap:nowrap;
      align-items:center;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;
      padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}
    .sidebar::-webkit-scrollbar{height:0}
    .sidebar .brand,.sidebar .nav-label,.sidebar .side-foot{display:none}
    .nav-item{flex:0 0 auto;margin-bottom:0;white-space:nowrap;padding:8px 13px;font-size:13px}
    .nav-item:hover{transform:none}
    .topbar{position:static;flex-wrap:wrap;padding:12px 16px;gap:10px 12px}
    .topbar h1{font-size:16px}
    .search{display:none}
    .top-right{margin-left:auto;flex-wrap:wrap;gap:8px}
    .content{padding:16px 14px 40px}
  }
  @media(max-width:420px){
    .topbar h1{font-size:15px}
    .btn,.btn.ghost,.btn.sm{padding:8px 12px;font-size:12px}
    .content{padding:14px 12px 36px}
  }
</style>
</head>
<body>
<div class="bgfx" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i></div>
<div class="layout">
  <aside class="sidebar">
    <div class="brand"><span class="logo">⚡</span>Sporty Value Pick <span>&nbsp;AI</span></div>
    <div class="nav-label">Main</div>
    ${nav("human", "📊", "Dashboard", mode === "human")}
    ${nav("ai", "🤖", "AI Codes", mode === "ai")}
    ${nav("pred", "📈", "Predictions", mode === "pred")}
    ${nav("expert", "🎯", "Expert Picks", mode === "expert")}
    ${nav("value", "💎", "Value Picks", mode === "value")}
    ${nav("analysis", "📊", "AI Analysis", mode === "analysis")}
    ${nav("combo", "🎰", "Value Combos", mode === "combo")}
    ${nav("saved", "💾", "Saved Codes", mode === "saved")}
    ${
      isAdmin
        ? `<div class="nav-label">Owner</div>
    ${nav("metrics", "📈", "Metrics", mode === "metrics")}
    <div class="nav-label">Data</div>
    <a class="nav-item" href="/api/codes" target="_blank"><span class="ni">🔗</span>Codes API</a>
    <a class="nav-item" href="/api/ai-slips" target="_blank"><span class="ni">🧠</span>AI Slips API</a>
    <a class="nav-item" href="/health" target="_blank"><span class="ni">💓</span>Health</a>`
        : ""
    }
    <div class="side-foot">
      ${
        account
          ? `<div style="margin-bottom:8px;display:flex;align-items:center;gap:6px;min-width:0">
        <span style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:linear-gradient(145deg,#a78bfa,#6d28d9);display:grid;place-items:center;font-size:11px;font-weight:800;color:#fff">${esc(account.email[0]?.toUpperCase() ?? "U")}</span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(account.email)}">${esc(account.email)}</span>
        <a href="/logout" style="flex-shrink:0;color:var(--muted);font-size:11px;text-decoration:underline">sign out</a>
      </div>
      ${account.premiumUntil ? `<div style="margin-bottom:8px;font-size:11px;color:#f6c453">👑 Premium until ${account.premiumUntil.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short" })}</div>` : ""}`
          : ""
      }
      ${config.adminKey && isAdmin ? `<div style="margin-bottom:8px"><span style="background:#3a2a06;color:#f6c453;font-weight:800;font-size:10px;padding:2px 8px;border-radius:6px">👑 ADMIN</span> <a href="/admin/off" style="color:var(--muted);font-size:11px">exit</a></div>` : ""}
      <span class="live-dot"></span>Live · scans every ${Math.round(intervalSec / 60)} min<br/>
      <span style="opacity:.8">18+ · Bet responsibly</span>
    </div>
  </aside>
  <div class="app">
    <div class="topbar">
      <div>
        <h1>${mode === "metrics" ? "Owner Metrics" : mode === "analysis" ? "AI Match Analysis" : mode === "combo" ? "Value Combos" : mode === "value" ? "Value Picks" : mode === "saved" ? "Saved Codes" : mode === "expert" ? "Expert Picks" : mode === "pred" ? "Match Predictions" : mode === "ai" ? "AI-Generated Slips" : "Booking Code Dashboard"}</h1>
        <div class="sub">${mode === "analysis" ? "Poisson model calibrated to live odds — match & correct-score probabilities" : mode === "combo" ? "Ready-made accumulators auto-built from the best picks — book one in a click" : mode === "value" ? "Higher-odds opportunities where a model beats the market price — EV-ranked, estimates not guarantees" : mode === "saved" ? "Every generated code — with the day, time and who made it" : mode === "expert" ? "Confidence-ranked picks across your chosen window — estimates, never guarantees" : mode === "pred" ? "Third-party statistical tips — not booking codes" : mode === "ai" ? "Model recommendations with auto-generated booking codes" : "Live codes discovered & verified against SportyBet"}</div>
      </div>
      <div class="search"><input id="search" placeholder="Search codes, leagues, sources…" oninput="flt(this.value)"/></div>
      <div class="top-right">
        <select class="bookie-sel" title="Choose bookmaker" onchange="location.href='/bookmaker?id='+this.value">
          ${BOOKMAKERS.map(
            (b) =>
              `<option value="${b.id}"${b.id === bookie.id ? " selected" : ""}>${b.emoji} ${esc(b.name)}${b.status === "soon" ? " — soon" : ""}</option>`,
          ).join("")}
        </select>
        <button class="btn ghost theme-btn" id="tourBtn" onclick="obStart(true)" title="Take a quick tour of the dashboard">❓</button>
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
      ${
        bookie.status !== "live"
          ? `<div class="bookie-soon">🚧 <b>${esc(bookie.emoji + " " + bookie.name)} is coming soon.</b> ${bookie.note ? esc(bookie.note.charAt(0).toUpperCase() + bookie.note.slice(1)) + ". " : ""}It needs its own odds + booking-code integration before it goes live. Meanwhile you're seeing <b>${esc(liveBookie.emoji + " " + liveBookie.name)}</b> data — codes generated here are ${esc(liveBookie.name)} codes. <a href="/bookmaker?id=${liveBookie.id}">Switch to ${esc(liveBookie.name)}</a></div>`
          : ""
      }
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
<div id="obwrap" hidden>
  <div id="obspot"></div>
  <div id="obcard" role="dialog" aria-modal="true" aria-labelledby="obtitle">
    <span class="ob-step" id="obstep"></span>
    <h3 id="obtitle"></h3>
    <p id="obtext"></p>
    <div class="ob-foot">
      <button class="btn ghost sm" onclick="obEnd()">Skip</button>
      <div class="ob-dots" id="obdots"></div>
      <div class="ob-btns">
        <button class="btn ghost sm" id="obback" onclick="obNav(-1)">← Back</button>
        <button class="btn sm" id="obnext" onclick="obNav(1)">Next →</button>
      </div>
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
    // AI pick-guard: when the user ticks a weak or badly-priced market, say so
    // immediately (model probability + value vs the live odds).
    if(cb.checked){
      var prob = parseFloat(cb.getAttribute('data-prob'));
      var odds = parseFloat(cb.getAttribute('data-odds'));
      var label = cb.getAttribute('data-label') || 'This pick';
      if(prob > 0){
        // EV multiplier: prob × odds. 1.0 = break-even; every bookie price is a
        // bit below 1 (their margin) — only flag prices that are truly bad.
        var ev = odds > 1 ? prob * odds - 1 : 0;
        if(prob < 0.5){
          showToast('⚠️ Risky: the model gives "'+label+'" only '+Math.round(prob*100)+'% — it loses more often than it wins. Consider a safer market.','warn');
        } else if(odds > 1 && ev < -0.15){
          showToast('⚠️ Poor value: "'+label+'" pays @'+odds.toFixed(2)+' but the model rates it '+Math.round(prob*100)+'% (fair ≈ @'+(1/prob).toFixed(2)+'). The odd doesn\\'t cover the risk.','warn');
        } else if(prob >= 0.7){
          showToast('✅ Solid pick: "'+label+'" — '+Math.round(prob*100)+'% model chance'+(odds>1?' @'+odds.toFixed(2):'')+'.','ok');
        }
      }
    }
    selTog(cb);
  }
  /* ---- Deep-dive AI analyst chat (AI Analysis cards) ---- */
  var CHAT = { home:'', away:'', busy:false };
  function anChat(btn){
    CHAT.home = btn.getAttribute('data-home') || '';
    CHAT.away = btn.getAttribute('data-away') || '';
    var modal = document.getElementById('anchat'); if(!modal) return;
    // Also persist the match on the modal itself, so an ask can never lose it
    // even if this script re-runs and resets CHAT.
    modal.setAttribute('data-home', CHAT.home);
    modal.setAttribute('data-away', CHAT.away);
    document.getElementById('anchat-title').textContent = '🧠 ' + CHAT.home + ' v ' + CHAT.away;
    var wa = document.getElementById('anchat-wa');
    if(wa) wa.href = 'https://wa.me/?text=' + (btn.getAttribute('data-wa') || '');
    document.getElementById('anchat-log').innerHTML = '';
    modal.hidden = false;
    anChatAsk('overview');
  }
  function anChatClose(){ var m = document.getElementById('anchat'); if(m) m.hidden = true; }
  // Esc closes the deep-dive modal (backdrop click and ✕ / Close also work).
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
      var m = document.getElementById('anchat');
      if(m && !m.hidden){ e.preventDefault(); anChatClose(); }
    }
  });
  function anChatBubble(kind, text){
    var log = document.getElementById('anchat-log');
    var b = document.createElement('div');
    b.className = 'anchat-msg ' + kind;
    // Render **bold** and newlines from the analyst answers.
    var safe = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    b.innerHTML = safe.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\n/g,'<br/>');
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function anChatAsk(q){
    if(CHAT.busy) return;
    // The modal element is the source of truth for which match is open — CHAT is
    // only a convenience mirror. Reading the DOM makes an ask impossible to send
    // without a match, even if this script re-ran and reset CHAT.
    var modal = document.getElementById('anchat');
    var home = (modal && modal.getAttribute('data-home')) || CHAT.home || '';
    var away = (modal && modal.getAttribute('data-away')) || CHAT.away || '';
    if(!home || !away){
      anChatBubble('ai', 'I lost track of which match this is — please close this box and tap “Deep-dive” on the match card again.');
      return;
    }
    if(q !== 'overview') anChatBubble('me', q);
    CHAT.busy = true;
    var wait = anChatBubble('ai', '…thinking');
    fetch('/api/analysis/chat', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({home: home, away: away, q: q})})
      .then(function(r){ return r.json(); })
      .then(function(j){ wait.remove(); anChatBubble('ai', j.answer || j.error || 'No answer — try again.'); CHAT.busy = false; })
      .catch(function(){ wait.remove(); anChatBubble('ai', 'Network error — try again.'); CHAT.busy = false; });
  }
  function anChatSend(ev){
    ev.preventDefault();
    var inp = document.getElementById('anchat-q');
    var q = (inp.value || '').trim();
    if(q){ inp.value=''; anChatAsk(q); }
    return false;
  }
  function updBar(){
    var n = Object.keys(SEL).length;
    var bar = document.getElementById('slipbar'); if(!bar) return;
    bar.hidden = n === 0;
    document.getElementById('slipcount').textContent = n;
    // Live slip intelligence: combined odds + model chance that EVERY leg wins,
    // computed from the data-odds / data-prob the cards carry.
    var tot = 1, ch = 1, withOdds = 0, withProb = 0;
    document.querySelectorAll('input[type=checkbox][data-key]:checked').forEach(function(cb){
      var o = parseFloat(cb.getAttribute('data-odds')); if(o > 1){ tot *= o; withOdds++; }
      var p = parseFloat(cb.getAttribute('data-prob')); if(p > 0 && p <= 1){ ch *= p; withProb++; }
    });
    var st = document.getElementById('slipstats');
    var sk = document.getElementById('slipstake');
    if(st){
      st.hidden = withOdds === 0;
      if(withOdds > 0){
        // "≥" when some selections have no price attached (e.g. Predictions tab).
        document.getElementById('slipodds').textContent = (withOdds < n ? '≥' : '') + tot.toFixed(2);
        document.getElementById('slipchance').textContent = withProb === n ? Math.round(ch*100) + '%' : '—';
      }
    }
    if(sk) sk.hidden = withOdds === 0;
    updPayout(false);
  }
  function updPayout(save){
    var el = document.getElementById('stake'), out = document.getElementById('payout');
    if(!el || !out) return;
    var tot = 1, withOdds = 0;
    document.querySelectorAll('input[type=checkbox][data-key]:checked').forEach(function(cb){
      var o = parseFloat(cb.getAttribute('data-odds')); if(o > 1){ tot *= o; withOdds++; }
    });
    var s = parseFloat(el.value);
    out.textContent = (s > 0 && withOdds > 0) ? '₦' + Math.round(s * tot).toLocaleString() : '—';
    if(save){ try{ localStorage.setItem('stake', el.value); }catch(e){} }
  }
  // AI Quick Slip: auto-pick the statistically safest options on the Analysis
  // page. 'safe' = the 3 highest-probability picks; a number = keep adding the
  // highest-probability pick per match until the combined odds reach it.
  function anPreset(kind){
    clearSel();
    var byMatch = {};
    document.querySelectorAll('.an-opt input[type=checkbox][data-match]').forEach(function(cb){
      var m = cb.getAttribute('data-match');
      var p = parseFloat(cb.getAttribute('data-prob')) || 0;
      var o = parseFloat(cb.getAttribute('data-odds')) || 0;
      if(o <= 1) return;
      if(!byMatch[m] || p > byMatch[m].p) byMatch[m] = {cb: cb, p: p, o: o};
    });
    var best = Object.keys(byMatch).map(function(k){ return byMatch[k]; });
    best.sort(function(a, b){ return b.p - a.p; });
    var picked = [];
    if(kind === 'safe'){
      picked = best.slice(0, 3);
    } else {
      var tot = 1;
      for(var i = 0; i < best.length && tot < kind; i++){ picked.push(best[i]); tot *= best[i].o; }
      if(tot < kind && picked.length){
        showToast('Only reached ' + tot.toFixed(2) + ' odds with the matches shown — load more matches for a bigger slip', 'warn');
      }
    }
    if(!picked.length){ showToast('No modelled matches to pick from — try a wider window', 'warn'); return; }
    picked.forEach(function(x){ x.cb.checked = true; anTog(x.cb); });
    var t = 1, c = 1;
    picked.forEach(function(x){ t *= x.o; c *= x.p; });
    showToast('🤖 ' + picked.length + ' picks selected · ≈' + t.toFixed(2) + ' odds · ' + Math.round(c*100) + '% model chance. Review, then Generate.', 'ok');
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
    // Prefill the saved generator name + stake so they're remembered across visits.
    try{ var n = localStorage.getItem('genName'); var el = document.getElementById('genname'); if(n && el) el.value = n; }catch(e){}
    try{ var s = localStorage.getItem('stake'); var se = document.getElementById('stake'); if(s && se) se.value = s; }catch(e){}
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
    var IS_ANALYSIS = ${mode === "analysis" ? "true" : "false"};
    var el = document.getElementById('countdown');
    // Show a toast for a scan that completed just before this page (re)loaded.
    try{ var done=sessionStorage.getItem('scanDone'); if(done){ sessionStorage.removeItem('scanDone'); showToast(done,'ok'); } }catch(e){}
    // Countdown display (updates every second). On the AI Analysis tab the
    // 10-min auto-scan below drives this instead, so skip the 3-min crawl clock.
    function tick(){
      if(!el || IS_ANALYSIS) return;
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
          // AI Analysis has its own 10-min auto-scan below — don't let the
          // frequent scan-completion reload interrupt it.
          if(IS_ANALYSIS){ LASTRUN = h.lastRunAt; return; }
          try{ sessionStorage.setItem('scanDone', niceSummary(h.lastSummary||'')); }catch(e){}
          location.reload();
        } else if(h.lastRunAt && !LASTRUN){ LASTRUN = h.lastRunAt; }
      }catch(e){}
    }
    setInterval(poll, 5000);

    // ---- AI Analysis: auto-scan every 10 minutes ----
    // The SportyBet odds feed refreshes on a ~10-min clock, so we re-run the
    // analysis on the same cadence with a visible countdown.
    if(IS_ANALYSIS){
      var anEl = document.getElementById('an-countdown');
      var target = Date.now() + 10*60*1000;
      function anTick(){
        var r = Math.round((target - Date.now())/1000);
        var txt = r <= 0 ? 'refreshing…' : (Math.floor(r/60)+':'+((r%60)<10?'0':'')+(r%60));
        if(anEl) anEl.textContent = txt;
        if(el) el.textContent = txt; // also drive the top-bar "Next scan" chip
        if(r <= 0){ location.reload(); }
      }
      anTick(); setInterval(anTick, 1000);
    }
  })();
  /* ---- Hero card: interactive 3D tilt (desktop pointers only) ---- */
  (function(){
    var hero = document.getElementById('hero3d');
    if(!hero || !window.matchMedia) return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(pointer: coarse)').matches) return;
    var raf = null, fx = document.getElementById('heroFx');
    hero.addEventListener('mousemove', function(e){
      var r = hero.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - .5;
      var y = (e.clientY - r.top) / r.height - .5;
      if(raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function(){
        hero.style.transform = 'perspective(900px) rotateX(' + (-y * 5).toFixed(2) + 'deg) rotateY(' + (x * 7).toFixed(2) + 'deg)';
        if(fx) fx.style.transform = 'translate3d(' + (x * -20).toFixed(1) + 'px,' + (y * -14).toFixed(1) + 'px,0)';
      });
    });
    hero.addEventListener('mouseleave', function(){
      if(raf) cancelAnimationFrame(raf);
      hero.style.transform = '';
      if(fx) fx.style.transform = '';
    });
  })();
  /* ---- KPI numbers: animated count-up ---- */
  (function(){
    if(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('b.cnt').forEach(function(el){
      var end = parseFloat(el.getAttribute('data-n'));
      if(!isFinite(end) || end <= 0) return;
      var t0 = null, dur = 900;
      function step(t){
        if(!t0) t0 = t;
        var p = Math.min((t - t0) / dur, 1);
        p = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(end * p).toLocaleString();
        if(p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  })();
  /* ---- Scroll-reveal: cards rise in with a stagger ---- */
  (function(){
    if(!('IntersectionObserver' in window)) return;
    if(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var els = document.querySelectorAll('.kpi,.card,.xcard,.slip,.cmb-card,.an-card,.sc-row,.plan,.dg-head');
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting){ en.target.classList.add('rv-in'); io.unobserve(en.target); }
      });
    }, { threshold: .08 });
    els.forEach(function(el, i){
      el.classList.add('rv');
      el.style.setProperty('--rvd', (i % 6) * 70 + 'ms');
      io.observe(el);
    });
  })();
  /* ---- First-visit onboarding tour ---- */
  var OB_STEPS = [
    { t:null, title:'Welcome to Sporty Value Pick AI 👋',
      text:'Live booking codes, AI-built slips and match analysis in one place. Take a 30-second tour of the essentials.' },
    { t:'#hero3d', title:'Freshest verified code',
      text:'The newest ACTIVE booking code, checked against SportyBet. Click the big code (or hit Copy) and paste it straight into your bet slip.' },
    { t:'.sidebar', title:'Every angle, one sidebar',
      text:'Dashboard shows live codes. AI Codes builds slips for you. Predictions, Expert Picks and Value Picks rank tips by confidence, and Value Combos bundles the best into one ready-made code.' },
    { t:'.top-right', title:'Your toolbar',
      text:'The countdown shows the next auto-scan. Hit ⟳ Scan now for an instant refresh, or 📷 upload a bet-slip screenshot and we’ll read the booking code out of it.' },
    { t:'#riskBanner', title:'Estimates — never guarantees',
      text:'Every code and pick is statistical. Nothing is ever “sure”, and anyone promising guaranteed wins is scamming you. Only stake what you can afford to lose. 18+ only.' },
    { t:'#tourBtn', title:'That’s the tour!',
      text:'Replay it any time from this ❓ button. Good luck — and bet responsibly.' }
  ];
  var obI = -1;
  function obTarget(st){
    if(!st.t) return null; /* intentionally centered step */
    var el = document.querySelector(st.t);
    return (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) ? el : undefined; /* undefined = skip */
  }
  function obVisible(){
    var v = [];
    for(var k = 0; k < OB_STEPS.length; k++){ if(obTarget(OB_STEPS[k]) !== undefined) v.push(k); }
    return v;
  }
  function obStart(force){
    try{ if(!force && localStorage.getItem('ob_done')) return; }catch(e){}
    var w = document.getElementById('obwrap'); if(!w) return;
    obI = -1; w.hidden = false; obNav(1);
  }
  function obEnd(){
    var w = document.getElementById('obwrap'); if(w) w.hidden = true;
    obI = -1;
    try{ localStorage.setItem('ob_done', '1'); }catch(e){}
  }
  function obNav(dir){
    var i = obI + dir;
    while(i >= 0 && i < OB_STEPS.length && obTarget(OB_STEPS[i]) === undefined) i += dir;
    if(i < 0) i = 0;
    if(i >= OB_STEPS.length){ obEnd(); return; }
    obI = i;
    var st = OB_STEPS[i], tg = obTarget(st);
    var vis = obVisible(), pos = vis.indexOf(i), last = pos === vis.length - 1;
    document.getElementById('obtitle').textContent = st.title;
    document.getElementById('obtext').textContent = st.text;
    document.getElementById('obstep').textContent = 'Step ' + (pos + 1) + ' of ' + vis.length;
    document.getElementById('obdots').innerHTML = vis.map(function(k){ return '<i class="' + (k === i ? 'on' : '') + '"></i>'; }).join('');
    document.getElementById('obback').style.visibility = pos === 0 ? 'hidden' : 'visible';
    document.getElementById('obnext').textContent = pos === 0 ? 'Show me around →' : last ? 'Finish ✓' : 'Next →';
    var w = document.getElementById('obwrap'), s = document.getElementById('obspot');
    if(tg){
      w.classList.remove('center'); s.style.display = 'block';
      tg.scrollIntoView({ block: 'center' });
      requestAnimationFrame(function(){ obPlace(tg); });
    }else{
      w.classList.add('center'); s.style.display = 'none';
      requestAnimationFrame(obCenter);
    }
  }
  function obPlace(tg){
    var s = document.getElementById('obspot'), c = document.getElementById('obcard');
    var r = tg.getBoundingClientRect(), pad = 8;
    s.style.top = (r.top - pad) + 'px'; s.style.left = (r.left - pad) + 'px';
    s.style.width = (r.width + pad * 2) + 'px'; s.style.height = (r.height + pad * 2) + 'px';
    var cw = Math.min(344, innerWidth - 32), ch = c.offsetHeight || 190, top, left;
    if(r.height > innerHeight * .5 && r.right + cw + 30 < innerWidth){
      /* tall target (sidebar): put the card beside it */
      top = Math.max(16, Math.min(r.top + 60, innerHeight - ch - 16));
      left = r.right + pad + 14;
    }else{
      top = r.bottom + pad + 14;
      if(top + ch > innerHeight - 16) top = Math.max(16, r.top - pad - ch - 14);
      left = Math.min(Math.max(16, r.left), innerWidth - cw - 16);
    }
    c.style.top = top + 'px'; c.style.left = left + 'px';
  }
  function obCenter(){
    var c = document.getElementById('obcard');
    c.style.top = Math.max(16, (innerHeight - c.offsetHeight) / 2) + 'px';
    c.style.left = Math.max(16, (innerWidth - c.offsetWidth) / 2) + 'px';
  }
  document.addEventListener('keydown', function(e){
    var w = document.getElementById('obwrap');
    if(!w || w.hidden) return;
    if(e.key === 'Escape') obEnd();
    if(e.key === 'ArrowRight') obNav(1);
    if(e.key === 'ArrowLeft') obNav(-1);
  });
  window.addEventListener('resize', function(){
    var w = document.getElementById('obwrap');
    if(!w || w.hidden || obI < 0) return;
    var tg = obTarget(OB_STEPS[obI]);
    if(tg) obPlace(tg); else obCenter();
  });
  setTimeout(function(){ obStart(false); }, 800);
</script>
</body></html>`;
}

function kpi(icon: string, value: number | string, label: string, color: string): string {
  const cnt = typeof value === "number" && Number.isFinite(value) ? ` class="cnt" data-n="${value}"` : "";
  return `<div class="kpi ${color}"><div class="ic">${icon}</div><div><b${cnt}>${value}</b><small>${label}</small></div></div>`;
}

const UPGRADE_ERRORS: Record<string, string> = {
  "1": "Invalid access code.",
  pay: "Online payments aren't configured yet — ask the site owner, or use an access code below.",
  init: "Could not start the payment — please try again in a moment.",
  verify: "We couldn't confirm that payment. If you were debited, your access is granted automatically once the payment settles — refresh in a minute or contact support.",
};

const fmtNgn = (n: number) => `₦${n.toLocaleString("en-NG")}`;

function renderUpgrade(
  err: string | null,
  opts: { loggedIn: boolean; premiumUntil: Date | null } = { loggedIn: false, premiumUntil: null },
): string {
  const planCard = (planId: "daily" | "weekly" | "monthly", pop: boolean, per: string, note: string) => {
    const p = PLANS[planId];
    const btn =
      opts.loggedIn && paystackEnabled()
        ? `<form method="post" action="/pay/init"><input type="hidden" name="plan" value="${planId}"/>
           <button class="btn${pop ? "" : " ghost"}" type="submit">Get ${p.label} — ${fmtNgn(p.ngn)}</button></form>`
        : !opts.loggedIn
          ? `<a class="btn${pop ? "" : " ghost"}" href="/signup">Create account to buy</a>`
          : `<a class="btn ghost" href="#demo">Payments not configured</a>`;
    return `<div class="plan${pop ? " pop" : ""}">
      <h3>${p.label}</h3><div class="price">${fmtNgn(p.ngn)}<small>${per}</small></div>
      <ul>
        <li><b>Instant</b> fresh codes — no ${config.freeDelayMin}-min delay</li>
        <li>All AI slips with <b>booking codes</b></li>
        <li>Expert, Value &amp; Combo picks unlocked</li>
        <li>${note}</li>
      </ul>
      ${btn}
    </div>`;
  };
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Go Premium · Sporty Value Pick AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap" media="print" onload="this.media='all'"/>
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap"/></noscript>
<style>
  /* Web fonts load non-blockingly via <link> in <head> so first paint never waits on the network (works offline too). */
  body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;
    background:
      radial-gradient(1000px 560px at 85% -10%,rgba(124,58,237,.14),transparent 60%),
      radial-gradient(800px 500px at -10% 25%,rgba(56,189,248,.09),transparent 55%),
      radial-gradient(760px 640px at 55% 115%,rgba(168,85,247,.12),transparent 62%),
      #f4f1fb;
    background-attachment:fixed;color:#1a1333}
  .wrap{max-width:1000px;margin:0 auto;padding:40px 24px}
  a{color:#6d28d9;text-decoration:none}
  h1{font-family:'Sora','Inter',sans-serif;font-size:28px;margin:0 0 6px}.lead{color:#6b6490;margin-bottom:28px}
  .pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
  .plan{background:#ffffff;
    border:1px solid rgba(24,12,60,.12);border-radius:18px;padding:24px;
    box-shadow:0 14px 40px rgba(76,29,149,.10);
    transition:transform .15s,border-color .15s}
  .plan:hover{transform:translateY(-3px);border-color:rgba(139,92,246,.4)}
  .plan.pop{border:2px solid #8b5cf6;position:relative;box-shadow:0 18px 50px rgba(124,58,237,.20)}
  .plan.pop::before{content:'MOST POPULAR';position:absolute;top:-11px;left:24px;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;font-size:10px;font-weight:800;padding:3px 10px;border-radius:6px;box-shadow:0 6px 16px rgba(124,58,237,.5)}
  .plan h3{font-family:'Sora','Inter',sans-serif;margin:0 0 4px;font-size:18px}
  .price{font-size:34px;font-weight:800;margin:10px 0}.price small{font-size:14px;color:#6b6490;font-weight:500}
  ul{list-style:none;padding:0;margin:16px 0;font-size:13.5px;color:#4a4173}
  li{padding:7px 0;border-bottom:1px solid rgba(24,12,60,.08)}
  li::before{content:'✓ ';color:#0f8a52;font-weight:800}
  li.no{color:#9a94b8}li.no::before{content:'✕ ';color:#c9c4dd}
  .btn{display:block;text-align:center;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;
    border:0;border-radius:12px;padding:12px;font-weight:800;cursor:pointer;margin-top:12px;text-decoration:none;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 10px 26px rgba(124,58,237,.4);
    transition:transform .12s,filter .12s}
  .btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
  .btn.gold{background:linear-gradient(135deg,#e0a531,#f6c453);color:#3a2a06;box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 10px 26px rgba(224,165,49,.35)}
  .btn.ghost{background:#ffffff;color:#1a1333;border:1px solid rgba(24,12,60,.14);box-shadow:none}
  .demo{margin-top:28px;background:#ffffff;
    border:1px solid rgba(24,12,60,.12);border-radius:16px;padding:20px;box-shadow:0 10px 30px rgba(76,29,149,.06)}
  .demo input{padding:10px 12px;border:1px solid rgba(24,12,60,.16);border-radius:10px;font-size:14px;width:200px;
    background:#fff;color:#1a1333;outline:none}
  .demo input::placeholder{color:#8b85ab}
  .demo input:focus{border-color:#8b5cf6}
  .err{color:#c0344a;font-size:13px;margin-top:8px}
  .note{color:#6b6490;font-size:12.5px;margin-top:10px}
  code{background:rgba(139,92,246,.12);color:#6d28d9;padding:1px 6px;border-radius:6px}
  @media(max-width:760px){ .pricing{grid-template-columns:1fr} .wrap{padding:28px 16px} h1{font-size:23px} }
</style></head><body><div class="wrap">
  <a href="/">← Back to dashboard</a>
  <h1 style="margin-top:14px">Go Premium — instant codes, zero delay 👑</h1>
  <div class="lead">Free sees codes ${config.freeDelayMin} minutes late. Premium gets every verified code and AI pick the second it lands. Pay once with card, bank transfer or USSD — no auto-renewal.</div>
  ${
    opts.premiumUntil
      ? `<div class="demo" style="border-color:rgba(52,211,153,.4);margin:0 0 20px"><b style="color:#0f8a52">✓ Premium active</b>
         <div class="note">Your access runs until <b>${opts.premiumUntil.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })}</b>. Buying another pass adds time on top.</div></div>`
      : ""
  }
  ${err && UPGRADE_ERRORS[err] ? `<div class="demo" style="border-color:rgba(251,113,133,.4);margin:0 0 20px"><div class="err" style="margin:0">${UPGRADE_ERRORS[err]}</div></div>` : ""}
  <div class="pricing">
    ${planCard("daily", false, "/24 hours", "Perfect for big match days")}
    ${planCard("weekly", true, "/7 days", "Best value for regular punters")}
    ${planCard("monthly", false, "/30 days", `Save vs weekly (${fmtNgn(PLANS.monthly.ngn)} for 30 days)`)}
  </div>
  <div class="note" style="margin-top:14px">Payments are processed securely by <b>Paystack</b> (card · bank transfer · USSD · mobile money). Access is credited to your account automatically within seconds of payment.</div>
  ${
    !opts.loggedIn
      ? `<div class="demo"><b>Have an account already?</b>
         <div class="note"><a href="/login">Sign in</a> first so your purchase attaches to your account.</div></div>`
      : ""
  }
  <div class="demo" id="demo">
    <b>Access code</b>
    <div class="note">Got a promo / tester access code? Redeem it here for temporary Premium on this browser.</div>
    <form action="/unlock" method="get" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <input name="key" placeholder="access code" autocomplete="off"/>
      <button class="btn" style="width:auto;padding:10px 18px;margin:0" type="submit">Redeem</button>
    </form>
  </div>
  <div class="note" style="margin-top:18px">⚠️ Premium speeds up delivery of statistical estimates — it does <b>not</b> increase the chance any bet wins. Nothing here is a guaranteed win. 18+ only · <a href="https://www.begambleaware.org" target="_blank" rel="noopener">BeGambleAware.org</a></div>
</div></body></html>`;
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

      const cookies = req.headers.cookie ?? "";
      const ip = req.socket.remoteAddress ?? "?";

      // ---- Paystack webhook (public; authenticated by its HMAC signature) ----
      // Must be handled before any auth gate — Paystack's servers call it.
      if (url.pathname === "/paystack/webhook" && req.method === "POST") {
        const raw = await readBody(req, 512 * 1024);
        if (!webhookSignatureValid(raw, req.headers["x-paystack-signature"])) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        try {
          const evt = JSON.parse(raw);
          if (evt?.event === "charge.success") await grantFromCharge(evt.data ?? {});
        } catch (e) {
          console.error("[billing] webhook processing failed:", e);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
        return;
      }

      // ---- User session ----
      const sessionUserId = verifySession(readCookie(cookies, "sid"));
      let user:
        | {
            id: string;
            email: string;
            role: string;
            subscription: { status: string; currentPeriodEnd: Date | null } | null;
          }
        | null = null;
      if (sessionUserId) {
        const u = await prisma.user
          .findUnique({ where: { id: sessionUserId }, include: { subscription: true } })
          .catch(() => null);
        if (u && u.status === "ACTIVE") user = u;
      }
      // Legacy owner access: the shared APP_PASSWORD cookie keeps working.
      const legacyAuthed =
        !!config.appPassword &&
        new RegExp(`(?:^|;\\s*)app_auth=${sha256Hex(config.appPassword)}(?:;|$)`).test(cookies);

      // ---- Auth routes ----
      if (url.pathname === "/logout") {
        res.writeHead(303, {
          "Set-Cookie": [
            "sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
            "app_auth=; Path=/; Max-Age=0; SameSite=Lax",
            "admin=; Path=/; Max-Age=0; SameSite=Lax",
          ],
          Location: "/login",
        });
        res.end();
        return;
      }
      if (url.pathname === "/signup") {
        if (!config.allowSignup) {
          res.writeHead(303, { Location: "/login" });
          res.end();
          return;
        }
        if (req.method === "POST") {
          if (rateLimited(`su:${ip}`, 5, 3_600_000)) {
            res.writeHead(303, { Location: "/signup?err=rate" });
            res.end();
            return;
          }
          const body = new URLSearchParams((await readBody(req, 4096)) || "");
          const email = (body.get("email") ?? "").trim().toLowerCase();
          const pw = body.get("password") ?? "";
          const err = !EMAIL_RE.test(email)
            ? "email"
            : pw.length < 8
              ? "pw"
              : pw !== (body.get("confirm") ?? "")
                ? "match"
                : (await prisma.user.findUnique({ where: { email } }))
                  ? "exists"
                  : null;
          if (err) {
            res.writeHead(303, { Location: `/signup?err=${err}` });
            res.end();
            return;
          }
          const created = await prisma.user.create({
            data: { email, passwordHash: hashPassword(pw), lastLoginAt: new Date() },
          });
          res.writeHead(303, {
            "Set-Cookie": `sid=${signSession(created.id)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
            Location: "/",
          });
          res.end();
          return;
        }
        if (user) {
          res.writeHead(303, { Location: "/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderSignup(url.searchParams.get("err")));
        return;
      }
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          if (rateLimited(`li:${ip}`, 20, 600_000)) {
            res.writeHead(303, { Location: "/login?err=rate" });
            res.end();
            return;
          }
          const body = new URLSearchParams((await readBody(req, 4096)) || "");
          const email = (body.get("email") ?? "").trim().toLowerCase();
          const pw = body.get("password") ?? "";
          if (email) {
            const u = await prisma.user.findUnique({ where: { email } }).catch(() => null);
            if (u && u.status === "ACTIVE" && verifyPassword(pw, u.passwordHash)) {
              void prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
              res.writeHead(303, {
                "Set-Cookie": `sid=${signSession(u.id)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
                Location: "/",
              });
              res.end();
              return;
            }
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderLogin("bad"));
            return;
          }
          if (config.appPassword && pw === config.appPassword) {
            // The owner/staff password also grants admin (source columns, crawl
            // info) so the owner doesn't have to separately visit /admin?key=.
            const cookiesOut = [
              `app_auth=${sha256Hex(config.appPassword)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
            ];
            if (config.adminKey) {
              cookiesOut.push(`admin=${sha256Hex(config.adminKey)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
            }
            res.writeHead(303, { "Set-Cookie": cookiesOut, Location: "/" });
            res.end();
            return;
          }
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLogin("1"));
          return;
        }
        if (user || legacyAuthed) {
          res.writeHead(303, { Location: "/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLogin(url.searchParams.get("err")));
        return;
      }

      // ---- App access gate ----
      // If APP_PASSWORD is set, everything else requires a user account or the
      // owner password — except /health (uptime monitors) and /pay/callback
      // (Paystack redirects the browser back there; the grant itself is decided
      // by server-side verification, not by who loads the URL).
      if (config.appPassword) {
        const open = url.pathname === "/health" || url.pathname === "/pay/callback";
        if (!user && !legacyAuthed && !open) {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLogin(null));
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
                      : modeParam === "metrics"
                        ? "metrics"
                        : "human";
      // Tier comes from the user's paid subscription window in the DB. The demo
      // unlock cookie must carry a hashed token (not the literal "premium"), so
      // it can't be forged from devtools. Admins are always premium.
      const sub = user?.subscription;
      const premiumViaSub =
        !!sub &&
        (sub.status === "ACTIVE" || sub.status === "TRIALING") &&
        !!sub.currentPeriodEnd &&
        sub.currentPeriodEnd.getTime() > Date.now();
      const demoTok = sha256Hex(`demo-premium:${config.premiumKey}`);

      // Admin sees source-revealing info (which channel a code came from,
      // crawl activity). If no ADMIN_KEY is configured, treat everyone as admin
      // so the owner isn't locked out of their own data by default.
      const isAdmin =
        !config.adminKey ||
        new RegExp(`(?:^|;\\s*)admin=${sha256Hex(config.adminKey)}(?:;|$)`).test(req.headers.cookie ?? "");

      // Admins always get full Premium access to every plan/feature — this
      // covers both the DB ADMIN role and the cookie-based admin unlock the
      // owner/staff password grants (so signing in as admin unlocks everything).
      const tier: Tier =
        config.defaultTier === "premium" ||
        premiumViaSub ||
        user?.role === "ADMIN" ||
        isAdmin ||
        new RegExp(`(?:^|;\\s*)tier=${demoTok}(?:;|$)`).test(cookies)
          ? "premium"
          : "free";

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
      if (url.pathname === "/bookmaker") {
        const id = getBookmaker(url.searchParams.get("id")).id;
        res.writeHead(303, {
          "Set-Cookie": `bookie=${id}; Path=/; Max-Age=2592000; SameSite=Lax`,
          Location: url.searchParams.get("back") || "/",
        });
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
        res.end(
          renderUpgrade(url.searchParams.get("err"), {
            loggedIn: !!user,
            premiumUntil: premiumViaSub ? sub!.currentPeriodEnd : null,
          }),
        );
        return;
      }
      // ---- Paystack checkout ----
      if (url.pathname === "/pay/init" && req.method === "POST") {
        if (!user) {
          // Paying needs a real account (the receipt + entitlement attach to it).
          res.writeHead(303, { Location: config.allowSignup ? "/signup" : "/login?err=signup" });
          res.end();
          return;
        }
        const body = new URLSearchParams((await readBody(req, 2048)) || "");
        const planId = validPlan(body.get("plan"));
        if (!planId || !paystackEnabled()) {
          res.writeHead(303, { Location: "/upgrade?err=pay" });
          res.end();
          return;
        }
        try {
          const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || "http";
          const origin = config.publicBaseUrl || `${proto}://${req.headers.host ?? `localhost:${config.port}`}`;
          const { url: payUrl } = await initTransaction(user.id, user.email, planId, `${origin}/pay/callback`);
          res.writeHead(303, { Location: payUrl });
          res.end();
        } catch (e) {
          console.error("[billing] init failed:", e);
          res.writeHead(303, { Location: "/upgrade?err=init" });
          res.end();
        }
        return;
      }
      if (url.pathname === "/pay/callback") {
        // Browser returns here after Paystack checkout. The grant is decided by
        // a server-to-server verify of the reference — nothing user-supplied.
        const reference = url.searchParams.get("reference") ?? url.searchParams.get("trxref");
        let ok = false;
        if (reference) ok = await verifyAndGrant(reference).catch(() => false);
        res.writeHead(303, { Location: ok ? "/?paid=1" : "/upgrade?err=verify" });
        res.end();
        return;
      }
      if (url.pathname === "/unlock") {
        if (url.searchParams.get("key") === config.premiumKey) {
          // Demo/testing unlock — cookie carries a hashed token so it can't be
          // hand-crafted without knowing PREMIUM_ACCESS_KEY.
          res.writeHead(303, {
            "Set-Cookie": `tier=${demoTok}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
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
        // Legacy route — the real checkout now lives on /upgrade → /pay/init.
        res.writeHead(303, { Location: "/upgrade" });
        res.end();
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
      // Raw data dumps are admin-only — they expose codes, sources and internal
      // data. Blocking the endpoints (not just hiding the menu links) so nobody
      // can reach them by typing the URL.
      const adminOnlyApi = new Set([
        "/api/codes",
        "/api/ai-slips",
        "/api/predictions",
        "/api/expert/record",
        "/api/expert/roi",
      ]);
      if (adminOnlyApi.has(url.pathname) && !isAdmin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
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
      if (req.method === "POST" && url.pathname === "/api/analysis/chat") {
        // Deep-dive analyst chat: answers grounded in the SAME live model the
        // Analysis cards show (Poisson + live odds + real past results).
        const json = (s: number, o: unknown) => {
          res.writeHead(s, { "Content-Type": "application/json" });
          res.end(JSON.stringify(o));
        };
        let home = "";
        let away = "";
        let q = "";
        try {
          const body = JSON.parse((await readBody(req, 16 * 1024)) || "{}");
          home = String(body.home ?? "").slice(0, 80);
          away = String(body.away ?? "").slice(0, 80);
          q = String(body.q ?? "").slice(0, 300);
        } catch {
          return json(400, { error: "Bad request body." });
        }
        if (!home || !away) return json(400, { error: "Missing match." });
        const events = await getSportyFixtures().catch(() => []);
        const now = Date.now();
        const ev = events.find(
          (e) => e.kickoff > now && fuzzyTeamsMatch(e.home, home) && fuzzyTeamsMatch(e.away, away),
        );
        if (!ev)
          return json(200, {
            answer:
              "I can't find that fixture on SportyBet any more — it may have kicked off or been withdrawn. Refresh the page for the current list.",
          });
        const a = analyzeEvent(ev);
        if (!a)
          return json(200, {
            answer: "Not enough live prices remain to model this match honestly — check back as odds populate.",
          });
        const form = await getMatchForm(ev.home, ev.away).catch(() => null);
        return json(200, { answer: analystAnswer(q, a, form) });
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
      // Analysis calendar: a specific match-day (YYYY-MM-DD) overrides the window;
      // an optional `to` extends it to an inclusive range (the weekend shortcut).
      const onParam = url.searchParams.get("on") ?? "";
      const toParam = url.searchParams.get("to") ?? "";
      const analysisOn = /^\d{4}-\d{2}-\d{2}$/.test(onParam) ? onParam : undefined;
      const analysisTo =
        analysisOn && /^\d{4}-\d{2}-\d{2}$/.test(toParam) && toParam >= analysisOn ? toParam : undefined;
      const html = await renderDashboard(
        mode,
        tier,
        dateStr,
        {
          count: expertCount,
          days: expertDays,
          gameType: expertGameType,
          minConfidence: expertMinConf, // plain percentage (0/50/60/70/80/90) — kept for form state
          onDate: analysisOn,
          onEnd: analysisTo,
        },
        isAdmin,
        user ? { email: user.email, premiumUntil: premiumViaSub ? sub!.currentPeriodEnd : null } : null,
        (/(?:^|;\s*)bookie=([a-z0-9]+)/.exec(req.headers.cookie ?? "") || [])[1] || "sportybet",
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
