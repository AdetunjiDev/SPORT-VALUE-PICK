import { config } from "./config.js";

/**
 * Transactional email via Resend's HTTP API — no SMTP, no extra dependency,
 * just fetch. Dormant by design: with no RESEND_API_KEY set, isEmailEnabled()
 * is false and sendEmail() is a no-op that returns { skipped: true }, so the
 * app runs exactly as before until a key is added (same convention as the
 * Paystack and API-Football adapters).
 */

const RESEND_API = "https://api.resend.com/emails";

export function isEmailEnabled(): boolean {
  return !!config.email.apiKey;
}

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}

/** Send one email. Returns { skipped:true } when email isn't configured. */
export async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  if (!isEmailEnabled()) return { ok: false, skipped: true };
  if (!to || !/.+@.+\..+/.test(to)) return { ok: false, error: "invalid recipient" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.email.from, to, subject, html }),
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.message ?? `http ${res.status}` };
    return { ok: true, id: json?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Branded HTML for an Auto-Pilot booking-code email. */
export function autopilotEmailHtml(opts: {
  code: string;
  games: number;
  totalOdds: number;
  url?: string;
}): string {
  const open = opts.url || `https://www.sportybet.com/ng/?shareCode=${encodeURIComponent(opts.code)}`;
  // Inline styles only — email clients strip <style>/external CSS.
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1333">
    <div style="background:linear-gradient(135deg,#7c3aed,#4c1d95);padding:20px 24px;border-radius:14px 14px 0 0">
      <span style="color:#fff;font-size:18px;font-weight:800">⚡ Sporty Value Pick AI</span>
    </div>
    <div style="border:1px solid #e7e3f5;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      <h2 style="margin:0 0 6px;font-size:20px">🤖 Your Auto-Pilot slip is ready</h2>
      <p style="margin:0 0 18px;color:#5b5380;font-size:14px">Built automatically from today's safest picks. Review it and place it yourself on SportyBet.</p>
      <div style="background:#f5f2fb;border:1px solid #e7e3f5;border-radius:12px;padding:16px;text-align:center;margin-bottom:18px">
        <div style="font-size:12px;color:#8b85ab;font-weight:700;letter-spacing:.06em">BOOKING CODE</div>
        <div style="font-size:30px;font-weight:900;letter-spacing:.08em;color:#4c1d95;margin:4px 0">${escapeHtml(opts.code)}</div>
        <div style="font-size:13px;color:#5b5380">${opts.games} games · total odds ×${opts.totalOdds}</div>
      </div>
      <a href="${escapeHtml(open)}" style="display:block;text-align:center;background:#7c3aed;color:#fff;text-decoration:none;font-weight:800;padding:13px;border-radius:10px;font-size:15px">Open on SportyBet →</a>
      <p style="margin:18px 0 0;color:#8b85ab;font-size:12px;line-height:1.6">
        ⚠️ These are statistical estimates, never guarantees. No code is "sure". Only stake what you can afford to lose. 18+ only. You place the bet yourself — this app never bets on your behalf.
      </p>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
